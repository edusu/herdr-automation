import { test } from "node:test";
import assert from "node:assert/strict";
import { createEngine, decide, catchUpMs, LEASE_MS } from "../mods/automation/engine.js";
import { store } from "../mods/automation/store.js";
import { io, tempRoot, removeRoot, fakeHost, fakeLease, clock, SETTINGS } from "./helpers.js";

const at = (d, h = 0, mi = 0, sec = 0) => new Date(2026, 10, d, h, mi, sec).getTime();
const MIN = 60000;
const daily = { id: "d", name: "Daily", kind: "script", folder: "/tmp", command: "true", trigger: { type: "schedule", preset: "daily", at: "09:00" } };
const every = { id: "e", name: "Every", kind: "script", folder: "/tmp", command: "true", trigger: { type: "schedule", preset: "every", minutes: 15 } };

async function setup(t, automations, start, paused = false) {
  const root = await tempRoot();
  t.after(() => removeRoot(root));
  const s = store(root, io), host = fakeHost(), now = clock(start), lease = fakeLease();
  await s.updateAutomations(() => ({ paused, automations }));
  const make = (id = "one") => createEngine({ store: s, host, lease, id, settings: () => SETTINGS, now });
  return { s, host, now, lease, make, engine: make() };
}
/** One tick and the work it started beside it. */
const tick = async (e) => { const r = await e.tick(); await e.idle(); return r; };
const statuses = async (s) => (await s.readHistory()).reverse().map((e) => e.status);

test("Catch-up or Missed after a gap, on time without one", () => {
  const base = { count: 1, latest: at(25, 9), catchUp: 2 * 60 * MIN, paused: false };
  assert.deepEqual(decide({ ...base, from: at(25, 8, 59), now: at(25, 9, 0, 5) }), { fire: "schedule", missed: 0, skipped: 0 });
  assert.deepEqual(decide({ ...base, from: at(24, 22), now: at(25, 10, 30) }), { fire: "catch-up", missed: 0, skipped: 0 });
  assert.deepEqual(decide({ ...base, from: at(24, 22), now: at(25, 11, 30) }), { fire: null, missed: 1, skipped: 0 });
  assert.deepEqual(decide({ ...base, count: 3, from: at(22, 22), now: at(25, 10) }), { fire: "catch-up", missed: 2, skipped: 0 });
  assert.deepEqual(decide({ ...base, paused: true, from: at(24), now: at(25, 9, 1) }), { fire: null, missed: 0, skipped: 1 });
  // Two times between two close ticks run once and miss nothing.
  assert.deepEqual(decide({ count: 2, latest: at(25, 9, 1), from: at(25, 8, 59, 59), now: at(25, 9, 1, 30), catchUp: 0, paused: false }), { fire: "schedule", missed: 0, skipped: 0 });
  assert.equal(catchUpMs(daily), 2 * 60 * MIN);
  assert.equal(catchUpMs(every), 0);
  assert.equal(catchUpMs({ ...daily, catchUp: "" }), 0);
  assert.equal(catchUpMs({ ...every, catchUp: "30m" }), 30 * MIN);
});

test("a new Automation does not fire for times before it; then it fires on time", async (t) => {
  const { s, host, now, engine } = await setup(t, [daily], at(25, 8, 59));
  await tick(engine);
  assert.equal(host.opened.length, 0);
  now.set(at(25, 9, 0, 10));
  await tick(engine);
  assert.equal(host.opened.length, 1);
  assert.deepEqual(await statuses(s), ["running"]);
  assert.equal((await s.readHistory())[0].trigger, "schedule");
});

test("after Herdr was closed: Catch-up inside the window, Missed outside it", async (t) => {
  const { s, host, now, engine } = await setup(t, [daily, every], at(24, 18));
  await tick(engine);
  now.set(at(25, 10, 7));
  await tick(engine);
  // Daily is 67 minutes late, inside 2 h: a Catch-up. Every-15 has no Catch-up: all Missed.
  assert.equal(host.opened.length, 1);
  const h = (await s.readHistory()).reverse();
  // The Run starts beside the tick, so the two lines may come in either order.
  assert.deepEqual(h.map((e) => [e.automation, e.status, e.trigger]).sort(), [["d", "running", "catch-up"], ["e", "missed", "schedule"]]);
  assert.equal(h.find((e) => e.status === "missed").count, 64);
});

test("a time that comes due while the last Run goes on is skipped (overlap)", async (t) => {
  const { s, host, now, engine } = await setup(t, [{ ...every, timeout: 60 }], at(25, 9, 14));
  await tick(engine);
  now.set(at(25, 9, 15, 5));
  await tick(engine);
  now.set(at(25, 9, 30, 5));
  await tick(engine);
  assert.equal(host.opened.length, 1);
  assert.deepEqual(await statuses(s), ["running", "skipped"]);
  assert.equal((await s.readHistory())[0].reason, "overlap");
});

test("an interval Trigger: at once, then its interval after the last Run ended; a skipped Run does not count", async (t) => {
  const hourly = { id: "i", name: "Hourly", kind: "script", folder: "/tmp", command: "true", trigger: { type: "interval", every: "1h" } };
  const { s, host, now, engine } = await setup(t, [hourly], at(25, 9));
  await tick(engine);
  assert.equal(host.opened.length, 1, "never ran: due at once");
  const [run] = Object.values((await s.readState()).runs);
  now.set(at(25, 9, 5));
  await s.writeRunFile(run.id, "exit", "0");
  await tick(engine);
  assert.equal((await s.readState()).ran.i, at(25, 9, 5));
  now.set(at(25, 10, 4));
  await tick(engine);
  assert.equal(host.opened.length, 1, "counted from the end, not the start");
  // Herdr closed for two days: one Run, nothing Missed.
  now.set(at(27, 8));
  await tick(engine);
  assert.equal(host.opened.length, 2);
  await engine.stop(Object.keys((await s.readState()).runs)[0]);
  await s.updateAutomations(() => ({ paused: false, automations: [{ ...hourly, check: { inline: "exit 1" } }] }));
  now.set(at(27, 9, 1));
  await tick(engine);
  now.add(MIN);
  await tick(engine);
  now.add(5 * MIN);
  await tick(engine);
  assert.equal(host.opened.length, 2);
  assert.equal((await s.readState()).ran.i, at(27, 8), "a Run its Check skipped leaves it due");
  assert.deepEqual(await statuses(s), ["running", "ok", "running", "stopped", "skipped", "skipped"]);
  await s.updateAutomations(() => ({ paused: true, automations: [hourly] }));
  now.add(10 * MIN);
  await tick(engine);
  assert.equal((await statuses(s)).length, 6, "paused: nothing starts and nothing is recorded");
});

test("paused, per Automation or for everything: skipped and never replayed", async (t) => {
  const { s, host, now, engine } = await setup(t, [{ ...every, enabled: false }], at(25, 9, 14));
  await tick(engine);
  now.set(at(25, 9, 15, 5));
  await tick(engine);
  assert.deepEqual(await statuses(s), ["skipped"]);
  assert.equal((await s.readHistory())[0].reason, "paused");
  await s.updateAutomations(() => ({ paused: true, automations: [every] }));
  now.set(at(25, 9, 30, 5));
  await tick(engine);
  await s.updateAutomations(() => ({ paused: false, automations: [every] }));
  now.set(at(25, 9, 31));
  await tick(engine);
  assert.equal(host.opened.length, 0);
  assert.deepEqual(await statuses(s), ["skipped", "skipped"]);
});

test("the engine follows a Run to its end: script exit code, timeout, Stop, closed tab", async (t) => {
  const { s, host, now, engine } = await setup(t, [every], at(25, 9));
  const run = await engine.runNow(every);
  await tick(engine);
  await s.writeRunFile(run.id, "exit", "1");
  await tick(engine);
  assert.deepEqual((await s.readState()).last.e.status, "failed");
  assert.equal(host.toasts[0].terminal, "t1");

  const r2 = await engine.runNow(every);
  now.add(10 * MIN);
  await tick(engine);
  assert.equal((await s.readState()).last.e.status, "timed out");
  assert.ok(host.live.has(r2.terminal), "a timed-out tab stays");

  const r3 = await engine.runNow(every);
  assert.deepEqual(host.closed, ["tab1", "tab2"], "a timed-out Run has ended, so its tab goes");
  await engine.stop(r3.id);
  assert.equal((await s.readState()).last.e.status, "stopped");
  assert.deepEqual(host.killed, [r3.terminal]);

  const r4 = await engine.runNow(every);
  host.live.delete(r4.terminal);
  await tick(engine);
  assert.equal((await s.readState()).runs[r4.id].status, "running", "one missed look is not enough");
  await tick(engine);
  assert.equal((await s.readState()).last.e.status, "closed");
});

test("an agent Run: blocked posts a toast, then done is ok", async (t) => {
  const agent = { ...every, id: "g", kind: "agent", prompt: "Hi", trigger: { type: "manual" } };
  const { s, host, engine } = await setup(t, [agent], at(25, 9));
  const run = await engine.runNow(agent);
  assert.deepEqual([host.opened[0].argv, host.opened[0].task], [["claude", "--add-dir", s.outDir(run.id)], "Hi"]);
  host.status.set(run.terminal, "working");
  await tick(engine);
  host.status.set(run.terminal, "blocked");
  await tick(engine);
  await tick(engine);
  assert.equal((await s.readState()).runs[run.id].status, "blocked");
  assert.equal(host.toasts.length, 1);
  assert.equal(host.toasts[0].blocked, true);
  host.status.set(run.terminal, "working");
  await tick(engine);
  host.status.set(run.terminal, "done");
  await tick(engine);
  assert.deepEqual(await statuses(s), ["running", "blocked", "running", "ok"]);
});

test("an agent Run blocked before any work does not end on idle", async (t) => {
  const agent = { ...every, id: "g", kind: "agent", prompt: "Hi", trigger: { type: "manual" } };
  const { s, host, engine } = await setup(t, [agent], at(25, 9));
  const run = await engine.runNow(agent);
  for (const status of ["blocked", "idle", "idle"]) {
    host.status.set(run.terminal, status);
    await tick(engine);
  }
  assert.equal((await s.readState()).runs[run.id].status, "running");
  host.status.set(run.terminal, "working");
  await tick(engine);
  host.status.set(run.terminal, "idle");
  await tick(engine);
  assert.equal((await s.readState()).last.g.status, "ok");
});

test("closing an agent Run's tab by hand ends it as closed, not as an exited agent", async (t) => {
  const agent = { ...every, id: "g", kind: "agent", prompt: "Hi", trigger: { type: "manual" } };
  const { s, host, engine } = await setup(t, [agent], at(25, 9));
  const run = await engine.runNow(agent);
  host.status.set(run.terminal, "working");
  await tick(engine);
  // Herdr drops the agent and its terminal together.
  host.live.delete(run.terminal);
  host.status.delete(run.terminal);
  await tick(engine);
  assert.equal((await s.readState()).runs[run.id].status, "running");
  await tick(engine);
  const { last } = await s.readState();
  assert.deepEqual([last.g.status, last.g.reason], ["closed", "The tab was closed"]);
});

test("Run now and Stop from any copy are done by the leader", async (t) => {
  const { s, host, make } = await setup(t, [every], at(25, 9));
  const leader = make("leader"), other = make("other");
  await tick(leader);
  assert.equal(await tick(other), false);
  await other.askRun(every);
  const [request] = Object.values((await s.readState()).requests);
  assert.deepEqual([request.type, request.automation], ["run", "e"]);
  await tick(other);
  assert.equal(host.opened.length, 0, "only the leader starts it");
  await tick(leader);
  assert.equal(host.opened.length, 1);
  const st = await s.readState();
  assert.deepEqual(st.requests, {});
  const [run] = Object.values(st.runs);
  assert.equal(run.trigger, "manual");
  await other.askStop(run.id);
  await tick(leader);
  assert.equal((await s.readState()).last.e.status, "stopped");
  assert.deepEqual(host.killed, [run.terminal]);
  // Stop on a Run still waiting for the leader takes the request back.
  await other.askRun(every);
  const [id] = Object.keys((await s.readState()).requests);
  await other.askStop(id);
  await tick(leader);
  assert.equal(host.opened.length, 1);
  assert.deepEqual((await s.readState()).requests, {});
});

test("a Run going on survives an engine restart and is not started twice", async (t) => {
  const { s, host, now, make } = await setup(t, [every], at(25, 9, 14));
  const before = make("before");
  await tick(before);
  now.set(at(25, 9, 15, 5));
  await tick(before);
  assert.equal(host.opened.length, 1);
  // The mod reloads: a new engine, a new lease owner, nothing in memory.
  now.add(LEASE_MS);
  const after = make("after");
  await tick(after);
  assert.equal(host.opened.length, 1);
  const [run] = Object.values((await s.readState()).runs);
  await s.writeRunFile(run.id, "exit", "0");
  await tick(after);
  assert.equal((await s.readState()).last.e.status, "ok");
  assert.deepEqual(await statuses(s), ["running", "ok"]);
});

test("a Run cut off while starting is failed by the next engine", async (t) => {
  const { s, now, engine } = await setup(t, [every], at(25, 9));
  await s.updateState((st) => ({ ...st, runs: { x: { id: "x", automation: "e", name: "Every", kind: "script", status: "starting", started: now() } } }));
  await tick(engine);
  assert.equal((await s.readState()).runs.x.status, "starting");
  now.add(6 * MIN);
  await tick(engine);
  assert.equal((await s.readState()).last.e.status, "failed");
});

test("only the lease holder fires; the lease passes on when it lapses or is released", async (t) => {
  const { host, now, make, lease } = await setup(t, [every], at(25, 9, 14, 40));
  const a = make("a"), b = make("b");
  assert.equal(await tick(a), true);
  now.set(at(25, 9, 14, 56));
  assert.equal(await tick(a), true);
  now.set(at(25, 9, 15, 5));
  assert.equal(await tick(b), false);
  assert.equal(await tick(a), true);
  assert.equal(host.opened.length, 1);
  now.add(LEASE_MS / 2 + 1);
  assert.equal(a.leader(), true, "renewed at half its life");
  now.add(LEASE_MS - 1);
  assert.equal(b.leader(), false);
  now.add(2);
  assert.equal(b.leader(), true, "a lapsed lease is taken");
  b.release();
  assert.equal(lease.get(), null);
  assert.equal(a.leader(), true);
});
