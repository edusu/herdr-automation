# Automations

A Herdr mod that starts a coding agent or a script when its Trigger fires (a schedule, Run now, an agent's status, a git commit), opens each Run as a tab in the `Automations` space, and keeps a history of every Run. Judge any addition by whether it helps a person hand recurring work to an agent and check what came back.

## Install

You are the agent installing it. Read `~/.config/herdr-app/AGENTS.md` first. Do each step, then check.

1. **Copy the mod.** From this repository, run `./sync.sh`. It copies `mods/automation/` to `~/.config/herdr-app/mods/automation` and keeps the `settings` key of an installed `mod.json`. By hand: copy the folder (not a symlink: Herdr does not load a symlinked mod's icons), and if the installed `mod.json` had a `settings` key, put it back.
2. **Add the panel block.** In a layout the person owns (shipped layouts are read-only), add this block as another child of the panel stack, the stack with id `panel-body` inside the container `panel`:

   ```json
   { "id": "automation", "type": "block", "content": { "mod": "automation" } }
   ```

3. **Add a Better Tabs button**, when the layout uses Better Tabs, beside the other panel buttons:

   ```json
   { "id": "automations", "label": "Automations", "icon": "mods/automation/automation.svg",
     "when": { "node": "automation" },
     "action": { "type": "panel", "container": "panel", "stack": "panel-body", "target": "automation" } }
   ```

4. **Offer the key.** [keys.json](keys.json) holds `"cmd-shift-a": "mod.open:automation"` under `global`, which opens the same view as a dialog. Ask the person before merging it into `~/.config/herdr-app/keys.json`, and check first that `cmd-shift-a` is not taken.
5. **Check.** Run `herdr-app check ~/.config/herdr-app/mods/automation`, then `herdr-app status` and look for errors from the layout or the mod.

The engine runs only while the `automation` block is in the layout Herdr shows. The block may be hidden behind its button; a copy in a layout that is not shown, or a mod that is only installed, fires nothing. With the dialog open, that copy runs it too.

Do not create Automations for the person unless they ask. They live in `~/.config/herdr-app/data/automation/automations.json`, which updates of the mod never touch.

## What you see

- A panel with the Automations, each with its Trigger in words, its next time, its last Run, an on/off switch, **Run now** and **Go to tab**; a header with pause everything and **+**.
- A detail view with the history and each Run's saved output; a form with every field.
- Runs as tabs in the `Automations` space, opened without taking focus. Toasts by the `notifications` setting.

## How it behaves

- Every copy ticks every 5 seconds with `cx.timer.every`; `init` returns before the timer while `checking()`. Only the copy holding the lease `automation.leader` in Herdr's shared state fires and follows Runs.
- A schedule is computed from the wall clock, so a time that passed while Herdr was closed starts late inside `catchUp`, or is recorded as Missed.
- An agent Run in a repository works in a new worktree; the agent may write only `<run folder>/out/` (`{run_dir}`). The engine keeps the post-script and `requireResult` in `state.json`, never reading them back from a file the agent could change.
- Every git call carries `-c core.fsmonitor=false -c core.hooksPath=/dev/null -c core.pager=cat`.
- Every 10 minutes it removes old clean worktrees, and history days and run folders older than `historyRetention`.

## Built from

`mods/automation/`: `main.js` and `views/` (the panel), `engine.js` (the tick and `DEFAULT_SETTINGS`), `runs.js` (a Run's steps), `triggers.js`, `cron.js`, `store.js` (the data folder and the checks of `automations.json`), `shell.js` (every `sh` and `git` command line), `host.js` (the only module that imports `herdr` for effects), `settings.js` (shared with the herdr-mods repository), `mod.json` (`place: none`, a 720 × 640 dialog for `mod.open`), `mod.schema.json` (the settings), `automations.schema.json` (the Automations file), `automation.svg`.

It runs `sh`, `git`, `hc label`, `hc read` and `herdr-app do tab.new` / `space.new`; the README's "What it runs" lists each one and when.

## Watch out

- A save in the mod's folder reloads every copy of the mod. The mod writes only to `~/.config/herdr-app/data/automation/`.
- `mod.schema.json`, `DEFAULT_SETTINGS` in `engine.js` and the README's settings table must agree; `tests/settings.test.js` checks them. `automations.schema.json` and the field lists in `store.js` must agree too; `tests/schema.test.js` checks them.

## Done when

- `npm test` and `herdr-app check ~/.config/herdr-app/mods/automation` pass.
- The Automations button shows the panel, and `mod.open:automation` (or `cmd-shift-a`) shows the same view as a dialog that Esc closes.
- A manual script Automation with `"command": "echo hello"` opens a tab in the `Automations` space on Run now and ends `ok` in its history.
