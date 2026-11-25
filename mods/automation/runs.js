// The Run state machine and the steps that start and end a Run. Effects go through `host`
// (tabs, terminals, agents, toasts) and `store` (files), so tests drive it with fakes.
import { durationMs } from "./cron.js";
import { dayKey, SCRIPT_TIMEOUT_MAX } from "./store.js";
import { scriptArgv, shellRef, runScript, addWorktree, repoRoot, head } from "./shell.js";

/** A Run in one of these is still going. */
export const ACTIVE = ["starting", "running", "blocked"];
export const ENDED = ["ok", "failed", "timed out", "stopped", "closed"];
/** The label on the terminal of every Run's main step, so agents an Automation started are known. */
export const RUN_LABEL = "herdr.automation.run";
/**
 * A Run still "starting" this long after its Check and pre-script could have ended (`startBy`)
 * was cut off by a reload or a quit. It covers git fetch and worktree add.
 */
export const STARTING_MS = 5 * 60000;

export const isActive = (run) => ACTIVE.includes(run?.status);

const FAILURES = ["failed", "timed out", "blocked"], SKIPS = ["skipped", "missed"];
const LEVELS = { failures: FAILURES, "failures-and-skips": [...FAILURES, ...SKIPS], all: [...FAILURES, ...SKIPS, "ok", "stopped", "closed"], never: [] };
/** Whether notification level `level` (the setting; unknown reads as "failures") posts a toast for a Run that became `status`. */
export const notifies = (level, status) => (LEVELS[level] ?? LEVELS.failures).includes(status);

const TOAST_LEVELS = { failed: "error", "timed out": "error", blocked: "warning", skipped: "warning", missed: "warning", ok: "success" };
/** A toast for `run` becoming `status`, when the settings' level asks for one; a click goes to `terminal`. */
export function toast({ host, settings }, run, status, reason, terminal = null) {
  if (!notifies(settings.notifications, status)) return;
  host.notify({ title: `${run.name}: ${status}`, body: reason ?? "", level: TOAST_LEVELS[status] ?? "info", terminal, blocked: status === "blocked" });
}

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

/** The variables of prompts, commands and inline scripts. */
export const VARIABLES = ["pre", "check", "folder", "trigger", "commit", "branch", "date", "result_file", "run_dir"];
/** The environment variable that carries variable `name` to scripts. */
export const envName = (name) => `HERDR_AUTO_${name.toUpperCase()}`;
/** The longest {pre} or {check} value passed on, so it fits in an argv. */
export const VALUE_MAX = 64 * 1024;
const RESULT_MAX = 8 * 1024;
/** The result file, in the Run's out/ folder. */
export const RESULT_FILE = "result.md";
/** The timeout of a Check, pre- or post-script without one, in seconds. */
const SCRIPT_TIMEOUT = 60;

/** `text` with each {variable} replaced by `value(name)`; other braces stay as they are. */
export const expand = (text, value) => text.replace(/\{(\w+)\}/g, (m, k) => (VARIABLES.includes(k) ? value(k) : m));
// In shell text a variable becomes a quoted reference to its environment variable, so a value
// with quotes or $(...) arrives as data and never runs.
const expandShell = (text) => expand(text, (k) => shellRef(envName(k)));

/** The HERDR_AUTO_* environment of a Run's scripts. */
export const runEnv = (vars, run) => ({
  ...Object.fromEntries(VARIABLES.map((k) => [envName(k), String(vars[k] ?? "")])),
  HERDR_AUTO_NAME: run.name,
  HERDR_AUTO_RUN_ID: run.id,
});

/**
 * The main step's tab: `{argv, task}`. An agent is its knownAgents() entry's `run`, then
 * `--add-dir {run_dir}` for Claude Code, `--model` when set, then the extra args, with the
 * prompt as the tab's first message. A script gets the Run's environment.
 */
export function mainStep(automation, { agents, settings, exitFile, vars = {}, env }) {
  if (automation.kind === "script") return { argv: scriptArgv(expandShell(automation.command), exitFile, env) };
  const key = automation.agent || settings.agent;
  const entry = agents.find((a) => a.key === key);
  if (!entry) throw new Error(`The agent "${key}" is not one of Herdr's programs`);
  if (entry.installed === false) throw new Error(`${entry.name ?? key} is not installed`);
  return {
    argv: [
      ...entry.run,
      ...(key === "claude" && vars.run_dir ? ["--add-dir", vars.run_dir] : []),
      ...(automation.model ? ["--model", automation.model] : []),
      ...(automation.args ?? []),
    ],
    task: expand(automation.prompt, (k) => String(vars[k] ?? "")),
  };
}

/**
 * Where a Run of `automation` works: its `workspace`, else a worktree for an agent in a git
 * repository. An agent-status Trigger defaults to the folder, so the Run sees that agent's work.
 */
export async function workspaceOf(exec, automation) {
  if (automation.workspace) return automation.workspace;
  if (automation.trigger?.type === "agent") return "folder";
  return automation.kind === "agent" && (await repoRoot(exec, automation.folder)) ? "worktree" : "folder";
}

const scriptMs = (s) => (s ? Math.min(s.timeout ?? SCRIPT_TIMEOUT, SCRIPT_TIMEOUT_MAX) * 1000 : 0);
const firstLine = (r) => (r.stdout.trim() || r.stderr.trim()).split("\n")[0].trim();

// Runs the Check, pre- or post-script `step` of a Run and saves its output in the Run's folder
// (<step>.txt for stdout, <step>.err.txt for stderr). A relative file is in the Automation's `folder`.
async function runStepScript({ host, store }, run, step, script, { cwd, folder, vars, extra }) {
  const spec = script.inline != null
    ? { inline: expandShell(script.inline) }
    : { file: script.file.startsWith("/") ? script.file : `${folder}/${script.file}` };
  const r = await runScript(host.exec, spec, {
    cwd,
    env: { ...runEnv(vars, run), ...extra },
    timeout: scriptMs(script),
  });
  await store.writeRunFile(run.id, `${step}.txt`, r.stdout);
  if (r.stderr) await store.writeRunFile(run.id, `${step}.err.txt`, r.stderr);
  return { ...r, value: r.stdout.replace(/\n+$/, "").slice(0, VALUE_MAX), line: firstLine(r) };
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
  const { id, automation, name, kind, trigger, due, started, ended, status, reason, count, space, tab, terminal, worktree, branch } = run;
  return { at, run: id, automation, name, kind, trigger, due, started, ended, status, reason, count, space, tab, terminal, worktree, branch };
};

const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "automation";

/**
 * Starts a Run of `automation` set off by `trigger` ("schedule", "catch-up", "manual", or the
 * words of an agent-status or git firing), for the time `due`: Check, pre-script, workspace,
 * then the main step in a tab. `fired.folder` (the agent's folder) replaces the Automation's
 * folder; `fired.commit` (a git firing) is {commit} and a worktree's base. A previous
 * Run still going makes it a skipped Run (overlap). The Run is in state.json from its first
 * step, so a reload never starts it twice.
 */
export async function startRun(ctx, automation, trigger, due = null, fired = {}) {
  const { host, store, settings, now } = ctx;
  const run = {
    id: newRunId(now()), automation: automation.id, name: automation.name, kind: automation.kind, trigger, due, started: now(), status: "starting",
    startBy: now() + STARTING_MS + scriptMs(automation.check) + scriptMs(automation.pre),
  };
  let overlap = false;
  await store.updateState((s) => {
    overlap = Object.values(s.runs).some((r) => r.automation === automation.id && isActive(r));
    return overlap ? s : { ...s, runs: { ...s.runs, [run.id]: run } };
  });
  if (overlap) {
    const skipped = { ...run, status: "skipped", reason: "overlap", ended: now() };
    await store.appendHistory(event(skipped, now()));
    toast(ctx, skipped, "skipped", "The previous Run is still going");
    return skipped;
  }
  let current = run;
  try {
    await store.writeRunFile(run.id, "automation.json", JSON.stringify(automation, null, 2));
    const runDir = store.runDir(run.id), outDir = store.outDir(run.id);
    await store.writeRunFile(run.id, `out/${RESULT_FILE}`, "");
    const folder = fired.folder ?? automation.folder;
    const vars = { folder, trigger, date: dayKey(now()), run_dir: outDir, result_file: `${outDir}/${RESULT_FILE}`, pre: "", check: "", commit: "", branch: "" };
    const before = { cwd: folder, folder: automation.folder, vars };
    if (automation.check) {
      const r = await runStepScript(ctx, run, "check", automation.check, before);
      if (r.code !== 0) return finishRun(ctx, run, { status: "skipped", reason: r.line || `The Check exited with code ${r.code}` });
      vars.check = r.value;
    }
    if (automation.pre) {
      const r = await runStepScript(ctx, run, "pre", automation.pre, before);
      if (r.code !== 0) return finishRun(ctx, run, { status: "failed", reason: `Pre-script: ${r.line || `exit code ${r.code}`}` });
      vars.pre = r.value;
    }
    if ((await workspaceOf(host.exec, automation)) === "worktree") {
      const wt = { ...(await addWorktree(host.exec, { folder, base: fired.commit ?? automation.base, dir: await host.worktreesDir(), name: `${slug(automation.name)}-${run.id}` })), created: now() };
      // Registered at once, so the purge finds it even when the Run fails after this.
      await store.updateState((s) => ({ ...s, worktrees: { ...s.worktrees, [run.id]: wt } }));
      vars.folder = wt.path;
      current = { ...current, worktree: wt.path };
    }
    Object.assign(vars, await head(host.exec, vars.folder), fired.commit ? { commit: fired.commit } : {});
    current = { ...current, folder: vars.folder, branch: vars.branch || undefined, commit: vars.commit || undefined };
    const step = mainStep(automation, {
      agents: automation.kind === "agent" ? await host.knownAgents() : [],
      settings, exitFile: `${runDir}/exit`, vars, env: runEnv(vars, run),
    });
    const opened = await host.openTab({ space: settings.space, name: automation.name, folder: vars.folder, ...step });
    // A missing label only weakens the agent-status loop guard; the Run itself goes on.
    await host.label(opened.terminal, RUN_LABEL, run.id).catch(() => {});
    // {pre} and {check} stay in their files; the post-script reads them back.
    const { pre, check, ...kept } = vars;
    // What the end of the Run decides on is kept here, never read back from a file an agent may write.
    const going = { ...current, ...opened, vars: kept, status: "running", deadline: now() + timeoutMs(automation, settings),
      home: automation.folder, post: automation.post, requireResult: automation.requireResult === true };
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
    return finishRun(ctx, current, { status: "failed", reason: e?.message ?? String(e) });
  }
}

// After the main step: requireResult, then the post-script where the Run worked. Resolves the
// change to the ended Run, or null.
async function afterMainStep(ctx, ended) {
  const { store } = ctx;
  const result = (await store.readRunFile(ended.id, `out/${RESULT_FILE}`).catch(() => null)) ?? "";
  let change = null;
  if (ended.requireResult && ended.status === "ok" && !result.trim()) change = { status: "failed", reason: "The Run ended without a result file" };
  if (!ended.post) return change;
  const status = change?.status ?? ended.status, reason = change?.reason ?? ended.reason ?? "";
  const [pre, check] = await Promise.all(["pre", "check"].map((s) => store.readRunFile(ended.id, `${s}.txt`).catch(() => null)));
  const vars = { ...ended.vars, pre: (pre ?? "").replace(/\n+$/, "").slice(0, VALUE_MAX), check: (check ?? "").replace(/\n+$/, "").slice(0, VALUE_MAX) };
  const r = await runStepScript(ctx, ended, "post", ended.post, {
    cwd: ended.folder, folder: ended.home, vars,
    extra: {
      HERDR_AUTO_STATUS: status, HERDR_AUTO_REASON: reason, HERDR_AUTO_RESULT: result.slice(0, RESULT_MAX),
      HERDR_AUTO_TAIL_FILE: `${store.runDir(ended.id)}/tail.txt`, HERDR_AUTO_TERMINAL: ended.terminal ?? "",
    },
  });
  if (r.code === 0 || status !== "ok") return change;
  return { status: "failed", reason: `Post-script: ${r.line || `exit code ${r.code}`}` };
}

/**
 * Ends a Run with `change` (`{status, reason}`): saves its terminal's tail, moves it from
 * `runs` to `last` in state.json, ends a stopped Run's terminal, and when the main step ran,
 * applies requireResult and runs the post-script; then writes its history line and posts a
 * toast when the notification level asks for one. Resolves the ended Run, or null when another copy ended it first.
 */
export async function finishRun(ctx, run, change) {
  const { host, store, now } = ctx;
  let ended = { ...run, ...change, ended: now() };
  if (run.terminal) {
    const tail = await host.tail(run.terminal).catch(() => null);
    if (tail) await store.writeRunFile(run.id, "tail.txt", tail).catch(() => {});
  }
  let mine = false;
  const setLast = (s, value) => {
    // A Run that never opened a tab keeps the previous Run's, so that tab is still the one
    // the next Run closes and Go to tab shows.
    const prev = s.last[run.automation];
    const last = value.tab || !prev?.tab || prev.status === "timed out" ? value : { ...value, space: prev.space, tab: prev.tab };
    return { ...s, last: { ...s.last, [run.automation]: last } };
  };
  await store.updateState((s) => {
    mine = Boolean(s.runs[run.id]);
    if (!mine) return s;
    const runs = { ...s.runs };
    delete runs[run.id];
    return setLast({ ...s, runs }, ended);
  });
  if (!mine) return null;
  if (ended.status === "stopped" && run.terminal) host.kill(run.terminal);
  if (run.terminal) {
    const after = await afterMainStep(ctx, ended).catch((e) => ({ status: "failed", reason: `Post-script: ${e?.message ?? e}` }));
    if (after) {
      ended = { ...ended, ...after };
      await store.updateState((s) => (s.last[run.automation]?.id === run.id ? setLast(s, ended) : s));
    }
  }
  await store.appendHistory(event(ended, now()));
  toast(ctx, run, ended.status, ended.reason, host.alive(run.terminal) ? run.terminal : null);
  return ended;
}

/** Records a change of a going Run that does not end it (blocked, working again, first seen). */
export async function updateRun(ctx, run, change) {
  const { store, now } = ctx;
  const next = { ...run, ...change };
  await store.updateState((s) => (s.runs[run.id] ? { ...s, runs: { ...s.runs, [run.id]: next } } : s));
  if (change.status && change.status !== run.status) await store.appendHistory(event(next, now()));
  if (change.status === "blocked" && run.status !== "blocked") toast(ctx, run, "blocked", "The agent needs you.", run.terminal);
  return next;
}
