// The form that makes or edits an Automation.
import { div } from "gpui-kit";
import { h_flex, v_flex, Input, Textarea } from "gpui-base";
import { nextTimes, compile, when, DAY_NAMES } from "../cron.js";
import { TEXT, button, chip, toggle, label, note } from "./ui.js";

const PRESETS = [["manual", "Manual"], ["every", "Every N min"], ["daily", "Daily"], ["weekdays", "Weekdays"], ["cron", "Cron"]];
const STEPS = [["check", "Check (exit 0 goes on, else the Run is skipped)"], ["pre", "Pre-script (its output is {pre})"], ["post", "Post-script (runs where the Run worked)"]];
// Monday first, as people read a week.
const WEEK = [1, 2, 3, 4, 5, 6, 0];

/** The Trigger the form describes now. */
export function formTrigger(f) {
  const p = f.preset;
  if (p === "manual") return { type: "manual" };
  if (p === "every") return { type: "schedule", preset: p, minutes: Number(f.minutes.value().trim()) };
  if (p === "daily") return { type: "schedule", preset: p, at: f.at.value().trim() };
  if (p === "weekdays") return { type: "schedule", preset: p, at: f.at.value().trim(), days: WEEK.filter((d) => f.days.includes(d)) };
  return { type: "schedule", preset: "cron", cron: f.cron.value().trim() };
}

export function form(m, t) {
  const f = m.form;
  const input = (s) => Input.new(s).h(30).px(8).rounded(6).border_1().border_color(t.input).bg(t.background).text_color(t.foreground);
  const area = (s) => Textarea.new(s).h(96).px(8).py(6).rounded(6).border_1().border_color(t.input).bg(t.background).text_color(t.foreground);
  const row = (...children) => h_flex().gap(6).items_center().flex_wrap().children(children);
  const trigger = formTrigger(f);
  let preview;
  if (trigger.type === "manual") preview = note(t, "Runs only with Run now.");
  else {
    try {
      compile(trigger);
      const now = Date.now();
      preview = note(t, `Next: ${nextTimes(trigger, now).map((x) => when(x, now)).join(", ") || "never"}`);
    } catch (e) {
      preview = note(t, e.message, t.blocked);
    }
  }
  const daily = f.preset === "daily" || f.preset === "weekdays";
  const workspace = f.workspace ?? (f.kind === "agent" && f.isRepo ? "worktree" : "folder");
  return v_flex().gap(6).p(10)
    .child(div().font_semibold().child(f.id ? "Edit Automation" : "New Automation"))
    .child(label(t, "Name")).child(input(f.name))
    .child(row(chip(t, "kind-agent", "Agent", f.kind === "agent", () => { f.kind = "agent"; }), chip(t, "kind-script", "Script", f.kind === "script", () => { f.kind = "script"; })))
    .child(label(t, "Folder"))
    .child(h_flex().gap(6).items_center().child(div().flex_1().min_w(0).child(input(f.folder))).child(button(t, "pick-folder", "Choose…", (cx) => m.pickFolder(cx))))
    .when(f.kind === "agent", (el) => el
      .child(label(t, "Agent"))
      .child(f.agents.length
        ? row(...f.agents.map((a) => chip(t, `agent-${a.key}`, a.installed === false ? `${a.name} (not installed)` : a.name, f.agent === a.key, () => { f.agent = a.key; })))
        : note(t, f.agentsError ?? "Looking for agents…"))
      .child(label(t, "Model (optional, passed as --model)")).child(input(f.model))
      .child(label(t, "Extra arguments (separated by spaces)")).child(input(f.args))
      .child(label(t, "Prompt")).child(area(f.prompt)))
    .when(f.kind === "script", (el) => el.child(label(t, "Command (run with sh where the Run works)")).child(area(f.command)))
    .child(note(t, "Variables: {pre} {check} {folder} {trigger} {commit} {branch} {date} {result_file} {run_dir}. In shell text, leave them unquoted."))
    .child(label(t, "Workspace"))
    .child(row(...[
      f.isRepo === false && workspace !== "worktree" ? null : chip(t, "ws-worktree", "New worktree", workspace === "worktree", () => { f.workspace = "worktree"; }),
      chip(t, "ws-folder", "The folder as it is", workspace === "folder", () => { f.workspace = "folder"; }),
      f.isRepo === false ? note(t, "Not a git repository") : null,
    ].filter(Boolean)))
    .when(workspace === "worktree", (el) => el.child(label(t, "Base (a git ref)")).child(input(f.base)))
    .children(STEPS.map(([k, title]) => v_flex().gap(4)
      .child(label(t, title))
      .child(h_flex().gap(6).items_center()
        .child(chip(t, `${k}-inline`, "Inline", f[`${k}Mode`] === "inline", () => { f[`${k}Mode`] = "inline"; }))
        .child(chip(t, `${k}-file`, "File", f[`${k}Mode`] === "file", () => { f[`${k}Mode`] = "file"; }))
        .child(div().flex_1().min_w(0).child(input(f[k])))
        .child(div().w(60).child(input(f[`${k}Timeout`])))
        .child(div().text_size(TEXT.label).text_color(t.dim).child("s")))))
    .child(h_flex().gap(8).items_center().child(toggle(t, "form-result", f.requireResult, () => { f.requireResult = !f.requireResult; }))
      .child(div().child("Require a result file ({result_file})")))
    .child(label(t, "Trigger"))
    .child(row(...PRESETS.map(([p, name]) => chip(t, `preset-${p}`, name, f.preset === p, () => { f.preset = p; }))))
    .when(f.preset === "every", (el) => el.child(row(div().child("Every"), div().w(70).child(input(f.minutes)), div().child("minutes"))))
    .when(daily, (el) => el.child(row(div().child("At"), div().w(80).child(input(f.at)))))
    .when(f.preset === "weekdays", (el) => el.child(row(...WEEK.map((d) => chip(t, `day-${d}`, DAY_NAMES[d], f.days.includes(d),
      () => { f.days = f.days.includes(d) ? f.days.filter((x) => x !== d) : [...f.days, d]; })))))
    .when(f.preset === "cron", (el) => el.child(input(f.cron)).child(note(t, "minute hour day month weekday, in local time")))
    .child(preview)
    .child(h_flex().gap(10)
      .child(v_flex().flex_1().gap(4).child(label(t, "Timeout in minutes")).child(input(f.timeout)))
      .when(trigger.type === "schedule", (el) => el.child(v_flex().flex_1().gap(4).child(label(t, "Catch-up window (2h, 30m, none)")).child(input(f.catchUp)))))
    .child(h_flex().gap(8).items_center().child(toggle(t, "form-enabled", f.enabled, () => { f.enabled = !f.enabled; })).child(div().child(f.enabled ? "On" : "Off")))
    .when(Boolean(f.error), (el) => el.child(div().text_size(TEXT.note).text_color(t.blocked).child(f.error)))
    .child(h_flex().gap(6).justify_end()
      .child(button(t, "form-cancel", "Cancel", (cx) => m.closeForm(cx)))
      .child(button(t, "form-save", "Save", (cx) => m.save(cx), true)));
}
