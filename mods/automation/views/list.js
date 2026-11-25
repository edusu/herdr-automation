// The header and the list of Automations.
import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { describe, when } from "../cron.js";
import { TEXT, flat, toggle, note, dot, span } from "./ui.js";

/** The header: the title, pause everything and +. */
export function header(m, t) {
  const paused = m.doc.paused;
  return h_flex().flex_none().px(10).py(6).gap(6).items_center().border_b(1).border_color(t.border)
    .child(div().flex_1().min_w(0).font_semibold().truncate().child(m.screen.name === "list" ? "Automations" : ""))
    .when(m.screen.name !== "list", (el) => el.child(flat(t, "back", "‹ All", (cx) => { m.closeForm(cx); m.show({ name: "list" }, cx); })))
    .child(div().text_size(TEXT.note).text_color(paused ? t.blocked : t.muted).child(paused ? "Paused" : "Active"))
    .child(toggle(t, "pause-all", !paused, (cx) => m.togglePaused(cx), paused ? "Resume every Automation" : "Pause every Automation"))
    .child(flat(t, "new", "+", (cx) => m.openForm(null, cx), "New Automation"))
    .when(Boolean(m.overlay), (el) => el.child(flat(t, "close-dialog", "✕", () => m.closeDialog())));
}

/** One row per Automation: Trigger, next time, last Run, the Run going on, switch, Run now, Go to tab. */
export function list(m, t) {
  const now = Date.now();
  if (!m.doc.automations.length)
    return v_flex().p(14).gap(6).child(note(t, "No Automations yet. Press + to make one."));
  return v_flex().px(4).py(4).gap(1).children(m.doc.automations.map((a) => {
    const going = m.going(a.id), last = m.state.last[a.id], tab = m.state.tabs[a.id];
    const next = a.enabled === false || m.doc.paused ? null : m.next(a);
    const status = going?.status ?? last?.status;
    const parts = [describe(a.trigger), next ? `next ${when(next, now)}` : a.enabled === false ? "off" : null].filter(Boolean);
    return h_flex().id(`row-${a.id}`).px(6).py(6).gap(8).items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => m.show({ name: "detail", id: a.id }, cx))
      .child(status ? dot(t, status) : div().size(8).flex_none())
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().truncate().text_color(a.enabled === false ? t.muted : t.foreground).child(a.name))
        .child(div().truncate().text_size(TEXT.note).text_color(t.muted).child(parts.join(" · ")))
        .child(div().truncate().text_size(TEXT.label).text_color(t.dim).child(going
          ? `${going.status} for ${span(now - going.started)}`
          : last ? `${last.status} ${when(last.ended ?? last.started, now)}` : "No Run yet")))
      .when(m.tabOpen(tab), (el) => el.child(flat(t, `go-${a.id}`, "Go to tab", () => m.goTo(tab))))
      .child(flat(t, `run-${a.id}`, "Run now", (cx) => m.runNow(a, cx)))
      .child(toggle(t, `on-${a.id}`, a.enabled !== false, (cx) => m.toggleEnabled(a, cx), a.enabled === false ? "Turn on" : "Turn off"));
  }));
}
