// The Run state machine and the steps that start and end a Run. Effects go through `host`
// (tabs, terminals, agents, toasts) and `store` (files), so tests drive it with fakes.
import { durationMs } from "./cron.js";
import { scriptArgv } from "./shell.js";

/** A Run in one of these is still going. */
export const ACTIVE = ["starting", "running", "blocked"];
export const ENDED = ["ok", "failed", "timed out", "stopped", "closed"];
/** The label on the terminal of every Run's main step, so agents an Automation started are known. */
export const RUN_LABEL = "herdr.automation.run";
/** A Run still "starting" after this long was cut off by a reload or a quit. */
export const STARTING_MS = 2 * 60000;

export const isActive = (run) => ACTIVE.includes(run?.status);

const pad = (n) => String(n).padStart(2, "0");
/** "20261125-093000-k3f9": sortable, and safe as a folder name and a label value. */
export function newRunId(now, random = Math.random) {
  const d = new Date(now);
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${stamp}-${Math.floor(random() * 36 ** 4).toString(36).padStart(4, "0")}`;
}

/** The timeout of an Automation's Runs in ms: its own `timeout` (minutes), else the setting for its kind. */
export function timeoutMs(automation, settings) {
  if (automation.timeout > 0) return automation.timeout * 60000;
  const agent = automation.kind === "agent";
  return durationMs(agent ? settings.agentTimeout : settings.scriptTimeout) ?? (agent ? 60 : 10) * 60000;
}

/**
 * The main step's tab: `{argv, task}`. An agent is its knownAgents() entry's `run`, then
 * `--model` when set, then the extra args, with the prompt as the tab's first message.
 */
export function mainStep(automation, { agents, settings, exitFile }) {
  if (automation.kind === "script") return { argv: scriptArgv(automation.command, exitFile) };
  const key = automation.agent || settings.agent;
  const entry = agents.find((a) => a.key === key);
  if (!entry) throw new Error(`The agent "${key}" is not one of Herdr's programs`);
  if (entry.installed === false) throw new Error(`${entry.name ?? key} is not installed`);
  return {
    argv: [...entry.run, ...(automation.model ? ["--model", automation.model] : []), ...(automation.args ?? [])],
    task: automation.prompt,
  };
}

/**
 * What a going Run becomes after one look at its terminal: the fields that change, or null.
 * `obs`: `{alive}` (the terminal still exists), `agent` (its agents() status or null) and
 * `exit` (a script's exit code file, or null).
 */
export function observe(run, obs, now) {
  if (run.kind === "script" && obs.exit != null && String(obs.exit).trim() !== "") {
    const code = String(obs.exit).trim();
    return code === "0" ? { status: "ok" } : { status: "failed", reason: `Exit code ${code}` };
  }
  if (!obs.alive) return { status: "closed", reason: "The tab was closed" };
  if (now >= run.deadline) return { status: "timed out", reason: `No end after ${Math.round((run.deadline - run.started) / 60000)} min` };
  if (run.kind !== "agent") return null;
  const s = obs.agent;
  if (s === "blocked") return run.status === "blocked" ? null : { status: "blocked", seen: true, sawWork: true };
  if (s === "working") return run.status === "running" && run.sawWork ? null : { status: "running", seen: true, sawWork: true };
  // "done" is a finished turn; "idle" too once someone has looked, but only after it worked,
  // since a new agent is idle before its first message arrives.
  if (s === "done" || (s === "idle" && run.sawWork)) return { status: "ok" };
  if (s === null && run.seen) return { status: "failed", reason: "The agent exited" };
  if (s && !run.seen) return { seen: true };
  return null;
}

/** The history line of `run` at `at`. */
export const event = (run, at) => {
  const { id, automation, name, kind, trigger, due, started, ended, status, reason, count, space, tab, terminal } = run;
  return { at, run: id, automation, name, kind, trigger, due, started, ended, status, reason, count, space, tab, terminal };
};

/**
 * Starts a Run of `automation` set off by `trigger` ("schedule", "catch-up" or "manual",
 * for the time `due`). A previous Run still going makes it a skipped Run (overlap).
 * The Run is in state.json from its first step, so a reload never starts it twice.
 */
export async function startRun(ctx, automation, trigger, due = null) {
  const { host, store, settings, now } = ctx;
  const run = { id: newRunId(now()), automation: automation.id, name: automation.name, kind: automation.kind, trigger, due, started: now(), status: "starting" };
  let overlap = false;
  await store.updateState((s) => {
    overlap = Object.values(s.runs).some((r) => r.automation === automation.id && isActive(r));
    return overlap ? s : { ...s, runs: { ...s.runs, [run.id]: run } };
  });
  if (overlap) {
    const skipped = { ...run, status: "skipped", reason: "overlap", ended: now() };
    await store.appendHistory(event(skipped, now()));
    return skipped;
  }
  try {
    await store.writeRunFile(run.id, "automation.json", JSON.stringify(automation, null, 2));
    // Slice 1 runs every Run in the folder as it is: "worktree" is treated as "folder" here
    // until worktree Runs exist.
    const folder = automation.folder;
    const step = mainStep(automation, { agents: automation.kind === "agent" ? await host.knownAgents() : [], settings, exitFile: `${store.runDir(run.id)}/exit` });
    const opened = await host.openTab({ space: settings.space, name: automation.name, folder, ...step });
    // A missing label only weakens the agent-status loop guard; the Run itself goes on.
    await host.label(opened.terminal, RUN_LABEL, run.id).catch(() => {});
    const going = { ...run, ...opened, folder, status: "running", deadline: now() + timeoutMs(automation, settings) };
    let previous = null;
    await store.updateState((s) => {
      previous = s.last[automation.id] ?? null;
      return { ...s, runs: { ...s.runs, [run.id]: going } };
    });
    await store.appendHistory(event(going, now()));
    // One live tab per Automation. A timed-out Run's tab stays: its program may still be at work.
    if (previous?.tab && previous.tab !== opened.tab && previous.status !== "timed out") host.closeTab(previous.tab);
    return going;
  } catch (e) {
    return finishRun(ctx, run, { status: "failed", reason: e?.message ?? String(e) });
  }
}

/**
 * Ends a going Run with `change` (`{status, reason}`): saves its terminal's tail, moves it
 * from `runs` to `last` in state.json, writes its history line and posts a toast on failure.
 * Resolves the ended Run, or null when another copy ended it first.
 */
export async function finishRun(ctx, run, change) {
  const { host, store, now } = ctx;
  const ended = { ...run, ...change, ended: now() };
  if (run.terminal) {
    const tail = await host.tail(run.terminal).catch(() => null);
    if (tail) await store.writeRunFile(run.id, "tail.txt", tail).catch(() => {});
  }
  let mine = false;
  await store.updateState((s) => {
    mine = Boolean(s.runs[run.id]);
    if (!mine) return s;
    const runs = { ...s.runs };
    delete runs[run.id];
    return { ...s, runs, last: { ...s.last, [run.automation]: ended } };
  });
  if (!mine) return null;
  await store.appendHistory(event(ended, now()));
  if (ended.status === "failed" || ended.status === "timed out")
    host.notify({ title: `${run.name}: ${ended.status}`, body: ended.reason ?? "", level: "error", terminal: host.alive(run.terminal) ? run.terminal : null });
  return ended;
}

/** Records a change of a going Run that does not end it (blocked, working again, first seen). */
export async function updateRun(ctx, run, change) {
  const { host, store, now } = ctx;
  const next = { ...run, ...change };
  await store.updateState((s) => (s.runs[run.id] ? { ...s, runs: { ...s.runs, [run.id]: next } } : s));
  if (change.status && change.status !== run.status) await store.appendHistory(event(next, now()));
  if (change.status === "blocked" && run.status !== "blocked")
    host.notify({ title: `${run.name}: blocked`, body: "The agent needs you.", level: "warning", terminal: run.terminal, blocked: true });
  return next;
}
