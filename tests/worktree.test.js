import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { startRun, finishRun } from "../mods/automation/runs.js";
import { purgeWorktrees, purgeDecision } from "../mods/automation/engine.js";
import { store } from "../mods/automation/store.js";
import { io, fakeHost, clock, git, commit, gitRepo, SETTINGS } from "./helpers.js";

const DAY = 24 * 60 * 60000;
const agent = (folder, more) => ({ id: "w", name: "Nightly Review", kind: "agent", folder, prompt: "Review {branch} at {commit}", trigger: { type: "manual" }, ...more });

async function setup(t, options) {
  const g = await gitRepo(t, options);
  const host = fakeHost();
  host.worktrees = `${g.root}/worktrees`;
  const s = store(`${g.root}/data`, io), now = clock(Date.now());
  return { ...g, host, s, now, ctx: { host, store: s, settings: { ...SETTINGS, worktreeRetention: "7d" }, now } };
}
const exists = (p) => fs.stat(p).then(() => true, () => false);
const branches = (repo) => git(repo, "branch", "--format=%(refname:short)").split("\n");

test("an agent in a repository works in a new worktree from the remote's default branch", async (t) => {
  const { root, repo, origin, host, s, ctx } = await setup(t, { remote: true });
  // origin/main moves on without the local checkout knowing.
  git(root, "clone", "-q", origin, "other");
  const ahead = await commit(`${root}/other`, "two");
  git(`${root}/other`, "push", "-q", "origin", "main");
  const run = await startRun(ctx, agent(repo), "manual");
  assert.equal(run.status, "running", run.reason);
  assert.equal(run.worktree, `${root}/worktrees/repo/auto-nightly-review-${run.id}`);
  assert.equal(run.branch, `auto/nightly-review-${run.id}`);
  assert.equal(run.commit, ahead);
  assert.equal(host.opened[0].folder, run.worktree);
  assert.equal(host.opened[0].task, `Review ${run.branch} at ${ahead}`);
  assert.equal(git(run.worktree, "rev-parse", "HEAD"), ahead);
  const wt = (await s.readState()).worktrees[run.id];
  assert.deepEqual([wt.repo, wt.path, wt.branch, wt.start], [repo, run.worktree, run.branch, ahead]);
});

test("a worktree starts from the given base, or from HEAD with no remote", async (t) => {
  const { repo, first, ctx } = await setup(t);
  git(repo, "checkout", "-q", "-b", "feature");
  const feature = await commit(repo, "feature");
  git(repo, "checkout", "-q", "main");
  const given = await startRun(ctx, agent(repo, { base: "feature" }), "manual");
  assert.equal(git(given.worktree, "rev-parse", "HEAD"), feature);
  await finishRun(ctx, given, { status: "ok" });
  const fallback = await startRun(ctx, agent(repo), "manual");
  assert.equal(git(fallback.worktree, "rev-parse", "HEAD"), first);
});

test("a worktree that cannot be made fails the Run with git's words; a folder that is not a repository runs as it is", async (t) => {
  const { root, repo, host, ctx } = await setup(t);
  const bad = await startRun(ctx, agent(repo, { base: "nope" }), "manual");
  assert.deepEqual([bad.status, host.opened.length], ["failed", 0]);
  assert.match(bad.reason, /base "nope" is not a commit/);
  await fs.mkdir(`${root}/plain`);
  const refused = await startRun(ctx, agent(`${root}/plain`, { id: "p", workspace: "worktree" }), "manual");
  assert.match(refused.reason, /is not a git repository/);
  const plain = await startRun(ctx, agent(`${root}/plain`, { id: "q" }), "manual");
  assert.deepEqual([plain.status, plain.worktree, host.opened[0].folder], ["running", undefined, `${root}/plain`]);
});

test("the purge keeps young and dirty worktrees, removes old clean ones and deletes branches without commits", async (t) => {
  const { repo, s, now, ctx } = await setup(t);
  const make = async (id) => {
    const run = await startRun(ctx, agent(repo, { id }), "manual");
    await finishRun(ctx, run, { status: "ok" });
    return run;
  };
  const [clean, dirty, worked] = [await make("clean"), await make("dirty"), await make("worked")];
  await fs.writeFile(`${dirty.worktree}/notes.txt`, "unsaved");
  await commit(worked.worktree, "fix");
  now.add(DAY);
  await purgeWorktrees(ctx);
  assert.equal(Object.keys((await s.readState()).worktrees).length, 3);
  assert.ok(await exists(clean.worktree));

  now.add(7 * DAY);
  await purgeWorktrees(ctx);
  const { worktrees } = await s.readState();
  assert.deepEqual(Object.keys(worktrees), [dirty.id]);
  assert.equal(worktrees[dirty.id].review, true);
  assert.ok(await exists(dirty.worktree));
  assert.ok(!(await exists(clean.worktree)) && !(await exists(worked.worktree)));
  const left = branches(repo);
  assert.ok(!left.includes(clean.branch));
  assert.ok(left.includes(worked.branch) && left.includes(dirty.branch));
});

test("the purge decision", () => {
  const wt = { created: 0 };
  assert.equal(purgeDecision(wt, { exists: true, dirty: true }, DAY, 7 * DAY), "keep");
  assert.equal(purgeDecision(wt, { exists: true, dirty: false }, 8 * DAY, 7 * DAY), "remove");
  assert.equal(purgeDecision(wt, { exists: true, dirty: true }, 8 * DAY, 7 * DAY), "review");
  assert.equal(purgeDecision(wt, { exists: false, dirty: false }, 8 * DAY, 7 * DAY), "remove");
});
