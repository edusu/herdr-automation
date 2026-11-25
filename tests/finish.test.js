import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { notifies } from "../mods/automation/runs.js";
import { purgeOld } from "../mods/automation/engine.js";
import { store } from "../mods/automation/store.js";
import { io, tempRoot, removeRoot, fakeHost, clock, SETTINGS } from "./helpers.js";

const DAY = 24 * 60 * 60000;
const exists = (p) => fs.stat(p).then(() => true, () => false);

test("which Run statuses post a toast at each notification level", () => {
  const all = ["ok", "failed", "timed out", "blocked", "stopped", "closed", "skipped", "missed"];
  const at = (level) => all.filter((s) => notifies(level, s));
  assert.deepEqual(at("failures"), ["failed", "timed out", "blocked"]);
  assert.deepEqual(at("failures-and-skips"), ["failed", "timed out", "blocked", "skipped", "missed"]);
  assert.deepEqual(at("all"), all);
  assert.deepEqual(at("never"), []);
  // An unknown level reads as the default.
  assert.deepEqual(at("loud"), at("failures"));
});

test("history days and run folders past historyRetention go, except a Run going or with a worktree", async (t) => {
  const root = await tempRoot();
  t.after(() => removeRoot(root));
  const s = store(root, io), now = clock(new Date(2026, 10, 25, 12).getTime());
  const ctx = { host: fakeHost(), store: s, settings: { ...SETTINGS, historyRetention: "30d" }, now };
  const old = now() - 40 * DAY, recent = now() - 2 * DAY;
  await s.appendHistory({ at: old, run: "x", status: "ok" });
  await s.appendHistory({ at: recent, run: "y", status: "ok" });
  for (const id of ["20261016-090000-aaaa", "20261016-090000-bbbb", "20261016-090000-cccc", "20261123-090000-dddd"]) await s.writeRunFile(id, "tail.txt", "x");
  await s.updateState((st) => ({ ...st, runs: { "20261016-090000-bbbb": { id: "20261016-090000-bbbb", status: "running" } }, worktrees: { "20261016-090000-cccc": { path: "/x" } } }));
  await purgeOld(ctx);
  assert.deepEqual((await fs.readdir(s.files.history)).sort(), ["2026-11-23.jsonl"]);
  assert.deepEqual((await fs.readdir(s.files.runs)).sort(), ["20261016-090000-bbbb", "20261016-090000-cccc", "20261123-090000-dddd"]);
  assert.ok(await exists(`${s.runDir("20261016-090000-bbbb")}/tail.txt`));
});

test("deleting an Automation forgets what the engine kept for it", async (t) => {
  const root = await tempRoot();
  t.after(() => removeRoot(root));
  const s = store(root, io);
  const a = { id: "a", name: "A", kind: "script", folder: "/tmp", command: "true", trigger: { type: "git", source: "local" } };
  await s.updateAutomations((d) => ({ ...d, automations: [a, { ...a, id: "b" }] }));
  await s.updateState((st) => ({ ...st, commits: { a: { commit: "1" }, b: { commit: "2" } }, checked: { a: 1, b: 2 } }));
  await s.deleteAutomation("a");
  assert.deepEqual((await s.readAutomations()).automations.map((x) => x.id), ["b"]);
  const st = await s.readState();
  assert.deepEqual([st.commits, st.checked], [{ b: { commit: "2" } }, { b: 2 }]);
});
