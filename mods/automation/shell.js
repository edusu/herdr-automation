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

const git = (exec, cwd, args, timeout = 60000) => exec("git", args, { cwd, timeout }).catch(failed);
const output = (r) => (r.stderr || r.stdout).trim();

/** The top folder of the repository `folder` is in, or null when it is not in one. */
export async function repoRoot(exec, folder) {
  const r = await git(exec, folder, ["rev-parse", "--show-toplevel"]);
  return r.code === 0 ? r.stdout.trim() : null;
}

/** `{commit, branch}` of the checkout in `folder`; empty strings outside a repository, branch empty when detached. */
export async function head(exec, folder) {
  const [c, b] = await Promise.all([git(exec, folder, ["rev-parse", "HEAD"]), git(exec, folder, ["symbolic-ref", "--quiet", "--short", "HEAD"])]);
  return { commit: c.code === 0 ? c.stdout.trim() : "", branch: b.code === 0 ? b.stdout.trim() : "" };
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
 * Makes the worktree of a Run: fetches the remote, then `git worktree add` at
 * `<dir>/<repo>/auto-<name>` on a new branch `auto/<name>` from `base` (default: the remote's
 * default branch; with no remote, HEAD). Resolves `{repo, path, branch, start}`, `start` being
 * the commit it started from. Rejects with git's output.
 */
export async function addWorktree(exec, { folder, base, dir, name }) {
  const root = await repoRoot(exec, folder);
  if (!root) throw new Error(`${folder} is not a git repository, so it cannot have a worktree`);
  const remotes = (await git(exec, root, ["remote"])).stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  const remote = remotes.includes("origin") ? "origin" : remotes[0];
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
