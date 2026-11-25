// The data folder (ADR 2): automations.json, state.json, history/<YYYY-MM-DD>.jsonl and
// runs/<run id>/. File access comes in as `io` ({readTextFile, writeTextFile, mkdir, readdir},
// Herdr's or node's), so tests run on a temporary folder.
import { compile, durationMs } from "./cron.js";

/** The longest a Check, pre- or post-script may take, in seconds. */
export const SCRIPT_TIMEOUT_MAX = 600;

const KINDS = ["agent", "script"];
const TRIGGERS = ["schedule", "manual", "agent", "git"];
// "origin/main": a remote name, a slash, a branch; neither part may read as a git option.
const REMOTE_BRANCH = /^[A-Za-z0-9._][A-Za-z0-9._-]*\/[A-Za-z0-9._][^\s~^:?*\[\\]*$/;
const WORKSPACES = ["worktree", "folder"];
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const EMPTY_STATE = { checked: {}, runs: {}, last: {}, worktrees: {}, commits: {} };

const pad = (n) => String(n).padStart(2, "0");
/** Local "YYYY-MM-DD" of instant `t`. */
export const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v) => typeof v === "string" && v.trim() !== "";
const optional = (v, ok) => v === undefined || v === null || ok(v);

// A Check, pre- or post-script: {file} or {inline}, and an optional timeout in seconds.
function scriptError(s) {
  if (s === undefined || s === null) return null;
  if (text(s.file) === text(s.inline)) return 'needs either "file" (a path) or "inline" (shell text)';
  if (s.file !== undefined && !text(s.file)) return "file must be a path";
  if (s.inline !== undefined && !text(s.inline)) return "inline must be shell text";
  if (!optional(s.timeout, (v) => Number.isInteger(v) && v > 0 && v <= SCRIPT_TIMEOUT_MAX)) return `timeout must be whole seconds from 1 to ${SCRIPT_TIMEOUT_MAX}`;
  return null;
}

/**
 * Checks one entry of automations.json, which people edit by hand. Returns the error in words,
 * or null when the entry can run. Unknown keys are kept and ignored.
 */
export function automationError(a) {
  if (!isObject(a)) return "is not an object";
  if (typeof a.id !== "string" || !ID.test(a.id)) return "needs an id of letters, digits, - or _";
  if (!text(a.name)) return "needs a name";
  if (!KINDS.includes(a.kind)) return 'kind must be "agent" or "script"';
  if (!text(a.folder) || !a.folder.startsWith("/")) return "folder must be an absolute path";
  if (!isObject(a.trigger) || !TRIGGERS.includes(a.trigger.type)) return `trigger type must be one of ${TRIGGERS.join(", ")}`;
  if (a.trigger.type === "schedule") {
    try { compile(a.trigger); } catch (e) { return `trigger: ${e.message}`; }
  }
  if (a.trigger.type === "agent") {
    if (!["done", "blocked"].includes(a.trigger.status)) return 'trigger status must be "done" or "blocked"';
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
  for (const step of ["check", "pre", "post"]) {
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
  const readJson = async (path) => {
    const raw = await io.readTextFile(path);
    if (raw === null || raw === undefined) return { raw: null, value: null };
    try { return { raw, value: JSON.parse(raw) }; } catch (e) { return { raw, value: null, error: e.message }; }
  };
  // writeTextFile refuses when the file changed since `raw` was read; then `fn` runs again on
  // the newer contents, so a change from another copy is never overwritten.
  const update = async (path, parse, fn) => {
    await io.mkdir(root, { recursive: true });
    for (let tries = 1; ; tries++) {
      const r = await readJson(path);
      if (r.raw !== null && r.value === null) throw new Error(`${path} is not valid JSON: ${r.error}`);
      const before = parse(r.value);
      const after = fn(before);
      if (after === before) return after;
      try {
        await io.writeTextFile(path, JSON.stringify(after, null, 2) + "\n", r.raw);
        return after;
      } catch (e) {
        if (tries >= 5) throw e;
      }
    }
  };
  const doc = (v) => ({ paused: v?.paused === true, automations: Array.isArray(v?.automations) ? v.automations : [] });
  const state = (v) => (isObject(v) ? { ...EMPTY_STATE, ...v } : EMPTY_STATE);

  return {
    root,
    files,
    /**
     * automations.json: `{paused, automations, problems}`. A bad entry or a duplicate id is
     * named in `problems` and left out; the valid ones still load.
     */
    async readAutomations() {
      const r = await readJson(files.automations);
      if (r.raw !== null && r.value === null) return { paused: false, automations: [], problems: [`automations.json is not valid JSON: ${r.error}`] };
      const d = doc(r.value), problems = [], seen = new Set(), automations = [];
      d.automations.forEach((a, i) => {
        const error = automationError(a) ?? (seen.has(a.id) ? "has the same id as an earlier one" : null);
        if (error) return problems.push(`Automation ${i + 1}${text(a?.name) ? ` (${a.name})` : ""} ${error}`);
        seen.add(a.id);
        automations.push(a);
      });
      return { paused: d.paused, automations, problems };
    },
    /** Rewrites automations.json as `fn({paused, automations})`, where automations are the raw entries, bad ones too. */
    updateAutomations: (fn) => update(files.automations, doc, fn),
    /**
     * state.json: `{checked: {id: ms}, runs: {runId: run}, last: {id: run}, worktrees: {runId: worktree},
     * commits: {id: {commit, branch, error}}}`; empty when missing. `commits` is the last commit a git Trigger saw.
     */
    async readState() {
      const r = await readJson(files.state);
      return state(r.value);
    },
    updateState: (fn) => update(files.state, state, fn),
    /** Adds one Run event to the history file of its day. */
    async appendHistory(event) {
      await io.mkdir(files.history, { recursive: true });
      const path = `${files.history}/${dayKey(event.at)}.jsonl`;
      for (let tries = 1; ; tries++) {
        const raw = await io.readTextFile(path);
        try {
          await io.writeTextFile(path, `${raw ?? ""}${JSON.stringify(event)}\n`, raw ?? null);
          return;
        } catch (e) {
          if (tries >= 5) throw e;
        }
      }
    },
    /**
     * Run events of the newest `days` history files, newest first. Lines that do not parse
     * are skipped, so one hand-damaged line costs only itself.
     */
    async readHistory(days = 30) {
      let names = [];
      try { names = await io.readdir(files.history); } catch { return []; }
      const out = [];
      for (const name of names.filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort().reverse().slice(0, days)) {
        const raw = (await io.readTextFile(`${files.history}/${name}`)) ?? "";
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
    async writeRunFile(id, name, contents) {
      await io.mkdir(`${files.runs}/${id}`, { recursive: true });
      const path = `${files.runs}/${id}/${name}`;
      await io.writeTextFile(path, contents, await io.readTextFile(path));
    },
    readRunFile: (id, name) => io.readTextFile(`${files.runs}/${id}/${name}`),
  };
}

/** The newest event of each Run in `events` (newest first), keeping that order. */
export function latestRuns(events) {
  const seen = new Set();
  return events.filter((e) => e.run && !seen.has(e.run) && seen.add(e.run));
}
