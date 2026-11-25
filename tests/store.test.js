import { test } from "node:test";
import assert from "node:assert/strict";
import { store, automationError, latestRuns } from "../mods/automation/store.js";
import { writeFileSync as fsWrite } from "node:fs";
import { io, tempRoot, removeRoot } from "./helpers.js";

const good = { id: "a1", name: "Nightly", kind: "script", folder: "/tmp", command: "make", trigger: { type: "schedule", preset: "daily", at: "02:00" } };

test("automations round trip through automations.json", async (t) => {
  const root = await tempRoot();
  t.after(() => removeRoot(root));
  const s = store(root, io);
  assert.deepEqual(await s.readAutomations(), { paused: false, automations: [], problems: [] });
  await s.updateAutomations((d) => ({ ...d, paused: true, automations: [good] }));
  assert.deepEqual(await s.readAutomations(), { paused: true, automations: [good], problems: [] });
});

test("a bad entry is reported and the valid ones still load", async (t) => {
  const root = await tempRoot();
  t.after(() => removeRoot(root));
  const s = store(root, io);
  const bad = { ...good, id: "b", name: "Broken", trigger: { type: "schedule", preset: "cron", cron: "99 * * * *" } };
  await io.writeTextFile(s.files.automations, JSON.stringify({ automations: [bad, good, { ...good }, 7] }), null);
  const r = await s.readAutomations();
  assert.deepEqual(r.automations, [good]);
  assert.equal(r.problems.length, 3);
  assert.match(r.problems[0], /Automation 1 \(Broken\) trigger: minute/);
  assert.match(r.problems[1], /same id/);
  // A save keeps hand-written entries it does not understand.
  await s.updateAutomations((d) => ({ ...d, paused: true }));
  assert.equal(JSON.parse(await io.readTextFile(s.files.automations)).automations.length, 4);
});

test("a file that is not JSON is reported, not thrown", async (t) => {
  const root = await tempRoot();
  t.after(() => removeRoot(root));
  const s = store(root, io);
  await io.writeTextFile(s.files.automations, "{ nope", null);
  const r = await s.readAutomations();
  assert.equal(r.automations.length, 0);
  assert.match(r.problems[0], /not valid JSON/);
});

test("entry checks name what is wrong", () => {
  assert.equal(automationError(good), null);
  assert.equal(automationError({ ...good, kind: "agent", prompt: "Review", agent: "claude", model: "opus", args: ["--x"], workspace: "worktree", base: "main", catchUp: "2h", timeout: 5 }), null);
  assert.match(automationError({ ...good, folder: "rel" }), /absolute/);
  assert.match(automationError({ ...good, kind: "agent" }), /prompt/);
  assert.match(automationError({ ...good, command: " " }), /command/);
  assert.match(automationError({ ...good, trigger: { type: "file" } }), /trigger type/);
  assert.match(automationError({ ...good, args: "--x" }), /args/);
  assert.match(automationError({ ...good, catchUp: "soon" }), /catchUp/);
  assert.match(automationError({ ...good, id: "../x" }), /id/);
  assert.equal(automationError({ ...good, trigger: { type: "manual" } }), null);
});

test("state round trip, and a stale write is redone on the newer state", async (t) => {
  const root = await tempRoot();
  t.after(() => removeRoot(root));
  const s = store(root, io);
  assert.deepEqual(await s.readState(), { checked: {}, runs: {}, last: {}, worktrees: {} });
  await s.updateState((st) => ({ ...st, checked: { a: 1 } }));
  let calls = 0;
  const raw = await io.readTextFile(s.files.state);
  await s.updateState((st) => {
    // Another copy writes between this read and this write.
    if (calls++ === 0) fsWrite(s.files.state, JSON.stringify({ ...st, checked: { ...st.checked, other: 2 } }));
    return { ...st, checked: { ...st.checked, mine: 3 } };
  });
  assert.equal(calls, 2);
  assert.notEqual(raw, await io.readTextFile(s.files.state));
  assert.deepEqual((await s.readState()).checked, { a: 1, other: 2, mine: 3 });
});

test("history appends per day and reads newest first, skipping damaged lines", async (t) => {
  const root = await tempRoot();
  t.after(() => removeRoot(root));
  const s = store(root, io);
  const day1 = new Date(2026, 10, 24, 10).getTime(), day2 = new Date(2026, 10, 25, 10).getTime();
  await s.appendHistory({ at: day1, run: "r1", status: "running" });
  await s.appendHistory({ at: day1 + 1000, run: "r1", status: "ok" });
  await s.appendHistory({ at: day2, run: "r2", status: "failed" });
  const path = `${s.files.history}/2026-11-24.jsonl`;
  await io.writeTextFile(path, (await io.readTextFile(path)) + "{broken\n", await io.readTextFile(path));
  const events = await s.readHistory();
  assert.deepEqual(events.map((e) => [e.run, e.status]), [["r2", "failed"], ["r1", "ok"], ["r1", "running"]]);
  assert.deepEqual(latestRuns(events).map((e) => e.status), ["failed", "ok"]);
  assert.deepEqual((await s.readHistory(1)).map((e) => e.run), ["r2"]);
});

test("run files live in the Run's folder", async (t) => {
  const root = await tempRoot();
  t.after(() => removeRoot(root));
  const s = store(root, io);
  await s.writeRunFile("r1", "tail.txt", "hello");
  await s.writeRunFile("r1", "tail.txt", "again");
  assert.equal(await s.readRunFile("r1", "tail.txt"), "again");
  assert.equal(await s.readRunFile("r1", "exit"), null);
  assert.equal(s.runDir("r1"), `${root}/runs/r1`);
});
