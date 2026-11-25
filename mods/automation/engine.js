// The tick: leader lease, Runs going, due schedule Triggers, Catch-up, Missed and pauses.
// The engine keeps nothing that matters in memory: Runs going and the last instant checked
// per Automation are in state.json, so the next engine after a reload carries on.
import { dueBetween, defaultCatchUp, durationMs } from "./cron.js";
import { startRun, finishRun, updateRun, observe, newRunId, event, ENDED, STARTING_MS } from "./runs.js";

/** How long a leader's lease lasts without renewal. */
export const LEASE_MS = 30000;
/** A time this late is still on time: ticks, reloads and a lease handover take a while. */
export const GRACE_MS = 2 * 60000;
// A terminal must be missing on two looks in a row before its Run counts as closed, since
// terminals() can be empty for a moment while Herdr starts.
const GONE_LOOKS = 2;

/** An Automation's Catch-up window in ms: its `catchUp`, the default for its schedule when absent, 0 for none. */
export function catchUpMs(automation) {
  if (automation.catchUp === undefined) return defaultCatchUp(automation.trigger);
  return durationMs(automation.catchUp) ?? 0;
}

/**
 * What to do with `count` times that came due in (from, now], the last one `latest`:
 * `{fire: "schedule" | "catch-up" | null, missed, skipped}`. Paused, they are all skipped.
 * After a gap (Herdr closed, the computer asleep) only the last one may still run, on time
 * or as a Catch-up; the others are Missed. Without a gap, times that piled up between two
 * ticks run once.
 */
export function decide({ count, latest, from, now, catchUp, paused }) {
  if (!count) return { fire: null, missed: 0, skipped: 0 };
  if (paused) return { fire: null, missed: 0, skipped: count };
  const late = now - latest;
  const fire = late <= GRACE_MS ? "schedule" : late <= catchUp ? "catch-up" : null;
  const gap = now - from > GRACE_MS;
  return { fire, missed: gap || !fire ? count - (fire ? 1 : 0) : 0, skipped: 0 };
}

/**
 * The engine of one mod copy. `lease` is `{get, set}` over Herdr's shared state, `id` this
 * copy's lease owner, `settings()` the current settings, `now()` the clock.
 */
export function createEngine({ store, host, lease, id, settings, now = Date.now }) {
  const ctx = { store, host, now, get settings() { return settings(); } };
  const gone = new Map();
  let busy = false;

  /** Whether this copy fires Runs: it holds a live lease, renewed at half its life, or takes a free one. */
  function leader() {
    const t = now(), l = lease.get();
    if (l && l.owner !== id && l.until > t) return false;
    if (!l || l.owner !== id || l.until - t < LEASE_MS / 2) lease.set({ owner: id, until: t + LEASE_MS });
    return lease.get()?.owner === id;
  }

  async function watchRuns() {
    const { runs } = await store.readState();
    for (const run of Object.values(runs)) {
      if (run.status === "starting") {
        if (now() - run.started > STARTING_MS) await finishRun(ctx, run, { status: "failed", reason: "Herdr stopped while the Run was starting" });
        continue;
      }
      const alive = host.alive(run.terminal);
      const looks = alive ? 0 : (gone.get(run.id) ?? 0) + 1;
      gone.set(run.id, looks);
      const obs = {
        alive: alive || looks < GONE_LOOKS,
        agent: run.kind === "agent" ? host.agentStatus(run.terminal) : null,
        exit: run.kind === "script" ? await store.readRunFile(run.id, "exit").catch(() => null) : null,
      };
      const change = observe(run, obs, now());
      if (!change) continue;
      if (ENDED.includes(change.status)) {
        gone.delete(run.id);
        await finishRun(ctx, run, change);
      } else await updateRun(ctx, run, change);
    }
  }

  async function record(a, status, reason, count, due) {
    const at = now();
    await store.appendHistory(event({ id: newRunId(at), automation: a.id, name: a.name, kind: a.kind, trigger: "schedule", due, started: at, ended: at, status, reason, count }, at));
  }

  async function fireDue(doc) {
    for (const a of doc.automations) {
      if (a.trigger.type !== "schedule") continue;
      const t = now();
      const from = (await store.readState()).checked[a.id];
      // A new Automation starts counting now; times before it existed are not Missed.
      const { count, latest } = from === undefined ? { count: 0, latest: null } : dueBetween(a.trigger, from, t);
      if (from !== undefined && !count) continue;
      await store.updateState((s) => ({ ...s, checked: { ...s.checked, [a.id]: t } }));
      const d = decide({ count, latest, from, now: t, catchUp: catchUpMs(a), paused: doc.paused || a.enabled === false });
      if (d.skipped) await record(a, "skipped", "paused", d.skipped, latest);
      if (d.missed) await record(a, "missed", d.missed > 1 ? `${d.missed} times passed while Herdr was closed or the computer slept` : "Passed while Herdr was closed or the computer slept", d.missed, latest);
      if (d.fire) await startRun(ctx, a, d.fire, latest);
    }
  }

  return {
    leader,
    /** One tick. Resolves whether this copy is the leader. Ticks never overlap. */
    async tick() {
      if (!leader()) return false;
      if (busy) return true;
      busy = true;
      try {
        const doc = await store.readAutomations();
        await watchRuns();
        await fireDue(doc);
      } finally {
        busy = false;
      }
      return true;
    },
    /** Run now. A Run of it still going makes this one skipped (overlap). */
    runNow: (automation) => startRun(ctx, automation, "manual"),
    /** Stop: ends the Run as stopped, then its terminal. */
    async stop(runId) {
      const run = (await store.readState()).runs[runId];
      if (!run) return null;
      const ended = await finishRun(ctx, run, { status: "stopped", reason: "Stopped from the panel" });
      if (run.terminal) host.kill(run.terminal);
      return ended;
    },
    /** Gives the lease up, so another copy takes over at its next tick. */
    release() {
      if (lease.get()?.owner === id) lease.set(null);
    },
  };
}
