import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mifflinStJeor, ageOn, dailyCalorieBudget, dailyDeficit, macroGrams, parseCalorieSchedule, scheduledCalorieBudget, scheduledWeek, type CalorieBudgetProfile,
} from "../nutrition/calorieBudget.ts";

const woman: CalorieBudgetProfile = {
  sex: "female", birthDate: "1990-06-15", heightCm: 170, activityLevel: "light", palOverride: null,
  planLbPerWeek: 1, minCalorieBudgetMode: "safe", calorieBudgetOverrideKcal: null,
};

test("Mifflin-St Jeor: worked example (female, 35 y, 170 cm, 80 kg)", () => {
  // 10*80 + 6.25*170 - 5*35 - 161 = 800 + 1062.5 - 175 - 161 = 1526.5
  assert.equal(mifflinStJeor({ sex: "female", weightKg: 80, heightCm: 170, ageYears: 35 }), 1526.5);
  // Same body as a man differs by exactly 166 (+5 vs -161).
  assert.equal(mifflinStJeor({ sex: "male", weightKg: 80, heightCm: 170, ageYears: 35 }), 1692.5);
});

test("age is computed at the given local date", () => {
  assert.equal(ageOn("1990-06-15", "2025-06-14"), 34);
  assert.equal(ageOn("1990-06-15", "2025-06-15"), 35);
  assert.equal(ageOn("1990-06-15", "2026-01-01"), 35);
});

test("deficit: 250 kcal per half pound per week", () => {
  assert.equal(dailyDeficit(0), 0);
  assert.equal(dailyDeficit(0.5), 250);
  assert.equal(dailyDeficit(1), 500);
  assert.equal(dailyDeficit(2), 1000);
  assert.equal(dailyDeficit(-0.5), -250); // gain plan adds calories
  assert.throws(() => dailyDeficit(0.7), RangeError);
});

test("dailyCalorieBudget: light activity, 1 lb/week = maintenance - 500", () => {
  const b = dailyCalorieBudget(woman, 80, "2025-06-15");
  assert.equal(b.bmr, 1526.5);
  assert.equal(b.maintenance, 2098.94); // 1526.5 * 1.375 = 2098.9375
  assert.equal(b.calorieBudget, 1598.94);
  assert.equal(b.belowFloor, false);
});

test("PAL override replaces the activity multiplier", () => {
  const b = dailyCalorieBudget({ ...woman, palOverride: 1.5, planLbPerWeek: 0 }, 80, "2025-06-15");
  assert.equal(b.maintenance, 2289.75);
  assert.equal(b.calorieBudget, 2289.75);
});

test("floor warns but never clamps; none never warns; low uses lower floors", () => {
  const aggressive = { ...woman, planLbPerWeek: 2, activityLevel: "sedentary" as const };
  const safe = dailyCalorieBudget(aggressive, 60, "2025-06-15");
  assert.ok(safe.calorieBudget < 1200);
  assert.equal(safe.belowFloor, true);
  assert.equal(dailyCalorieBudget({ ...aggressive, minCalorieBudgetMode: "none" }, 60, "2025-06-15").belowFloor, false);
  // Men's safe floor is higher than women's.
  const man = dailyCalorieBudget({ ...woman, sex: "male", calorieBudgetOverrideKcal: 1400 }, 80, "2025-06-15");
  assert.equal(man.calorieBudget, 1400);
  assert.equal(man.belowFloor, true);
  assert.equal(dailyCalorieBudget({ ...woman, sex: "male", calorieBudgetOverrideKcal: 1400, minCalorieBudgetMode: "low" }, 80, "2025-06-15").belowFloor, false);
});

test("budget override wins", () => {
  assert.equal(dailyCalorieBudget({ ...woman, calorieBudgetOverrideKcal: 1800 }, 80, "2025-06-15").calorieBudget, 1800);
});

test("macroGrams: percent and grams modes", () => {
  assert.deepEqual(macroGrams(2000, { mode: "percent", protein: 20, carbs: 50, fat: 30 }), { protein: 100, carbs: 250, fat: 66.67 });
  assert.deepEqual(macroGrams(2000, { mode: "grams", protein: 150, carbs: 200, fat: 70 }), { protein: 150, carbs: 200, fat: 70 });
});

// ---- calorie schedule ----------------------------------------------------------------------

// 2026-03-08 is a Sunday, so these seven dates are Sunday..Saturday.
const WEEK = ["2026-03-08", "2026-03-09", "2026-03-10", "2026-03-11", "2026-03-12", "2026-03-13", "2026-03-14"];
const cents = (kcal: number) => Math.round(kcal * 100);
const weekSum = (profile: CalorieBudgetProfile, weightKg = 80) => WEEK.reduce((a, d) => a + cents(dailyCalorieBudget(profile, weightKg, d).calorieBudget), 0);

test("calorie schedule: high days get base + extra, low days share the cost, and the week still sums to 7 x base", () => {
  const plain = dailyCalorieBudget({ ...woman, planLbPerWeek: 0 }, 80, WEEK[0]); // base = maintenance 2098.94
  const sched = { highDays: [0, 6], extraKcal: 300 }; // Sat + Sun
  const p = { ...woman, planLbPerWeek: 0, calorieSchedule: sched };
  const budgets = WEEK.map((d) => dailyCalorieBudget(p, 80, d).calorieBudget);
  assert.equal(budgets[0], 2398.94);
  assert.equal(budgets[6], 2398.94);
  // 2 high days, 5 low: each low day gives up 300 x 2 / 5 = 120.
  assert.deepEqual(budgets.slice(1, 6), [1978.94, 1978.94, 1978.94, 1978.94, 1978.94]);
  assert.equal(weekSum(p), cents(plain.calorieBudget) * 7);
});

test("calorie schedule: the weekly total is exactly 7 x base even when the shares don't divide into cents", () => {
  // 250 x 1 / 6 = 41.666...: the cent that can't be split evenly goes to the earliest low days.
  const p = { ...woman, planLbPerWeek: 1, calorieSchedule: { highDays: [3], extraKcal: 250 } };
  const base = dailyCalorieBudget({ ...woman, planLbPerWeek: 1 }, 80, WEEK[0]).calorieBudget; // 1598.94
  assert.equal(weekSum(p), cents(base) * 7);
  const lows = WEEK.filter((_, i) => i !== 3).map((d) => dailyCalorieBudget(p, 80, d).calorieBudget);
  assert.ok(Math.max(...lows) - Math.min(...lows) <= 0.01 + 1e-9, "low days differ by at most a cent");
  assert.equal(dailyCalorieBudget(p, 80, WEEK[3]).calorieBudget, base + 250);
  // The invariant holds for a spread of shapes and bases.
  for (const highDays of [[0], [1, 2], [0, 3, 5], [0, 1, 2, 3], [1, 2, 3, 4, 5], [0, 1, 2, 3, 4, 5]]) {
    for (const extraKcal of [1, 99.99, 250, 333, 1500]) {
      for (const kg of [55.5, 80, 103.7]) {
        const q = { ...woman, planLbPerWeek: 0.5, calorieSchedule: { highDays, extraKcal } };
        const b = dailyCalorieBudget({ ...woman, planLbPerWeek: 0.5 }, kg, WEEK[0]).calorieBudget;
        assert.equal(weekSum(q, kg), cents(b) * 7, `${highDays} +${extraKcal} at ${kg} kg`);
      }
    }
  }
});

test("calorie schedule: no high days, all seven, no extra or no schedule leave every day at the base", () => {
  const base = dailyCalorieBudget(woman, 80, WEEK[0]).calorieBudget;
  for (const calorieSchedule of [null, undefined, { highDays: [], extraKcal: 400 }, { highDays: [0, 1, 2, 3, 4, 5, 6], extraKcal: 400 }, { highDays: [0, 6], extraKcal: 0 }]) {
    for (const d of WEEK) assert.equal(dailyCalorieBudget({ ...woman, calorieSchedule }, 80, d).calorieBudget, base);
  }
});

test("calorie schedule: applies on top of a budget override, and the floor is judged per day", () => {
  const p = { ...woman, calorieBudgetOverrideKcal: 1500, calorieSchedule: { highDays: [6], extraKcal: 600 } }; // woman: safe floor 1200
  assert.equal(dailyCalorieBudget(p, 80, WEEK[6]).calorieBudget, 2100); // Saturday: +600
  const monday = dailyCalorieBudget(p, 80, WEEK[1]);
  assert.equal(monday.calorieBudget, 1400); // the other six days give up 600 / 6 = 100 each
  assert.equal(monday.belowFloor, false);
  assert.equal(dailyCalorieBudget(p, 80, WEEK[6]).belowFloor, false);
  // A bigger treat day pushes the low days under the safe minimum -- the warning is per day, the budget is not clamped.
  const hard = { ...woman, calorieBudgetOverrideKcal: 1400, calorieSchedule: { highDays: [0, 6], extraKcal: 700 } };
  assert.equal(dailyCalorieBudget(hard, 80, WEEK[0]).belowFloor, false); // 2100
  const low = dailyCalorieBudget(hard, 80, WEEK[2]);
  assert.equal(low.calorieBudget, 1120); // 1400 - 700 x 2 / 5
  assert.equal(low.belowFloor, true);
});

test("parseCalorieSchedule: validates, sorts and de-duplicates", () => {
  assert.equal(parseCalorieSchedule(null), null);
  assert.equal(parseCalorieSchedule(undefined), null);
  assert.deepEqual(parseCalorieSchedule({ highDays: [6, 0, 6], extraKcal: 300 }), { highDays: [0, 6], extraKcal: 300 });
  assert.deepEqual(parseCalorieSchedule({ highDays: [], extraKcal: 0 }), { highDays: [], extraKcal: 0 });
  assert.deepEqual(parseCalorieSchedule({ highDays: [1, 2, 3, 4, 5, 6], extraKcal: 1500 }), { highDays: [1, 2, 3, 4, 5, 6], extraKcal: 1500 });
  assert.throws(() => parseCalorieSchedule({ highDays: [0, 1, 2, 3, 4, 5, 6], extraKcal: 100 }), /at most 6/);
  assert.throws(() => parseCalorieSchedule({ highDays: [7], extraKcal: 100 }), RangeError);
  assert.throws(() => parseCalorieSchedule({ highDays: [1.5], extraKcal: 100 }), RangeError);
  assert.throws(() => parseCalorieSchedule({ highDays: "1", extraKcal: 100 }), RangeError);
  assert.throws(() => parseCalorieSchedule({ highDays: [1], extraKcal: -1 }), RangeError);
  assert.throws(() => parseCalorieSchedule({ highDays: [1], extraKcal: 1501 }), RangeError);
  assert.throws(() => parseCalorieSchedule({ highDays: [1] }), RangeError);
  assert.throws(() => parseCalorieSchedule([1, 2]), RangeError);
});

test("scheduledWeek is indexed by weekday and scheduledCalorieBudget picks a date's weekday", () => {
  const s = { highDays: [5], extraKcal: 600 };
  assert.deepEqual(scheduledWeek(2000, s), [1900, 1900, 1900, 1900, 1900, 2600, 1900]);
  assert.equal(scheduledCalorieBudget(2000, s, "2026-03-13"), 2600); // a Friday
  assert.equal(scheduledCalorieBudget(2000, s, "2026-03-14"), 1900);
  assert.deepEqual(scheduledWeek(2000, null), [2000, 2000, 2000, 2000, 2000, 2000, 2000]);
});
