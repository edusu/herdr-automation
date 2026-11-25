# Herdr Automation: product requirements

A Herdr app mod (`automation`) that starts a coding agent or a script when a Trigger fires, shows the work in a tab of a dedicated space, and keeps a history of every Run. Vocabulary is in [GLOSSARY.md](../GLOSSARY.md); the two structural decisions are in [docs/adr](adr/).

It combines the parts we liked of four projects: worktree per run, wall-clock catch-up and "missed" (DnzzL/herdr-automations); triggers, check / pre / post scripts, result file and variables (dougcunha/automations-app); visible, history-first runs (kimsuhan/herdr-scheduler); script automations and tidy-up after success (lucasprag/herdr-automate-everything).

## Scope

- A Herdr mod in JavaScript only. No daemon (ADR 1). Runs happen only while Herdr is open.
- macOS and Linux, through `sh`. No Windows. All shell and git commands sit behind one module.
- One computer. No remote machines.

## An Automation

| Field | Meaning |
| --- | --- |
| `id`, `name`, `enabled` | Identity and the pause switch. |
| `kind` | `agent` (a prompt for a coding agent) or `script` (a shell command). |
| `folder` | Where it applies. For a worktree run, the repository. |
| `trigger` | Exactly one (below). Every Automation also has **Run now**. |
| `agent`, `model`, `args` | Agent kind: an entry of Herdr's `knownAgents()`, an optional model (passed as `--model`), extra arguments. The agent defaults to the global setting. |
| `prompt` | Agent kind: the first message, with variables (below). |
| `command` | Script kind: the shell command. |
| `workspace` | `worktree` (a new git worktree per Run) or `folder` (the folder as it is). |
| `base` | Worktree only: the ref the worktree starts from. Default: the remote's default branch, fetched first. |
| `check`, `pre`, `post` | Optional scripts: a file path or inline shell, each with a timeout in seconds. |
| `timeout` | Minutes. Defaults come from the settings (60 for agents, 10 for scripts). |
| `catchUp` | A duration such as `"2h"`, or absent. |
| `requireResult` | Off by default. On: a Run that ends without a result file has failed. |

Defaults for `workspace`: `worktree` for an agent Automation whose folder is a git repository; `folder` for script Automations, for a folder that is not a repository (worktree is then not offered), and for the agent-status trigger (the Run must see that agent's uncommitted work, in the folder of the agent that fired it).

## Triggers

One per Automation.

- **Schedule**: every N minutes, daily at a time, chosen weekdays at a time, or a 5-field cron (`minute hour day month weekday`; `*`, numbers, ranges, lists, steps). Always the computer's local time. The form previews the next three times.
- **Manual**: only Run now.
- **Agent status**: an agent changes to *done* or to *needs you* (blocked). Optional filters: only agents in the Automation's folder, and the agent app (`claude`, `codex`…). An agent started by an Automation never fires one, so two Automations cannot start each other.
- **Git**: a new commit on the current branch of the local repository, or new commits on a remote branch (for example `origin/main`, read with `git ls-remote` on the settings' interval). A branch switch is not a trigger. The first observation only records the commit; it does not fire. A worktree Run started by this trigger starts from the commit that fired it.

## A Run

1. **Check**: exit code 0 goes on. Any other code skips the Run; the first line of its output is the reason shown in the history.
2. **Pre-script**: a failure fails the Run. Its output is `{pre}`.
3. **Workspace**: for `worktree`, `git fetch`, then `git worktree add` at `<worktrees dir>/<repo>/auto-<name>-<stamp>` on branch `auto/<name>-<stamp>`. The worktrees dir is `worktrees.directory` of Herdr's settings.json, default `~/.herdr/worktrees`.
4. **Main step**, in a tab: the agent with its prompt, or the script's command. The tab is opened without taking focus, in the space named by the settings (default `Automations`), which is created if it does not exist.
5. **Post-script**: runs with the status and the result. A failure fails the Run.

Check, pre-script and post-script run without a tab; their output is saved with the Run.

Rules:

- **One live tab per Automation.** Starting a Run closes the tab of that Automation's previous Run if that Run has ended. A tab of a Run that is still going is never closed by the mod.
- **End of an agent Run**: the agent finishes its turn (*done*) → `ok`. The agent needs the person → `blocked`: a toast, the tab stays, and the Run goes on when the agent works again. Agents start in their normal interactive mode; nothing skips permissions unless the Automation's extra arguments say so.
- **End of a script Run**: the command's exit code; 0 is `ok`.
- **Timeout**: after it, the Run is `timed out` and the tab stays open.
- **Stop** in the panel ends the Run's terminal → `stopped`. Closing the tab by hand → `closed`.
- **Overlap**: a Trigger that fires while that Automation's previous Run is still going is skipped and recorded. Nothing is queued.
- **Catch-up**: a scheduled time that passed while Herdr was closed starts once, late, if it is within `catchUp`; otherwise it is recorded as `missed`. Default `catchUp`: 2 hours for daily and weekday schedules, none for "every N minutes" and cron.
- **Pauses**: a switch per Automation and one for everything. What comes due while paused is recorded as skipped and is not replayed.
- **Several Herdr windows**: only one copy of the mod fires Runs (a lease in Herdr's shared state); the others only show.

Run statuses: `running`, `blocked`, `ok`, `failed`, `timed out`, `stopped`, `closed`, `skipped` (with a reason: check, overlap, paused), `missed`.

### Variables

The prompt, the command and inline scripts can use `{pre}`, `{check}`, `{folder}` (where the Run works: the worktree or the folder), `{trigger}`, `{commit}`, `{branch}`, `{date}`, `{result_file}` and `{run_dir}`.

Scripts get the same values as environment variables: `HERDR_AUTO_FOLDER`, `HERDR_AUTO_TRIGGER`, `HERDR_AUTO_COMMIT`, `HERDR_AUTO_BRANCH`, `HERDR_AUTO_DATE`, `HERDR_AUTO_PRE`, `HERDR_AUTO_CHECK`, `HERDR_AUTO_RESULT_FILE`, `HERDR_AUTO_RUN_DIR`, plus `HERDR_AUTO_NAME` and `HERDR_AUTO_RUN_ID`. The post-script also gets `HERDR_AUTO_STATUS`, `HERDR_AUTO_REASON`, `HERDR_AUTO_RESULT` (the first 8 KB of the result file), `HERDR_AUTO_TAIL_FILE` and `HERDR_AUTO_TERMINAL`.

Each Run has its own folder; the result file is `<run_dir>/result.md`. The built-in Claude Code command adds `--add-dir {run_dir}` so the agent may write there.

## Worktrees and branches after a Run

- A worktree is kept for the settings' retention (default 7 days), then removed if it is clean.
- A worktree with uncommitted changes is never removed by the mod: the panel marks its Run as needing review.
- A branch `auto/...` with no commits of its own is deleted with its worktree. A branch with commits stays until the person merges or deletes it.
- The history row has **Remove worktree** for doing it by hand (asks first when it is dirty).

## The panel

A dock panel on the right, placed like Notes and Calendar (a hidden block of the panel stack with a button), and the same view as a dialog from `cmd-shift-a` (`mod.open:automation`).

- **Header**: the pause-everything switch and **+**.
- **List**: each Automation with its trigger in words, the next time, how the last Run went, how long a current Run has been going, an on/off switch, **Run now**, and **Go to tab** (the tab of its last Run, when still open).
- **Detail**: Run now, Stop, Edit, Delete (asks first), and the history: each Run with status, trigger, start, duration and reason. A click goes to the Run's tab when it is still open; otherwise it shows the saved output (check, pre, post, the last 200 lines of the terminal, the result file), the branch and the worktree path, with **Open a tab here** while the worktree exists and **Remove worktree**.
- **Form**: the fields above, the folder through Herdr's folder picker, schedule presets or cron with the next three times, and validation before saving.
- **Toasts**: by the settings' notification level. A click opens the Run.

## Files

All under `~/.config/herdr-app/data/automation/` (ADR 2):

- `automations.json`: `{ "paused": false, "automations": [...] }`. Editable by hand; read again within 30 seconds. `automations.schema.json` in the mod's folder describes it.
- `history/<YYYY-MM-DD>.jsonl`: one line per Run event; kept for the settings' retention (default 30 days).
- `runs/<run id>/`: `result.md`, the scripts' outputs, the terminal's tail. Removed with its history.
- `state.json`: what the engine must remember between starts (last times checked, last commits seen, worktrees to purge).

## Settings

In `mod.json` → `settings`, described by `mod.schema.json`, with defaults in the code's `DEFAULT_SETTINGS` and a table in the README; a test keeps the three in step. Editable from Better Config.

| Setting | Default | Meaning |
| --- | --- | --- |
| `agent` | `"claude"` | The agent of a new Automation. |
| `space` | `"Automations"` | The space that holds the Runs' tabs. |
| `worktreeRetention` | `"7d"` | How long a Run's worktree is kept. |
| `historyRetention` | `"30d"` | How long history and run folders are kept. |
| `notifications` | `"failures"` | `failures` (also when an agent needs you), `failures-and-skips`, `all`, `never`. |
| `gitPollInterval` | `"5m"` | How often remote branches are read. |
| `agentTimeout` | `"60m"` | Default timeout of an agent Automation. |
| `scriptTimeout` | `"10m"` | Default timeout of a script Automation. |

## Repository

The layout of the `herdr-mods` repository: `mods/automation/` (what Herdr loads: `main.js`, `mod.json`, `mod.schema.json`, `settings.js`, the engine's modules, icons), `tests/` (`node --test`, Herdr's API injected or stubbed), `README.md`, `RECIPE.md` (for the agent that installs it), `sync.sh`.

## Out of scope for version 1

Runs with Herdr closed; file-change triggers; several triggers per Automation; jobs written as JavaScript; resuming an agent's conversation from the history; a skill that teaches agents the file format (after the format has settled); time zones per Automation; Windows; remote machines.

## Phases

1. **Engine and panel**: schedule and manual triggers, agent and script Automations in tabs of the space, in the folder as it is; overlap, catch-up, missed, pauses, timeout, Stop, the leader lease; history; the panel with list, detail and form.
2. **Worktrees and pipeline**: worktree per Run with its base, retention and purge, branch cleanup, the needs-review mark; check, pre-script and post-script; variables and the result file.
3. **Triggers**: agent status and git (local and remote).
4. **Settings and finish**: the settings schema and its test, `automations.schema.json` with validation, the dialog and its key, notification levels, README and RECIPE.
