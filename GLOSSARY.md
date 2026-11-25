# Herdr Automation

A Herdr app mod that starts coding agents and scripts when something happens, and keeps a record of what they did.

## Language

**Automation**:
A saved definition of work to do: an agent prompt or a script, the folder it applies to, and what sets it off.
_Avoid_: Schedule, job, task

**Trigger**:
The condition that sets off an Automation: a time, a manual request, an agent changing status, or a git change.
_Avoid_: Event, hook

**Run**:
One execution of an Automation, from the moment its Trigger fires until it ends or is skipped.
_Avoid_: Session, execution

**Check**:
A script that decides, before a Run does any work, whether the Run goes ahead or is skipped.
_Avoid_: Precheck, gate, guard

**Catch-up**:
Starting a Run late, once, for a time that passed while Herdr was closed.

**Missed**:
The outcome of a Run whose time passed while Herdr was closed and that was too late to catch up.
