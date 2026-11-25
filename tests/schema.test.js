// automations.schema.json is for people and editors; store.js is what the mod checks. They must name the same fields.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { automationError, FIELDS, TRIGGER_FIELDS, SCRIPT_FIELDS } from "../mods/automation/store.js";

const root = new URL("..", import.meta.url).pathname;
const schema = JSON.parse(fs.readFileSync(root + "mods/automation/automations.schema.json", "utf8"));
const keys = (node) => Object.keys(node.properties).sort();

test("the schema and the validator know the same fields", () => {
  assert.deepEqual(keys(schema), ["$schema", "automations", "paused"]);
  const entry = schema.$defs.automation;
  assert.equal(entry.additionalProperties, false);
  assert.deepEqual(keys(entry), [...FIELDS].sort());
  assert.deepEqual(keys(schema.$defs.script), [...SCRIPT_FIELDS].sort());
  const triggers = Object.fromEntries(schema.$defs.trigger.oneOf.map((t) => [t.properties.type.const, keys(t)]));
  assert.deepEqual(Object.keys(triggers).sort(), Object.keys(TRIGGER_FIELDS).sort());
  for (const [type, fields] of Object.entries(TRIGGER_FIELDS)) assert.deepEqual(triggers[type], [...fields].sort(), type);
});

test("a field neither knows is reported", () => {
  const a = { id: "a", name: "A", kind: "script", folder: "/tmp", command: "true", trigger: { type: "manual" } };
  assert.match(automationError({ ...a, promt: "x" }), /unknown field "promt"/);
  assert.match(automationError({ ...a, trigger: { type: "manual", at: "09:00" } }), /trigger has an unknown field "at"/);
  assert.match(automationError({ ...a, post: { inline: "true", timout: 5 } }), /post has an unknown field "timout"/);
});

test("the README's examples are valid Automations", () => {
  const readme = fs.readFileSync(root + "README.md", "utf8");
  const blocks = [...readme.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => JSON.parse(m[1])).filter((b) => b.kind);
  assert.ok(blocks.length >= 2);
  for (const a of blocks) assert.equal(automationError(a), null, a.name);
});
