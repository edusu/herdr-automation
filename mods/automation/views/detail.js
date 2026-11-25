// One Automation: its actions and the history of its Runs.
import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { describe, nextTimes, when } from "../cron.js";
import { latestRuns } from "../store.js";
import { TEXT, button, card, label, note, dot, span } from "./ui.js";

export function detail(m, t) {
  const a = m.doc.automations.find((x) => x.id === m.screen.id);
  if (!a) return v_flex().p(14).child(note(t, "This Automation is gone."));
  const now = Date.now(), going = m.going(a.id);
  const runs = latestRuns(m.history).filter((e) => e.automation === a.id);
  const next = nextTimes(a.trigger, now, 1)[0];
  return v_flex().gap(6).p(10)
    .child(div().font_semibold().child(a.name))
    .child(note(t, [a.kind === "agent" ? `Agent ${a.agent || m.settings.agent}` : "Script", a.folder].join(" · ")))
    .child(note(t, [describe(a.trigger), next && a.enabled !== false && !m.doc.paused ? `next ${when(next, now)}` : null].filter(Boolean).join(" · ")))
    .child(h_flex().flex_wrap().gap(6)
      .child(button(t, "detail-run", "Run now", (cx) => m.runNow(a, cx), true))
      .when(Boolean(going), (el) => el.child(button(t, "detail-stop", "Stop", (cx) => m.stop(going.id, cx))))
      .child(button(t, "detail-edit", "Edit", (cx) => m.openForm(a, cx)))
      .child(button(t, "detail-delete", "Delete", () => { m.ask = { id: a.id, name: a.name }; })))
    .when(m.ask?.id === a.id, (el) => el.child(card(t, "ask", `Delete "${a.name}"?`, () => { m.ask = null; })
      .child(note(t, "Its history stays in the data folder."))
      .child(h_flex().gap(6).justify_end()
        .child(button(t, "ask-cancel", "Cancel", () => { m.ask = null; }))
        .child(button(t, "ask-delete", "Delete", (cx) => m.remove(a, cx), true)))))
    .when(Boolean(m.output), (el) => el.child(card(t, "output", `Run ${m.output.run}`, () => { m.output = null; })
      .child(div().max_h(260).overflow_y_scrollbar().text_size(TEXT.label).when(Boolean(m.mono), (el) => el.font_family(m.mono)).text_color(t.foreground)
        .child(m.output.text || "No saved output."))))
    .child(label(t, "History"))
    .children(runs.length ? runs.map((e) => h_flex().id(`h-${e.run}`).px(6).py(4).gap(8).items_center().rounded(6).cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { m.openRun(e, cx); cx.notify(); })
      .child(dot(t, e.status))
      .child(v_flex().flex_1().min_w(0)
        .child(div().truncate().child(`${e.status}${e.count > 1 ? ` ×${e.count}` : ""} · ${e.trigger ?? ""}`))
        .child(div().truncate().text_size(TEXT.label).text_color(t.dim).child([
          when(e.started ?? e.at, now),
          e.ended && e.status !== "skipped" && e.status !== "missed" ? span(e.ended - e.started) : e.status === "running" || e.status === "blocked" ? span(now - e.started) : null,
          e.reason,
        ].filter(Boolean).join(" · ")))))
      : [note(t, "No Runs yet.")]);
}
