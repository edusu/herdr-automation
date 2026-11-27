# Automations

A [Herdr](https://herdr.dev/) mod that starts a coding agent or a script when something happens: a time, Run now, an agent finishing or needing you, or a new git commit. Each Run opens as a tab in the `Automations` space, can work in a fresh git worktree, and leaves a history with its output. The design is in [docs/prd.md](docs/prd.md), the words in [GLOSSARY.md](GLOSSARY.md).

## Quick start

1. Install it with [RECIPE.md](RECIPE.md): it copies the mod, adds a panel block and a button to your layout, and offers `cmd-shift-a`.
2. Open the panel, or press `cmd-shift-a` for the same view as a dialog, and press **+**.
3. Give it a name, a folder, a Trigger and a prompt or a command, then **Save**. **Run now** tries it at once.

## An Automation

The panel's form writes these fields to `automations.json`. You can also edit that file by hand; [automations.schema.json](mods/automation/automations.schema.json) describes it for editors.

| Field | What it is |
| --- | --- |
| `id`, `name` | A stable id (letters, digits, `-`, `_`) and the name shown in the panel, the tab and toasts. |
| `enabled` | `false` pauses this Automation. |
| `kind` | `agent` (a prompt for a coding agent) or `script` (a shell command). |
| `folder` | An absolute path. Where it works; for a worktree Run, the repository. |
| `trigger` | What sets it off; see Triggers. |
| `agent`, `model`, `args` | Agent kind: a key of Herdr's known agents (default: the `agent` setting), a model passed as `--model`, and extra arguments as a list. |
| `prompt` | Agent kind: the first message, with variables. |
| `command` | Script kind: the shell command, with variables. |
| `workspace` | `worktree` (a new git worktree per Run) or `folder` (the folder as it is). |
| `base` | Worktree only: the ref the worktree starts from. Default: the remote's default branch, fetched first. |
| `check`, `pre`, `post` | Optional scripts: `{"inline": "shell text"}` or `{"file": "path"}`, with an optional `"timeout"` in seconds (default 60, at most 600). |
| `timeout` | Minutes. Default: the `agentTimeout` or `scriptTimeout` setting. |
| `catchUp` | How late a scheduled time may still start, such as `"2h"`; `""` for never. Default: 2 hours for daily and weekday schedules, none for the others. |
| `requireResult` | `true`: a Run that ends without a result file has failed. |

Without `workspace`, an agent Automation whose folder is a git repository gets a worktree. A script, a folder that is not a repository, and an agent-status Trigger work in the folder.

A field the mod does not know, or a value it cannot use, is reported at the top of the panel with the entry's number, its name and the reason. That entry does not run; the others still do.

### Two examples

A weekday review: at 09:00 from Monday to Friday, the Check skips the Run when nothing landed since yesterday; otherwise Claude Code reviews the new commits in a worktree and writes a summary to the result file.

```json
{
  "id": "weekday-review",
  "name": "Weekday review",
  "kind": "agent",
  "folder": "/Users/you/code/app",
  "trigger": { "type": "schedule", "preset": "weekdays", "at": "09:00", "days": [1, 2, 3, 4, 5] },
  "check": { "inline": "git fetch -q && git log --since=yesterday --oneline origin/main | grep -q . || { echo No commits since yesterday; exit 1; }" },
  "prompt": "Review the commits on origin/main since yesterday. Write what needs attention to {result_file}.",
  "requireResult": true
}
```

A script: the tests every night at 02:00, with a line per Run in a log file.

```json
{
  "id": "nightly-tests",
  "name": "Nightly tests",
  "kind": "script",
  "folder": "/Users/you/code/app",
  "trigger": { "type": "schedule", "preset": "daily", "at": "02:00" },
  "command": "npm test",
  "timeout": 20,
  "post": { "inline": "echo {date} $HERDR_AUTO_STATUS >> \"$HOME/nightly-tests.log\"" }
}
```

## Triggers

Each Automation has one Trigger, and Run now.

- **Schedule**: `{"type": "schedule", "preset": "every", "minutes": 15}` (counted from midnight), `"daily"` with `"at": "09:00"`, `"weekdays"` with `"at"` and `"days"` (0 is Sunday), or `"cron"` with `"cron": "0 9 * * 1-5"` (minute hour day month weekday; `*`, numbers, ranges, lists, steps). Always the computer's local time. The form shows the next three times.
- **Interval**: `{"type": "interval", "every": "24h"}` (`"90m"`, `"7d"`; a minute or more) starts a Run once that long has passed since the Automation's last Run ended, and at once when it never ran. Any Run counts, Run now too, except one its Check skipped; then the Check is asked again every 5 minutes. After Herdr was closed it runs once and counts again from there: nothing is Missed, and `catchUp` does not apply.
- **Manual**: `{"type": "manual"}`. Only Run now.
- **Agent status**: `{"type": "agent", "status": "done"}` or `"blocked"` (needs you). `"inFolder": true` keeps only agents inside the Automation's folder; `"app": "claude"` keeps only that agent app. The Run works in the folder of the agent that fired it. An agent an Automation started (its terminal carries the Run label) never fires one, so two Automations cannot start each other.
- **Git**: `{"type": "git", "source": "local"}` fires on a new commit on the current branch of the folder. `{"type": "git", "source": "remote", "branch": "origin/main"}` fires on new commits of that remote branch, read with `git ls-remote` every `gitPollInterval`; a local one looks every 30 seconds. The first look only records the commit. A branch switch does not fire. A worktree Run starts from the commit that fired it.

A time that passed while Herdr was closed or the computer slept starts once, late, inside `catchUp`; otherwise it is recorded as Missed. What comes due while paused is recorded as skipped and is not replayed; a paused interval Trigger records nothing and runs when it is on again.

## A Run

1. **Check**: exit code 0 goes on. Any other code skips the Run; the first line of its output is the reason in the history.
2. **Pre-script**: a failure fails the Run. Its output is `{pre}`.
3. **Workspace**: for a worktree, `git fetch`, then `git worktree add` on a new branch `auto/<name>-<run id>`.
4. **Main step**, in a tab of the `space` setting, opened without taking focus: the agent with its prompt, or the script's command.
5. **Post-script**: runs where the Run worked, with the status and the result. A failure turns an ok Run into failed; a Run that already ended as failed, closed, stopped or timed out keeps its status.

Check and pre-script run in the Automation's folder. Their output, and the post-script's, is saved with the Run.

- An agent Run is `ok` when the agent finishes its turn. When it needs you it is `blocked`: a toast, the tab stays, and the Run goes on when the agent works again. Agents start in their normal interactive mode; nothing skips permissions unless your `args` say so.
- A script Run ends with its command's exit code; 0 is `ok`.
- After its timeout a Run is `timed out` and its tab stays open until the next Run of that Automation starts. **Stop** ends it as `stopped`, also while it is still starting; closing its tab ends it as `closed`.
- A Trigger that fires while the previous Run of that Automation is still going is skipped and recorded. Nothing is queued.
- One live tab per Automation: a new Run closes the tab of the previous one once it has ended. A Run that ends before its tab opens leaves the previous tab as it is.
- With several Herdr windows, one copy of the mod fires Runs; the others only show them. Run now and Stop from any copy, the dialog too, are handed to that copy through `state.json`, and the Run shows as starting at once.

Statuses: `running`, `blocked`, `ok`, `failed`, `timed out`, `stopped`, `closed`, `skipped` (check, overlap, paused), `missed`.

## Variables

The prompt, the command and inline scripts can use `{pre}`, `{check}`, `{folder}` (where the Run works), `{trigger}`, `{commit}`, `{branch}`, `{date}`, `{result_file}` and `{run_dir}`.

- In a prompt each one is pasted as text.
- In shell text each one becomes a quoted reference to its environment variable, `{pre}` → `"$HERDR_AUTO_PRE"`, so a value with quotes or `$(...)` arrives as data and never runs. Write them unquoted: `git log {commit}`, not `git log '{commit}'`.
- Scripts get `HERDR_AUTO_FOLDER`, `HERDR_AUTO_TRIGGER`, `HERDR_AUTO_COMMIT`, `HERDR_AUTO_BRANCH`, `HERDR_AUTO_DATE`, `HERDR_AUTO_PRE`, `HERDR_AUTO_CHECK`, `HERDR_AUTO_RESULT_FILE`, `HERDR_AUTO_RUN_DIR`, `HERDR_AUTO_NAME` and `HERDR_AUTO_RUN_ID`.
- The post-script also gets `HERDR_AUTO_STATUS`, `HERDR_AUTO_REASON`, `HERDR_AUTO_RESULT` (the first 8 KB of the result file), `HERDR_AUTO_TAIL_FILE` and `HERDR_AUTO_TERMINAL`.
- `{pre}` and `{check}` are cut at 64 KB.

`{run_dir}` is the Run's `out/` folder and `{result_file}` is `out/result.md` in it. It is the only part of the Run's folder an agent may write: Claude Code gets `--add-dir={run_dir}`. What the mod decides with (the post-script, `requireResult`, exit codes, script outputs) never comes from that folder. Other agents need your `args` to let them write there.

## Worktrees

A worktree is at `<worktrees dir>/<repo>/auto-<name>-<run id>`, where the worktrees dir is `worktrees.directory` of Herdr's settings.json, default `~/.herdr/worktrees`.

- After `worktreeRetention` a clean worktree is removed. Its branch goes with it when the branch has no commits of its own; a branch with commits stays until you merge or delete it.
- A worktree with uncommitted changes is never removed by the mod. Its Run shows "needs review".
- An ended Run's detail has **Open a tab here** while the worktree exists, and **Remove worktree**, which asks first when it is dirty.
- git in a worktree runs with fsmonitor, hooks, the pager, external diff and the `ext` protocol turned off, so a config an agent left there runs nothing.

## The panel

- **Header**: pause everything, and **+** for a new Automation.
- **List**: each Automation with its Trigger in words, the next time, how the last Run went or how long the current one has been going, an on/off switch, **Run now**, and **Go to tab** while the Automation's live tab (the tab its latest Run opened) is open.
- **Detail**: Run now, Stop, Edit, Delete (asks first), and the history. A row goes to the Run's tab while it is open; otherwise it shows the saved output (Check, pre-script, the last 200 lines of the terminal, post-script, result file), the branch and the worktree.
- **Form**: every field above, the folder through Herdr's folder picker, schedule presets or cron with the next three times, and checks before saving.
- **Dialog**: `mod.open:automation` (`cmd-shift-a` with the key from RECIPE.md) shows the same view in a dialog, with the panel shown or not. Esc closes it, and so does Go to tab.
- **Toasts**: by the `notifications` setting. A click goes to the Run's terminal while its tab is open; otherwise (skipped, missed, a closed tab) it opens the dialog, unless the dialog is open already.
- Problems in `automations.json` or the settings, and a failing git look, are listed at the top.

## Settings

[Better Config](https://github.com/munza/herdr-mods/tree/main/better-config) shows and edits these. By hand, add a `settings` block to the installed `mods/automation/mod.json` with only what you change, such as `"settings": { "notifications": "all" }`. Durations are a number and `s`, `m`, `h` or `d`.

| Key | Default | What it does |
| --- | --- | --- |
| `agent` | `"claude"` | The agent of a new Automation, a key of Herdr's known agents. |
| `space` | `"Automations"` | The space that holds the Runs' tabs. It is made when missing. |
| `worktreeRetention` | `"7d"` | How long a Run's worktree is kept before a clean one is removed. |
| `historyRetention` | `"30d"` | How long history days and run folders are kept. The folder of a Run still going, or whose worktree is still there, stays. |
| `notifications` | `"failures"` | Which Runs post a toast: `failures` (failed, timed out, blocked), `failures-and-skips` (also skipped and missed), `all`, or `never`. |
| `gitPollInterval` | `"5m"` | How often a remote git Trigger reads its branch. |
| `agentTimeout` | `"60m"` | The timeout of an agent Automation without its own. |
| `scriptTimeout` | `"10m"` | The timeout of a script Automation without its own. |

## Install

Ask your Herdr agent to install it with [RECIPE.md](RECIPE.md). By hand:

1. `./sync.sh` copies `mods/automation/` to `~/.config/herdr-app/mods/automation`, keeping the `settings` of an installed copy.
2. Add the block `{ "id": "automation", "type": "block", "content": { "mod": "automation" } }` to your layout's panel stack, and a Better Tabs button for it. RECIPE.md has both.
3. Optional: merge [keys.json](keys.json) into `~/.config/herdr-app/keys.json` for `cmd-shift-a`.
4. `herdr-app check ~/.config/herdr-app/mods/automation`.

The mod has `"place": "none"`, so copying it does not put it anywhere. Updating is the same copy; Herdr reloads the mod, and your Automations stay, since they live in the data folder.

## Files and commands

Everything the mod writes is in `~/.config/herdr-app/data/automation/`, never in the mod's folder, so an edit does not reload the mod:

- `automations.json`: `{ "paused": false, "automations": [...] }`. Read again every 5 seconds.
- `history/<YYYY-MM-DD>.jsonl`: one line per Run event, kept for `historyRetention`.
- `runs/<run id>/`: `automation.json` (the definition when the Run started, for the record), `check.txt`, `pre.txt`, `post.txt` and their `.err.txt`, `tail.txt` (the terminal's last 200 lines), `exit` (a script's exit code) and `out/result.md`. Removed with its history.
- `state.json`: what the engine remembers between starts: Runs going, the last Run of each Automation, each Automation's live tab, the last time checked, the last commit seen, worktrees to purge, and Run now and Stop waiting for the leader.

Commands: `mod.open:automation` opens or closes the dialog. Toasts carry `pane.focus` or `agent.focus` for the Run's terminal, or `mod.open` for the dialog.

## Limits

- Runs happen only while Herdr is open, and only while a copy of the mod has started in the layout Herdr shows. Herdr starts a copy the first time it is shown, so a panel hidden behind its button fires nothing until it has been opened once. The engine block of the install steps (`props: { "part": "engine" }`, 0 px) is always shown and starts with Herdr. The dialog's copy never fires Runs.
- One computer: agents on other machines are not seen, and Runs start only here.
- macOS and Linux, through `sh`. No Windows.
- Schedules use the computer's local time; there are no time zones per Automation.
- One Trigger per Automation, and no file-change Trigger.
- Only Claude Code is given `--add-dir` for the result file automatically.
- The prompt is the agent's last argument, after `args`. An option in `args` that takes several values, such as Claude Code's `--allowedTools`, must not come last, or it takes the prompt as one of them and the agent starts with none.
- Claude Code asks whether to trust a repository it has not seen; the Run shows `blocked` until you answer in its tab, and then goes on.
- A Run that was starting when Herdr quit is marked failed at the next start.
- git runs in your repositories with your own git configuration (credential helpers, ssh, remotes), as your own git commands do, with fsmonitor, hooks, the pager, external diff and the `ext` protocol turned off.

## What it runs

Every command line is in [shell.js](mods/automation/shell.js). User values go in as arguments or environment variables, never pasted into shell text.

- `sh`, through `env`: the Check, pre- and post-script (`sh -c <inline>`, or the file as a program), and a script Run's command in its tab (`env HERDR_AUTO_…=… sh -c 'sh -c "$1"; printf "%s" "$?" > "$2"'`), which writes the exit code to the Run's folder.
- The agent: the `run` command of its entry in Herdr's known agents, then `--add-dir` for Claude Code, `--model` and your `args`, in the Run's tab.
- `git`, in your repositories and with your own git configuration, as your own git commands run, every call with `-c core.fsmonitor=false -c core.hooksPath=/dev/null -c core.pager=cat -c protocol.ext.allow=never -c diff.external=` (fsmonitor, hooks, pager, external diff and the `ext` protocol off; credential helpers and ssh stay yours, so fetch works with your remotes): `rev-parse` to find the repository, its commit and branch (the form, each Run, local git Triggers every 30 seconds); `remote`, `fetch` (of the remote a remote git Trigger names, else `origin`), `ls-remote --symref` and `worktree add` when a worktree Run starts; `ls-remote` for remote git Triggers every `gitPollInterval`; `status --porcelain` and `rev-list --count` to look at a worktree; `worktree remove`, `worktree prune` and `branch -D` in the purge and Remove worktree.
- `hc label <terminal> herdr.automation.run=<run id>` when a Run's tab opens, and `hc read <terminal> --lines 200` when it ends; of the screen and history it prints, the last 200 lines are kept.- `herdr-app do tab.new` or `herdr-app do space.new` to open a Run's tab without focus.

The purge of old worktrees, history and run folders runs every 10 minutes.

## For developers

`mods/automation/` holds the engine as plain modules that take the clock, file access and a command runner as arguments (`cron.js`, `store.js`, `runs.js`, `engine.js`, `triggers.js`, `shell.js`); `host.js` is the only one that reaches Herdr. `main.js` and `views/` draw the panel.

```sh
npm test                  # node --test, no packages
./sync.sh                 # copies mods/automation into ~/.config/herdr-app/mods/automation, keeping its settings
herdr-app check ~/.config/herdr-app/mods/automation
```
