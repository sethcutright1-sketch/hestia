// The calorie schedule through the data layer: saved with the goal, applied to each weekday's
// calorie budget in the day summaries (the week still averages the plan), past days frozen, the
// preview. Ported from the calorie app's schedule.test.ts.

import { test, after } from "node:test";
import assert from "node:assert/strict";

import { cleanupDb } from "./helpers/testdb.ts";
import { LONG_AGO, NOW, TODAY, YESTERDAY, newWorld } from "./helpers/nutritionWorld.ts";
import { addEntry } from "../nutrition/data/diary.ts";
import { daySummary } from "../nutrition/data/days.ts";
import { addGoal, goalJson, listGoals, previewCalorieBudgets } from "../nutrition/data/goals.ts";
import { get } from "../nutrition/data/sql.ts";
import { todayFor } from "../nutrition/data/tracker.ts";
import { addWeight } from "../nutrition/data/weights.ts";

after(cleanupDb);

// TODAY is Tuesday 2026-03-10. The next full week, Sunday..Saturday, is 03-15..03-21.
const NEXT_WEEK = ["2026-03-15", "2026-03-16", "2026-03-17", "2026-03-18", "2026-03-19", "2026-03-20", "2026-03-21"];
const goal = (extra: Record<string, unknown> = {}) => ({
  planLbPerWeek: 1, activityLevel: "light", macroProtein: 20, macroCarbs: 50, macroFat: 30, ...extra,
});
const cents = (kcal: number) => Math.round(kcal * 100);

async function world(t: Parameters<typeof newWorld>[0]) {
  const w = await newWorld(t);
  const ann = () => w.tracker(w.ids.ann);
  addWeight(w.db, ann(), NOW, { weightKg: 80, measuredOn: "2026-03-01" });
  const budgetOn = (date: string) => daySummary(w.db, ann(), date, todayFor(ann(), NOW)).calorieBudget as number;
  const setGoal = (body: Record<string, unknown>) => goalJson(addGoal(w.db, ann(), TODAY, goal(body)));
  const badGoal = (body: Record<string, unknown>) => {
    try {
      addGoal(w.db, ann(), TODAY, goal(body));
    } catch (err: any) {
      assert.equal(err.status, 400);
      return err.message as string;
    }
    return assert.fail(`expected a 400 for ${JSON.stringify(body)}`);
  };
  return { w, ann, budgetOn, setGoal, badGoal };
}

test("a schedule saved with the goal changes each weekday's budget and the week still sums to 7 x the base", async (t) => {
  const { w, ann, budgetOn, setGoal } = await world(t);
  setGoal({}); // 1 lb/week, no schedule: maintenance 2098.94 less 500
  const base = budgetOn(NEXT_WEEK[0]);
  assert.equal(base, 1598.94);
  const saved = setGoal({ calorieSchedule: { highDays: [6, 0, 6], extraKcal: 300 } });
  assert.deepEqual(saved.calorieSchedule, { highDays: [0, 6], extraKcal: 300 }, "sorted and de-duplicated");
  assert.deepEqual(listGoals(w.db, ann(), TODAY).current!.calorieSchedule, { highDays: [0, 6], extraKcal: 300 });

  const week = NEXT_WEEK.map(budgetOn);
  // Sunday and Saturday get +300; the five other days give up 300 x 2 / 5 = 120.
  assert.deepEqual(week, [1898.94, 1478.94, 1478.94, 1478.94, 1478.94, 1478.94, 1898.94]);
  assert.equal(week.reduce((a, b) => a + cents(b), 0), cents(base) * 7, "the seven-day total is unchanged, to the cent");
  // Today (a Tuesday) is a low day and follows the new goal at once.
  assert.equal(budgetOn(TODAY), 1478.94);
  // The macro targets follow the day's calorie budget too.
  assert.equal(daySummary(w.db, ann(), NEXT_WEEK[0], TODAY).macros.protein.goal, 94.95); // 20% of 1898.94 / 4
});

test("the week sums exactly even when the share doesn't divide into cents", async (t) => {
  const { budgetOn, setGoal } = await world(t);
  setGoal({});
  const base = budgetOn(NEXT_WEEK[0]);
  setGoal({ calorieSchedule: { highDays: [5], extraKcal: 250 } }); // 250 / 6 = 41.666...
  const week = NEXT_WEEK.map(budgetOn);
  assert.equal(week.reduce((a, b) => a + cents(b), 0), cents(base) * 7);
  assert.equal(week[5], base + 250);
});

test("a schedule is kept by later goals that don't mention it, replaced by one that does, and cleared by null", async (t) => {
  const { w, ann, setGoal, budgetOn } = await world(t);
  setGoal({ calorieSchedule: { highDays: [6], extraKcal: 200 } });
  assert.deepEqual(setGoal({ planLbPerWeek: 0.5 }).calorieSchedule, { highDays: [6], extraKcal: 200 }, "an unrelated edit");
  assert.equal(setGoal({ calorieSchedule: { highDays: [0], extraKcal: 100 } }).calorieSchedule!.highDays[0], 0);
  assert.equal(setGoal({ calorieSchedule: null }).calorieSchedule, null);
  assert.equal(setGoal({}).calorieSchedule, null, "stays cleared");
  assert.equal(budgetOn("2026-03-14"), budgetOn("2026-03-15"));
  // No high days is no schedule; so is zero extra... (a schedule with extra 0 is kept but changes nothing).
  assert.equal(setGoal({ calorieSchedule: { highDays: [], extraKcal: 300 } }).calorieSchedule, null);
  assert.deepEqual(setGoal({ calorieSchedule: { highDays: [1], extraKcal: 0 } }).calorieSchedule, { highDays: [1], extraKcal: 0 });
  assert.equal(budgetOn("2026-03-14"), budgetOn("2026-03-16"));
  assert.ok(listGoals(w.db, ann(), TODAY).history.length >= 7);
});

test("the schedule is validated: at most 6 high days, 0-1500 extra calories, real weekdays, and not so much that a day is starved", async (t) => {
  const { w, ann, setGoal, badGoal } = await world(t);
  const bad = (calorieSchedule: unknown) => badGoal({ calorieSchedule });
  assert.match(bad({ highDays: [0, 1, 2, 3, 4, 5, 6], extraKcal: 100 }), /at most 6 high days/);
  assert.match(bad({ highDays: [0], extraKcal: 1501 }), /between 0 and 1500/);
  bad({ highDays: [0], extraKcal: -1 });
  bad({ highDays: [7], extraKcal: 100 });
  bad({ highDays: [-1], extraKcal: 100 });
  bad({ highDays: [1.5], extraKcal: 100 });
  bad({ highDays: ["Sat"], extraKcal: 100 });
  bad({ highDays: [0] });
  bad({ extraKcal: 100 });
  bad("weekends");
  bad([6]);
  // 1,598.94 a day with six high days at +1,500 would leave the one low day at -7,400.
  assert.match(bad({ highDays: [1, 2, 3, 4, 5, 6], extraKcal: 1500 }), /some days at/);
  setGoal({ calorieSchedule: { highDays: [1, 2, 3, 4, 5, 6], extraKcal: 100 } }); // allowed when the low day stays sensible
  assert.equal(listGoals(w.db, ann(), TODAY).current!.calorieSchedule!.highDays.length, 6);
});

test("the schedule applies on top of a calorie budget override, and the minimum-calorie warning is judged per day", async (t) => {
  const { w, ann, setGoal } = await world(t);
  setGoal({ calorieBudgetOverrideKcal: 1500, calorieSchedule: { highDays: [0, 6], extraKcal: 700 } });
  const on = (d: string) => daySummary(w.db, ann(), d, TODAY);
  const sunday = on(NEXT_WEEK[0]), monday = on(NEXT_WEEK[1]);
  assert.deepEqual([sunday.calorieBudget, sunday.belowFloor], [2200, false]);
  // 1500 - 700 x 2 / 5 = 1220: a low day, above the safe minimum for a woman (1,200)...
  assert.deepEqual([monday.calorieBudget, monday.belowFloor], [1220, false]);
  // ...and a bigger treat pushes the low days under it: the warning appears on those days only, nothing is clamped.
  setGoal({ calorieBudgetOverrideKcal: 1500, calorieSchedule: { highDays: [0, 6], extraKcal: 800 } });
  const low = on(NEXT_WEEK[1]);
  assert.deepEqual([low.calorieBudget, low.belowFloor], [1180, true]);
  assert.equal(on(NEXT_WEEK[0]).belowFloor, false);
});

test("past days stay frozen: a schedule never rewrites a day that was already lived", async (t) => {
  const { w, ann, budgetOn, setGoal } = await world(t);
  // LONG_AGO (Thursday 03-05) gets an entry, so its budget is frozen the moment it is logged into: maintenance, no schedule.
  addEntry(w.db, ann(), LONG_AGO, TODAY, { slot: "lunch", kcal: 500 });
  assert.equal(budgetOn(LONG_AGO), 2098.94);
  // A goal with a schedule, effective before both days: Thursdays are the high day (+400, so the other six give up 66.67 each).
  setGoal({ effectiveFrom: "2026-03-01", calorieSchedule: { highDays: [4], extraKcal: 400 } });
  assert.equal(budgetOn(LONG_AGO), 2098.94, "the frozen Thursday doesn't turn into a 1,998.94 high day");
  // Yesterday (Monday 03-09) was never opened, so it takes the goal in effect on its date -- and is frozen by being looked at.
  assert.equal(budgetOn(YESTERDAY), 1532.28);
  setGoal({ effectiveFrom: "2026-03-01", calorieSchedule: { highDays: [1], extraKcal: 400 } }); // now Mondays are high
  assert.equal(budgetOn(YESTERDAY), 1532.28, "yesterday stays what it was");
  assert.equal(get<{ b: number }>(w.db, "SELECT calorie_budget_kcal_snapshot AS b FROM nutrition_day_logs WHERE local_date = ? AND user_id = ?", YESTERDAY, w.ids.ann)!.b, 1532.28);
  assert.equal(budgetOn(LONG_AGO), 2098.94);
  // Today and the future always follow the latest goal: Tuesday is a low day under a Monday schedule, next Monday is high.
  assert.equal(budgetOn(TODAY), 1532.28);
  assert.equal(budgetOn("2026-03-16"), 1998.94);
});

test("the preview shows each weekday's calorie budget for the form's values without saving anything", async (t) => {
  const { w, ann, setGoal } = await world(t);
  const preview = (body: Record<string, unknown>) => previewCalorieBudgets(w.db, ann(), TODAY, body) as any;
  const before = listGoals(w.db, ann(), TODAY).history.length;

  const p = preview({ calorieSchedule: { highDays: [0, 6], extraKcal: 300 }, planLbPerWeek: 1 });
  assert.equal(p.baseKcal, 1598.94);
  assert.deepEqual(p.days.map((d: any) => [d.date, d.weekday, d.kcal, d.high]), [
    ["2026-03-09", 1, 1478.94, false], ["2026-03-10", 2, 1478.94, false], ["2026-03-11", 3, 1478.94, false], ["2026-03-12", 4, 1478.94, false],
    ["2026-03-13", 5, 1478.94, false], ["2026-03-14", 6, 1898.94, true], ["2026-03-15", 0, 1898.94, true],
  ], "Monday first, the week of today");
  // Unsent fields default to the goal in effect; sent ones win -- so it follows an unsaved form.
  assert.equal(preview({}).baseKcal, 2098.94);
  assert.equal(preview({ activityLevel: "moderate", planLbPerWeek: 0 }).baseKcal, 2366.08, "1526.5 x 1.55");
  assert.equal(preview({ calorieBudgetOverrideKcal: 1800 }).days[0].kcal, 1800);
  setGoal({ calorieSchedule: { highDays: [6], extraKcal: 200 } });
  assert.equal(preview({}).days[5].high, true, "the saved schedule is the default");
  assert.equal(preview({ calorieSchedule: null }).days[5].high, false, "null previews having none");
  assert.equal(listGoals(w.db, ann(), TODAY).history.length, before + 1, "previews save nothing");

  for (const bad of [{ planLbPerWeek: 0.7 }, { calorieSchedule: { highDays: [9], extraKcal: 1 } }, { activityLevel: "extreme" }]) {
    assert.throws(() => preview(bad), (e: any) => e.status === 400, JSON.stringify(bad));
  }
  // The minimum warning is shown per day.
  const harsh = preview({ calorieBudgetOverrideKcal: 1300, calorieSchedule: { highDays: [6], extraKcal: 700 } }); // low days 1,183.33
  assert.deepEqual(harsh.days.map((d: any) => d.belowFloor), [true, true, true, true, true, false, true]);
});

test("the preview says so when there is no weight yet, or no profile", async (t) => {
  const w = await newWorld(t);
  const ben = w.tracker(w.ids.ben); // ben has a profile but no weigh-in
  assert.deepEqual(previewCalorieBudgets(w.db, ben, TODAY, {}), { days: null, baseKcal: null, missing: ["weight"] });
  const bare = await newWorld(t, { profiles: false });
  assert.deepEqual(previewCalorieBudgets(bare.db, bare.tracker(bare.ids.ann), TODAY, {}), { days: null, baseKcal: null, missing: ["profile", "weight"] });
});
