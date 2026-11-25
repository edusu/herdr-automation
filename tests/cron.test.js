import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCron, nextTimes, dueBetween, describe, durationMs, defaultCatchUp } from "../mods/automation/cron.js";

const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const cron = (c) => ({ type: "schedule", preset: "cron", cron: c });

test("cron fields take numbers, ranges, lists and steps", () => {
  const c = parseCron("*/15 9-11 1,15 * 1-5");
  assert.deepEqual([...c.minute], [0, 15, 30, 45]);
  assert.deepEqual([...c.hour], [9, 10, 11]);
  assert.deepEqual([...c.day], [1, 15]);
  assert.equal(c.month.size, 12);
  assert.deepEqual([...c.weekday], [1, 2, 3, 4, 5]);
  assert.deepEqual([...parseCron("5/20 * * * 7").minute], [5, 25, 45]);
  assert.deepEqual([...parseCron("0 0 * * 7").weekday], [0]);
});

test("bad cron input is refused with a reason", () => {
  for (const bad of ["", "* * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "a * * * *", "5-1 * * * *", "*/0 * * * *", "* * * * * *"])
    assert.throws(() => parseCron(bad), Error, bad);
});

test("next three times of the presets, in local time", () => {
  const now = at(2026, 11, 25, 8, 50); // a Wednesday
  assert.deepEqual(nextTimes({ type: "schedule", preset: "every", minutes: 15 }, now), [at(2026, 11, 25, 9), at(2026, 11, 25, 9, 15), at(2026, 11, 25, 9, 30)]);
  assert.deepEqual(nextTimes({ type: "schedule", preset: "daily", at: "08:30" }, now), [at(2026, 11, 26, 8, 30), at(2026, 11, 27, 8, 30), at(2026, 11, 28, 8, 30)]);
  assert.deepEqual(nextTimes({ type: "schedule", preset: "weekdays", at: "09:00", days: [1, 5] }, now), [at(2026, 11, 27, 9), at(2026, 11, 30, 9), at(2026, 12, 4, 9)]);
  assert.deepEqual(nextTimes(cron("0 9 * * 1-5"), at(2026, 11, 27, 10)), [at(2026, 11, 30, 9), at(2026, 12, 1, 9), at(2026, 12, 2, 9)]);
  assert.deepEqual(nextTimes({ type: "schedule", preset: "every", minutes: 90 }, at(2026, 11, 25, 22, 31), 2), [at(2026, 11, 26, 0), at(2026, 11, 26, 1, 30)]);
});

test("a cron with day and weekday both set matches either", () => {
  assert.deepEqual(nextTimes(cron("0 0 13 * 5"), at(2026, 11, 1), 2), [at(2026, 11, 6), at(2026, 11, 13)]);
});

test("a rare cron is found and an impossible one gives nothing", () => {
  assert.deepEqual(nextTimes(cron("0 0 29 2 *"), at(2026, 11, 25), 1), [at(2028, 2, 29)]);
  assert.deepEqual(nextTimes(cron("0 0 31 2 *"), at(2026, 11, 25)), []);
  assert.deepEqual(nextTimes({ type: "manual" }, at(2026, 11, 25)), []);
});

test("due times between two instants count a sleep gap", () => {
  const every = { type: "schedule", preset: "every", minutes: 15 };
  assert.deepEqual(dueBetween(every, at(2026, 11, 25, 9), at(2026, 11, 25, 9, 14)), { count: 0, latest: null });
  assert.deepEqual(dueBetween(every, at(2026, 11, 25, 9), at(2026, 11, 25, 9, 15)), { count: 1, latest: at(2026, 11, 25, 9, 15) });
  // Asleep from 18:05 to 09:20 the next day.
  assert.deepEqual(dueBetween(every, at(2026, 11, 25, 18, 5), at(2026, 11, 26, 9, 20)), { count: 61, latest: at(2026, 11, 26, 9, 15) });
  const daily = { type: "schedule", preset: "daily", at: "09:00" };
  assert.deepEqual(dueBetween(daily, at(2026, 11, 23, 10), at(2026, 11, 26, 9, 30)), { count: 3, latest: at(2026, 11, 26, 9) });
});

test("Triggers in words, durations and the default Catch-up", () => {
  assert.equal(describe({ type: "schedule", preset: "every", minutes: 15 }), "Every 15 minutes");
  assert.equal(describe({ type: "schedule", preset: "daily", at: "09:00" }), "Daily at 09:00");
  assert.equal(describe({ type: "schedule", preset: "weekdays", at: "09:00", days: [1, 2, 3, 4, 5] }), "Weekdays at 09:00");
  assert.equal(describe({ type: "schedule", preset: "weekdays", at: "09:00", days: [5, 1] }), "Mon, Fri at 09:00");
  assert.equal(describe(cron("0 9 * * *")), "Cron 0 9 * * *");
  assert.equal(describe({ type: "manual" }), "Manual");
  assert.equal(durationMs("2h"), 7200000);
  assert.equal(durationMs("7d"), 604800000);
  assert.equal(durationMs("soon"), null);
  assert.equal(defaultCatchUp({ type: "schedule", preset: "daily", at: "09:00" }), 7200000);
  assert.equal(defaultCatchUp({ type: "schedule", preset: "weekdays", at: "09:00" }), 7200000);
  assert.equal(defaultCatchUp({ type: "schedule", preset: "every", minutes: 5 }), 0);
  assert.equal(defaultCatchUp(cron("* * * * *")), 0);
});
