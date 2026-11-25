# 2. Automations live in the data folder, not in mod.json

Date: 2026-11-25

## Status

Accepted

## Context

Every other mod in this family keeps its user configuration in the `settings` key of its installed `mod.json`, described by `mod.schema.json` and edited through Better Config. The obvious place for the list of Automations would be that same key.

Herdr reloads every copy of a mod when any file in its folder is saved, and the old build's tasks and timers stop. Automations are edited often (the form, pause switches, hand edits), and a reload in the middle of a Run would lose track of it.

## Decision

- `mod.json` → `settings` holds only global preferences that change rarely: default agent, space name, retention, notification level, git poll interval, default timeouts.
- Automations live in `~/.config/herdr-app/data/automation/automations.json`. History, per-run files and engine state live beside it. The mod reads the file again on a timer and after its own writes.

## Consequences

- Editing an Automation never reloads the mod or interrupts a Run.
- Better Config edits the global settings with no extra work, but not the Automations; those have their own form and a JSON Schema (`automations.schema.json`) for hand edits.
- The data folder is per machine and outside any repository, so two computers never share Automations by accident.
- The mod's installer must carry `settings` across updates like the other mods; the data folder is untouched by updates.
