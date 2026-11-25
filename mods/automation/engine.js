// The tick: leader lease, Runs going, due schedule Triggers, Catch-up, Missed, agent-status and
// git Triggers, pauses and the purge of old worktrees. Starting and ending a Run (scripts, git,
// tabs) go on beside the tick, so one slow step never holds the others or the lease.
// The engine keeps nothing that matters in memory: Runs going and the last instant checked
// per Automation are in state.json, so the next engine after a reload carries on.
import { dueBetween, defaultCatchUp, durationMs } from "./cron.js";
import { startRun, finishRun, updateRun, observe, newRunId, event, toast, ms, ENDED, STARTING_MS } from "./runs.js";
import { dayKey } from "./store.js";
import { inspectWorktree, removeWorktree } from "./shell.js";
import { agentFirings, gitHead, gitFiring } from "./triggers.js";

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

/** How often the tick looks for worktrees to purge. */
export const PURGE_MS = 10 * 60000;
/** How often a local git Trigger looks at its checkout. */
export const LOCAL_GIT_MS = 30000;

/**
 * What the purge does with worktree `wt` (`{created}`) as `seen` (`{exists, dirty}`), with
 * `retention` in ms: "keep" while it is young, "review" when it is old and dirty (never
 * removed), else "remove".
 */
export function purgeDecision(wt, seen, now, retention) {
  if (now - wt.created < retention) return "keep";
  return seen.exists && seen.dirty ? "review" : "remove";
}

/**
 * Removes the worktrees of ended Runs older than the settings' worktreeRetention when they are
 * clean, with their branch when it has no commits of its own; marks dirty ones for review.
 * The registry is `worktrees` in state.json, by Run id.
 */
export async function purgeWorktrees(ctx) {
  const { host, store, settings, now } = ctx;
  const retention = ms(settings, "worktreeRetention");
  const { worktrees, runs } = await store.readState();
  for (const [id, wt] of Object.entries(worktrees)) {
    if (runs[id]) continue;
    const seen = await inspectWorktree(host.exec, wt);
    const d = purgeDecision(wt, seen, now(), retention);
    if (d === "keep" || (d === "review" && wt.review)) continue;
    if (d === "remove" && (await removeWorktree(host.exec, wt, { deleteBranch: seen.commits === 0 }))) continue;
    await store.updateState(d === "review"
      ? (s) => (s.worktrees[id] ? { ...s, worktrees: { ...s.worktrees, [id]: { ...wt, review: true } } } : s)
      : forgetWorktree(id));
  }
}

// The state.json update that drops worktree `id` from the registry.
const forgetWorktree = (id) => (s) => {
  if (!s.worktrees[id]) return s;
  const worktrees = { ...s.worktrees };
  delete worktrees[id];
  return { ...s, worktrees };
};

// "20261125-093000-k3f9" → "2026-11-25"; null for a folder that is not a Run's.
const runDay = (id) => (/^\d{8}-/.test(id) ? `${id.slice(0, 4)}-${id.slice(4, 6)}-${id.slice(6, 8)}` : null);

/**
 * Removes the history days and run folders older than the settings' historyRetention, by day.
 * The folder of a Run still going, or whose worktree is still registered, stays.
 */
export async function purgeOld(ctx) {
  const { store, settings, now } = ctx;
  const cutoff = dayKey(now() - ms(settings, "historyRetention"));
  const { runs, worktrees } = await store.readState();
  for (const day of await store.historyDays()) if (day < cutoff) await store.removeHistoryDay(day);
  for (const id of await store.runIds()) {
    const day = runDay(id);
    if (day && day < cutoff && !runs[id] && !worktrees[id]) await store.removeRun(id);
  }
}

/**
 * The engine of one mod copy. `lease` is `{get, set}` over Herdr's shared state, `id` this
 * copy's lease owner, `settings()` the current settings, `now()` the clock.
 */
export function createEngine({ store, host, lease, id, settings, now = Date.now }) {
  const ctx = { store, host, now, get settings() { return settings(); } };
  const gone = new Map(), polled = new Map();
  // Work going on beside the tick, by key: one start per firing, one end per Run, one git look
  // per Automation, the purge. A failure is reported by the next tick.
  const work = new Map();
  let busy = false, purged = -Infinity, seq = 0, failure = null, agentsSeen = null;
  const spawn = (key, fn) => {
    if (work.has(key)) return;
    work.set(key, Promise.resolve().then(fn).catch((e) => { failure ??= e; }).finally(() => work.delete(key)));
  };
  // Every firing starts on its own; the overlap rule in startRun decides between them.
  const start = (a, trigger, due, fired) => spawn(`start:${seq++}`, () => startRun(ctx, a, trigger, due, fired));
  const stop = (run) => spawn(`end:${run.id}`, () => finishRun(ctx, run, { status: "stopped", reason: "Stopped from the panel" }));
  const paused = (doc, a) => doc.paused || a.enabled === false;

  /** Whether this copy fires Runs: it holds a live lease, renewed at half its life, or takes a free one. */
  function leader() {
    const t = now(), l = lease.get();
    if (l && l.owner !== id && l.until > t) {
      // Agent statuses seen before losing the lease would be stale when it comes back.
      agentsSeen = null;
      return false;
    }
    if (!l || l.owner !== id || l.until - t < LEASE_MS / 2) lease.set({ owner: id, until: t + LEASE_MS });
    return lease.get()?.owner === id;
  }

  // `look`: one host.look() of the tick, `{terminals, agents}`.
  async function watchRuns(state, look) {
    for (const run of Object.values(state.runs)) {
      if (work.has(`end:${run.id}`)) continue;
      // startRun moves startBy on after each step, so only a start cut off by a reload or a quit passes it.
      if (run.status === "starting") {
        if (now() > (run.startBy ?? run.started + STARTING_MS)) await finishRun(ctx, run, { status: "failed", reason: "Herdr stopped while the Run was starting" });
        continue;
      }
      const alive = look.terminals.has(run.terminal);
      const looks = alive ? 0 : (gone.get(run.id) ?? 0) + 1;
      gone.set(run.id, looks);
      const obs = {
        alive: alive || looks < GONE_LOOKS,
        gone: !alive,
        agent: run.kind === "agent" ? look.agents.find((a) => a.address === run.terminal)?.status ?? null : null,
        exit: run.kind === "script" ? await store.readRunFile(run.id, "exit").catch(() => null) : null,
      };
      const change = observe(run, obs, now());
      if (!change) continue;
      if (ENDED.includes(change.status)) {
        gone.delete(run.id);
        spawn(`end:${run.id}`, () => finishRun(ctx, run, change));
      } else await updateRun(ctx, run, change);
    }
  }

  async function record(a, status, reason, count, due, trigger = "schedule") {
    const at = now();
    await store.appendHistory(event({ id: newRunId(at), automation: a.id, name: a.name, kind: a.kind, trigger, due, started: at, ended: at, status, reason, count }, at));
    toast(ctx, a, status, reason);
  }

  async function fireDue(doc, state) {
    for (const a of doc.automations) {
      if (a.trigger.type !== "schedule") continue;
      const t = now();
      // Only this tick writes checked[a.id], so the tick's snapshot of it is current.
      const from = state.checked[a.id];
      // A new Automation starts counting now; times before it existed are not Missed.
      const { count, latest } = from === undefined ? { count: 0, latest: null } : dueBetween(a.trigger, from, t);
      if (from !== undefined && !count) continue;
      await store.updateState((s) => ({ ...s, checked: { ...s.checked, [a.id]: t } }));
      const d = decide({ count, latest, from, now: t, catchUp: catchUpMs(a), paused: paused(doc, a) });
      if (d.skipped) await record(a, "skipped", "paused", d.skipped, latest);
      if (d.missed) await record(a, "missed", d.missed > 1 ? `${d.missed} times passed while Herdr was closed or the computer slept` : "Passed while Herdr was closed or the computer slept", d.missed, latest);
      if (d.fire) start(a, d.fire, latest);
    }
  }

  // A firing while paused is recorded as skipped and never replayed.
  async function fire(doc, a, trigger, fired) {
    if (paused(doc, a)) await record(a, "skipped", "paused", 1, null, trigger);
    else start(a, trigger, null, fired);
  }

  async function fireAgents(doc, look) {
    const r = agentFirings({ seen: agentsSeen, agents: look.agents, automations: doc.automations });
    agentsSeen = r.seen;
    for (const { automation, agent, status } of r.firings)
      await fire(doc, automation, `agent ${agent.address} ${status}`, agent.folder ? { folder: agent.folder } : {});
  }

  // A local Trigger looks every LOCAL_GIT_MS; a remote one at gitPollInterval. The commit seen is
  // in state.json, with the error of a failing look until one succeeds.
  function fireGit(doc) {
    const remoteEvery = ms(settings(), "gitPollInterval");
    for (const a of doc.automations) {
      if (a.trigger.type !== "git") continue;
      const remote = a.trigger.source === "remote";
      if (now() - (polled.get(a.id) ?? -Infinity) < (remote ? remoteEvery : LOCAL_GIT_MS)) continue;
      spawn(`git:${a.id}`, async () => {
        polled.set(a.id, now());
        let seen, error = null;
        try { seen = await gitHead(host.exec, a); } catch (e) { error = e?.message ?? String(e); }
        let last;
        await store.updateState((s) => {
          last = s.commits[a.id];
          const next = error ? { ...last, error } : { commit: seen.commit, branch: seen.branch };
          if (JSON.stringify(next) === JSON.stringify(last)) return s;
          return { ...s, commits: { ...s.commits, [a.id]: next } };
        });
        const commit = error ? null : gitFiring(last, seen);
        // The worktree must fetch the remote the commit is on.
        const fired = remote ? { commit, remote: a.trigger.branch.slice(0, a.trigger.branch.indexOf("/")) } : { commit };
        if (commit) await fire(doc, a, `git ${commit.slice(0, 7)}${seen.branch ? ` on ${seen.branch}` : ""}`, fired);
      });
    }
  }

  // Run now and Stop that copies wrote in state.json for the leader, since a copy in the dialog
  // is cancelled soon after the dialog closes.
  async function takeRequests(doc, state) {
    const ids = Object.keys(state.requests);
    if (!ids.length) return;
    let taken = [];
    await store.updateState((s) => {
      taken = ids.filter((k) => s.requests[k]).map((k) => s.requests[k]);
      const requests = { ...s.requests };
      for (const k of ids) delete requests[k];
      return taken.length ? { ...s, requests } : s;
    });
    for (const r of taken) {
      const a = doc.automations.find((x) => x.id === r.automation), run = state.runs[r.run];
      if (r.type === "run" && a) start(a, "manual");
      if (r.type === "stop" && run) stop(run);
    }
  }

  const ask = (request) => store.updateState((s) => ({ ...s, requests: { ...s.requests, [newRunId(now())]: request } }));

  return {
    leader,
    /** One tick. Resolves whether this copy is the leader. Ticks never overlap. */
    async tick() {
      if (!leader()) return false;
      if (busy) return true;
      busy = true;
      try {
        const [doc, state] = await Promise.all([store.readAutomations(), store.readState()]);
        const look = host.look();
        await watchRuns(state, look);
        await takeRequests(doc, state);
        await fireDue(doc, state);
        await fireAgents(doc, look);
        fireGit(doc);
        if (now() - purged >= PURGE_MS) {
          purged = now();
          spawn("purge", async () => {
            await purgeWorktrees(ctx);
            await purgeOld(ctx);
          });
        }
      } finally {
        busy = false;
      }
      if (failure) {
        const e = failure;
        failure = null;
        throw e;
      }
      return true;
    },
    /** Resolves once the work going on beside the tick (starting and ending Runs, git looks) is done. */
    async idle() {
      while (work.size) await Promise.all(work.values());
    },
    /** Run now, here. A Run of it still going makes this one skipped (overlap). */
    runNow: (automation) => startRun(ctx, automation, "manual"),
    /** Stop, here: ends the Run as stopped, and its terminal. */
    async stop(runId) {
      const run = (await store.readState()).runs[runId];
      return run ? finishRun(ctx, run, { status: "stopped", reason: "Stopped from the panel" }) : null;
    },
    /** Run now from any copy: asks the leader, whose next tick starts it. */
    askRun: (automation) => ask({ type: "run", automation: automation.id, at: now() }),
    /** Stop from any copy: takes back a Run now the leader has not started yet, else asks the leader to stop Run `runId`. */
    async askStop(runId) {
      let asked = false;
      await store.updateState((s) => {
        if (!s.requests[runId]) return s;
        asked = true;
        const requests = { ...s.requests };
        delete requests[runId];
        return { ...s, requests };
      });
      if (!asked) await ask({ type: "stop", run: runId, at: now() });
    },
    /** The worktree of Run `runId` still registered, with `exists`, `dirty` and `commits`; null when there is none. */
    async worktree(runId) {
      const wt = (await store.readState()).worktrees[runId];
      return wt ? { ...wt, ...(await inspectWorktree(host.exec, wt)) } : null;
    },
    /** Remove worktree from the panel: with its changes, and its branch when it has no commits of its own. */
    async removeWorktree(runId) {
      const wt = (await store.readState()).worktrees[runId];
      if (!wt) return;
      const { commits } = await inspectWorktree(host.exec, wt);
      const error = await removeWorktree(host.exec, wt, { force: true, deleteBranch: commits === 0 });
      if (error) throw new Error(error);
      await store.updateState(forgetWorktree(runId));
    },
    /** Gives the lease up, so another copy takes over at its next tick. */
    release() {
      if (lease.get()?.owner === id) lease.set(null);
    },
  };
}
