# Automations

A [Herdr](https://herdr.dev/) mod that starts a coding agent or a script when its Trigger fires (a schedule or Run now), shows the work in a tab of the `Automations` space, and keeps a history of every Run. The design is in [docs/prd.md](docs/prd.md), the vocabulary in [GLOSSARY.md](GLOSSARY.md).

Work in progress: worktrees, check / pre / post scripts, agent-status and git Triggers, the settings schema and the full install recipe come in later slices.

## Try it

```sh
npm test                  # node --test, no packages
./sync.sh                 # copies mods/automation into ~/.config/herdr-app/mods/automation, keeping its settings
herdr-app check ~/.config/herdr-app/mods/automation
```

The mod has `"place": "none"`: put an `automation` block in a layout to show the panel, or open it as a dialog with `mod.open {name: "automation"}`. Automations, history and run folders live in `~/.config/herdr-app/data/automation/`.
