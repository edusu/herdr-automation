// The settings live in three places a person reads: mod.schema.json, DEFAULT_SETTINGS and the README table.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { DEFAULT_SETTINGS } from "../mods/automation/engine.js";

const root = new URL("..", import.meta.url).pathname;
const json = (p) => JSON.parse(fs.readFileSync(root + p, "utf8"));

// The README's "## Settings" table: key → default, as JSON.
function readmeTable() {
  const readme = fs.readFileSync(root + "README.md", "utf8");
  const section = readme.slice(readme.indexOf("\n## Settings\n")).split(/\n## /)[1];
  const rows = section.split("\n").filter((l) => /^\| `/.test(l));
  return Object.fromEntries(rows.map((l) => {
    const [, key, value] = /^\| `([^`]+)` \| `([^`]+)` \|/.exec(l);
    return [key, JSON.parse(value)];
  }));
}

test("mod.json points at its schema and ships without settings", () => {
  const manifest = json("mods/automation/mod.json");
  assert.equal(manifest.$schema, "./mod.schema.json");
  assert.equal(manifest.settings, undefined);
  const schema = json("mods/automation/mod.schema.json");
  for (const key of Object.keys(manifest)) assert.ok(schema.properties[key], `mod.schema.json does not describe ${key}`);
});

test("schema, DEFAULT_SETTINGS and the README table agree", () => {
  const described = json("mods/automation/mod.schema.json").properties.settings;
  assert.equal(described.additionalProperties, false);
  assert.deepEqual(Object.keys(described.properties).sort(), Object.keys(DEFAULT_SETTINGS).sort());
  for (const [key, spec] of Object.entries(described.properties)) {
    assert.ok(spec.title && spec.description && spec.type, `${key} needs a title, a description and a type`);
    assert.deepEqual(spec.default, DEFAULT_SETTINGS[key], `${key}: the schema and the code differ`);
    assert.equal(typeof spec.default, spec.type, `${key}'s default is not a ${spec.type}`);
    if (spec.enum) assert.ok(spec.enum.includes(spec.default), `${key}'s default is not one of its values`);
    if (spec.pattern) assert.match(spec.default, new RegExp(spec.pattern));
  }
  assert.deepEqual(readmeTable(), DEFAULT_SETTINGS);
});
