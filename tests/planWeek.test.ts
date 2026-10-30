// src/sections/mealplan/planWeek.ts -- the dates behind Meal Plan's "Plan the
// week" button. The button exists partly so the model never has to do this
// arithmetic itself, so it had better be right: local dates (not UTC), Sunday
// belonging to the week before, and month/year boundaries.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { isoDate, mondayOf, weekDays, defaultDays, buildPlanMessage, daysInCall, savedDays, missingDays, saveNudge, SAVE_NUDGE } from "../src/sections/mealplan/planWeek.ts";

describe("mondayOf", () => {
  test("a Thursday maps back to that week's Monday", () => {
    assert.equal(isoDate(mondayOf(new Date(2026, 9, 1))), "2026-09-28");
  });

  test("Sunday belongs to the week that started six days earlier", () => {
    assert.equal(isoDate(mondayOf(new Date(2026, 9, 4))), "2026-09-28");
  });

  test("a Monday is its own week", () => {
    assert.equal(isoDate(mondayOf(new Date(2026, 9, 5, 23, 30))), "2026-10-05");
  });
});

describe("isoDate", () => {
  test("is the local calendar date, even late in the evening", () => {
    // toISOString() would report tomorrow here for anyone west of UTC.
    assert.equal(isoDate(new Date(2026, 9, 1, 23, 45)), "2026-10-01");
  });
});

describe("weekDays", () => {
  test("runs Monday to Sunday across a year boundary", () => {
    const days = weekDays(new Date(2026, 11, 28));
    assert.equal(days.length, 7);
    assert.deepEqual(days[0], { day: "Monday", date: "2026-12-28" });
    assert.deepEqual(days[6], { day: "Sunday", date: "2027-01-03" });
  });
});

describe("defaultDays", () => {
  test("next week ticks every day", () => {
    assert.equal(defaultDays("next", new Date(2026, 9, 1)).size, 7);
  });

  test("this week ticks today onward", () => {
    assert.deepEqual([...defaultDays("this", new Date(2026, 9, 1))], ["Thursday", "Friday", "Saturday", "Sunday"]);
  });

  test("on a Sunday, this week is just Sunday", () => {
    assert.deepEqual([...defaultDays("this", new Date(2026, 9, 4))], ["Sunday"]);
  });
});

describe("buildPlanMessage", () => {
  test("spells out every date and the week it belongs to", () => {
    const days = weekDays(new Date(2026, 9, 5)).slice(0, 3);
    assert.equal(
      buildPlanMessage(days),
      "Plan breakfast, lunch and dinner for Monday 2026-10-05, Tuesday 2026-10-06 and Wednesday 2026-10-07 " +
        "(the week starting 2026-10-05). Choose the dishes yourself and save them with create_meal_plan one day at a time -- " +
        "one call per day with that day's meals and keepOtherDays: true."
    );
  });

  test("puts days in week order whatever order they came in", () => {
    const [mon, , , , fri] = weekDays(new Date(2026, 9, 5));
    assert.match(buildPlanMessage([fri, mon]), /Monday 2026-10-05 and Friday 2026-10-09/);
  });

  test("a single day reads naturally", () => {
    const [, , , , , sat] = weekDays(new Date(2026, 9, 5));
    assert.match(buildPlanMessage([sat]), /for Saturday 2026-10-10 \(the week starting 2026-10-05\)/);
  });
});

describe("saving a day at a time", () => {
  const week = weekDays(new Date(2026, 9, 5));
  const call = (days: string[], keepOtherDays?: boolean) => ({
    args: { weekStart: "2026-10-05", ...(keepOtherDays === undefined ? {} : { keepOtherDays }), meals: days.map((day) => ({ day, slot: "dinner", name: "x", ingredients: ["y"] })) },
  });

  test("daysInCall reads the days off a call's meals, in week order, whatever the casing", () => {
    assert.deepEqual(daysInCall({ meals: [{ day: "friday" }, { day: " Monday " }, { day: "Friday" }, { day: "Blursday" }, {}] }), ["Monday", "Friday"]);
    assert.deepEqual(daysInCall(undefined), []);
    assert.deepEqual(daysInCall({ meals: "nope" }), []);
  });

  test("savedDays adds up the calls that kept the other days", () => {
    assert.deepEqual([...savedDays([call(["Monday"], true), call(["Tuesday"], true)])].sort(), ["Monday", "Tuesday"]);
  });

  test("a call without keepOtherDays replaced the week, so earlier days are gone", () => {
    assert.deepEqual([...savedDays([call(["Monday"], true), call(["Tuesday", "Wednesday"])])].sort(), ["Tuesday", "Wednesday"]);
    assert.deepEqual([...savedDays([call(["Monday"], true), call(["Tuesday"], false)])], ["Tuesday"]);
  });

  test("missingDays lists the ticked days nothing saved, in week order", () => {
    const ticked = [week[4], week[3], week[6], week[0]];
    assert.deepEqual(missingDays(ticked, new Set(["Monday"])), ["Thursday", "Friday", "Sunday"]);
    assert.deepEqual(missingDays(ticked, new Set(["Monday", "Thursday", "Friday", "Sunday", "Tuesday"])), []);
  });

  test("the nudge names the missing days and asks for one call each", () => {
    assert.equal(
      saveNudge(["Thursday", "Friday", "Sunday"]),
      "You haven't saved Thursday, Friday and Sunday yet. Call create_meal_plan for each of them now, one day per call, with keepOtherDays: true -- " +
        "use the dishes you just described, with a slot, name and ingredients for each meal."
    );
    assert.match(saveNudge(["Sunday"]), /^You haven't saved Sunday yet\. Call create_meal_plan for it now, one day per call, with keepOtherDays: true/);
    assert.match(saveNudge(["Monday", "Tuesday"]), /saved Monday and Tuesday yet/);
  });

  test("with no days to name the nudge is the generic one, which also asks for a day per call", () => {
    assert.equal(saveNudge([]), SAVE_NUDGE);
    assert.match(SAVE_NUDGE, /one day per call with keepOtherDays: true/);
  });
});
