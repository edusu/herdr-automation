// Node stand-ins for what Herdr hands the pure modules: file access, a host and a lease.
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFile, execFileSync } from "node:child_process";

const writing = new Map();
/** Herdr's readTextFile / writeTextFile contract on the real disk. */
export const io = {
  async readTextFile(p) {
    try { return await fs.readFile(p, "utf8"); } catch (e) { if (e.code === "ENOENT") return null; throw e; }
  },
  // Herdr compares and replaces in one step; here a queue per path does it, since the engine
  // writes from work going on beside its tick.
  writeTextFile(p, text, expected) {
    const done = (writing.get(p) ?? Promise.resolve()).then(async () => {
      if ((await io.readTextFile(p)) !== expected) throw new Error("stale snapshot");
      const tmp = `${p}.${process.pid}.tmp`;
      await fs.writeFile(tmp, text);
      await fs.rename(tmp, p);
      return null;
    });
    writing.set(p, done.catch(() => {}));
    return done;
  },
  mkdir: (p, o) => fs.mkdir(p, o),
  readdir: (p, o) => fs.readdir(p, o),
  unlink: (p) => fs.unlink(p),
  rmdir: (p) => fs.rmdir(p),
};

/** Herdr's exec contract on node: resolves {code, stdout, stderr}, rejects when it cannot start. */
export const exec = (cmd, args = [], { cwd, timeout = 30000 } = {}) => new Promise((resolve, reject) => {
  execFile(cmd, args, { cwd, timeout, maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
    if (err && err.killed) return resolve({ code: -1, stdout, stderr: stderr || "timed out" });
    if (err && typeof err.code !== "number") return reject(err);
    resolve({ code: err ? err.code : 0, stdout, stderr });
  });
});

// Commits in tests must not depend on the person's git config (identity, signing, hooks).
const GIT = ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"];
/** Runs git in `cwd`; resolves its trimmed stdout. */
export const git = (cwd, ...args) => execFileSync("git", [...GIT, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
/** A commit with one new file in `repo`; resolves its id. */
export const commit = async (repo, name) => {
  await fs.writeFile(path.join(repo, name), name);
  git(repo, "add", name);
  git(repo, "commit", "-q", "-m", name);
  return git(repo, "rev-parse", "HEAD");
};

/**
 * A git repository with one commit in a temporary folder, removed after test `t`; with
 * `remote`, a bare "origin" it was pushed to. Resolves `{root, repo, origin, first}`.
 */
export async function gitRepo(t, { remote = false } = {}) {
  const root = await fs.realpath(await tempRoot());
  t.after(() => removeRoot(root));
  const repo = path.join(root, "repo"), origin = path.join(root, "origin.git");
  await fs.mkdir(repo);
  git(repo, "init", "-q", "-b", "main");
  const first = await commit(repo, "one");
  if (remote) {
    git(root, "init", "-q", "--bare", "-b", "main", origin);
    git(repo, "remote", "add", "origin", origin);
    git(repo, "push", "-q", "-u", "origin", "main");
  }
  return { root, repo, origin, first };
}

/** A new empty data folder. */
export const tempRoot = () => fs.mkdtemp(path.join(os.tmpdir(), "automation-test-"));
export const removeRoot = (root) => fs.rm(root, { recursive: true, force: true });

/** A clock tests move by hand. */
export function clock(start) {
  let t = start;
  const now = () => t;
  now.set = (v) => { t = v; };
  now.add = (ms) => { t += ms; };
  return now;
}

/** A host whose terminals and agents the test sets. */
export function fakeHost() {
  let n = 0;
  const h = {
    opened: [], closed: [], killed: [], labels: [], toasts: [],
    live: new Set(), status: new Map(), agentList: [],
    async openTab(args) {
      n++;
      h.opened.push(args);
      const terminal = `t${n}`;
      h.live.add(terminal);
      return { space: "s1", tab: `tab${n}`, terminal };
    },
    async label(t, k, v) { h.labels.push([t, k, v]); },
    closeTab(tab) { h.closed.push(tab); },
    kill(t) { h.killed.push(t); h.live.delete(t); },
    alive: (t) => h.live.has(t),
    agentStatus: (t) => h.status.get(t) ?? null,
    agents: () => h.agentList,
    tail: async (t) => (h.live.has(t) ? `tail of ${t}` : null),
    knownAgents: async () => [{ key: "claude", name: "Claude Code", run: ["claude"], installed: true }],
    exec,
    worktrees: path.join(os.tmpdir(), "automation-test-worktrees"),
    worktreesDir: () => h.worktrees,
    notify(n) { h.toasts.push(n); },
  };
  return h;
}

/** Herdr's shared state for the lease key. */
export function fakeLease() {
  let v = null;
  return { get: () => v, set: (x) => { v = x; } };
}

export const SETTINGS = { agent: "claude", space: "Automations", agentTimeout: "60m", scriptTimeout: "10m" };
