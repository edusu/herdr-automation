import { test } from "node:test";
import assert from "node:assert/strict";
import { formTrigger, catchUpText, catchUpValue } from "../mods/automation/views/form-model.js";
import { automationError } from "../mods/automation/store.js";

const input = (text) => ({ value: () => text });
const form = (more) => ({
  preset: "daily", agentStatus: "done", inFolder: false, app: input(""), gitSource: "local", gitBranch: input("origin/main"),
  minutes: input("15"), at: input(" 09:30 "), cron: input("0 9 * * 1-5"), days: [5, 1], ...more,
});

test("the form's Trigger for each preset", () => {
  assert.deepEqual(formTrigger(form()), { type: "schedule", preset: "daily", at: "09:30" });
  assert.deepEqual(formTrigger(form({ preset: "every" })), { type: "schedule", preset: "every", minutes: 15 });
  assert.deepEqual(formTrigger(form({ preset: "weekdays" })), { type: "schedule", preset: "weekdays", at: "09:30", days: [1, 5] });
  assert.deepEqual(formTrigger(form({ preset: "cron" })), { type: "schedule", preset: "cron", cron: "0 9 * * 1-5" });
  assert.deepEqual(formTrigger(form({ preset: "manual" })), { type: "manual" });
  assert.deepEqual(formTrigger(form({ preset: "interval", interval: input(" 24h ") })), { type: "interval", every: "24h" });
  assert.deepEqual(formTrigger(form({ preset: "agent", inFolder: true, app: input(" codex ") })), { type: "agent", status: "done", inFolder: true, app: "codex" });
  assert.deepEqual(formTrigger(form({ preset: "git", gitSource: "remote" })), { type: "git", source: "remote", branch: "origin/main" });
  assert.equal(formTrigger(form({ preset: "git" })).branch, undefined);
});

test("catchUp goes from an Automation to the form and back unchanged", () => {
  for (const catchUp of [undefined, "", "2h"]) assert.equal(catchUpValue(catchUpText(catchUp)), catchUp);
  assert.equal(catchUpText(false), "none");
  assert.equal(catchUpValue("0"), "");
  const a = { id: "a", name: "A", kind: "script", folder: "/tmp", command: "true", trigger: formTrigger(form()) };
  assert.equal(automationError({ ...a, catchUp: catchUpValue("none") }), null);
});
