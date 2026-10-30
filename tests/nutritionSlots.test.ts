// Meal settings: renaming, switching off, reordering, adding a meal, per-meal calorie targets,
// and how the diary shows a target for a given day. Ported from the calorie app's slots.test.ts.

import { test, after } from "node:test";
import assert from "node:assert/strict";

import { cleanupDb } from "./helpers/testdb.ts";
import { NOW, TODAY, newWorld } from "./helpers/nutritionWorld.ts";
import { addEntry, getDay } from "../nutrition/data/diary.ts";
import { addExercise } from "../nutrition/data/exercise.ts";
import { addGoal } from "../nutrition/data/goals.ts";
import { MAX_SLOTS, allSlotsFor, createSlot, isBuiltInSlot, reorderSlots, slotJson, slotsFor, updateSlot } from "../nutrition/data/slots.ts";
import { all, get } from "../nutrition/data/sql.ts";
import { todayFor } from "../nutrition/data/tracker.ts";
import { addWeight } from "../nutrition/data/weights.ts";

after(cleanupDb);

const status = (fn: () => unknown): number => {
  try {
    fn();
  } catch (err: any) {
    return err.status ?? -1;
  }
  return 0;
};

async function world(t: Parameters<typeof newWorld>[0]) {
  const w = await newWorld(t);
  const who = (name: "ann" | "ben") => w.tracker(w.ids[name]);
  const slots = (name: "ann" | "ben") => allSlotsFor(w.db, w.ids[name]).map((s) => ({ ...slotJson(s), custom: !isBuiltInSlot(s.key) }));
  const put = (name: "ann" | "ben", key: string, body: Record<string, unknown>) => ({ ...slotJson(updateSlot(w.db, who(name), key, body)), custom: !isBuiltInSlot(key) });
  const add = (name: "ann" | "ben", body: Record<string, unknown>) => { const s = createSlot(w.db, who(name), body); return { ...slotJson(s), custom: true }; };
  const day = (name: "ann" | "ben", date = TODAY) => getDay(w.db, who(name), date, todayFor(who(name), NOW));
  return { w, who, slots, put, add, day };
}

test("a new tracker's meals are the four defaults; the list shows switched-off ones, the profile's shows only the switched-on", async (t) => {
  const { w, slots, put } = await world(t);
  assert.deepEqual(slots("ann").map((s) => [s.key, s.label, s.enabled, s.custom, s.targetKcal, s.targetPct]), [
    ["breakfast", "Breakfast", true, false, null, null], ["lunch", "Lunch", true, false, null, null],
    ["dinner", "Dinner", true, false, null, null], ["snacks", "Snacks", true, false, null, null],
  ]);
  put("ann", "snacks", { enabled: false });
  assert.equal(slots("ann").length, 4, "still listed");
  assert.deepEqual(slotsFor(w.db, w.ids.ann).map((s) => s.key), ["breakfast", "lunch", "dinner"], "what the phone caches carries only the switched-on ones");
});

test("adding a meal: the key comes from the name, is unique, and never collides with a built-in or a route", async (t) => {
  const { w, slots, add, day } = await world(t);
  const pre = add("ann", { label: "Pre-Workout!" });
  assert.deepEqual([pre.key, pre.label, pre.sort, pre.enabled, pre.custom], ["pre-workout", "Pre-Workout!", 4, true, true]);
  assert.equal(add("ann", { label: "pre workout" }).key, "pre-workout-2");
  assert.equal(add("ann", { label: "Dinner" }).key, "dinner-2", "a second Dinner is its own meal, not the built-in one");
  assert.equal(add("ann", { label: "Reorder" }).key, "reorder-2", "\"reorder\" is a route");
  assert.equal(add("ann", { label: "Snack time", targetKcal: 150 }).targetKcal, 150);
  // Ben's list is his own.
  assert.equal(slots("ben").length, 4);
  assert.equal(add("ben", { label: "Pre-Workout" }).key, "pre-workout");
  // It is a real meal everywhere: the diary lists it, and food can go in it.
  assert.ok(day("ann").slots.some((s) => s.key === "pre-workout"));

  for (const bad of [{}, { label: "" }, { label: "   " }, { label: "x".repeat(41) }, { label: 5 }, { label: "A", targetKcal: 0 }, { label: "A", targetPct: 101 }, { label: "A", targetKcal: 100, targetPct: 10 }]) {
    assert.equal(status(() => add("ann", bad)), 400, JSON.stringify(bad));
  }
  // At most 20.
  while (slots("ann").length < MAX_SLOTS) add("ann", { label: `Extra ${slots("ann").length}` });
  assert.equal(status(() => add("ann", { label: "One too many" })), 400);
  assert.equal(slots("ann").length, MAX_SLOTS);
  assert.equal(get<{ n: number }>(w.db, "SELECT COUNT(*) AS n FROM nutrition_meal_slots WHERE user_id = ?", w.ids.ben)!.n, 5, "ben's list never moved");
});

test("renaming changes the label, never the key: entries and the diary keep working", async (t) => {
  const { w, who, put, day } = await world(t);
  addEntry(w.db, who("ann"), TODAY, TODAY, { slot: "dinner", kcal: 600, name: "Pasta" });
  const r = put("ann", "dinner", { label: "Supper" });
  assert.deepEqual([r.key, r.label], ["dinner", "Supper"]);
  const dinner = day("ann").slots.find((s) => s.key === "dinner")!;
  assert.deepEqual(dinner.entries.map((e) => e.name), ["Pasta"]);
  assert.equal(dinner.label, "Supper");
  assert.equal(addEntry(w.db, who("ann"), TODAY, TODAY, { slot: "dinner", kcal: 1 }).created, true, "the old key still works");
  assert.equal(status(() => put("ann", "nope", { label: "x" })), 404);
  assert.equal(status(() => put("ann", "dinner", { label: "" })), 400);
  assert.equal(status(() => put("ann", "dinner", { enabled: "yes" })), 400);
  assert.equal(put("ann", "dinner", {}).label, "Supper", "an empty update changes nothing");
});

test("switching a meal off keeps what's in it visible, refuses new food, and one meal always stays on", async (t) => {
  const { w, who, slots, put, day } = await world(t);
  addEntry(w.db, who("ann"), TODAY, TODAY, { slot: "snacks", kcal: 150, name: "Apple" });
  put("ann", "snacks", { enabled: false });
  const snacks = day("ann").slots.find((s) => s.key === "snacks")!;
  assert.deepEqual([snacks.enabled, snacks.entries.length], [false, 1], "old entries still show");
  assert.ok(!day("ann", "2026-03-08").slots.some((s) => s.key === "snacks"), "a day without entries in it doesn't list it");
  assert.equal(status(() => addEntry(w.db, who("ann"), TODAY, TODAY, { slot: "snacks", kcal: 1 })), 400);
  // Ben is unaffected.
  assert.equal(slots("ben").find((s) => s.key === "snacks")!.enabled, true);

  for (const key of ["breakfast", "lunch"]) put("ann", key, { enabled: false });
  assert.throws(() => put("ann", "dinner", { enabled: false }), /at least one meal/);
  assert.equal(put("ann", "snacks", { enabled: true }).enabled, true, "and it comes back");
});

test("reordering: the full list of keys in the new order, switched-off meals included", async (t) => {
  const { w, who, slots, put, add, day } = await world(t);
  put("ann", "lunch", { enabled: false });
  add("ann", { label: "Brunch" });
  const order = ["brunch", "snacks", "lunch", "dinner", "breakfast"];
  reorderSlots(w.db, who("ann"), order);
  assert.deepEqual(slots("ann").map((s) => s.key), order);
  assert.deepEqual(day("ann").slots.map((s) => s.key), ["brunch", "snacks", "dinner", "breakfast"], "the diary follows, minus the switched-off meal");

  for (const bad of [order.slice(1), [...order, "extra"], [...order.slice(1), "brunch", "brunch"], [...order.slice(0, 4), "dinner"], "brunch", [1, 2, 3, 4, 5], undefined]) {
    assert.equal(status(() => reorderSlots(w.db, who("ann"), bad)), 400, JSON.stringify(bad));
  }
  assert.deepEqual(slots("ann").map((s) => s.key), order, "a refused reorder changes nothing");
  // A custom meal named "reorder" can't shadow the route.
  assert.equal(add("ann", { label: "reorder" }).key, "reorder-2");
});

test("targets: a fixed number of kcal OR a percentage of the day's calorie budget, never both", async (t) => {
  const { slots, put, add } = await world(t);
  const lunch = () => slots("ann").find((s) => s.key === "lunch")!;
  const pair = (r: { targetKcal: number | null; targetPct: number | null }) => [r.targetKcal, r.targetPct];
  assert.deepEqual([put("ann", "lunch", { targetKcal: 600 }).targetKcal, lunch().targetPct], [600, null]);
  // Setting the other kind clears the first.
  assert.deepEqual(pair(put("ann", "lunch", { targetPct: 30 })), [null, 30]);
  assert.deepEqual(pair(put("ann", "lunch", { targetKcal: 450.456 })), [450.46, null]);
  // null clears just that kind; both null clears both.
  assert.deepEqual(pair(put("ann", "lunch", { targetPct: null })), [450.46, null]);
  assert.deepEqual(pair(put("ann", "lunch", { targetKcal: null })), [null, null]);
  put("ann", "lunch", { targetPct: 25 });
  assert.deepEqual(pair(put("ann", "lunch", { targetKcal: null, targetPct: null })), [null, null]);
  // A rename leaves the target alone.
  put("ann", "lunch", { targetKcal: 500 });
  assert.equal(put("ann", "lunch", { label: "Midday" }).targetKcal, 500);

  for (const bad of [{ targetKcal: 0 }, { targetKcal: -5 }, { targetKcal: 10_001 }, { targetKcal: "500" }, { targetPct: 0 }, { targetPct: 101 }, { targetKcal: 500, targetPct: 20 }]) {
    assert.equal(status(() => put("ann", "lunch", bad)), 400, JSON.stringify(bad));
  }
  assert.equal(lunch().targetKcal, 500, "refused updates change nothing");
  assert.equal(add("ann", { label: "Late snack", targetPct: 10 }).targetPct, 10);
});

test("the diary shows each meal's target for the day: fixed as is, a percentage taken of that day's calorie budget", async (t) => {
  const { w, who, put, day } = await world(t);
  // No calorie budget without a weight: a percentage target can't be worked out, a fixed one can.
  put("ann", "breakfast", { targetPct: 25 });
  put("ann", "dinner", { targetKcal: 700 });
  let d = day("ann");
  assert.equal(d.summary.calorieBudget, null);
  assert.deepEqual(d.slots.map((s) => [s.key, s.targetKcal, s.targetPct]), [["breakfast", null, 25], ["lunch", null, null], ["dinner", 700, null], ["snacks", null, null]]);

  addWeight(w.db, who("ann"), NOW, { weightKg: 80, measuredOn: "2026-03-01" });
  d = day("ann");
  assert.equal(d.summary.calorieBudget, 2098.94);
  assert.equal(d.slots[0].targetKcal, 524.74, "25% of 2098.94, not counting exercise");
  assert.equal(d.slots[2].targetKcal, 700);
  // It follows the day's calorie budget: another day, another goal.
  addGoal(w.db, who("ann"), TODAY, { effectiveFrom: "2026-03-11", planLbPerWeek: 1, activityLevel: "light", macroProtein: 20, macroCarbs: 50, macroFat: 30 });
  assert.equal(day("ann", "2026-03-11").slots[0].targetKcal, 399.74, "25% of 1598.94");
  // The targets are Ann's alone.
  assert.deepEqual(day("ben").slots.map((s) => [s.targetKcal, s.targetPct]), Array(4).fill([null, null]));
  // Exercise is not added to the base for percentages.
  addExercise(w.db, who("ann"), NOW, { name: "Run", kcal: 400 });
  assert.equal(day("ann").slots[0].targetKcal, 524.74);
  // Entries in a meal with a target still come back as before.
  addEntry(w.db, who("ann"), TODAY, TODAY, { slot: "dinner", kcal: 800, name: "Big dinner" });
  const dinner = day("ann").slots[2];
  assert.deepEqual([dinner.kcal, dinner.targetKcal, dinner.entries.length], [800, 700, 1]);
  assert.equal(get<{ n: number }>(w.db, "SELECT COUNT(*) AS n FROM nutrition_meal_slots WHERE target_pct IS NOT NULL AND target_kcal IS NOT NULL")!.n, 0);
  assert.equal(all(w.db, "SELECT 1 FROM nutrition_meal_slots WHERE user_id = ?", w.ids.ben).length, 4);
});
