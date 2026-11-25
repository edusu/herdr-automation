// Every sh and git command line of the mod lives here: the platform seam (macOS and Linux).
// User values are passed as arguments ("$1", environment variables, git argv), never pasted
// into a command line. `exec` is Herdr's exec(command, args, {cwd, timeout}) or a stand-in.

const envArgs = (env = {}) => Object.entries(env).map(([k, v]) => `${k}=${v ?? ""}`);

/**
 * The argv of a script Run's tab: `command` runs through sh in its own process, so an `exit`
 * in it ends only itself, and its exit code is then written to `exitFile` for the engine.
 * `env` is set for it through env(1), since a tab takes no environment of its own.
 */
export const scriptArgv = (command, exitFile, env) =>
  ["env", ...envArgs(env), "sh", "-c", 'sh -c "$1"; printf "%s" "$?" > "$2"', "sh", command, exitFile];

/** How shell text names an environment variable: double-quoted, so its value arrives as one literal word. */
export const shellRef = (name) => `"$${name}"`;

const failed = (e) => ({ code: -1, stdout: "", stderr: e?.message ?? String(e) });

/**
 * Runs a Check, pre- or post-script: `{inline}` through sh -c, or `{file}` (an absolute path)
 * as a program, with `env` added, in `cwd`, for at most `timeout` ms. Resolves
 * `{code, stdout, stderr}`; a script that cannot start or is cut off has code -1.
 */
export function runScript(exec, script, { cwd, env, timeout }) {
  // The file goes in as "$0" so a path with "=" or spaces is never read as an assignment by env(1).
  const argv = script.inline != null ? ["sh", "-c", script.inline] : ["sh", "-c", 'exec "$0"', script.file];
  return exec("env", [...envArgs(env), ...argv], { cwd, timeout }).catch(failed);
}

// A Run's worktree, and the repository after an agent worked in it, may hold a config or hook
// the agent planted; these keep git from running any program such config names. Credential
// helpers and ssh stay the person's own, so fetch works with their remotes.
const SAFE = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "core.pager=cat", "-c", "protocol.ext.allow=never", "-c", "diff.external="];
const git = (exec, cwd, args, timeout = 60000) => exec("git", [...SAFE, ...args], { cwd, timeout }).catch(failed);
const output = (r) => (r.stderr || r.stdout).trim();

/** The top folder of the repository `folder` is in, or null when it is not in one. */
export async function repoRoot(exec, folder) {
  const r = await git(exec, folder, ["rev-parse", "--show-toplevel"]);
  return r.code === 0 ? r.stdout.trim() : null;
}

/**
 * `{commit, branch}` of the checkout in `folder`, from one git process; empty strings outside a
 * repository or before its first commit, branch empty when detached.
 */
export async function head(exec, folder) {
  const r = await git(exec, folder, ["rev-parse", "HEAD", "--symbolic-full-name", "HEAD"]);
  if (r.code !== 0) return { commit: "", branch: "" };
  const [commit, ref = ""] = r.stdout.trim().split("\n");
  return { commit, branch: ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : "" };
}

// "origin/main": the branch the remote's HEAD names, from the fetched refs or else by asking it.
async function defaultBranch(exec, root, remote) {
  const local = await git(exec, root, ["symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`]);
  if (local.code === 0 && local.stdout.trim()) return local.stdout.trim();
  const r = await git(exec, root, ["ls-remote", "--symref", remote, "HEAD"], 120000);
  const m = /^ref: refs\/heads\/(\S+)\s+HEAD/m.exec(r.stdout);
  if (!m) throw new Error(`Cannot tell the default branch of ${remote}: ${output(r) || "no HEAD"}`);
  return `${remote}/${m[1]}`;
}

/**
 * Makes the worktree of a Run in the repository `root` (null when `folder` is not in one):
 * fetches `remote` (default: origin, else the first remote), then `git worktree add` at
 * `<dir>/<repo>/auto-<name>` on a new branch `auto/<name>` from `base` (default: the remote's
 * default branch; with no remote, HEAD). Resolves `{repo, path, branch, start}`, `start` being
 * the commit it started from. Rejects with git's output.
 */
export async function addWorktree(exec, { root, folder, remote, base, dir, name }) {
  if (!root) throw new Error(`${folder} is not a git repository, so it cannot have a worktree`);
  if (!remote) {
    const remotes = (await git(exec, root, ["remote"])).stdout.split("\n").map((s) => s.trim()).filter(Boolean);
    remote = remotes.includes("origin") ? "origin" : remotes[0];
  }
  if (remote) {
    const f = await git(exec, root, ["fetch", "--quiet", remote], 120000);
    if (f.code !== 0) throw new Error(`git fetch ${remote} failed: ${output(f)}`);
  }
  const ref = base || (remote ? await defaultBranch(exec, root, remote) : "HEAD");
  const c = await git(exec, root, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]);
  if (c.code !== 0) throw new Error(`The base "${ref}" is not a commit of ${root}`);
  const start = c.stdout.trim();
  const path = `${dir}/${root.split("/").pop()}/auto-${name}`, branch = `auto/${name}`;
  const w = await git(exec, root, ["worktree", "add", "--quiet", "-b", branch, path, start], 120000);
  if (w.code !== 0) throw new Error(`git worktree add failed: ${output(w)}`);
  return { repo: root, path, branch, start };
}

/**
 * The commit `remoteBranch` ("origin/main") points to on its remote, read with git ls-remote
 * from the repository in `folder` without touching the working copy. Rejects with the reason.
 */
export async function remoteCommit(exec, folder, remoteBranch) {
  const i = remoteBranch.indexOf("/"), remote = remoteBranch.slice(0, i), branch = remoteBranch.slice(i + 1);
  const r = await git(exec, folder, ["ls-remote", "--", remote, `refs/heads/${branch}`], 120000);
  if (r.code !== 0) throw new Error(`git ls-remote ${remote} failed: ${output(r)}`);
  const commit = r.stdout.split("\t")[0].trim();
  if (!commit) throw new Error(`${remoteBranch} is not a branch of ${remote}`);
  return commit;
}

/**
 * What the purge needs to know of a worktree `{repo, path, branch, start}`: `exists`, `dirty`
 * (uncommitted or untracked files) and `commits` (on its branch since `start`; null when unknown).
 */
export async function inspectWorktree(exec, wt) {
  const [s, n] = await Promise.all([
    git(exec, wt.path, ["status", "--porcelain"]),
    git(exec, wt.repo, ["rev-list", "--count", `${wt.start}..refs/heads/${wt.branch}`]),
  ]);
  return { exists: s.code === 0, dirty: s.code === 0 && s.stdout.trim() !== "", commits: n.code === 0 ? Number(n.stdout.trim()) : null };
}

/** Removes a worktree (`force`: with its changes) and, with `deleteBranch`, its branch. Resolves an error in words or null. */
export async function removeWorktree(exec, wt, { force = false, deleteBranch = false } = {}) {
  const r = await git(exec, wt.repo, ["worktree", "remove", ...(force ? ["--force"] : []), wt.path]);
  // Already gone from disk: git only has to forget it.
  if (r.code !== 0 && (await git(exec, wt.path, ["rev-parse", "--git-dir"])).code === 0) return `git worktree remove failed: ${output(r)}`;
  await git(exec, wt.repo, ["worktree", "prune"]);
  if (deleteBranch) {
    const b = await git(exec, wt.repo, ["branch", "-D", wt.branch]);
    if (b.code !== 0) return `git branch -D failed: ${output(b)}`;
  }
  return null;
}
