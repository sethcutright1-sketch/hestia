// Date stepping and labels for the Food diary (src/sections/food/dates.ts).

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { LOG_ON_THE_DAY, canLogPlanned, canMarkDone, dayLabel, isFutureDay, longDate, stepDate, whenLabel } from "../src/sections/food/dates.ts";

describe("stepDate", () => {
  test("moves one day either way, across month and year ends and a leap day", () => {
    assert.equal(stepDate("2026-10-15", 1), "2026-10-16");
    assert.equal(stepDate("2026-10-15", -1), "2026-10-14");
    assert.equal(stepDate("2026-10-31", 1), "2026-11-01");
    assert.equal(stepDate("2026-12-31", 1), "2027-01-01");
    assert.equal(stepDate("2027-01-01", -1), "2026-12-31");
    assert.equal(stepDate("2028-02-28", 1), "2028-02-29");
    assert.equal(stepDate("2028-03-01", -1), "2028-02-29");
  });
  test("is not thrown by daylight-saving changes (the maths is on dates, not instants)", () => {
    assert.equal(stepDate("2026-03-08", 1), "2026-03-09");
    assert.equal(stepDate("2026-11-01", 1), "2026-11-02");
    assert.equal(stepDate("2026-11-02", -1), "2026-11-01");
  });
});

describe("dayLabel / whenLabel / longDate", () => {
  const today = "2026-10-15"; // a Thursday
  test("Today, Yesterday, Tomorrow, else the weekday", () => {
    assert.equal(dayLabel("2026-10-15", today), "Today");
    assert.equal(dayLabel("2026-10-14", today), "Yesterday");
    assert.equal(dayLabel("2026-10-16", today), "Tomorrow");
    assert.equal(dayLabel("2026-10-10", today), "Saturday");
    assert.equal(dayLabel("2026-10-19", today), "Monday");
  });
  test("whenLabel adds the date when the weekday alone would be ambiguous", () => {
    assert.equal(whenLabel("2026-10-15", today), "Today");
    assert.equal(whenLabel("2026-10-10", today), "Saturday, Oct 10");
  });
  test("longDate is fixed English", () => {
    assert.equal(longDate("2026-10-05"), "Oct 5, 2026");
    assert.equal(longDate("2027-01-31"), "Jan 31, 2027");
  });
});

describe("canMarkDone", () => {
  const today = "2026-10-15";
  test("today and the 7 days before it", () => {
    assert.equal(canMarkDone("2026-10-15", today), true);
    assert.equal(canMarkDone("2026-10-08", today), true);
    assert.equal(canMarkDone("2026-10-07", today), false);
  });
  test("never a day that hasn't happened", () => {
    assert.equal(canMarkDone("2026-10-16", today), false);
  });
});

describe("isFutureDay", () => {
  test("only days after today", () => {
    assert.equal(isFutureDay("2026-10-16", "2026-10-15"), true);
    assert.equal(isFutureDay("2026-10-15", "2026-10-15"), false);
    assert.equal(isFutureDay("2026-10-14", "2026-10-15"), false);
  });
});

describe("canLogPlanned", () => {
  test("a planned entry can be logged only on or after its own day", () => {
    assert.equal(canLogPlanned("2026-10-16", "2026-10-15"), false, "tomorrow");
    assert.equal(canLogPlanned("2027-01-01", "2026-10-15"), false, "months ahead");
    assert.equal(canLogPlanned("2026-10-15", "2026-10-15"), true, "today");
    assert.equal(canLogPlanned("2026-10-14", "2026-10-15"), true, "yesterday");
    assert.equal(canLogPlanned("2025-01-01", "2026-10-15"), true, "long ago");
    assert.equal(LOG_ON_THE_DAY, "Log it on the day");
  });
});
