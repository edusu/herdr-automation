// Node stand-ins for what Herdr hands the pure modules: file access, a host and a lease.
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/** Herdr's readTextFile / writeTextFile contract on the real disk. */
export const io = {
  async readTextFile(p) {
    try { return await fs.readFile(p, "utf8"); } catch (e) { if (e.code === "ENOENT") return null; throw e; }
  },
  async writeTextFile(p, text, expected) {
    if ((await io.readTextFile(p)) !== expected) throw new Error("stale snapshot");
    const tmp = `${p}.${process.pid}.tmp`;
    await fs.writeFile(tmp, text);
    await fs.rename(tmp, p);
    return null;
  },
  mkdir: (p, o) => fs.mkdir(p, o),
  readdir: (p) => fs.readdir(p),
};

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
    live: new Set(), status: new Map(),
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
    tail: async (t) => (h.live.has(t) ? `tail of ${t}` : null),
    knownAgents: async () => [{ key: "claude", name: "Claude Code", run: ["claude"], installed: true }],
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
