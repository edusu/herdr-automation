# Automations

A [Herdr](https://herdr.dev/) mod that starts a coding agent or a script when its Trigger fires (a schedule or Run now), shows the work in a tab of the `Automations` space, and keeps a history of every Run. The design is in [docs/prd.md](docs/prd.md), the vocabulary in [GLOSSARY.md](GLOSSARY.md).

Work in progress: agent-status and git Triggers, the settings schema and the full install recipe come in later slices.

## Worktrees and scripts

An agent Automation whose folder is a git repository works, by default, in a new worktree per Run: `git fetch`, then `git worktree add` at `<worktrees.directory of Herdr's settings.json, default ~/.herdr/worktrees>/<repo>/auto-<name>-<run id>` on branch `auto/<name>-<run id>`, from `base` (default: the remote's default branch; HEAD with no remote). Set `"workspace": "folder"` to work in the folder as it is. After `worktreeRetention` a clean worktree is removed, with its branch when the branch has no commits of its own; a dirty one stays and its Run shows "needs review".

`check`, `pre` and `post` are each `{"inline": "shell text"}` or `{"file": "path"}` (relative to the Automation's folder, run as a program), with an optional `"timeout"` in seconds (default 60, at most 600). Check and pre-script run in the Automation's folder before the worktree exists; the post-script runs where the Run worked.

Variables (`{pre}`, `{check}`, `{folder}`, `{trigger}`, `{commit}`, `{branch}`, `{date}`, `{result_file}`, `{run_dir}`) are pasted as text into an agent's prompt. In shell text (a script's command, inline scripts) each one becomes a quoted reference to its environment variable, `{pre}` → `"$HERDR_AUTO_PRE"`, so a value with quotes or `$(...)` arrives as data and never runs. Write them unquoted: `git log {commit}`, not `git log '{commit}'`. Scripts also get `HERDR_AUTO_NAME` and `HERDR_AUTO_RUN_ID`, and the post-script `HERDR_AUTO_STATUS`, `HERDR_AUTO_REASON`, `HERDR_AUTO_RESULT` (the first 8 KB of the result file), `HERDR_AUTO_TAIL_FILE` and `HERDR_AUTO_TERMINAL`. `{pre}` and `{check}` are cut at 64 KB.

## Try it

```sh
npm test                  # node --test, no packages
./sync.sh                 # copies mods/automation into ~/.config/herdr-app/mods/automation, keeping its settings
herdr-app check ~/.config/herdr-app/mods/automation
```

The mod has `"place": "none"`: put an `automation` block in a layout to show the panel, or open it as a dialog with `mod.open {name: "automation"}`. Automations, history and run folders live in `~/.config/herdr-app/data/automation/`.
