// The form's values to an Automation and back, without Herdr, so tests can import it.

/** The weekdays as the form lists them, Monday first. */
export const WEEK = [1, 2, 3, 4, 5, 6, 0];

/** The Trigger the form `f` describes now; its text fields are inputs with value(). */
export function formTrigger(f) {
  const p = f.preset;
  if (p === "manual") return { type: "manual" };
  if (p === "agent") return { type: "agent", status: f.agentStatus, inFolder: f.inFolder || undefined, app: f.app.value().trim() || undefined };
  if (p === "git") return { type: "git", source: f.gitSource, branch: f.gitSource === "remote" ? f.gitBranch.value().trim() : undefined };
  if (p === "interval") return { type: "interval", every: f.interval.value().trim() };
  if (p === "every") return { type: "schedule", preset: p, minutes: Number(f.minutes.value().trim()) };
  if (p === "daily") return { type: "schedule", preset: p, at: f.at.value().trim() };
  if (p === "weekdays") return { type: "schedule", preset: p, at: f.at.value().trim(), days: WEEK.filter((d) => f.days.includes(d)) };
  return { type: "schedule", preset: "cron", cron: f.cron.value().trim() };
}

/** An Automation's `catchUp` as the form's text: "" for the default, "none" for never. */
export const catchUpText = (catchUp) => (catchUp === undefined ? "" : catchUp === "" || catchUp === false ? "none" : catchUp);

/** The form's Catch-up text as `catchUp`: undefined for the default, "" for none or 0. */
export const catchUpValue = (text) => (text === "" ? undefined : /^(none|0)$/i.test(text) ? "" : text);
