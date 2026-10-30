import { test } from "node:test";
import assert from "node:assert/strict";
import { addDays } from "../nutrition/dates.ts";
import { computeStreak } from "../nutrition/streaks.ts";

/** `n` consecutive days ending on `last`. */
const run = (last: string, n: number) => Array.from({ length: n }, (_, i) => addDays(last, -i));

test("no counted days: nothing", () => {
  assert.deepEqual(computeStreak([], "2026-03-10"), { current: 0, best: 0, countedToday: false });
});

test("today counted: the run ends today", () => {
  assert.deepEqual(computeStreak(run("2026-03-10", 4), "2026-03-10"), { current: 4, best: 4, countedToday: true });
});

test("today not counted yet: an unfinished today doesn't break the run that ended yesterday", () => {
  assert.deepEqual(computeStreak(run("2026-03-09", 12), "2026-03-10"), { current: 12, best: 12, countedToday: false });
});

test("a whole uncounted day breaks it: two days ago is too old", () => {
  assert.deepEqual(computeStreak(run("2026-03-08", 5), "2026-03-10"), { current: 0, best: 5, countedToday: false });
});

test("gaps: current stops at the gap, best is the longest run anywhere", () => {
  const counted = [...run("2026-03-10", 3), ...run("2026-03-05", 6)]; // 3-day run now, gap on the 7th-6th, 6-day run before
  assert.deepEqual(computeStreak(counted, "2026-03-10"), { current: 3, best: 6, countedToday: true });
  // A single missed day in the middle splits the run in two.
  const split = [...run("2026-03-10", 2), ...run("2026-03-07", 2)]; // 10, 9, [8 missing], 7, 6
  assert.deepEqual(computeStreak(split, "2026-03-10"), { current: 2, best: 2, countedToday: true });
});

test("best can be the current run", () => {
  const counted = [...run("2026-03-10", 10), "2026-02-01", "2026-02-02"];
  assert.deepEqual(computeStreak(counted, "2026-03-10"), { current: 10, best: 10, countedToday: true });
});

test("duplicates, unsorted input and invalid or future dates are harmless", () => {
  const counted = ["2026-03-10", "2026-03-08", "2026-03-09", "2026-03-09", "not-a-date", "2026-03-11", "2026-02-30"];
  assert.deepEqual(computeStreak(counted, "2026-03-10"), { current: 3, best: 3, countedToday: true });
  assert.deepEqual(computeStreak(new Set(["2026-03-09"]), "2026-03-10"), { current: 1, best: 1, countedToday: false });
});

test("month, year and leap-day boundaries count as consecutive", () => {
  assert.equal(computeStreak(["2026-02-27", "2026-02-28", "2026-03-01", "2026-03-02"], "2026-03-02").current, 4);
  assert.equal(computeStreak(["2025-12-30", "2025-12-31", "2026-01-01"], "2026-01-01").current, 3);
  assert.equal(computeStreak(["2024-02-28", "2024-02-29", "2024-03-01"], "2024-03-01").best, 3);
  // ...and a missing 29th of a leap February is a gap.
  assert.deepEqual(computeStreak(["2024-02-28", "2024-03-01"], "2024-03-01"), { current: 1, best: 1, countedToday: true });
});

test("daylight-saving change days neither skip nor repeat a day", () => {
  // US spring forward is 2026-03-08 (a 23-hour day) and fall back is 2026-11-01 (25 hours).
  assert.equal(computeStreak(["2026-03-07", "2026-03-08", "2026-03-09"], "2026-03-09").current, 3);
  assert.equal(computeStreak(["2026-10-31", "2026-11-01", "2026-11-02"], "2026-11-02").current, 3);
  assert.equal(computeStreak(run("2026-11-02", 400), "2026-11-02").current, 400);
});

test("a long history: best survives a recent break", () => {
  const counted = [...run("2026-01-31", 90), ...run("2026-03-10", 2)];
  assert.deepEqual(computeStreak(counted, "2026-03-10"), { current: 2, best: 90, countedToday: true });
});
