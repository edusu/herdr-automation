import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { startRun, finishRun, mainStep } from "../mods/automation/runs.js";
import { store, automationError } from "../mods/automation/store.js";
import { io, tempRoot, removeRoot, fakeHost, clock, SETTINGS } from "./helpers.js";

// A value no shell may run: quotes of both kinds and a command substitution.
const NASTY = `it's "q" $(touch pwned) \`touch pwned\``;
const q = (s) => `'${s.replaceAll("'", `'\\''`)}'`;

async function setup(t) {
  const root = await tempRoot();
  t.after(() => removeRoot(root));
  const host = fakeHost(), s = store(`${root}/data`, io);
  return { root, host, s, ctx: { host, store: s, settings: SETTINGS, now: clock(1000) } };
}
const script = (root, more) => ({ id: "a", name: "Job", kind: "script", folder: root, command: "true", trigger: { type: "manual" }, ...more });
const log = (root, word) => ({ inline: `echo ${word} >> ${q(`${root}/log`)}` });

test("the pipeline runs Check, pre-script, the main step, then the post-script", async (t) => {
  const { root, host, s, ctx } = await setup(t);
  const a = script(root, { check: log(root, "check"), pre: log(root, "pre"), post: log(root, "post") });
  const run = await startRun(ctx, a, "manual");
  assert.equal(run.status, "running");
  assert.equal(host.opened.length, 1);
  assert.equal(await io.readTextFile(`${root}/log`), "check\npre\n");
  const ended = await finishRun(ctx, run, { status: "ok" });
  assert.equal(ended.status, "ok");
  assert.equal(await io.readTextFile(`${root}/log`), "check\npre\npost\n");
  assert.deepEqual((await s.readHistory()).map((e) => e.status), ["ok", "running"]);
});

test("a Check that does not exit 0 skips the Run with its first line", async (t) => {
  const { root, host, s, ctx } = await setup(t);
  const r = await startRun(ctx, script(root, { check: { inline: "echo nothing to do; echo more; exit 1" }, pre: log(root, "pre") }), "manual");
  assert.deepEqual([r.status, r.reason], ["skipped", "nothing to do"]);
  assert.equal(host.opened.length, 0);
  assert.equal(await io.readTextFile(`${root}/log`), null);
  assert.equal(await s.readRunFile(r.id, "check.txt"), "nothing to do\nmore\n");
  assert.equal(host.toasts.length, 0);
});

test("a failing pre-script fails the Run before any tab", async (t) => {
  const { root, host, s, ctx } = await setup(t);
  const r = await startRun(ctx, script(root, { pre: { inline: "echo boom >&2; exit 2" } }), "manual");
  assert.deepEqual([r.status, r.reason], ["failed", "Pre-script: boom"]);
  assert.equal(host.opened.length, 0);
  assert.equal(await s.readRunFile(r.id, "pre.err.txt"), "boom\n");
  // A file that is not there fails it too.
  const f = await startRun(ctx, script(root, { pre: { file: "missing.sh" } }), "manual");
  assert.equal(f.status, "failed");
});

test("a failing post-script fails an ok Run", async (t) => {
  const { root, ctx } = await setup(t);
  const run = await startRun(ctx, script(root, { post: { inline: "echo cannot publish; exit 1" } }), "manual");
  const ended = await finishRun(ctx, run, { status: "ok" });
  assert.deepEqual([ended.status, ended.reason], ["failed", "Post-script: cannot publish"]);
});

test("requireResult fails an ok Run without a result file", async (t) => {
  const { root, s, ctx } = await setup(t);
  const a = script(root, { requireResult: true });
  const first = await startRun(ctx, a, "manual");
  assert.equal((await finishRun(ctx, first, { status: "ok" })).status, "failed");
  const second = await startRun(ctx, a, "manual");
  await s.writeRunFile(second.id, "result.md", "Done.");
  assert.equal((await finishRun(ctx, second, { status: "ok" })).status, "ok");
});

test("variables reach prompts, commands and scripts literally", async (t) => {
  const { root, host, s, ctx } = await setup(t);
  const a = script(root, {
    pre: { inline: `printf '%s' ${q(NASTY)}` },
    command: `printf '%s|%s|%s' {pre} {trigger} "$HERDR_AUTO_NAME" > {run_dir}/out`,
    post: { inline: `printf '%s|%s|%s' {pre} "$HERDR_AUTO_STATUS" "$HERDR_AUTO_RESULT" > ${q(`${root}/post`)}` },
  });
  const run = await startRun(ctx, a, "manual");
  const { argv } = host.opened[0];
  execFileSync(argv[0], argv.slice(1), { cwd: root });
  assert.equal(await s.readRunFile(run.id, "out"), `${NASTY}|manual|Job`);
  assert.equal(await s.readRunFile(run.id, "exit"), "0");
  await s.writeRunFile(run.id, "result.md", "all good");
  await finishRun(ctx, run, { status: "ok" });
  assert.equal(await io.readTextFile(`${root}/post`), `${NASTY}|ok|all good`);
  assert.equal(await io.readTextFile(`${root}/pwned`), null);
});

test("an agent's prompt gets the values and Claude Code may write in the Run's folder", () => {
  const vars = { pre: NASTY, run_dir: "/data/runs/r1", result_file: "/data/runs/r1/result.md", folder: "/repo" };
  const step = mainStep({ kind: "agent", prompt: "Read {pre}, write {result_file} in {folder}; keep {other}" }, {
    agents: [{ key: "claude", run: ["claude"], installed: true }], settings: SETTINGS, vars,
  });
  assert.deepEqual(step.argv, ["claude", "--add-dir", "/data/runs/r1"]);
  assert.equal(step.task, `Read ${NASTY}, write /data/runs/r1/result.md in /repo; keep {other}`);
});

test("scripts get the HERDR_AUTO_* environment", async (t) => {
  const { root, s, ctx } = await setup(t);
  const names = ["FOLDER", "TRIGGER", "COMMIT", "BRANCH", "DATE", "PRE", "CHECK", "RESULT_FILE", "RUN_DIR", "NAME", "RUN_ID"];
  const a = script(root, { check: { inline: "echo yes" }, pre: { inline: `env | grep '^HERDR_AUTO_' | sort` } });
  const run = await startRun(ctx, a, "manual");
  const env = Object.fromEntries((await s.readRunFile(run.id, "pre.txt")).trim().split("\n").map((l) => l.split(/=(.*)/s).slice(0, 2)));
  assert.deepEqual(Object.keys(env).sort(), names.map((n) => `HERDR_AUTO_${n}`).sort());
  assert.equal(env.HERDR_AUTO_CHECK, "yes");
  assert.equal(env.HERDR_AUTO_RUN_ID, run.id);
  assert.equal(env.HERDR_AUTO_RESULT_FILE, `${s.runDir(run.id)}/result.md`);
});

test("check, pre and post are validated", () => {
  const a = { id: "a", name: "A", kind: "script", folder: "/tmp", command: "true", trigger: { type: "manual" } };
  assert.equal(automationError({ ...a, check: { inline: "true", timeout: 30 }, post: { file: "post.sh" }, requireResult: true }), null);
  assert.match(automationError({ ...a, pre: { inline: "x", file: "y" } }), /^pre needs either/);
  assert.match(automationError({ ...a, post: { inline: "x", timeout: 601 } }), /^post timeout/);
  assert.match(automationError({ ...a, check: "true" }), /^check must be an object/);
  assert.match(automationError({ ...a, base: "--upload-pack=x" }), /base/);
});
