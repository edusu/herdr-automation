# 1. The mod is the scheduler; there is no daemon

Date: 2026-11-25

## Status

Accepted

## Context

Automations must fire on a time, on an agent changing status, and on a git change. The four projects this mod draws from split in two: a login-service daemon (DnzzL/herdr-automations in Go, lucasprag/herdr-automate-everything in Rust) that fires with the app closed, or a pure Herdr mod (dougcunha/automations-app, kimsuhan/herdr-scheduler) that fires only while Herdr is open.

A Herdr mod copy stays alive, with its timers running, while its block is in the layout, shown or not. Agent status is only observable from inside the app.

## Decision

Version 1 is a Herdr mod written in JavaScript and nothing else. No background service, no compiled binary, no installer beyond copying the runtime folder.

A time that passes while Herdr is closed or the computer sleeps is handled when the mod next ticks: the Run starts late once if it is inside the Automation's catch-up window, otherwise it is recorded as Missed. Occurrences are computed from the wall clock, never from elapsed timers.

## Consequences

- Nothing runs while Herdr is closed. This is accepted: the agent-status trigger needs the app anyway, and Runs open as visible tabs.
- No launchd unit, release pipeline or binary updates to maintain.
- If runs with the app closed become necessary, a daemon can be added later that reads the same `automations.json`. The file format must therefore stay free of mod-only concepts.
