// The data folder (ADR 2): automations.json, state.json, history/<YYYY-MM-DD>.jsonl and
// runs/<run id>/. File access comes in as `io` ({readTextFile, writeTextFile, mkdir, readdir, unlink, rmdir},
// Herdr's or node's), so tests run on a temporary folder.
import { compile, durationMs, pad } from "./cron.js";

/** The longest a Check, pre- or post-script may take, in seconds. */
export const SCRIPT_TIMEOUT_MAX = 600;

const KINDS = ["agent", "script"];
const TRIGGERS = ["schedule", "manual", "agent", "git"];
// "origin/main": a remote name, a slash, a branch; neither part may read as a git option.
const REMOTE_BRANCH = /^[A-Za-z0-9._][A-Za-z0-9._-]*\/[A-Za-z0-9._][^\s~^:?*\[\\]*$/;
const WORKSPACES = ["worktree", "folder"];
const ID = /^[A-Za-z0-9_-]{1,64}$/;
/** The fields of an entry of automations.json; automations.schema.json names the same (tests/schema.test.js). */
export const AUTOMATION_FIELDS = ["id", "name", "enabled", "kind", "folder", "trigger", "agent", "model", "args", "prompt", "command", "workspace", "base", "check", "pre", "post", "timeout", "catchUp", "requireResult"];
/** The fields of each Trigger type. */
export const TRIGGER_FIELDS = { manual: ["type"], schedule: ["type", "preset", "minutes", "at", "days", "cron"], agent: ["type", "status", "inFolder", "app"], git: ["type", "source", "branch"] };
/** The fields of a Check, pre- or post-script. */
export const SCRIPT_FIELDS = ["file", "inline", "timeout"];
/** The optional scripts of an Automation, in pipeline order. */
export const STEP_KEYS = ["check", "pre", "post"];
/** The agent statuses an agent-status Trigger can wait for. */
export const AGENT_STATUSES = ["done", "blocked"];
// A misspelt optional field would otherwise be ignored without a word.
const unknown = (o, known) => Object.keys(o).find((k) => !known.includes(k));
/** state.json when it is missing. */
export const EMPTY_STATE = { checked: {}, runs: {}, last: {}, tabs: {}, worktrees: {}, commits: {}, requests: {} };
const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
/** Local "YYYY-MM-DD" of instant `t`. */
export const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v) => typeof v === "string" && v.trim() !== "";
const optional = (v, ok) => v === undefined || v === null || ok(v);

// A Check, pre- or post-script: {file} or {inline}, and an optional timeout in seconds.
function scriptError(s) {
  if (s === undefined || s === null) return null;
  if (unknown(s, SCRIPT_FIELDS)) return `has an unknown field "${unknown(s, SCRIPT_FIELDS)}"`;
  if (text(s.file) === text(s.inline)) return 'needs either "file" (a path) or "inline" (shell text)';
  if (s.file !== undefined && !text(s.file)) return "file must be a path";
  if (s.inline !== undefined && !text(s.inline)) return "inline must be shell text";
  if (!optional(s.timeout, (v) => Number.isInteger(v) && v > 0 && v <= SCRIPT_TIMEOUT_MAX)) return `timeout must be whole seconds from 1 to ${SCRIPT_TIMEOUT_MAX}`;
  return null;
}

/**
 * Checks one entry of automations.json, which people edit by hand. Returns the error in words,
 * or null when the entry can run.
 */
export function automationError(a) {
  if (!isObject(a)) return "is not an object";
  if (typeof a.id !== "string" || !ID.test(a.id)) return "needs an id of letters, digits, - or _";
  if (!text(a.name)) return "needs a name";
  if (!KINDS.includes(a.kind)) return 'kind must be "agent" or "script"';
  if (!text(a.folder) || !a.folder.startsWith("/")) return "folder must be an absolute path";
  if (unknown(a, AUTOMATION_FIELDS)) return `has an unknown field "${unknown(a, AUTOMATION_FIELDS)}"`;
  if (!isObject(a.trigger) || !TRIGGERS.includes(a.trigger.type)) return `trigger type must be one of ${TRIGGERS.join(", ")}`;
  if (unknown(a.trigger, TRIGGER_FIELDS[a.trigger.type])) return `trigger has an unknown field "${unknown(a.trigger, TRIGGER_FIELDS[a.trigger.type])}"`;
  if (a.trigger.type === "schedule") {
    try { compile(a.trigger); } catch (e) { return `trigger: ${e.message}`; }
  }
  if (a.trigger.type === "agent") {
    if (!AGENT_STATUSES.includes(a.trigger.status)) return 'trigger status must be "done" or "blocked"';
    if (!optional(a.trigger.inFolder, (v) => typeof v === "boolean")) return "trigger inFolder must be true or false";
    if (!optional(a.trigger.app, text)) return "trigger app must be an agent's name";
  }
  if (a.trigger.type === "git") {
    if (!["local", "remote"].includes(a.trigger.source)) return 'trigger source must be "local" or "remote"';
    if (a.trigger.source === "remote" && !(typeof a.trigger.branch === "string" && REMOTE_BRANCH.test(a.trigger.branch) && !a.trigger.branch.includes("..")))
      return 'a remote git trigger needs a branch such as "origin/main"';
  }
  if (a.kind === "agent" && !text(a.prompt)) return "an agent Automation needs a prompt";
  if (a.kind === "script" && !text(a.command)) return "a script Automation needs a command";
  if (!optional(a.agent, text)) return "agent must be a name";
  if (!optional(a.model, (v) => typeof v === "string")) return "model must be text";
  if (!optional(a.args, (v) => Array.isArray(v) && v.every((x) => typeof x === "string"))) return "args must be a list of text";
  if (!optional(a.workspace, (v) => WORKSPACES.includes(v))) return 'workspace must be "worktree" or "folder"';
  if (!optional(a.base, (v) => typeof v === "string" && !v.startsWith("-"))) return "base must be a git ref";
  for (const step of STEP_KEYS) {
    const error = optional(a[step], isObject) ? scriptError(a[step]) : "must be an object";
    if (error) return `${step} ${error}`;
  }
  if (!optional(a.requireResult, (v) => typeof v === "boolean")) return "requireResult must be true or false";
  if (!optional(a.enabled, (v) => typeof v === "boolean")) return "enabled must be true or false";
  if (!optional(a.timeout, (v) => typeof v === "number" && v > 0)) return "timeout must be a number of minutes above 0";
  if (!optional(a.catchUp, (v) => v === false || v === "" || durationMs(v) > 0)) return 'catchUp must be a duration such as "2h"';
  return null;
}

/** The store for data folder `root`. */
export function store(root, io) {
  const files = {
    automations: `${root}/automations.json`,
    state: `${root}/state.json`,
    history: `${root}/history`,
    runs: `${root}/runs`,
  };
  const json = (raw) => {
    if (raw === null || raw === undefined) return { raw: null, value: null };
    try { return { raw, value: JSON.parse(raw) }; } catch (e) { return { raw, value: null, error: e.message }; }
  };
  // writeTextFile refuses when the file changed since `raw` was read; then `fn` runs again on
  // the newer contents, so a change from another copy is never overwritten.
  const swap = async (path, fn) => {
    for (let tries = 1; ; tries++) {
      const raw = (await io.readTextFile(path)) ?? null;
      const next = fn(raw);
      if (next === null) return;
      try {
        return await io.writeTextFile(path, next, raw);
      } catch (e) {
        if (tries >= 5) throw e;
      }
    }
  };
  const update = async (path, parse, fn) => {
    await io.mkdir(root, { recursive: true });
    let after;
    await swap(path, (raw) => {
      const r = json(raw);
      if (r.raw !== null && r.value === null) throw new Error(`${path} is not valid JSON: ${r.error}`);
      const before = parse(r.value);
      after = fn(before);
      return after === before ? null : JSON.stringify(after, null, 2) + "\n";
    });
    return after;
  };
  const dayFile = (day) => `${files.history}/${day}.jsonl`;
  const historyDays = async () => (await list(files.history)).filter((n) => DAY_FILE.test(n)).map((n) => n.slice(0, 10));
  // Herdr's fs has no recursive remove. A symlink an agent left is unlinked, never followed.
  const removeTree = async (path) => {
    for (const e of await io.readdir(path, { withFileTypes: true })) {
      if (e.isDirectory()) await removeTree(`${path}/${e.name}`);
      else await io.unlink(`${path}/${e.name}`);
    }
    await io.rmdir(path);
  };
  const list = (dir) => io.readdir(dir).catch(() => []);
  const doc = (v) => ({ ...(isObject(v) ? v : {}), paused: v?.paused === true, automations: Array.isArray(v?.automations) ? v.automations : [] });
  const state = (v) => (isObject(v) ? { ...EMPTY_STATE, ...v } : EMPTY_STATE);
  const automationsOf = (raw) => {
    const r = json(raw);
    if (r.raw !== null && r.value === null) return { paused: false, automations: [], problems: [`automations.json is not valid JSON: ${r.error}`] };
    const d = doc(r.value), problems = [], seen = new Set(), automations = [];
    d.automations.forEach((a, i) => {
      const error = automationError(a) ?? (seen.has(a.id) ? "has the same id as an earlier one" : null);
      if (error) return problems.push(`Automation ${i + 1}${text(a?.name) ? ` (${a.name})` : ""} ${error}`);
      seen.add(a.id);
      automations.push(a);
    });
    return { paused: d.paused, automations, problems };
  };

  return {
    root,
    files,
    /**
     * automations.json: `{paused, automations, problems}`. A bad entry or a duplicate id is
     * named in `problems` and left out; the valid ones still load.
     */
    readAutomations: async () => automationsOf(await io.readTextFile(files.automations)),
    /** readAutomations of the raw text `raw` of automations.json. */
    automationsOf,
    /** Rewrites automations.json as `fn({paused, automations})`, where automations are the raw entries, bad ones too. */
    updateAutomations: (fn) => update(files.automations, doc, fn),
    /**
     * state.json: `{checked: {id: ms}, runs: {runId: run}, last: {id: run}, tabs: {id: {space, tab, terminal, run}},
     * worktrees: {runId: worktree}, commits: {id: {commit, branch, error}}, requests: {requestId: request}}`; empty
     * when missing. `tabs` is each Automation's live tab, `commits` the last commit a git Trigger saw, `requests`
     * the Run now and Stop that copies of the mod hand to the leader.
     */
    readState: async () => state(json(await io.readTextFile(files.state)).value),
    /** readState of the raw text `raw` of state.json. */
    stateOf: (raw) => state(json(raw).value),
    /** The raw text of a file of the store (`files.state`, `historyFile(day)`), or null. */
    readText: (path) => io.readTextFile(path),
    historyFile: dayFile,
    updateState: (fn) => update(files.state, state, fn),
    /** Adds one Run event to the history file of its day. */
    async appendHistory(event) {
      await io.mkdir(files.history, { recursive: true });
      await swap(dayFile(dayKey(event.at)), (raw) => `${raw ?? ""}${JSON.stringify(event)}\n`);
    },
    /**
     * Run events of the newest `days` history files, newest first. Lines that do not parse
     * are skipped, so one hand-damaged line costs only itself.
     */
    async readHistory(days = 30) {
      const out = [];
      for (const day of (await historyDays()).sort().reverse().slice(0, days)) {
        const raw = (await io.readTextFile(dayFile(day))) ?? "";
        const lines = [];
        for (const line of raw.split("\n")) {
          if (!line.trim()) continue;
          try { const e = JSON.parse(line); if (isObject(e)) lines.push(e); } catch {}
        }
        out.push(...lines.reverse());
      }
      return out;
    },
    runDir: (id) => `${files.runs}/${id}`,
    /** The only folder of a Run an agent may write: its result file. The engine reads no decision from it. */
    outDir: (id) => `${files.runs}/${id}/out`,
    async writeRunFile(id, name, contents) {
      const path = `${files.runs}/${id}/${name}`;
      await io.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
      await io.writeTextFile(path, contents, await io.readTextFile(path));
    },
    readRunFile: (id, name) => io.readTextFile(`${files.runs}/${id}/${name}`),
    /** The days with a history file, "YYYY-MM-DD". */
    historyDays,
    removeHistoryDay: (day) => io.unlink(dayFile(day)),
    /** The ids of the run folders on disk. */
    runIds: () => list(files.runs),
    removeRun: (id) => removeTree(`${files.runs}/${id}`),
    /** Removes Automation `id` from automations.json, and what state.json kept for it. */
    async deleteAutomation(id) {
      await update(files.automations, doc, (d) => ({ ...d, automations: d.automations.filter((x) => x?.id !== id) }));
      const drop = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== id));
      await update(files.state, state, (s) => ({ ...s, checked: drop(s.checked), last: drop(s.last), tabs: drop(s.tabs), commits: drop(s.commits) }));
    },
  };
}

/** The newest event of each Run in `events` (newest first), keeping that order. */
export function latestRuns(events) {
  const seen = new Set();
  return events.filter((e) => e.run && !seen.has(e.run) && seen.add(e.run));
}
