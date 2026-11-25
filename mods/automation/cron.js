// Schedule Triggers: presets and 5-field cron, always in the computer's local time.
// Occurrences come from the wall clock, never from elapsed timers (ADR 1).

const MINUTE = 60000;
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAYS = [1, 2, 3, 4, 5];
const CRON_FIELDS = [["minute", 0, 59], ["hour", 0, 23], ["day", 1, 31], ["month", 1, 12], ["weekday", 0, 7]];
// The longest search for a next time: a 29 February cron can wait almost eight years.
const SEARCH_DAYS = 366 * 8;
// A sleep gap of weeks on an every-minute schedule stays bounded.
const MAX_OCCURRENCES = 100000;

function field(text, [name, lo, hi]) {
  const values = new Set();
  for (const part of text.split(",")) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new Error(`${name} "${part}" is not a number, range, list or step`);
    const step = m[4] === undefined ? 1 : Number(m[4]);
    const from = m[1] === "*" ? lo : Number(m[2]);
    const to = m[1] === "*" ? hi : m[3] !== undefined ? Number(m[3]) : m[4] !== undefined ? hi : from;
    if (step < 1 || from < lo || to > hi || from > to) throw new Error(`${name} "${part}" is out of ${lo}-${hi}`);
    for (let v = from; v <= to; v += step) values.add(name === "weekday" && v === 7 ? 0 : v);
  }
  return values;
}

/** A 5-field cron (`minute hour day month weekday`) as sets of values. Throws on bad input. */
export function parseCron(expr) {
  const parts = String(expr ?? "").trim().split(/\s+/);
  if (parts.length !== 5 || !parts[0]) throw new Error("A cron needs 5 fields: minute hour day month weekday");
  const [minute, hour, day, month, weekday] = parts.map((p, i) => field(p, CRON_FIELDS[i]));
  return { minute, hour, day, month, weekday, anyDay: parts[2] === "*", anyWeekday: parts[4] === "*" };
}

const parseAt = (at) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(at ?? "").trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error(`"${at ?? ""}" is not a time like 09:30`);
  return Number(m[1]) * 60 + Number(m[2]);
};

/**
 * A schedule Trigger compiled to the minutes of the day it fires at and a test for the days.
 * Trigger shapes: {type: "schedule", preset: "every", minutes} | {preset: "daily", at: "HH:MM"} |
 * {preset: "weekdays", at, days: [0-6, 0 = Sunday]} | {preset: "cron", cron}. Throws on bad input.
 */
export function compile(trigger) {
  if (trigger?.type !== "schedule") throw new Error("Only schedule Triggers have times");
  switch (trigger.preset) {
    case "every": {
      const n = trigger.minutes;
      if (!Number.isInteger(n) || n < 1 || n > 1440) throw new Error("Every N minutes needs N from 1 to 1440");
      // Counted from local midnight, so "every 90" restarts at 00:00 each day.
      return { times: Array.from({ length: Math.ceil(1440 / n) }, (_, i) => i * n), dayOk: () => true };
    }
    case "daily":
      return { times: [parseAt(trigger.at)], dayOk: () => true };
    case "weekdays": {
      const days = trigger.days ?? WEEKDAYS;
      if (!Array.isArray(days) || !days.length || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6))
        throw new Error("Pick at least one day");
      return { times: [parseAt(trigger.at)], dayOk: (d) => days.includes(d.getDay()) };
    }
    case "cron": {
      const c = parseCron(trigger.cron);
      const times = [...c.hour].flatMap((h) => [...c.minute].map((m) => h * 60 + m)).sort((a, b) => a - b);
      const inDay = (d) => c.day.has(d.getDate()), inWeek = (d) => c.weekday.has(d.getDay());
      // Cron's rule: with both day fields restricted, either one matches.
      const dayOk = (d) => c.month.has(d.getMonth() + 1)
        && (c.anyDay && c.anyWeekday ? true : c.anyDay ? inWeek(d) : c.anyWeekday ? inDay(d) : inDay(d) || inWeek(d));
      return { times, dayOk };
    }
    default:
      throw new Error(`Unknown schedule "${trigger.preset}"`);
  }
}

/** The first time of `spec` strictly after instant `t` (ms), or null. */
export function nextAfter(spec, t) {
  const start = new Date(t);
  const day = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  for (let i = 0; i < SEARCH_DAYS; i++, day.setDate(day.getDate() + 1)) {
    if (!spec.dayOk(day)) continue;
    for (const m of spec.times) {
      const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, m).getTime();
      if (at > t) return at;
    }
  }
  return null;
}

/** The next `n` times of a schedule Trigger after `now`; [] for any other Trigger or bad input. */
export function nextTimes(trigger, now, n = 3) {
  let spec;
  try { spec = compile(trigger); } catch { return []; }
  const out = [];
  for (let t = now; out.length < n; ) {
    t = nextAfter(spec, t);
    if (t === null) break;
    out.push(t);
  }
  return out;
}

/**
 * The times of a schedule Trigger in (from, to]: how many, and the last one.
 * `{count: 0, latest: null}` when none or when the Trigger has no times.
 */
export function dueBetween(trigger, from, to) {
  let spec;
  try { spec = compile(trigger); } catch { return { count: 0, latest: null }; }
  let count = 0, latest = null;
  for (let t = nextAfter(spec, from); t !== null && t <= to && count < MAX_OCCURRENCES; t = nextAfter(spec, t)) {
    count++;
    latest = t;
  }
  return { count, latest };
}

const UNITS = { s: 1000, m: MINUTE, h: 60 * MINUTE, d: 1440 * MINUTE };
/** "90s", "15m", "2h" or "7d", or a positive number of ms (as the settings take it), in ms; else null. */
export function durationMs(value) {
  if (typeof value === "number") return value > 0 ? value : null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(s|m|h|d)\s*$/.exec(String(value ?? ""));
  return m ? Math.round(Number(m[1]) * UNITS[m[2]]) : null;
}

/** The Catch-up window in ms when the Automation does not set one: 2 h for daily and weekday schedules. */
export const defaultCatchUp = (trigger) =>
  trigger?.type === "schedule" && (trigger.preset === "daily" || trigger.preset === "weekdays") ? 2 * 60 * MINUTE : 0;

/** Two digits: 7 → "07". */
export const pad = (n) => String(n).padStart(2, "0");
/** Local "HH:MM" of instant `t`. */
export const hhmm = (t) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
/** "Today 09:00", "Tomorrow 09:00" or "Mon 3 Dec 09:00" for instant `t` seen at `now`. */
export function when(t, now) {
  const d = new Date(t), today = new Date(now);
  const days = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - new Date(today.getFullYear(), today.getMonth(), today.getDate())) / 86400000);
  const day = days === 0 ? "Today" : days === 1 ? "Tomorrow" : days === -1 ? "Yesterday"
    : `${DAY_NAMES[d.getDay()]} ${d.getDate()} ${d.toLocaleString("en", { month: "short" })}`;
  return `${day} ${hhmm(t)}`;
}

/**
 * The Trigger in words: "Every 15 minutes", "Daily at 09:00", "Mon, Fri at 09:00", "Cron 0 9 * * 1-5",
 * "Manual", "When a claude agent in the folder is done", "New commit on the current branch", "New commits on origin/main".
 */
export function describe(trigger) {
  if (trigger?.type === "manual") return "Manual";
  if (trigger?.type === "agent")
    return `When ${trigger.app ? `a ${trigger.app} agent` : "an agent"}${trigger.inFolder ? " in the folder" : ""} ${trigger.status === "blocked" ? "needs you" : "is done"}`;
  if (trigger?.type === "git") return trigger.source === "remote" ? `New commits on ${trigger.branch}` : "New commit on the current branch";
  if (trigger?.type !== "schedule") return trigger?.type ?? "Unknown";
  switch (trigger.preset) {
    case "every": return trigger.minutes === 1 ? "Every minute" : `Every ${trigger.minutes} minutes`;
    case "daily": return `Daily at ${trigger.at}`;
    case "weekdays": {
      const days = [...(trigger.days ?? WEEKDAYS)].sort();
      const names = days.join() === WEEKDAYS.join() ? "Weekdays" : days.map((d) => DAY_NAMES[d]).join(", ");
      return `${names} at ${trigger.at}`;
    }
    case "cron": return `Cron ${trigger.cron}`;
    default: return "Schedule";
  }
}

export { DAY_NAMES, WEEKDAYS };
