// The kiosk (shared fridge screen) login's assistant: plan level only.
//
//   hidden               no food tools at all (the household meal plan and recipe tools stay, as for everyone)
//   plan only            get_planned_meal_portions: the approved meals and each person's planned PORTION calories
//   plan + quick logging also log_planned_meal: mark a person's planned MEAL-PLAN entry eaten
//
// and never a diary, total, calorie budget, weight, step count, goal or streak. The logging rules are the ones
// POST /api/nutrition/kiosk/log has (nutrition/data/kioskBoard.ts logPlanEntries, shared): entries from the
// household plan only (source = 'plan'), days up to the person's own today, all or nothing.
//
// Clock 2026-03-10 15:00Z: New York's today is 2026-03-10, Auckland's 2026-03-11.

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { loadDb, cleanupDb } from "./helpers/testdb.ts";

const { createUser, db, setConfig } = await loadDb();
const { buildTools } = await import("../assistant/registry.ts");
const { KIOSK_ACCESS_KEY } = await import("../routes/nutrition.ts");
const { getTracker, saveProfile } = await import("../nutrition/data/tracker.ts");
const { addWeight } = await import("../nutrition/data/weights.ts");
const { addEntry } = await import("../nutrition/data/diary.ts");
const { createFood } = await import("../nutrition/data/foods.ts");
const { liveEntries } = await import("../nutrition/data/days.ts");
const { run, get } = await import("../nutrition/data/sql.ts");

const NOW = new Date("2026-03-10T15:00:00Z");
const TODAY = "2026-03-10";
const TOMORROW = "2026-03-11";

let ann: string;
let ben: string;
let kiosk: string;
let sandwich: string;
let soup: string;

const tr = (id: string) => getTracker(db, id);
after(cleanupDb);

function callKiosk(name: string, args: Record<string, any> = {}): Promise<any> {
  const tool = buildTools(kiosk, true, { now: () => NOW }).find((t) => t.name === name);
  assert.ok(tool, `the kiosk has no tool ${name}`);
  return tool.run(args);
}
const kioskTools = () => buildTools(kiosk, true, { now: () => NOW }).filter((t) => t.sensitivity === "health").map((t) => t.name).sort();
const access = (value: string) => setConfig(KIOSK_ACCESS_KEY, value);

/** A planned entry for `who`; `fromPlan` makes it a household-plan entry (source 'plan'), else it is the person's own private plan. */
function planned(who: string, date: string, foodId: string, opts: { fromPlan: boolean; slot?: string; status?: "planned" | "logged" } = { fromPlan: true }): string {
  const id = addEntry(db, tr(who), date, TODAY, { slot: opts.slot ?? "dinner", foodId, status: opts.status ?? "planned" }).row.id;
  if (opts.fromPlan) run(db, "UPDATE nutrition_diary_entries SET source = 'plan', meal_plan_id = ? WHERE id = ?", `meal-${id}`, id);
  return id;
}
const statusOf = (id: string) => get<{ status: string }>(db, "SELECT status FROM nutrition_diary_entries WHERE id = ?", id)!.status;

before(() => {
  ann = createUser("ann-kt", "not-a-real-hash", "Ann", "admin");
  ben = createUser("ben-kt", "not-a-real-hash", "Ben", "parent");
  kiosk = createUser("kiosk-kt", "not-a-real-hash", "Kiosk", "kiosk");
  saveProfile(db, tr(ann), { sex: "female", birthDate: "1990-06-15", heightCm: 170, timezone: "America/New_York" });
  saveProfile(db, tr(ben), { sex: "male", birthDate: "1988-01-01", heightCm: 180, timezone: "Pacific/Auckland" });
  addWeight(db, tr(ann), NOW, { weightKg: 65 });
  addWeight(db, tr(ben), NOW, { weightKg: 91.5 });
  sandwich = createFood(db, tr(ann), { name: "Sandwich", basis: "per_serving", nutrients: { kcal: 400, protein: 20, carbs: 40, fat: 15 }, servings: [{ label: "1 sandwich", grams: 200 }], scope: "joint" }).id;
  soup = createFood(db, tr(ann), { name: "Soup", basis: "per_serving", nutrients: { kcal: 250, protein: 8, carbs: 30, fat: 9 }, servings: [{ label: "1 bowl", grams: 300 }], scope: "joint" }).id;
});
// Each test starts from an empty set of diaries and the default (hidden) kiosk setting, so they can't see each other's entries.
beforeEach(() => {
  access("hidden");
  run(db, "DELETE FROM nutrition_diary_entries");
});

describe("which tools the kiosk gets", () => {
  test("hidden (the default): none of the food tools, but the meal plan and recipe tools (with recipe calories) stay", () => {
    assert.deepEqual(kioskTools(), []);
    const all = buildTools(kiosk, true, { now: () => NOW }).map((t) => t.name);
    for (const name of ["list_recipes", "save_recipe", "get_meal_plan", "create_meal_plan", "set_meal_status", "search_food_calories"]) assert.ok(all.includes(name), name);
  });

  test("plan only: portions can be read, nothing can be logged", () => {
    access("plan_only");
    assert.deepEqual(kioskTools(), ["get_planned_meal_portions"]);
  });

  test("plan + quick logging: it can also mark a planned meal-plan meal eaten", () => {
    access("plan_and_quick_log");
    assert.deepEqual(kioskTools(), ["get_planned_meal_portions", "log_planned_meal"]);
  });

  test("an unrecognised stored setting is the safe default, hidden", () => {
    access("everything-please");
    assert.deepEqual(kioskTools(), []);
  });

  test("never a diary, total, calorie budget, weight, step, goal or streak tool, at any setting", () => {
    for (const level of ["hidden", "plan_only", "plan_and_quick_log"]) {
      access(level);
      const names = buildTools(kiosk, true, { now: () => NOW }).map((t) => t.name);
      for (const banned of ["get_calorie_day_summary", "get_calorie_week_summary", "get_weight_progress", "add_planned_calorie_diary_entries", "plan_meals_within_calorie_budgets"]) {
        assert.equal(names.includes(banned), false, `${banned} at ${level}`);
      }
    }
  });

  test("the tools are tagged health, so a cloud provider never receives them without the switch", () => {
    access("plan_and_quick_log");
    for (const t of buildTools(kiosk, true, { now: () => NOW }).filter((x) => ["get_planned_meal_portions", "log_planned_meal"].includes(x.name))) {
      assert.equal(t.sensitivity, "health", t.name);
    }
    assert.equal(buildTools(kiosk, true).find((t) => t.name === "log_planned_meal")!.mutates, true);
    assert.equal(buildTools(kiosk, true).find((t) => t.name === "get_planned_meal_portions")!.mutates, false);
  });

  test("a diary login never gets the kiosk's logging tool, whatever the kiosk setting", () => {
    access("plan_and_quick_log");
    const names = buildTools(ann, true, { now: () => NOW }).map((t) => t.name);
    assert.equal(names.includes("log_planned_meal"), false);
    assert.equal(names.includes("get_planned_meal_portions"), false);
  });
});

describe("get_planned_meal_portions: each person's portion calories, nothing else", () => {
  test("lists each person's planned MEAL-PLAN entries with their portion calories, on each person's own today", async () => {
    access("plan_only");
    const a = planned(ann, TODAY, sandwich, { fromPlan: true });
    const b = planned(ben, TOMORROW, soup, { fromPlan: true, slot: "lunch" }); // Ben's today in Auckland
    const r = await callKiosk("get_planned_meal_portions");
    assert.deepEqual(r.people.map((p: any) => p.person), ["Ann", "Ben"]);
    assert.deepEqual(r.people[0].plannedPortions, [{ entryId: a, dish: "Sandwich", meal: "Dinner", portionCalories: 400 }]);
    assert.deepEqual(r.people[1].plannedPortions, [{ entryId: b, dish: "Soup", meal: "Lunch", portionCalories: 250 }]);
    assert.equal(r.canMarkEaten, false);
  });

  test("it shows no totals, calorie budgets, weights, logged food or privately planned food", async () => {
    access("plan_only");
    planned(ann, TODAY, sandwich, { fromPlan: false, slot: "snacks" }); // Ann's own private plan
    planned(ann, TODAY, soup, { fromPlan: false, slot: "lunch", status: "logged" }); // logged
    const text = JSON.stringify(await callKiosk("get_planned_meal_portions"));
    for (const secret of ["calorieBudget", "eaten", "remaining", "weight", "91.5", "65", "streak", "snacks", "Logged", "steps"]) {
      assert.equal(text.includes(secret), false, `kiosk answer mentions ${secret}`);
    }
    const r = JSON.parse(text);
    assert.equal(r.people[0].plannedPortions.every((e: any) => e.dish === "Sandwich" && e.meal === "Dinner"), true, "only the plan's dinner portion");
  });

  test("a named date works for the plan; a bad one is an error", async () => {
    access("plan_only");
    assert.equal((await callKiosk("get_planned_meal_portions", { date: "2026-03-12" })).date, "2026-03-12");
    assert.match((await callKiosk("get_planned_meal_portions", { date: "next week" })).error, /YYYY-MM-DD/);
  });

  test("when the admin sets it back to hidden mid-conversation, the next call is refused", async () => {
    access("plan_only");
    const tool = buildTools(kiosk, true, { now: () => NOW }).find((t) => t.name === "get_planned_meal_portions")!;
    access("hidden");
    assert.match(((await tool.run({})) as any).error, /isn't shown on the kiosk/);
  });
});

describe("log_planned_meal: the kiosk route's rules, as a tool", () => {
  beforeEach(() => access("plan_and_quick_log"));

  test("marks a person's planned meal-plan entry eaten, by entry id", async () => {
    const id = planned(ann, TODAY, sandwich);
    const r = await callKiosk("log_planned_meal", { person: "Ann", entryIds: [id] });
    assert.deepEqual(r, { person: "Ann", markedEaten: 1, entryIds: [id] });
    assert.equal(statusOf(id), "logged");
  });

  test("by dish name when exactly one entry matches", async () => {
    const id = planned(ben, TOMORROW, soup, { fromPlan: true, slot: "lunch" });
    const r = await callKiosk("log_planned_meal", { person: "ben", dish: "soup" });
    assert.equal(r.markedEaten, 1);
    assert.equal(statusOf(id), "logged");
  });

  test("a dish that could mean two entries is refused, nothing marked", async () => {
    const one = planned(ann, TODAY, sandwich, { fromPlan: true, slot: "lunch" });
    const two = planned(ann, TODAY, sandwich, { fromPlan: true, slot: "dinner" });
    const r = await callKiosk("log_planned_meal", { person: "Ann", dish: "sandwich" });
    assert.match(r.error, /more than one/);
    assert.equal(r.candidates.length, 2);
    assert.deepEqual([statusOf(one), statusOf(two)], ["planned", "planned"]);
  });

  test("only meal-plan entries: a privately planned one is refused (409's rule), and nothing else in the call is logged", async () => {
    const fromPlan = planned(ann, TODAY, sandwich, { fromPlan: true });
    const privateOne = planned(ann, TODAY, soup, { fromPlan: false, slot: "snacks" });
    const r = await callKiosk("log_planned_meal", { person: "Ann", entryIds: [fromPlan, privateOne] });
    assert.match(r.error, /not planned meal-plan entries/);
    assert.deepEqual([statusOf(fromPlan), statusOf(privateOne)], ["planned", "planned"], "all or nothing");
  });

  test("an entry that belongs to another person, an already logged one, or a made-up id refuses the whole request", async () => {
    const annsOwn = planned(ann, TODAY, sandwich);
    const bens = planned(ben, TOMORROW, soup, { fromPlan: true, slot: "lunch" });
    const done = planned(ann, TODAY, soup, { fromPlan: true, slot: "snacks" });
    await callKiosk("log_planned_meal", { person: "Ann", entryIds: [done] });
    for (const bad of [bens, done, "not-an-entry"]) {
      const r = await callKiosk("log_planned_meal", { person: "Ann", entryIds: [annsOwn, bad] });
      assert.match(r.error, /can't be logged from here/, bad);
      assert.equal(statusOf(annsOwn), "planned", `${bad} must not let the good one through`);
    }
  });

  test("never a future day: a meal planned for tomorrow can't be marked eaten today (all or nothing)", async () => {
    const today = planned(ann, TODAY, sandwich, { fromPlan: true, slot: "lunch" });
    const tomorrow = planned(ann, TOMORROW, sandwich, { fromPlan: true, slot: "dinner" });
    const r = await callKiosk("log_planned_meal", { person: "Ann", entryIds: [today, tomorrow] });
    assert.match(r.error, /hasn't happened yet/);
    assert.deepEqual([statusOf(today), statusOf(tomorrow)], ["planned", "planned"]);
  });

  test("an earlier day is fine (the fridge screen is where the household catches up)", async () => {
    const yesterday = planned(ann, "2026-03-09", sandwich, { fromPlan: true, slot: "dinner" });
    const r = await callKiosk("log_planned_meal", { person: "Ann", entryIds: [yesterday], date: "2026-03-09" });
    assert.equal(r.markedEaten, 1);
  });

  test("it logs through the phone's own path: the entry keeps its food and amount, and the day's totals follow", async () => {
    const id = planned(ann, TODAY, soup, { fromPlan: true, slot: "lunch" });
    const before = liveEntries(db, ann, TODAY).find((e) => e.id === id)!;
    await callKiosk("log_planned_meal", { person: "Ann", entryIds: [id] });
    const after = liveEntries(db, ann, TODAY).find((e) => e.id === id)!;
    assert.equal(after.status, "logged");
    assert.deepEqual([after.food_id, after.quantity, after.nutrients_total, after.local_date], [before.food_id, before.quantity, before.nutrients_total, before.local_date]);
  });

  test("it can't add, edit or delete anything: the entry count is unchanged", async () => {
    const id = planned(ben, TOMORROW, soup, { fromPlan: true, slot: "snacks" });
    const count = () => get<{ n: number }>(db, "SELECT COUNT(*) AS n FROM nutrition_diary_entries")!.n;
    const n = count();
    await callKiosk("log_planned_meal", { person: "Ben", entryIds: [id] });
    assert.equal(count(), n);
  });

  test("an unknown person lists who keeps a diary; naming neither ids nor a dish asks which", async () => {
    const r = await callKiosk("log_planned_meal", { person: "Sam", dish: "soup" });
    assert.deepEqual(r.validValues, ["Ann", "Ben"]);
    assert.match((await callKiosk("log_planned_meal", { person: "Ann" })).error, /Say which planned meal/);
    assert.match((await callKiosk("log_planned_meal", { person: "Ann", dish: "caviar" })).error, /no planned meal-plan entry/);
  });

  test("with plan-only access the logging tool is not offered, and a stale reference to it is refused", async () => {
    access("plan_and_quick_log");
    const tool = buildTools(kiosk, true, { now: () => NOW }).find((t) => t.name === "log_planned_meal")!;
    access("plan_only");
    const id = planned(ann, TODAY, sandwich, { fromPlan: true, slot: "snacks" });
    assert.match(((await tool.run({ person: "Ann", entryIds: [id] })) as any).error, /isn't turned on/);
    assert.equal(statusOf(id), "planned");
    assert.deepEqual(kioskTools(), ["get_planned_meal_portions"]);
  });
});
