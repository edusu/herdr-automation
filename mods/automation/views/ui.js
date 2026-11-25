// The panel's building blocks, sized and coloured like the Calendar and Notes panels.
import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";

/** Text sizes in px: body, notes, labels. */
export const TEXT = { body: 13, note: 12, label: 11 };

// Controls sit inside clickable rows, so their clicks stop there.
const act = (el, on) => el.on_click((_e, cx) => { cx.stop_propagation(); on(cx); cx.notify(); });

/** A card button; `primary` is the solid one. */
export const button = (t, id, label, on, primary = false) => act(div().id(id).flex_none().px(10).py(4).rounded(6).cursor_pointer()
  .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground)
  .hover((s) => s.opacity(0.88)), on).child(label);

/** A quiet header or row button. */
export const flat = (t, id, label, on, tip) => act(div().id(id).flex_none().px(6).py(2).rounded(5).cursor_pointer().text_color(t.muted)
  .hover((s) => s.bg(t.hover)), on).child(label).when(Boolean(tip), (el) => el.tooltip(tip));

/** An on/off switch. */
export const toggle = (t, id, on, onToggle, tip) => act(h_flex().id(id).flex_none().w(28).h(16).p(2).rounded(8).cursor_pointer()
  .bg(on ? t.accent : t.input).when(on, (el) => el.justify_end()), onToggle)
  .child(div().size(12).rounded(6).bg(on ? t.accent_foreground : t.background))
  .when(Boolean(tip), (el) => el.tooltip(tip));

/** A choice among several. */
export const chip = (t, id, label, selected, on) => act(div().id(id).flex_none().px(6).py(2).rounded(5).cursor_pointer().border_1()
  .border_color(selected ? t.accent : t.border).text_color(selected ? t.foreground : t.muted).hover((s) => s.bg(t.hover)), on).child(label);

export const label = (t, text) => div().text_size(TEXT.label).text_color(t.dim).child(text);
export const note = (t, text, color) => div().text_size(TEXT.note).text_color(color ?? t.muted).child(text);

/** A card: a box with a title and a close button. */
export const card = (t, id, title, close) => v_flex().id(id).flex_none().mx(8).mt(8).p(10).gap(6).rounded(8).border_1().border_color(t.border).bg(t.popover)
  .child(h_flex().gap(6).items_center().child(div().flex_1().min_w(0).font_semibold().truncate().child(title))
    .child(flat(t, `${id}-close`, "✕", close)));

/** The colour of a Run status. */
export const statusColor = (t, status) => ({
  ok: t.done, running: t.working, starting: t.working, blocked: t.blocked, failed: t.ansi1, "timed out": t.ansi1,
}[status] ?? t.dim);

/** A status dot, pulsing while the Run goes on. */
export const dot = (t, status) => div().size(8).rounded(4).flex_none().bg(statusColor(t, status))
  .when(status === "running" || status === "starting", (el) => el.loop("opacity", { from: 0.35, to: 1, period: 1600 }));

/** "45s", "12m", "1h 5m". */
export function span(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}
