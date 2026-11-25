import { test } from "node:test";
import assert from "node:assert/strict";
import { observe, mainStep, timeoutMs, newRunId, startRun, finishRun, toastAction, goingRun, RUN_LABEL } from "../mods/automation/runs.js";
import { store } from "../mods/automation/store.js";
import { io, tempRoot, removeRoot, fakeHost, clock, SETTINGS } from "./helpers.js";

const agentRun = { kind: "agent", status: "running", started: 0, deadline: 60000 };
const scriptRun = { kind: "script", status: "running", started: 0, deadline: 60000 };
const live = (agent = null, exit = null) => ({ alive: true, agent, exit });

test("a script Run ends with its exit code", () => {
  assert.deepEqual(observe(scriptRun, live(null, "0"), 10), { status: "ok" });
  assert.deepEqual(observe(scriptRun, live(null, "2"), 10), { status: "failed", reason: "Exit code 2" });
  assert.equal(observe(scriptRun, live(), 10), null);
  // The exit code wins over a tab closed right after.
  assert.deepEqual(observe(scriptRun, { alive: false, exit: "0" }, 10), { status: "ok" });
});

test("an agent Run: working, blocked, working again, done", () => {
  let run = { ...agentRun };
  const step = (status) => { const c = observe(run, live(status), 10); run = { ...run, ...c }; return c; };
  assert.deepEqual(step("idle"), { seen: true });
  assert.equal(observe(run, live("idle"), 10), null);
  assert.deepEqual(step("working"), { status: "running", seen: true, sawWork: true });
  assert.equal(observe(run, live("working"), 10), null);
  assert.equal(step("blocked").status, "blocked");
  assert.equal(observe(run, live("blocked"), 10), null);
  assert.equal(step("working").status, "running");
  assert.deepEqual(step("done"), { status: "ok" });
});

test("idle ends an agent Run only after it worked; an exited agent fails it", () => {
  assert.deepEqual(observe({ ...agentRun, sawWork: true, seen: true }, live("idle"), 10), { status: "ok" });
  assert.deepEqual(observe({ ...agentRun, seen: true }, live(null), 10), { status: "failed", reason: "The agent exited" });
});

test("an agent missing with its terminal is not an exited agent: the gone-looks rule decides", () => {
  assert.equal(observe({ ...agentRun, seen: true }, { alive: true, gone: true, agent: null }, 10), null);
});

test("timed out, closed", () => {
  assert.equal(observe(agentRun, live("working"), 60000).status, "timed out");
  assert.equal(observe(scriptRun, live(), 60000).status, "timed out");
  assert.deepEqual(observe(agentRun, { alive: false, agent: null }, 10), { status: "closed", reason: "The tab was closed" });
});

test("the main step of an agent and of a script", () => {
  const agents = [{ key: "claude", run: ["claude"], installed: true }, { key: "codex", name: "Codex", run: ["codex"], installed: false }];
  const a = { kind: "agent", prompt: "Review it", model: "opus", args: ["--verbose"] };
  assert.deepEqual(mainStep(a, { agents, settings: SETTINGS }), { argv: ["claude", "--model", "opus", "--verbose"], task: "Review it" });
  assert.throws(() => mainStep({ ...a, agent: "codex" }, { agents, settings: SETTINGS }), /not installed/);
  assert.throws(() => mainStep({ ...a, agent: "nope" }, { agents, settings: SETTINGS }), /not one of/);
  const s = mainStep({ kind: "script", command: "make test; exit 3" }, { agents, settings: SETTINGS, exitFile: "/r/exit" });
  assert.deepEqual(s.argv.slice(-3), ["sh", "make test; exit 3", "/r/exit"]);
});

test("a script tab's command line writes the exit code to the file", async (t) => {
  const { execFileSync } = await import("node:child_process");
  const root = await tempRoot();
  t.after(() => removeRoot(root));
  const { argv } = mainStep({ kind: "script", command: "echo 'it''s'; exit 3" }, { agents: [], settings: SETTINGS, exitFile: `${root}/my exit` });
  assert.equal(execFileSync(argv[0], argv.slice(1)).toString(), "its\n");
  assert.equal(await io.readTextFile(`${root}/my exit`), "3");
});

test("timeouts come from the Automation, else the settings", () => {
  assert.equal(timeoutMs({ kind: "agent", timeout: 5 }, SETTINGS), 300000);
  assert.equal(timeoutMs({ kind: "agent" }, SETTINGS), 3600000);
  assert.equal(timeoutMs({ kind: "script" }, SETTINGS), 600000);
  // A value that is no duration falls back to the default; a plain number is ms.
  assert.equal(timeoutMs({ kind: "agent" }, { ...SETTINGS, agentTimeout: "soon" }), 3600000);
  assert.equal(timeoutMs({ kind: "script" }, { ...SETTINGS, scriptTimeout: 5000 }), 5000);
  assert.match(newRunId(new Date(2026, 10, 25, 9, 3, 7).getTime(), () => 0.5), /^20261125-090307-[0-9a-z]{4}$/);
});

test("starting a Run opens a labelled tab and closes the previous Run's tab", async (t) => {
  const root = await tempRoot();
  t.after(() => removeRoot(root));
  const host = fakeHost(), now = clock(1000), s = store(root, io);
  const ctx = { host, store: s, settings: SETTINGS, now };
  const a = { id: "a1", name: "Lint", kind: "script", folder: "/tmp", command: "true", trigger: { type: "manual" } };
  const first = await startRun(ctx, a, "manual");
  assert.equal(first.status, "running");
  assert.deepEqual(host.opened[0].space, "Automations");
  assert.deepEqual(host.labels[0], ["t1", RUN_LABEL, first.id]);
  // Still going: a second Run is skipped and nothing is closed.
  assert.equal((await startRun(ctx, a, "manual")).status, "skipped");
  assert.equal(host.opened.length, 1);
  await finishRun(ctx, first, { status: "ok" });
  assert.equal(await s.readRunFile(first.id, "tail.txt"), "tail of t1");
  const second = await startRun(ctx, a, "manual");
  assert.equal(second.tab, "tab2");
  assert.deepEqual(host.closed, ["tab1"]);
  const history = await s.readHistory();
  assert.deepEqual(history.map((e) => e.status), ["running", "ok", "skipped", "running"]);
  assert.equal(history.find((e) => e.status === "skipped").reason, "overlap");
});

test("a Run that cannot start fails with the reason", async (t) => {
  const root = await tempRoot();
  t.after(() => removeRoot(root));
  const host = fakeHost(), s = store(root, io);
  host.openTab = async () => { throw new Error("no window"); };
  const r = await startRun({ host, store: s, settings: SETTINGS, now: clock(1) }, { id: "a", name: "A", kind: "script", command: "x", folder: "/tmp" }, "manual");
  assert.deepEqual([r.status, r.reason], ["failed", "no window"]);
  assert.deepEqual((await s.readState()).runs, {});
  assert.equal(host.toasts.length, 1);
});

async function runCtx(t) {
  const root = await tempRoot();
  t.after(() => removeRoot(root));
  const host = fakeHost(), s = store(root, io);
  return { host, s, ctx: { host, store: s, settings: SETTINGS, now: clock(1000) } };
}
const lint = (more) => ({ id: "a1", name: "Lint", kind: "script", folder: "/tmp", command: "true", trigger: { type: "manual" }, ...more });
const stopped = { status: "stopped", reason: "Stopped from the panel" };

test("Stop while a Run is in its Check: no tab opens and the Run stays stopped", async (t) => {
  const { host, s, ctx } = await runCtx(t);
  const exec = host.exec;
  host.exec = async (cmd, args, o) => {
    const r = await exec(cmd, args, o);
    if (args.at(-1) === "true check-marker") await finishRun(ctx, Object.values((await s.readState()).runs)[0], stopped);
    return r;
  };
  assert.equal(await startRun(ctx, lint({ check: { inline: "true check-marker" } }), "manual"), null);
  assert.equal(host.opened.length, 0);
  const st = await s.readState();
  assert.deepEqual([st.runs, st.last.a1.status], [{}, "stopped"]);
});

test("Stop while a Run's tab opens: the tab is closed and the Run stays stopped", async (t) => {
  const { host, s, ctx } = await runCtx(t);
  const open = host.openTab;
  host.openTab = async (x) => {
    const o = await open(x);
    await finishRun(ctx, Object.values((await s.readState()).runs)[0], stopped);
    return o;
  };
  assert.equal(await startRun(ctx, lint(), "manual"), null);
  assert.deepEqual(host.closed, ["tab1"]);
  const st = await s.readState();
  assert.deepEqual([st.runs, st.last.a1.status, st.tabs.a1], [{}, "stopped", undefined]);
});

test("one live tab per Automation, kept apart from the last Run", async (t) => {
  const { host, s, ctx } = await runCtx(t);
  const first = await startRun(ctx, lint(), "manual");
  await finishRun(ctx, first, { status: "timed out" });
  assert.deepEqual((await s.readState()).tabs.a1, { space: "s1", tab: "tab1", terminal: "t1", run: first.id });
  // A Run that fails before its tab neither takes the tab over nor forgets it.
  const failed = await startRun(ctx, lint({ pre: { inline: "exit 1" } }), "manual");
  assert.equal(failed.status, "failed");
  const st = await s.readState();
  assert.deepEqual([st.last.a1.tab, st.tabs.a1.tab], [undefined, "tab1"]);
  const third = await startRun(ctx, lint(), "manual");
  assert.deepEqual(host.closed, ["tab1"], "the timed-out Run's tab goes when the next Run starts");
  assert.equal((await s.readState()).tabs.a1.run, third.id);
  await finishRun(ctx, third, { status: "ok" });
  // Closed by hand already, or failing to close: the new Run goes on.
  host.tabs.delete("tab2");
  await finishRun(ctx, await startRun(ctx, lint(), "manual"), { status: "ok" });
  assert.deepEqual(host.closed, ["tab1"]);
  host.closeTab = () => { throw new Error("no such tab"); };
  assert.equal((await startRun(ctx, lint(), "manual")).status, "running");
});

test("the terminal's tail keeps its last 200 lines", async (t) => {
  const { host, s, ctx } = await runCtx(t);
  host.tail = async () => Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n") + "\n";
  const run = await startRun(ctx, lint(), "manual");
  await finishRun(ctx, run, { status: "ok" });
  const lines = (await s.readRunFile(run.id, "tail.txt")).trimEnd().split("\n");
  assert.deepEqual([lines.length, lines[0], lines.at(-1)], [200, "line 100", "line 299"]);
});

test("a toast's click: the Run's terminal while it is there, else the dialog unless it is open", () => {
  assert.deepEqual(toastAction({ terminal: "t1" }), { name: "pane.focus", args: { terminal: "t1" } });
  assert.deepEqual(toastAction({ terminal: "t1", blocked: true }), { name: "agent.focus", args: { terminal: "t1" } });
  assert.deepEqual(toastAction({ terminal: null }), { name: "mod.open", args: { name: "automation" } });
  assert.equal(toastAction({ terminal: null, dialogOpen: true }), undefined);
});

test("a Run asked for and not started yet shows as starting", () => {
  const state = { runs: { r1: { id: "r1", automation: "b", status: "running" } }, requests: { q1: { type: "run", automation: "a", at: 5 } } };
  assert.deepEqual(goingRun(state, "a"), { id: "q1", automation: "a", status: "starting", started: 5, requested: true });
  assert.equal(goingRun(state, "b").id, "r1");
  assert.equal(goingRun(state, "c"), null);
});
