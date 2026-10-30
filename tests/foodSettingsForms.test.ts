// Food settings' forms as pure functions: Profile, Calorie goals (with the calorie schedule), Meals and Snack
// allowance (src/sections/food/profileForm.ts, goalForm.ts, slotSettings.ts).

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  ACTIVITY_OPTIONS, DEFAULT_EXTRA_KCAL, PLANS, WEEK, buildGoal, goalFormFrom, goalSummary, macroTotal, planLabel, previewBody, scheduleProblem,
  scheduleValue, toggleDay,
} from "../src/sections/food/goalForm.ts";
import { buildProfile, profileFormFrom, switchUnits } from "../src/sections/food/profileForm.ts";
import { isLastEnabled, mealBody, moveKey, snackBody, targetBody, targetKindOf, targetSummary } from "../src/sections/food/slotSettings.ts";
import type { Goal, Profile } from "../src/sections/food/types.ts";

const profile: Profile = {
  id: "u1", name: "Alex", role: "admin", hasProfile: true, sex: "male", birthDate: "1988-01-01", heightCm: 180, timezone: "America/New_York", unitSystem: "imperial",
};

const goal: Goal = {
  id: 3, effectiveFrom: "2026-10-01", planLbPerWeek: 1, activityLevel: "light", palOverride: 1.4, minCalorieBudgetMode: "safe", calorieBudgetOverrideKcal: null,
  macroMode: "percent", macroProtein: 25, macroCarbs: 45, macroFat: 30, goalWeightKg: 79.38, calorieSchedule: { highDays: [6, 0], extraKcal: 250 },
};

describe("profile", () => {
  test("the form starts from what is saved, in the person's units", () => {
    const f = profileFormFrom(profile);
    assert.deepEqual(f, { sex: "male", birthDate: "1988-01-01", unitSystem: "imperial", ft: "5", inch: "10.9", cm: "180", timezone: "America/New_York" });
    const first = profileFormFrom({ ...profile, hasProfile: false, sex: null, birthDate: null, heightCm: null });
    assert.deepEqual([first.sex, first.birthDate, first.ft, first.cm], ["", "", "", ""]);
  });

  test("a complete form becomes the body (height in cm whatever was typed); an incomplete one says what is missing", () => {
    const ok = buildProfile({ sex: "female", birthDate: "1990-06-15", unitSystem: "imperial", ft: "5", inch: "7", cm: "", timezone: " America/Chicago " });
    assert.deepEqual(ok, { ok: true, body: { sex: "female", birthDate: "1990-06-15", heightCm: 170.2, timezone: "America/Chicago", unitSystem: "imperial" } });
    const metric = buildProfile({ sex: "male", birthDate: "1988-01-01", unitSystem: "metric", ft: "", inch: "", cm: "182", timezone: "UTC" });
    assert.deepEqual(metric.ok && metric.body.heightCm, 182);
    const msg = (f: Parameters<typeof buildProfile>[0]) => { const r = buildProfile(f); return r.ok ? "" : r.error; };
    const full = { sex: "male" as const, birthDate: "1988-01-01", unitSystem: "metric" as const, ft: "", inch: "", cm: "180", timezone: "UTC" };
    assert.match(msg({ ...full, sex: "" }), /male or female/);
    assert.match(msg({ ...full, birthDate: "" }), /birth date/);
    assert.match(msg({ ...full, birthDate: "1988-02-31" }), /birth date/);
    assert.match(msg({ ...full, birthDate: "1850-01-01" }), /birth date/);
    assert.match(msg({ ...full, cm: "" }), /height/);
    assert.match(msg({ ...full, cm: "20" }), /between 50 and 260/);
    assert.match(msg({ ...full, timezone: "  " }), /time zone/);
  });

  test("switching units while editing converts the height typed so far", () => {
    const f = profileFormFrom(profile);
    const metric = switchUnits(f, "metric");
    assert.deepEqual([metric.unitSystem, metric.cm], ["metric", "180.1"]);
    const back = switchUnits(metric, "imperial");
    assert.deepEqual([back.unitSystem, back.ft, back.inch], ["imperial", "5", "10.9"]);
    assert.equal(switchUnits(f, "imperial"), f);
    assert.deepEqual(switchUnits({ ...f, ft: "", inch: "" }, "metric").cm, "", "a height not typed yet stays empty");
  });
});

describe("goals", () => {
  test("plans run from the biggest loss to the biggest gain, with the server's sign (positive = lose)", () => {
    assert.deepEqual([...PLANS], [2, 1.5, 1, 0.5, 0, -0.5, -1, -1.5, -2]);
    assert.equal(planLabel(1), "Lose 1 lb per week");
    assert.equal(planLabel(-0.5), "Gain 0.5 lb per week");
    assert.equal(planLabel(0), "Maintain weight");
  });

  test("the form starts from the goal in effect, goal weight in the person's units; with none it starts from sensible defaults", () => {
    const f = goalFormFrom(goal, "imperial");
    assert.deepEqual([f.plan, f.activity, f.minMode, f.protein, f.carbs, f.fat, f.override, f.goalWeight, f.highDays, f.extra], [1, "light", "safe", "25", "45", "30", "", "175", [6, 0], "250"]);
    assert.equal(goalFormFrom(goal, "metric").goalWeight, "79.4");
    const none = goalFormFrom(null, "imperial");
    assert.deepEqual([none.plan, none.activity, none.protein, none.carbs, none.fat, none.goalWeight, none.highDays, none.extra], [0, "light", "20", "50", "30", "", [], String(DEFAULT_EXTRA_KCAL)]);
  });

  test("a goal is built only when the macros total 100, the calorie budget is in range and the schedule is valid", () => {
    const f = goalFormFrom(goal, "imperial");
    const built = buildGoal(f, "imperial", goal.palOverride);
    assert.deepEqual(built.ok && built.body, {
      planLbPerWeek: 1, activityLevel: "light", minCalorieBudgetMode: "safe", macroMode: "percent", macroProtein: 25, macroCarbs: 45, macroFat: 30,
      calorieBudgetOverrideKcal: null, goalWeightKg: 79.38, palOverride: 1.4, calorieSchedule: { highDays: [0, 6], extraKcal: 250 },
    });
    const err = (patch: Partial<typeof f>) => { const r = buildGoal({ ...f, ...patch }, "imperial", null); return r.ok ? "" : r.error; };
    assert.match(err({ protein: "30" }), /add up to 100/);
    assert.match(err({ protein: "" }), /0 to 100/);
    assert.match(err({ fat: "-5", protein: "35", carbs: "70" }), /0 to 100/);
    assert.match(err({ override: "100" }), /500 and 10,000/);
    assert.match(err({ override: "abc" }), /500 and 10,000/);
    assert.match(err({ goalWeight: "20" }), /Goal weight/);
    assert.match(err({ extra: "2000" }), /between 0 and 1,500/);
    assert.match(err({ highDays: [0, 1, 2, 3, 4, 5, 6] }), /at most 6/);
    const own = buildGoal({ ...f, override: "2100", goalWeight: "" }, "imperial", null);
    assert.deepEqual(own.ok && [own.body.calorieBudgetOverrideKcal, own.body.goalWeightKg, own.body.palOverride], [2100, null, null]);
  });

  test("the calorie schedule: chips toggle, no days = none (clears it), a bad extra stops the save", () => {
    assert.deepEqual(toggleDay([], 6), [6]);
    assert.deepEqual(toggleDay([6], 0), [0, 6]);
    assert.deepEqual(toggleDay([0, 6], 6), [0]);
    assert.deepEqual(WEEK.map(([n]) => n), [1, 2, 3, 4, 5, 6, 0], "Monday first, Sunday last; 0 = Sunday as the server counts");
    assert.equal(scheduleProblem({ highDays: [], extra: "garbage" }), "", "no days = no schedule, whatever the extra box says");
    assert.equal(scheduleValue({ highDays: [], extra: "300" }), null);
    assert.deepEqual(scheduleValue({ highDays: [6, 0], extra: "300" }), { highDays: [0, 6], extraKcal: 300 });
    assert.equal(scheduleValue({ highDays: [6], extra: "x" }), null);
    assert.match(scheduleProblem({ highDays: [6], extra: "" }), /between 0 and 1,500/);
    assert.match(scheduleProblem({ highDays: [6], extra: "-1" }), /between 0 and 1,500/);
    assert.equal(scheduleProblem({ highDays: [6], extra: "0" }), "");
  });

  test("the preview sends what is typed, saved or not, and never fails on a half-typed box", () => {
    const f = goalFormFrom(goal, "imperial");
    assert.deepEqual(previewBody({ ...f, plan: 0.5, override: "" }), {
      planLbPerWeek: 0.5, activityLevel: "light", minCalorieBudgetMode: "safe", calorieBudgetOverrideKcal: null, calorieSchedule: { highDays: [0, 6], extraKcal: 250 },
    });
    assert.equal(previewBody({ ...f, override: "21" }).calorieBudgetOverrideKcal, null, "an out-of-range own budget is left out of the preview, not sent to be refused");
    assert.equal(previewBody({ ...f, highDays: [] }).calorieSchedule, null);
    assert.equal(macroTotal({ protein: "20", carbs: "50", fat: "30.4" }), 100);
  });

  test("the goal in effect is summarised in a line", () => {
    assert.equal(goalSummary(null, "imperial"), "No goal saved yet.");
    assert.equal(goalSummary(goal, "imperial"), "Lose 1 lb per week · Lightly active · goal weight 175 lb · calorie schedule: Sat, Sun +250");
    assert.equal(goalSummary({ ...goal, planLbPerWeek: 0, goalWeightKg: null, calorieSchedule: null, calorieBudgetOverrideKcal: 2100, activityLevel: "very" }, "metric"), "Maintain weight · Very active · 2,100 calories a day");
    assert.deepEqual(ACTIVITY_OPTIONS.map(([v]) => v), ["sedentary", "light", "moderate", "very"]);
  });
});

describe("meals", () => {
  test("moving a meal up or down swaps neighbours, and the ends stay put", () => {
    const keys = ["breakfast", "lunch", "dinner", "snacks"];
    assert.deepEqual(moveKey(keys, 1, -1), ["lunch", "breakfast", "dinner", "snacks"]);
    assert.deepEqual(moveKey(keys, 1, 1), ["breakfast", "dinner", "lunch", "snacks"]);
    assert.equal(moveKey(keys, 0, -1), keys);
    assert.equal(moveKey(keys, 3, 1), keys);
    assert.equal(moveKey(keys, 9, 1), keys);
    assert.deepEqual(keys, ["breakfast", "lunch", "dinner", "snacks"], "the original is not changed");
  });

  test("a target is none, a number of calories, or a share of the day's calorie budget -- one at a time", () => {
    assert.deepEqual(targetBody("none", ""), { ok: true, body: { targetKcal: null, targetPct: null } });
    assert.deepEqual(targetBody("kcal", "500"), { ok: true, body: { targetKcal: 500, targetPct: null } });
    assert.deepEqual(targetBody("pct", "30"), { ok: true, body: { targetKcal: null, targetPct: 30 } });
    for (const [kind, text] of [["kcal", ""], ["kcal", "0"], ["kcal", "10001"], ["kcal", "x"], ["pct", "0"], ["pct", "101"], ["pct", ""]] as const) assert.equal(targetBody(kind, text).ok, false, `${kind} ${text}`);
    assert.equal(targetKindOf({ targetKcal: 500, targetPct: null }), "kcal");
    assert.equal(targetKindOf({ targetKcal: null, targetPct: 25 }), "pct");
    assert.equal(targetKindOf({ targetKcal: null, targetPct: null }), "none");
    assert.equal(targetSummary({ targetKcal: 1250, targetPct: null }), "Target 1,250 kcal");
    assert.equal(targetSummary({ targetKcal: null, targetPct: 33.333 }), "Target 33.33% of your calorie budget");
    assert.equal(targetSummary({ targetKcal: null, targetPct: null }), "No target");
  });

  test("at least one meal stays on; a name is required and not too long", () => {
    const slots = [{ key: "a", enabled: true }, { key: "b", enabled: false }];
    assert.equal(isLastEnabled(slots, "a"), true);
    assert.equal(isLastEnabled(slots, "b"), false, "a meal that is already off isn't the last one on");
    assert.equal(isLastEnabled([{ key: "a", enabled: true }, { key: "b", enabled: true }], "a"), false);
    assert.deepEqual(mealBody("  Pre-workout "), { ok: true, body: { label: "Pre-workout" } });
    assert.equal(mealBody("   ").ok, false);
    assert.equal(mealBody("x".repeat(41)).ok, false);
  });

  test("the snack allowance is a percentage in the server's range", () => {
    assert.deepEqual(snackBody("12.5", 0, 50), { ok: true, body: { snackAllowancePct: 12.5 } });
    assert.deepEqual(snackBody("0", 0, 50), { ok: true, body: { snackAllowancePct: 0 } });
    for (const t of ["", "51", "-1", "abc"]) assert.equal(snackBody(t, 0, 50).ok, false, t);
  });
});
