import { test } from "node:test";
import assert from "node:assert/strict";
import { localDate, serverToday, serverMonth, addDays, isValidLocalDate, dayOfWeek, mondayOf } from "../nutrition/dates.ts";

test("localDate: UTC evening is still 'today' in the Americas", () => {
  // 01:30 UTC on Jan 15 = 8:30 pm Jan 14 in New York (EST) and 5:30 pm Jan 14 in LA.
  const at = new Date("2026-01-15T01:30:00Z");
  assert.equal(at.toISOString().slice(0, 10), "2026-01-15"); // the naive UTC answer, which is a day late for evenings in the Americas
  assert.equal(localDate("America/New_York", at), "2026-01-14");
  assert.equal(localDate("America/Los_Angeles", at), "2026-01-14");
  assert.equal(localDate("UTC", at), "2026-01-15");
});

test("localDate: DST (EDT is UTC-4) and zones ahead of UTC", () => {
  const at = new Date("2026-07-04T03:30:00Z"); // 11:30 pm Jul 3 EDT, 8:30 pm Jul 3 PDT
  assert.equal(localDate("America/New_York", at), "2026-07-03");
  assert.equal(localDate("America/Los_Angeles", at), "2026-07-03");
  assert.equal(localDate("Pacific/Auckland", new Date("2026-01-14T20:00:00Z")), "2026-01-15");
});

test("addDays crosses month, year and leap boundaries", () => {
  assert.equal(addDays("2026-01-31", 1), "2026-02-01");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  assert.equal(addDays("2024-03-01", -1), "2024-02-29");
  assert.equal(addDays("2025-12-31", 1), "2026-01-01");
  assert.equal(addDays("2026-03-08", 1), "2026-03-09"); // US DST change day
  assert.throws(() => addDays("nope", 1), RangeError);
});

test("isValidLocalDate", () => {
  assert.ok(isValidLocalDate("2024-02-29"));
  assert.ok(!isValidLocalDate("2025-02-29"));
  assert.ok(!isValidLocalDate("2026-13-01"));
  assert.ok(!isValidLocalDate("2026-1-1"));
  assert.ok(!isValidLocalDate(20260101));
});

test("dayOfWeek: 0 is Sunday, across month and year edges", () => {
  assert.equal(dayOfWeek("2026-03-08"), 0); // a Sunday (US DST change day)
  assert.equal(dayOfWeek("2026-03-09"), 1);
  assert.equal(dayOfWeek("2026-03-14"), 6);
  assert.equal(dayOfWeek("2024-02-29"), 4);
  assert.equal(dayOfWeek("2000-01-01"), 6);
  assert.throws(() => dayOfWeek("2026-02-30"), RangeError);
});

test("mondayOf: the Monday on or before, so weeks run Monday to Sunday", () => {
  assert.equal(mondayOf("2026-03-09"), "2026-03-09"); // a Monday maps to itself
  assert.equal(mondayOf("2026-03-10"), "2026-03-09");
  assert.equal(mondayOf("2026-03-15"), "2026-03-09"); // Sunday belongs to the week that began the Monday before
  assert.equal(mondayOf("2026-03-16"), "2026-03-16");
  assert.equal(mondayOf("2026-03-01"), "2026-02-23"); // across a month
  assert.equal(mondayOf("2026-01-01"), "2025-12-29"); // across a year
});

test("serverToday / serverMonth: read the machine's local clock, never UTC", () => {
  // Constructed from local components, so the answer is the same in any timezone. 11:30 pm local is "tomorrow" in
  // UTC for every zone west of Greenwich, which is exactly the household's evening problem.
  assert.equal(serverToday(new Date(2026, 9, 17, 23, 30)), "2026-10-17");
  assert.equal(serverToday(new Date(2026, 9, 17, 0, 1)), "2026-10-17");
  assert.equal(serverMonth(new Date(2026, 9, 31, 23, 30)), "2026-10");
  assert.equal(serverMonth(new Date(2026, 0, 1, 0, 30)), "2026-01");
});
