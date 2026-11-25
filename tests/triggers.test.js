import { test } from "node:test";
import assert from "node:assert/strict";
import { createEngine, LEASE_MS, LOCAL_GIT_MS } from "../mods/automation/engine.js";
import { agentFirings } from "../mods/automation/triggers.js";
import { RUN_LABEL } from "../mods/automation/runs.js";
import { store, automationError } from "../mods/automation/store.js";
import { io, exec, tempRoot, removeRoot, fakeHost, fakeLease, clock, git, commit, gitRepo, SETTINGS } from "./helpers.js";

const MIN = 60000;
const onAgent = (more) => ({ id: "ag", name: "After agent", kind: "script", folder: "/tmp", command: "true", trigger: { type: "agent", status: "done" }, ...more });
const onGit = (folder, more) => ({ id: "g", name: "On commit", kind: "agent", folder, prompt: "Look at {commit} ({trigger})", workspace: "folder", trigger: { type: "git", source: "local" }, ...more });
const agent = (status, more) => ({ address: "t9", status, app: "claude-code", program: "claude", space: "Work", folder: "/work/app", labels: {}, ...more });

async function setup(t, automations, { root, settings = SETTINGS } = {}) {
  root ??= await tempRoot();
  t.after(() => removeRoot(root));
  const s = store(`${root}/data`, io), host = fakeHost(), now = clock(new Date(2026, 10, 25, 9, 0).getTime()), lease = fakeLease();
  host.worktrees = `${root}/worktrees`;
  await s.updateAutomations(() => ({ paused: false, automations }));
  const make = (id = "one") => createEngine({ store: s, host, lease, id, settings: () => settings, now });
  return { s, host, now, lease, make, engine: make() };
}
const tick = async (e) => { const r = await e.tick(); await e.idle(); return r; };
const history = async (s) => (await s.readHistory()).reverse().map((e) => [e.status, e.reason ?? null, e.trigger]);
const setAutomations = (s, automations) => s.updateAutomations((d) => ({ ...d, automations }));

test("an agent changing status fires once, and not again while the status stays", async (t) => {
  const { s, host, engine } = await setup(t, [onAgent()]);
  host.agentList = [agent("working")];
  await tick(engine);
  host.agentList = [agent("done")];
  await tick(engine);
  await tick(engine);
  host.agentList = [agent("idle")];
  await tick(engine);
  assert.equal(host.opened.length, 1);
  assert.deepEqual(await history(s), [["running", null, "agent t9 done"]]);
});

test("a turn too short to be seen working still fires, by the terminal's count of turns", async (t) => {
  const { host, engine } = await setup(t, [onAgent()]);
  host.agentList = [agent("done", { turn: 1 })];
  await tick(engine);
  await tick(engine);
  assert.equal(host.opened.length, 0);
  host.agentList = [agent("idle", { turn: 2 })];
  await tick(engine);
  await tick(engine);
  assert.equal(host.opened.length, 1);
});

test("statuses already present when the engine starts do not fire", async (t) => {
  const { host, engine } = await setup(t, [onAgent(), onAgent({ id: "b", trigger: { type: "agent", status: "blocked" } })]);
  host.agentList = [agent("done"), agent("blocked", { address: "t10" })];
  await tick(engine);
  await tick(engine);
  assert.equal(host.opened.length, 0);
  host.agentList = [agent("done"), agent("working", { address: "t10" })];
  await tick(engine);
  host.agentList = [agent("done"), agent("blocked", { address: "t10" })];
  await tick(engine);
  assert.equal(host.opened.length, 1, "blocked again after working is a change");
});

test("the folder and app filters, and the loop guard", () => {
  const automations = [
    onAgent({ id: "any" }),
    onAgent({ id: "folder", folder: "/work/app", trigger: { type: "agent", status: "done", inFolder: true } }),
    onAgent({ id: "other", folder: "/work/other", trigger: { type: "agent", status: "done", inFolder: true } }),
    onAgent({ id: "claude", trigger: { type: "agent", status: "done", app: "claude" } }),
    onAgent({ id: "codex", trigger: { type: "agent", status: "done", app: "codex" } }),
    onAgent({ id: "blocked", trigger: { type: "agent", status: "blocked" } }),
  ];
  const fired = (now) => agentFirings({ seen: new Map([["t9", { status: "working", turn: 1 }]]), agents: [now], automations }).firings.map((f) => f.automation.id);
  assert.deepEqual(fired(agent("done", { folder: "/work/app/src" })), ["any", "folder", "claude"]);
  assert.deepEqual(fired(agent("done", { folder: "/work/application" })), ["any", "claude"], "a sibling folder with the same prefix is not inside");
  assert.deepEqual(fired(agent("blocked")), ["blocked"]);
  assert.deepEqual(fired(agent("done", { labels: { [RUN_LABEL]: "20261125-090000-abcd" } })), [], "an agent a Run started");
  assert.deepEqual(fired(agent("done", { space: "Automations" })), ["any", "folder", "claude"], "the space alone is no guard: a person's agent may work there");
});

test("agent-status and git Triggers are checked like the rest of automations.json", () => {
  assert.equal(automationError(onAgent({ trigger: { type: "agent", status: "blocked", inFolder: true, app: "codex" } })), null);
  assert.match(automationError(onAgent({ trigger: { type: "agent", status: "working" } })), /status/);
  assert.equal(automationError(onGit("/repo")), null);
  assert.equal(automationError(onGit("/repo", { trigger: { type: "git", source: "remote", branch: "origin/release/1.2" } })), null);
  for (const branch of [undefined, "main", "-o/main", "origin/--x", "origin/a..b", "origin/a b"])
    assert.match(automationError(onGit("/repo", { trigger: { type: "git", source: "remote", branch } })), /origin\/main/, String(branch));
  assert.match(automationError(onGit("/repo", { trigger: { type: "git" } })), /source/);
});

test("the agent's folder is where the Run works, as it is", async (t) => {
  const g = await gitRepo(t);
  const a = onAgent({ kind: "agent", folder: "/somewhere", prompt: "Review {folder} after {trigger}" });
  const { s, host, engine } = await setup(t, [a], { root: g.root });
  host.agentList = [agent("working", { folder: g.repo })];
  await tick(engine);
  host.agentList = [agent("done", { folder: g.repo })];
  await tick(engine);
  assert.equal(host.opened[0].folder, g.repo);
  assert.equal(host.opened[0].task, `Review ${g.repo} after agent t9 done`);
  assert.deepEqual((await s.readState()).worktrees, {}, "no worktree by default");
});

test("local git: the first look records, a new commit fires with it, a branch switch does not", async (t) => {
  const g = await gitRepo(t);
  const { s, host, now, engine } = await setup(t, [onGit(g.repo)], { root: g.root });
  now.add(LOCAL_GIT_MS);
  await tick(engine);
  assert.equal(host.opened.length, 0);
  assert.equal((await s.readState()).commits.g.commit, g.first);
  const second = await commit(g.repo, "two");
  now.add(LOCAL_GIT_MS);
  await tick(engine);
  assert.equal(host.opened.length, 1);
  assert.equal(host.opened[0].task, `Look at ${second} (git ${second.slice(0, 7)} on main)`);
  git(g.repo, "checkout", "-q", "-b", "side", g.first);
  now.add(LOCAL_GIT_MS);
  await tick(engine);
  assert.equal(host.opened.length, 1, "a branch switch is not a Trigger");
  assert.equal((await s.readState()).commits.g.branch, "side");
  await engine.stop(Object.keys((await s.readState()).runs)[0]);
  await commit(g.repo, "three");
  now.add(LOCAL_GIT_MS);
  await tick(engine);
  assert.equal(host.opened.length, 2);
});

test("remote git: a branch that moved fires at the poll interval, and the worktree starts at that commit", async (t) => {
  const g = await gitRepo(t, { remote: true });
  const a = onGit(g.repo, { workspace: undefined, trigger: { type: "git", source: "remote", branch: "origin/main" } });
  const { s, host, now, engine } = await setup(t, [a], { root: g.root, settings: { ...SETTINGS, gitPollInterval: "5m" } });
  await tick(engine);
  git(g.root, "clone", "-q", g.origin, "other");
  const ahead = await commit(`${g.root}/other`, "two");
  git(`${g.root}/other`, "push", "-q", "origin", "main");
  now.add(MIN);
  await tick(engine);
  assert.equal(host.opened.length, 0, "not read again before the interval");
  now.add(5 * MIN);
  await tick(engine);
  assert.equal(host.opened.length, 1);
  const [run] = Object.values((await s.readState()).runs);
  assert.equal(run.commit, ahead);
  assert.ok(run.worktree);
  assert.equal(git(run.worktree, "rev-parse", "HEAD"), ahead);
  assert.equal(git(g.repo, "rev-parse", "HEAD"), g.first, "the working copy is untouched");
});

test("remote git on another remote than origin: the worktree starts at the commit that fired", async (t) => {
  const g = await gitRepo(t, { remote: true });
  const upstream = `${g.root}/upstream.git`;
  git(g.root, "init", "-q", "--bare", "-b", "main", upstream);
  git(g.repo, "remote", "add", "upstream", upstream);
  git(g.repo, "push", "-q", "upstream", "main");
  const a = onGit(g.repo, { workspace: "worktree", trigger: { type: "git", source: "remote", branch: "upstream/main" } });
  const { s, host, now, engine } = await setup(t, [a], { root: g.root, settings: { ...SETTINGS, gitPollInterval: "5m" } });
  await tick(engine);
  git(g.root, "clone", "-q", upstream, "other");
  const ahead = await commit(`${g.root}/other`, "two");
  git(`${g.root}/other`, "push", "-q", "origin", "main");
  now.add(6 * MIN);
  await tick(engine);
  assert.equal(host.opened.length, 1, JSON.stringify((await s.readState()).last));
  const [run] = Object.values((await s.readState()).runs);
  assert.equal(git(run.worktree, "rev-parse", "HEAD"), ahead);
});

test("a failing git command does not fire, is reported once, and does not stop the others", async (t) => {
  const root = await tempRoot();
  const manual = { id: "m", name: "Every", kind: "script", folder: "/tmp", command: "true", trigger: { type: "schedule", preset: "every", minutes: 15 } };
  const { s, host, now, engine } = await setup(t, [onGit(root), manual], { root });
  await tick(engine);
  const { error } = (await s.readState()).commits.g;
  assert.match(error, /not a git repository/);
  const raw = await io.readTextFile(s.files.state);
  await tick(engine);
  assert.equal(await io.readTextFile(s.files.state), raw, "the same error is not written again");
  now.add(15 * MIN);
  await tick(engine);
  assert.equal(host.opened.length, 1);
  assert.equal(host.opened[0].name, "Every");
});

test("a firing while paused is skipped and not replayed", async (t) => {
  const g = await gitRepo(t);
  const { s, host, now, engine } = await setup(t, [onGit(g.repo, { enabled: false })], { root: g.root });
  now.add(LOCAL_GIT_MS);
  await tick(engine);
  const second = await commit(g.repo, "two");
  now.add(LOCAL_GIT_MS);
  await tick(engine);
  await setAutomations(s, [onGit(g.repo)]);
  now.add(LOCAL_GIT_MS);
  await tick(engine);
  assert.equal(host.opened.length, 0);
  assert.deepEqual(await history(s), [["skipped", "paused", `git ${second.slice(0, 7)} on main`]]);
});

test("a slow Check delays neither another Automation's Run nor the lease", async (t) => {
  const every = (id, more) => ({ id, name: id, kind: "script", folder: "/tmp", command: "true", timeout: 60, trigger: { type: "schedule", preset: "every", minutes: 15 }, ...more });
  const { s, host, now, make } = await setup(t, [every("slow", { check: { inline: "slow-check", timeout: 600 } }), every("quick")]);
  let release;
  const gate = new Promise((r) => { release = r; });
  host.exec = (cmd, args, o) => (args.includes("slow-check") ? gate.then(() => ({ code: 0, stdout: "", stderr: "" })) : exec(cmd, args, o));
  const a = make("a"), b = make("b");
  now.set(new Date(2026, 10, 25, 9, 14).getTime());
  await tick(a);
  now.set(new Date(2026, 10, 25, 9, 15, 5).getTime());
  await a.tick();
  for (let i = 0; i < 200 && host.opened.length < 1; i++) await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(host.opened.map((o) => o.name), ["quick"]);
  // The Check outlives the lease; the leader's ticks go on renewing it.
  for (let i = 0; i < 26; i++) {
    now.add(LEASE_MS / 2 + 1);
    assert.equal(await a.tick(), true);
    assert.equal(await b.tick(), false);
  }
  assert.equal(Object.values((await s.readState()).runs).find((r) => r.automation === "slow").status, "starting");
  // Still inside the Check's own timeout, so the Run is alive.
  now.set(new Date(2026, 10, 25, 9, 30, 1).getTime());
  await a.tick();
  release();
  await a.idle();
  assert.deepEqual(host.opened.map((o) => o.name), ["quick", "slow"]);
  const skipped = (await s.readHistory()).filter((e) => e.status === "skipped").map((e) => [e.automation, e.reason]).sort();
  assert.deepEqual(skipped, [["quick", "overlap"], ["slow", "overlap"]], "a Run still in its Check counts for overlap");
});
