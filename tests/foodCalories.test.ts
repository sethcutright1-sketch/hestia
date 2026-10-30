// The wording and numbers of the Food diary's top card and meal cards (src/sections/food/calories.ts):
// "X left" / "Y over", the calorie budget - food + exercise line, the meal "eaten / target", streak text.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  amountText, doneToast, kcalText, macroRows, plannedNote, slotView, streakText, summaryView,
} from "../src/sections/food/calories.ts";
import type { DaySummary } from "../src/sections/food/types.ts";

const nut = { kcal: 0, protein: 0, carbs: 0, fat: 0, satFat: 0, sugars: 0, fiber: 0, cholesterolMg: 0, sodiumMg: 0 };

const summary = (over: Partial<DaySummary> = {}): DaySummary => ({
  date: "2026-10-15",
  calorieBudget: 2100,
  maintenance: 2400,
  belowFloor: false,
  missing: [],
  eaten: 980,
  exercise: 120,
  exerciseExcluded: 0,
  remaining: 1240,
  macros: { protein: { eaten: 60, goal: 120 }, carbs: { eaten: 100, goal: 250 }, fat: { eaten: 30, goal: null } },
  nutrients: nut,
  perSlot: {},
  plannedKcal: 0,
  plannedCount: 0,
  doneLoggingAt: null,
  ...over,
});

describe("kcalText", () => {
  test("whole kcal with thousands separators", () => {
    assert.equal(kcalText(1240), "1,240");
    assert.equal(kcalText(2100.4), "2,100");
    assert.equal(kcalText(0), "0");
    assert.equal(kcalText(999.6), "1,000");
  });
});

describe("summaryView", () => {
  test("under the calorie budget: '1,240 left' and the budget - food + exercise line", () => {
    const v = summaryView(summary());
    assert.deepEqual([v.hasBudget, v.big, v.bigLabel, v.over], [true, "1,240", "left", false]);
    assert.equal(v.equation, "2,100 calorie budget − 980 food + 120 exercise");
    assert.equal(v.spoken, "1,240 calories left");
    assert.equal(v.missingNote, null);
  });

  test("over the calorie budget reads '150 over', never a negative left", () => {
    const v = summaryView(summary({ eaten: 2370, remaining: -150 }));
    assert.deepEqual([v.big, v.bigLabel, v.over], ["150", "over", true]);
    assert.equal(v.spoken, "150 calories over");
    assert.ok(!v.big.includes("-"));
  });

  test("exactly on the calorie budget is '0 left', and a fraction of a calorie over still is", () => {
    assert.deepEqual([summaryView(summary({ remaining: 0 })).big, summaryView(summary({ remaining: 0 })).bigLabel], ["0", "left"]);
    const tiny = summaryView(summary({ remaining: -0.4 }));
    assert.deepEqual([tiny.big, tiny.bigLabel, tiny.over], ["0", "left", false]);
    assert.equal(summaryView(summary({ remaining: -0.6 })).bigLabel, "over");
  });

  test("burned calories raise what is left and show in the line (they are added back to the calorie budget)", () => {
    const none = summaryView(summary({ exercise: 0, remaining: 1120 }));
    const some = summaryView(summary({ exercise: 300, remaining: 1420 }));
    assert.equal(none.equation, "2,100 calorie budget − 980 food + 0 exercise");
    assert.equal(some.equation, "2,100 calorie budget − 980 food + 300 exercise");
    assert.equal(some.big, "1,420");
  });

  test("the progress fraction is food over (calorie budget + exercise), clamped to 0..1", () => {
    assert.equal(summaryView(summary({ eaten: 1050, exercise: 100, calorieBudget: 2000, remaining: 1050 })).fraction, 0.5);
    assert.equal(summaryView(summary({ eaten: 5000, remaining: -2900 })).fraction, 1);
    assert.equal(summaryView(summary({ eaten: 0, remaining: 2220 })).fraction, 0);
  });

  test("with no calorie budget yet it shows what was eaten and says what is missing", () => {
    const v = summaryView(summary({ calorieBudget: null, remaining: null, missing: ["goal", "weight"], eaten: 640 }));
    assert.deepEqual([v.hasBudget, v.big, v.bigLabel, v.equation], [false, "640", "eaten", null]);
    assert.equal(v.missingNote, "Your calorie budget can't be worked out yet. It needs a weight goal and a weigh-in.");
    assert.equal(summaryView(summary({ calorieBudget: null, remaining: null, missing: [] })).missingNote, "Your calorie budget can't be worked out yet.");
    assert.match(summaryView(summary({ calorieBudget: null, remaining: null, missing: ["profile", "goal", "weight"] })).missingNote!, /a profile \(sex, birth date, height\), a weight goal and a weigh-in/);
  });

  test("never mentions a bare 'budget': it is always the calorie budget", () => {
    const v = summaryView(summary());
    assert.ok(!/(?<!calorie )budget/.test(v.equation!));
  });
});

describe("macroRows", () => {
  test("three rows with a fraction of the goal, and no fraction without a goal", () => {
    const rows = macroRows(summary());
    assert.deepEqual(rows.map((r) => r.key), ["protein", "carbs", "fat"]);
    assert.deepEqual(rows.map((r) => r.text), ["60 / 120 g", "100 / 250 g", "30 g"]);
    assert.deepEqual(rows.map((r) => r.fraction), [0.5, 0.4, 0]);
  });
  test("eating past a macro goal stops the bar at full", () => {
    assert.equal(macroRows(summary({ macros: { protein: { eaten: 300, goal: 100 }, carbs: { eaten: 0, goal: 1 }, fat: { eaten: 0, goal: 1 } } }))[0].fraction, 1);
  });
});

describe("slotView", () => {
  test("a meal with a target reads 'eaten / target kcal'", () => {
    const v = slotView({ kcal: 320, targetKcal: 500 });
    assert.deepEqual([v.text, v.over, v.remaining], ["320 / 500 kcal", false, 180]);
    assert.equal(v.detail, "180 kcal left in this meal's target");
  });
  test("over the target is flagged, and says by how much", () => {
    const v = slotView({ kcal: 650, targetKcal: 500 });
    assert.deepEqual([v.text, v.over, v.remaining], ["650 / 500 kcal", true, -150]);
    assert.equal(v.detail, "150 kcal over this meal's target");
  });
  test("exactly on the target is not over", () => {
    assert.equal(slotView({ kcal: 500, targetKcal: 500 }).over, false);
  });
  test("with no target it is just the kcal, never over", () => {
    const v = slotView({ kcal: 1200, targetKcal: null });
    assert.deepEqual([v.text, v.over, v.target, v.remaining, v.detail], ["1,200 kcal", false, null, null, null]);
  });
});

describe("wording", () => {
  test("plannedNote", () => {
    assert.equal(plannedNote({ plannedCount: 0, plannedKcal: 0 }), null);
    assert.equal(plannedNote({ plannedCount: 2, plannedKcal: 1050 }), "2 planned (1,050 kcal) not counted until logged.");
  });
  test("streak and done toast", () => {
    assert.equal(streakText(12), "12-day streak");
    assert.equal(doneToast({ current: 13 }), "Day done. 13-day streak.");
    assert.equal(doneToast({ current: 0 }), "Day done.");
    assert.equal(doneToast(null), "Day done.");
  });
  test("amountText avoids '1 1 cup'", () => {
    assert.equal(amountText(150, "g"), "150 g");
    assert.equal(amountText(2, "1 bar"), "2 x 1 bar");
    assert.equal(amountText(1, "1 cup (80 g)"), "1 cup (80 g)");
    assert.equal(amountText(1.5, "slice"), "1.5 slice");
  });
});
