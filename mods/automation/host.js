// The only module that reaches Herdr for effects: tabs, the space, terminals, agents, toasts,
// programs (exec), the lease in shared state, the dialog, the folder picker and file access.
// The engine and the views get these objects.
import {
  exec, hc, run, spaces, terminals, agents, panes, notify, knownAgents, readTextFile, writeTextFile, shared, setShared, appHome, home,
  closeOverlay, pickFolder, settings, window,
} from "herdr";
import * as fs from "fs/promises";
import { toastAction, TAIL_LINES } from "./runs.js";

/** File access for store.js. */
export const io = {
  readTextFile,
  writeTextFile,
  mkdir: (path, options) => fs.mkdir(path, options),
  readdir: (path, options) => fs.readdir(path, options),
  unlink: (path) => fs.unlink(path),
  rmdir: (path) => fs.rmdir(path),
};

const LEASE_KEY = "automation.leader";
/** The leader lease in Herdr's shared state, which every copy in every window sees. */
export const lease = { get: () => shared(LEASE_KEY) ?? null, set: (value) => setShared(LEASE_KEY, value) };
// Set while a copy shows the dialog, so a toast does not offer mod.open, which would close it.
const DIALOG_KEY = "automation.dialog";

// run() returns nothing, but `herdr-app do` prints the space, tab and terminal it made, and
// the Run must know its terminal from the first moment (the label, the end of the Run).
async function doCommand(name, args) {
  const r = await exec("herdr-app", ["do", name, JSON.stringify(args)], { timeout: 30000 });
  let out = {};
  try { out = JSON.parse(r.stdout || "{}"); } catch {}
  if (r.code !== 0 || out.error || !out.terminal) throw new Error(out.error || r.stderr.trim() || `${name} made no terminal`);
  return out;
}

export const host = {
  /** Herdr's exec, for shell.js. */
  exec,
  /** worktrees.directory of Herdr's settings.json, as New worktree reads it; default ~/.herdr/worktrees. */
  async worktreesDir() {
    let given = null;
    try { given = JSON.parse((await readTextFile(`${appHome()}/settings.json`)) ?? "{}")?.worktrees?.directory; } catch {}
    const dir = typeof given === "string" && given.trim() ? given.trim() : "~/.herdr/worktrees";
    return dir === "~" || dir.startsWith("~/") ? home() + dir.slice(1) : dir;
  },
  /** A tab without focus in the space named `space`; the space is made with this tab as its first one when missing. */
  async openTab({ space, name, folder, argv, task }) {
    const found = spaces().find((s) => s.named && s.name === space && !s.machine);
    if (found) {
      const r = await doCommand("tab.new", { space: found.id, name, folder, argv, task, focus: false });
      return { space: r.space ?? found.id, tab: r.tab, terminal: r.terminal };
    }
    const r = await doCommand("space.new", { name: space, tab: name, folder, argv, task, machine: "", focus: false });
    return { space: r.space, tab: r.tab, terminal: r.terminal };
  },
  async label(terminal, key, value) {
    const r = await hc(["label", terminal, `${key}=${value}`]);
    if (r.code !== 0) throw new Error(r.stderr.trim() || "hc label failed");
  },
  closeTab: (id) => run("tab.close", { id, confirmed: true }),
  kill: (terminal) => run("terminal.kill", { terminal }),
  alive: (terminal) => Boolean(terminal) && terminals().some((t) => t.address === terminal),
  /**
   * One look for a tick: `terminals`, the set of terminal addresses, and `agents`, the agents on
   * this computer as `{address, status, turn, app, program, space, folder, labels}`, with the live
   * folder of the agent's pane and its terminal's labels and count of turns.
   */
  look() {
    const all = terminals();
    const folders = new Map(panes().map((p) => [p.terminal, p.cwd]));
    const byAddress = new Map(all.map((t) => [t.address, t]));
    // An address with a machine prefix is on another computer, out of scope for v1.
    return {
      terminals: new Set(all.map((t) => t.address)),
      agents: agents().filter((a) => !a.address.includes("/")).map((a) => ({
        address: a.address, status: a.status, app: a.app, program: a.program?.key ?? null, space: a.space_name,
        folder: folders.get(a.address) ?? null, labels: byAddress.get(a.address)?.labels ?? {}, turn: byAddress.get(a.address)?.turn ?? null,
      })),
    };
  },
  async tail(terminal) {
    const r = await hc(["read", terminal, "--lines", String(TAIL_LINES)]);
    return r.code === 0 ? r.stdout : null;
  },
  knownAgents: () => knownAgents(),
  /** A toast whose click goes to the Run's terminal while it is there, else to the dialog. */
  notify: ({ title, body, level, terminal, blocked }) =>
    notify({ title, body, level, action: toastAction({ terminal, blocked, dialogOpen: shared(DIALOG_KEY) === true }) }),
  /** Marks the dialog shown or gone. */
  dialogShown: (shown) => setShared(DIALOG_KEY, shown),
  closeDialog: (overlay) => closeOverlay(overlay),
  pickFolder: () => pickFolder({ prompt: "Choose" }),
  /** The terminal font of Herdr's settings, or null. */
  monoFont: () => settings()?.font_family ?? null,
  /** Whether the window is on screen (true when there is none, as in `herdr-app check`). */
  visible: () => window()?.visible !== false,
  /** The ids of the open tabs, from one spaces() call. */
  openTabs: () => new Set(spaces().flatMap((s) => s.tabs.map((t) => t.id))),
  /** Whether tab `id` is still open. */
  tabOpen: (id) => Boolean(id) && host.openTabs().has(id),
  goToTab(space, tab) {
    if (space) run("space.select", { id: space });
    run("tab.select", { id: tab });
  },
};
