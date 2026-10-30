// The assistant's calorie-diary tools (assistant/tools/calories.ts, `sensitivity: "health"`), called the way a
// provider calls them -- `tool.run(args)` against the real data layer on the throwaway database, no model.
//
// What these hold in place:
//   - each tool's output for the owner (their calorie budget, eaten, left, weight, planning targets);
//   - another person's data at each visibility level, from BOTH sides, the owner's food-diary PIN, and a watch;
//   - chat logging adds PLANNED entries only, to the speaker's own diary, all-or-nothing;
//   - the weekly planner gets every login's calorie budget NUMBER (even at "nothing") and never a diary or weight;
//   - the naming rule: nothing here is ever called just "budget".
//
// Clock: 2026-03-10 15:00Z, so New York's today is 2026-03-10 (a Tuesday).

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { loadDb, cleanupDb } from "./helpers/testdb.ts";

const { createUser, db, setConfig, putScopedItem, newId } = await loadDb();
const { buildTools } = await import("../assistant/registry.ts");
const { getTracker, saveProfile } = await import("../nutrition/data/tracker.ts");
const { addWeight } = await import("../nutrition/data/weights.ts");
const { addGoal } = await import("../nutrition/data/goals.ts");
const { addEntry, addEntries } = await import("../nutrition/data/diary.ts");
const { createFood } = await import("../nutrition/data/foods.ts");
const { setVisibility } = await import("../nutrition/data/visibility.ts");
const { setSnackAllowancePct } = await import("../nutrition/data/snackAllowance.ts");
const { putSteps } = await import("../nutrition/data/steps.ts");
const { addExercise } = await import("../nutrition/data/exercise.ts");
const { daySummary, liveEntries } = await import("../nutrition/data/days.ts");
const { weekCalories } = await import("../nutrition/data/planCalories.ts");
const { run, all, get } = await import("../nutrition/data/sql.ts");

const NOW = new Date("2026-03-10T15:00:00Z");
const TODAY = "2026-03-10";
const MONDAY = "2026-03-09";

let ann: string; // admin, New York
let ben: string; // parent, New York
let kiosk: string;

after(cleanupDb);

const tr = (id: string) => getTracker(db, id);

/** Calls a tool by name as `userId`'s assistant would. */
function callAs(userId: string, name: string, args: Record<string, any> = {}, ctx: Record<string, any> = {}, unlocked = true): Promise<any> {
  const tool = buildTools(userId, unlocked, { now: () => NOW, ...ctx }).find((t) => t.name === name);
  assert.ok(tool, `no such tool for this login: ${name}`);
  return tool.run(args);
}
const namesFor = (userId: string, ctx: Record<string, any> = {}) => buildTools(userId, true, { now: () => NOW, ...ctx }).map((t) => t.name);

const eat = (user: string, date: string, foodId: string, status: "logged" | "planned", slot = "lunch", quantity = 1) =>
  addEntry(db, tr(user), date, TODAY, { slot, foodId, status, quantity }).row;

let toast: string; // joint, per serving, 80 kcal
let lasagna: string; // joint, per serving, 600 kcal
let benSecret: string; // Ben's personal food
let egg: string; // USDA catalogue, per 100 g, 143 kcal, servings "100 g" (default) and "1 large" (50 g)

function generic(name: string, kcal: number, servings: Array<[string, number, boolean]>): string {
  const id = crypto.randomUUID();
  run(db, `INSERT INTO nutrition_foods (id, name, basis, nutrients, source, source_ref, created_at) VALUES (?, ?, 'per100g', ?, 'usda_generic', ?, ?)`,
    id, name, JSON.stringify({ kcal, protein: 12.6, carbs: 0.7, fat: 9.5, satFat: 3, sugars: 0.4, fiber: 0, cholesterolMg: 372, sodiumMg: 142 }), id, new Date().toISOString());
  for (const [label, grams, isDefault] of servings) {
    run(db, "INSERT INTO nutrition_food_servings (id, food_id, label, grams, is_default) VALUES (?, ?, ?, ?, ?)", crypto.randomUUID(), id, label, grams, isDefault ? 1 : 0);
  }
  return id;
}

before(() => {
  ann = createUser("ann-cal", "not-a-real-hash", "Ann", "admin");
  ben = createUser("ben-cal", "not-a-real-hash", "Ben", "parent");
  kiosk = createUser("kiosk-cal", "not-a-real-hash", "Kiosk", "kiosk");
  saveProfile(db, tr(ann), { sex: "female", birthDate: "1990-06-15", heightCm: 170, timezone: "America/New_York" });
  saveProfile(db, tr(ben), { sex: "male", birthDate: "1988-01-01", heightCm: 180, timezone: "America/New_York" });
  addWeight(db, tr(ann), NOW, { weightKg: 65 });
  addWeight(db, tr(ben), NOW, { weightKg: 90 });
  // Fixed calorie budgets (a manual override) so the numbers below are exact: Ann 2000, Ben 1500.
  addGoal(db, tr(ann), TODAY, { planLbPerWeek: 0, activityLevel: "light", macroProtein: 20, macroCarbs: 50, macroFat: 30, calorieBudgetOverrideKcal: 2000, goalWeightKg: 60, effectiveFrom: "2026-01-01" });
  addGoal(db, tr(ben), TODAY, { planLbPerWeek: 0, activityLevel: "light", macroProtein: 20, macroCarbs: 50, macroFat: 30, calorieBudgetOverrideKcal: 1500, effectiveFrom: "2026-01-01" });
  setSnackAllowancePct(db, tr(ben), { snackAllowancePct: 20 });

  toast = createFood(db, tr(ann), { name: "Toast", basis: "per_serving", nutrients: { kcal: 80, protein: 3, carbs: 14, fat: 1 }, servings: [{ label: "1 slice", grams: 30 }], scope: "joint" }).id;
  lasagna = createFood(db, tr(ann), { name: "Lasagna", basis: "per_serving", nutrients: { kcal: 600, protein: 30, carbs: 60, fat: 25 }, servings: [{ label: "1 serving", grams: 300 }], scope: "joint" }).id;
  benSecret = createFood(db, tr(ben), { name: "Ben's secret fudge", basis: "per_serving", nutrients: { kcal: 300, protein: 2, carbs: 40, fat: 15 }, servings: [{ label: "1 piece", grams: 40 }], scope: "personal" }).id;
  egg = generic("Egg, whole, raw, fresh", 143, [["100 g", 100, true], ["1 large", 50, false]]);
});

describe("who gets which tools", () => {
  test("a diary login gets the calorie tools, tagged health, and no tool that logs", () => {
    const tools = buildTools(ann, true, { now: () => NOW });
    const health = tools.filter((t) => t.sensitivity === "health").map((t) => t.name).sort();
    assert.deepEqual(health, [
      "add_planned_calorie_diary_entries",
      "get_calorie_day_summary",
      "get_calorie_week_summary",
      "get_weight_progress",
      "plan_meals_within_calorie_budgets",
    ]);
    for (const t of tools) assert.notEqual(t.name, "log_planned_meal", "the assistant never logs for a normal login");
    assert.equal(tools.find((t) => t.name === "search_food_calories")?.sensitivity, "household", "the food catalogue is not health data");
  });

  test("only the one writing tool mutates, and it is described as planned-only", () => {
    const health = buildTools(ann, true, { now: () => NOW }).filter((t) => t.sensitivity === "health");
    assert.deepEqual(health.filter((t) => t.mutates).map((t) => t.name), ["add_planned_calorie_diary_entries"]);
    assert.match(health.find((t) => t.name === "add_planned_calorie_diary_entries")!.description, /PLANNED/);
  });

  test("a recipe's calories and the household meal plan stay household", () => {
    const tools = buildTools(ann, true, { now: () => NOW });
    for (const name of ["list_recipes", "save_recipe", "create_meal_plan", "get_meal_plan", "set_meal_status"]) {
      assert.equal(tools.find((t) => t.name === name)?.sensitivity, "household", name);
    }
  });

  test("the naming rule: the word \"budget\" is never bare in a name, description or parameter of a calorie or food tool", () => {
    const tools = buildTools(ann, true, { now: () => NOW }).filter((t) => t.domain === "calories" || t.domain === "foods");
    assert.ok(tools.length >= 6);
    for (const t of tools) {
      const texts = [t.name, t.description, ...Object.entries(t.parameters.properties).flatMap(([k, v]: [string, any]) => [k, v.description ?? "", JSON.stringify(v.items ?? {})])];
      for (const raw of texts) {
        // The money tool's own name is a pointer ("use get_budget_summary for money"), not a loose use of the word.
        const text = raw.replaceAll("get_budget_summary", "");
        for (const m of text.matchAll(/budget/gi)) {
          const before = text.slice(Math.max(0, m.index! - 8), m.index!).toLowerCase();
          assert.match(before, /(calorie|money)[\s_-]*$/, `${t.name}: "budget" without calorie/money in: ${text}`);
        }
      }
    }
  });

  test("a login that can't keep a diary gets nothing (the data layer would refuse it anyway)", () => {
    assert.deepEqual(namesFor(ann, { role: "member-of-nothing" }).filter((n) => n.includes("calorie_diary") || n === "get_weight_progress"), []);
  });
});

describe("the owner's own day", () => {
  before(() => {
    eat(ann, TODAY, toast, "logged", "breakfast", 2); // 160
    eat(ann, TODAY, lasagna, "logged", "dinner"); // 600
    eat(ann, TODAY, toast, "planned", "snacks"); // 80, planned: not counted
    addExercise(db, tr(ann), NOW, { name: "Walk", kcal: 150, minutes: 30 });
  });

  test("get_calorie_day_summary: calorie budget, eaten, exercise, left, per meal, and what is only planned", async () => {
    const r = await callAs(ann, "get_calorie_day_summary");
    assert.equal(r.person, "Ann");
    assert.equal(r.date, TODAY);
    assert.equal(r.isToday, true);
    assert.equal(r.calorieBudget, 2000);
    assert.equal(r.caloriesEaten, 760);
    assert.equal(r.exerciseCaloriesAddedBack, 150);
    assert.equal(r.caloriesLeft, 2000 - 760 + 150);
    assert.equal(r.caloriesPlannedNotYetEaten, 80);
    assert.equal(r.plannedEntryCount, 1);
    const breakfast = r.meals.find((m: any) => m.mealKey === "breakfast");
    assert.equal(breakfast.caloriesEaten, 160);
    assert.deepEqual(breakfast.entries.map((e: any) => [e.name, e.quantity, e.calories]), [["Toast", 2, 160]]);
    const snacks = r.meals.find((m: any) => m.mealKey === "snacks");
    assert.match(snacks.entries[0].status, /planned/);
    assert.equal(snacks.caloriesEaten, 0, "a planned entry is not eaten");
  });

  test("it agrees with the screen's own numbers", async () => {
    const r = await callAs(ann, "get_calorie_day_summary", { date: TODAY });
    const s = daySummary(db, tr(ann), TODAY, TODAY, { persist: false });
    assert.deepEqual([r.calorieBudget, r.caloriesEaten, r.caloriesLeft], [s.calorieBudget, s.eaten, s.remaining]);
  });

  test("dates: yesterday and tomorrow are the person's own; a loose word like Friday is refused, not guessed", async () => {
    assert.equal((await callAs(ann, "get_calorie_day_summary", { date: "yesterday" })).date, "2026-03-09");
    assert.equal((await callAs(ann, "get_calorie_day_summary", { date: "tomorrow" })).date, "2026-03-11");
    const bad = await callAs(ann, "get_calorie_day_summary", { date: "Friday" });
    assert.match(bad.error, /YYYY-MM-DD/);
  });

  test("reading a day writes nothing (no frozen calorie budget for a day nobody opened)", async () => {
    const before = get<{ n: number }>(db, "SELECT COUNT(*) AS n FROM nutrition_day_logs WHERE user_id = ? AND local_date = '2026-02-20'", ann)!.n;
    await callAs(ann, "get_calorie_day_summary", { date: "2026-02-20" });
    assert.equal(get<{ n: number }>(db, "SELECT COUNT(*) AS n FROM nutrition_day_logs WHERE user_id = ? AND local_date = '2026-02-20'", ann)!.n, before);
  });

  test("with no profile there is no calorie budget, and it says what is missing instead of inventing one", async () => {
    const newcomer = createUser("noprofile-cal", "not-a-real-hash", "Newcomer", "parent");
    const r = await callAs(newcomer, "get_calorie_day_summary");
    assert.equal(r.calorieBudget, null);
    assert.equal(r.caloriesLeft, null);
    assert.match(r.calorieBudgetUnavailable, /profile/);
  });

  test("get_calorie_week_summary: the week day by day for me; others only appear if they share", async () => {
    const r = await callAs(ann, "get_calorie_week_summary");
    assert.equal(r.weekStart, MONDAY);
    assert.deepEqual(r.people.map((p: any) => p.person), ["Ann"], "Ben shares nothing, so he is not in Ann's week");
    const tuesday = r.people[0].days[1];
    assert.equal(tuesday.day, "Tuesday");
    assert.equal(tuesday.caloriesEaten, 760);
    assert.equal(tuesday.calorieBudget, 2000);
    assert.equal(tuesday.planningTargetCalories, 1800);
  });

  test("get_weight_progress: latest weigh-in, trend, goal, steps", async () => {
    putSteps(db, tr(ann), TODAY, TODAY, { steps: 8123 });
    const r = await callAs(ann, "get_weight_progress");
    assert.equal(r.person, "Ann");
    assert.equal(r.latestWeighIn.weightKg, 65);
    assert.equal(r.latestWeighIn.weightLb, 143.3);
    assert.equal(r.goalWeightKg, 60);
    assert.deepEqual(r.stepsLast14Days.map((s: any) => s.steps), [8123]);
    assert.equal(r.preferredUnits, "imperial");
  });
});

describe("another person's data follows THEIR visibility setting, from both sides", () => {
  before(() => {
    eat(ben, TODAY, lasagna, "logged", "dinner"); // 600
    eat(ben, TODAY, benSecret, "logged", "snacks"); // 300
    addWeight(db, tr(ben), new Date("2026-03-01T15:00:00Z"), { weightKg: 91 });
  });
  const share = (who: string, level: "nothing" | "totals" | "everything") => setVisibility(db, tr(who), { visibility: level });
  after(() => {
    share(ann, "nothing");
    share(ben, "nothing");
  });

  test("nothing (the default): a refusal, with no numbers at all", async () => {
    share(ben, "nothing");
    for (const [tool, args] of [["get_calorie_day_summary", { person: "Ben" }], ["get_weight_progress", { person: "Ben" }]] as const) {
      const r = await callAs(ann, tool, args);
      assert.deepEqual(Object.keys(r), ["error"], tool);
      assert.match(r.error, /Ben doesn't share that with you/);
    }
  });

  test("totals: the day's calories against the calorie budget, no foods and no weight", async () => {
    share(ben, "totals");
    const r = await callAs(ann, "get_calorie_day_summary", { person: "ben" });
    assert.equal(r.person, "Ben");
    assert.equal(r.sharedAtLevel, "totals");
    assert.deepEqual([r.calorieBudget, r.caloriesEaten, r.caloriesLeft], [1500, 900, 600]);
    assert.equal("meals" in r, false);
    assert.equal(JSON.stringify(r).includes("secret fudge"), false);
    const w = await callAs(ann, "get_weight_progress", { person: "Ben" });
    assert.match(w.error, /doesn't share that/);
  });

  test("everything: the foods and exercise, and the weigh-ins and steps -- but never the goal", async () => {
    share(ben, "everything");
    const r = await callAs(ann, "get_calorie_day_summary", { person: "Ben" });
    assert.equal(r.sharedAtLevel, "everything");
    assert.deepEqual(r.meals.flatMap((m: any) => m.entries.map((e: any) => e.name)).sort(), ["Ben's secret fudge", "Lasagna"].sort());
    const w = await callAs(ann, "get_weight_progress", { person: "Ben" });
    assert.equal(w.latestWeighIn.weightKg, 90);
    assert.equal("goalWeightKg" in w, false);
    assert.equal("planPoundsPerWeek" in w, false);
  });

  test("the other direction is independent: Ann sharing nothing refuses Ben even while Ben shares everything", async () => {
    share(ben, "everything");
    share(ann, "nothing");
    const r = await callAs(ben, "get_calorie_day_summary", { person: "Ann" });
    assert.match(r.error, /Ann doesn't share that with you/);
    share(ann, "totals");
    const t = await callAs(ben, "get_calorie_day_summary", { person: "Ann" });
    assert.equal(t.caloriesEaten, 760);
    assert.equal((await callAs(ben, "get_weight_progress", { person: "Ann" })).error?.length > 0, true, "totals does not include weight");
  });

  test("the week summary lists exactly the logins that share at least totals", async () => {
    share(ben, "nothing");
    assert.deepEqual((await callAs(ann, "get_calorie_week_summary")).people.map((p: any) => p.person), ["Ann"]);
    share(ben, "totals");
    const r = await callAs(ann, "get_calorie_week_summary");
    assert.deepEqual(r.people.map((p: any) => p.person), ["Ann", "Ben"]);
    const benTuesday = r.people[1].days[1];
    assert.equal(benTuesday.caloriesEaten, 900);
    assert.equal(benTuesday.planningTargetCalories, undefined, "another person's planning target is not part of what they share");
  });

  test("asking about yourself by name or by \"me\" is your own diary", async () => {
    share(ann, "nothing");
    assert.equal((await callAs(ann, "get_calorie_day_summary", { person: "Ann" })).caloriesEaten, 760);
    assert.equal((await callAs(ann, "get_calorie_day_summary", { person: "me" })).caloriesEaten, 760);
  });

  test("someone with no login (a roster member), or a stranger, is a plain answer listing who keeps a diary", async () => {
    putScopedItem("household_members", ann, { id: newId("member"), name: "Sam", likes: [], dislikes: [], scope: "joint", createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() });
    const r = await callAs(ann, "get_calorie_day_summary", { person: "Sam" });
    assert.match(r.error, /doesn't keep a food diary/);
    assert.deepEqual(r.validValues, ["Ann", "Ben", "Newcomer"]);
  });

  test("the owner's food-diary PIN also locks their data for the viewer until the session is unlocked", async () => {
    share(ben, "everything");
    setConfig(`nutrition_require_pin:${ben}`, true);
    try {
      const locked = await callAs(ann, "get_calorie_day_summary", { person: "Ben" }, {}, false);
      assert.match(locked.error, /behind the PIN/);
      const week = await callAs(ann, "get_calorie_week_summary", {}, {}, false);
      assert.deepEqual(week.people.map((p: any) => p.person), ["Ann"], "a locked diary is left out of the week too");
      const open = await callAs(ann, "get_calorie_day_summary", { person: "Ben" }, {}, true);
      assert.equal(open.caloriesEaten, 900);
    } finally {
      setConfig(`nutrition_require_pin:${ben}`, false);
    }
  });

  test("a watch (device token) never views another person's data, whatever they share", async () => {
    share(ben, "everything");
    const r = await callAs(ann, "get_calorie_day_summary", { person: "Ben" }, { device: true });
    assert.match(r.error, /watch/);
    assert.equal((await callAs(ann, "get_calorie_day_summary", {}, { device: true })).caloriesEaten, 760, "its own owner's day is fine");
  });

  test("progress photos are unreachable: no calorie tool reads them and no answer mentions them", async () => {
    share(ben, "everything");
    const answers = [
      await callAs(ann, "get_calorie_day_summary", { person: "Ben" }),
      await callAs(ann, "get_weight_progress", { person: "Ben" }),
      await callAs(ann, "get_weight_progress"),
    ];
    for (const a of answers) assert.equal(/photo/i.test(JSON.stringify(a)), false);
  });
});

describe("my own food-diary PIN lock", () => {
  const lockedMessage = /locked behind the PIN/;
  const calls: Array<[string, Record<string, any>]> = [
    ["get_calorie_day_summary", {}],
    ["get_calorie_week_summary", {}],
    ["get_weight_progress", {}],
    ["plan_meals_within_calorie_budgets", { weekStart: MONDAY }],
    ["add_planned_calorie_diary_entries", { meal: "lunch", items: [{ foodId: "x", quantity: 1 }] }],
  ];

  test("while it is on and the session is locked, every health tool refuses -- like the API's 423", async () => {
    setConfig(`nutrition_require_pin:${ann}`, true);
    try {
      for (const [tool, args] of calls) {
        assert.match((await callAs(ann, tool, args, {}, false)).error, lockedMessage, `${tool} (session locked)`);
        assert.match((await callAs(ann, tool, args, { foodDiaryLocked: true }, true)).error, lockedMessage, `${tool} (flag)`);
        assert.match((await callAs(ann, tool, args, { device: true }, true)).error, lockedMessage, `${tool} (a watch can't enter a PIN)`);
      }
      assert.equal((await callAs(ann, "get_calorie_day_summary", {}, {}, true)).caloriesEaten, 760, "unlocked, it works");
    } finally {
      setConfig(`nutrition_require_pin:${ann}`, false);
    }
  });

  test("with the option off, a locked session changes nothing", async () => {
    assert.equal((await callAs(ann, "get_calorie_day_summary", {}, {}, false)).caloriesEaten, 760);
  });

  test("the manifest drops the health tools while the lock is on", async () => {
    const { toolManifest } = await import("../assistant/registry.ts");
    assert.ok(toolManifest(ann, false, { now: () => NOW }).some((t) => t.sensitivity === "health"));
    assert.equal(toolManifest(ann, false, { foodDiaryLocked: true }).some((t) => t.sensitivity === "health"), false);
  });
});

describe("chat logging adds PLANNED entries only", () => {
  const countEntries = (user: string) => get<{ n: number }>(db, "SELECT COUNT(*) AS n FROM nutrition_diary_entries WHERE user_id = ? AND deleted_at IS NULL", user)!.n;

  test("\"I had two eggs and toast for breakfast\": planned, source llm, uncounted, in the speaker's diary only", async () => {
    const date = "2026-03-12";
    const benBefore = countEntries(ben);
    const r = await callAs(ann, "add_planned_calorie_diary_entries", {
      meal: "breakfast",
      date,
      items: [{ foodId: egg, quantity: 2, serving: "1 large" }, { foodId: toast, quantity: 1 }],
    });
    assert.equal(r.status, "PLANNED, not eaten");
    assert.equal(r.totalPlannedCalories, 143 + 80);
    assert.deepEqual(r.addedAsPlanned.map((e: any) => [e.name, e.calories]), [["Egg, whole, raw, fresh", 143], ["Toast", 80]]);
    assert.match(r.toConfirm, /Nothing is logged yet/);

    const rows = liveEntries(db, ann, date);
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.status, "planned");
      assert.equal(row.source, "llm");
      assert.equal(row.slot_key, "breakfast");
    }
    assert.equal(rows[0].group_id?.startsWith("llm-"), true, "grouped, so the screen's Undo can remove them together");
    assert.equal(daySummary(db, tr(ann), date, TODAY, { persist: false }).eaten, 0, "planned food is not eaten");
    assert.equal(countEntries(ben), benBefore, "nothing was written to anyone else's diary");
  });

  test("a PAST day is planned too -- the data layer's own default would have made it logged", async () => {
    const r = await callAs(ann, "add_planned_calorie_diary_entries", { meal: "snacks", date: "2026-03-05", items: [{ foodId: toast, quantity: 1 }] });
    assert.equal(r.status, "PLANNED, not eaten");
    assert.deepEqual(liveEntries(db, ann, "2026-03-05").map((e) => e.status), ["planned"]);
  });

  test("the default day is the speaker's own today", async () => {
    const r = await callAs(ann, "add_planned_calorie_diary_entries", { meal: "snacks", items: [{ foodId: toast, quantity: 1 }] });
    assert.equal(r.date, TODAY);
  });

  test("it never touches an existing logged entry", async () => {
    const before = liveEntries(db, ann, TODAY).filter((e) => e.status === "logged").map((e) => [e.id, e.updated_at, e.nutrients_total]);
    await callAs(ann, "add_planned_calorie_diary_entries", { meal: "dinner", items: [{ foodId: lasagna, quantity: 1 }] });
    const after = liveEntries(db, ann, TODAY).filter((e) => e.status === "logged").map((e) => [e.id, e.updated_at, e.nutrients_total]);
    assert.deepEqual(after, before);
  });

  test("an amount is never guessed: no quantity, or a per-100 g food with no serving or grams, writes nothing", async () => {
    const n = countEntries(ann);
    assert.match((await callAs(ann, "add_planned_calorie_diary_entries", { meal: "lunch", items: [{ foodId: toast }] })).error, /How many servings of Toast/);
    const r = await callAs(ann, "add_planned_calorie_diary_entries", { meal: "lunch", items: [{ foodId: egg, quantity: 2 }] });
    assert.match(r.error, /measured per 100 g/);
    assert.deepEqual(r.validValues, ["100 g", "1 large"]);
    assert.equal(countEntries(ann), n);
  });

  test("grams work for a per-100 g food, and the calories follow the weight", async () => {
    const r = await callAs(ann, "add_planned_calorie_diary_entries", { meal: "lunch", date: "2026-03-14", items: [{ foodId: egg, grams: 200 }] });
    assert.equal(r.totalPlannedCalories, 286);
  });

  test("all or nothing: a bad second item adds neither", async () => {
    const n = countEntries(ann);
    const r = await callAs(ann, "add_planned_calorie_diary_entries", { meal: "lunch", items: [{ foodId: toast, quantity: 1 }, { foodId: "not-a-food", quantity: 1 }] });
    assert.match(r.error, /No food with that foodId/);
    assert.equal(countEntries(ann), n);
  });

  test("an unknown meal lists the person's own meals; the meal is required, not assumed", async () => {
    const r = await callAs(ann, "add_planned_calorie_diary_entries", { meal: "elevenses", items: [{ foodId: toast, quantity: 1 }] });
    assert.match(r.error, /Choose one of: Breakfast, Lunch, Dinner, Snacks/);
    assert.match((await callAs(ann, "add_planned_calorie_diary_entries", { items: [{ foodId: toast, quantity: 1 }] })).error, /Which meal/);
  });

  test("a food name that matches several foods is refused with candidates (nothing guessed); one match is accepted", async () => {
    generic("Egg white", 52, [["100 g", 100, true]]);
    const n = countEntries(ann);
    const r = await callAs(ann, "add_planned_calorie_diary_entries", { meal: "lunch", items: [{ food: "egg", quantity: 1 }] });
    assert.match(r.error, /matches more than one food/);
    assert.ok(r.candidates.length >= 2);
    assert.equal(countEntries(ann), n);
    const ok = await callAs(ann, "add_planned_calorie_diary_entries", { meal: "lunch", date: "2026-03-15", items: [{ food: "toast", quantity: 1 }] });
    assert.equal(ok.addedAsPlanned[0].name, "Toast");
  });

  test("someone else's personal food can't be added by id", async () => {
    const r = await callAs(ann, "add_planned_calorie_diary_entries", { meal: "lunch", items: [{ foodId: benSecret, quantity: 1 }] });
    assert.match(r.error, /No food with that foodId/);
  });

  test("it has no way to name another person, and no tool in the set can log, edit or delete", () => {
    const tool = buildTools(ann, true).find((t) => t.name === "add_planned_calorie_diary_entries")!;
    assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ["date", "items", "meal"]);
    const planned = all<{ status: string; source: string }>(db, "SELECT status, source FROM nutrition_diary_entries WHERE source = 'llm'");
    assert.ok(planned.length > 0);
    assert.ok(planned.every((e) => e.status === "planned"), "everything the assistant ever wrote is planned");
  });

  test("too many foods in one call is refused", async () => {
    const items = Array.from({ length: 21 }, () => ({ foodId: toast, quantity: 1 }));
    assert.match((await callAs(ann, "add_planned_calorie_diary_entries", { meal: "lunch", items })).error, /At most 20/);
  });
});

describe("calorie-aware planning: every login's calorie budget number, and only that", () => {
  test("returns each diary login's planning target per day -- calorie budget minus the snack allowance", async () => {
    const r = await callAs(ann, "plan_meals_within_calorie_budgets", { weekStart: "2026-03-11" }); // any date in the week
    assert.equal(r.weekStart, MONDAY);
    const byName = Object.fromEntries(r.people.map((p: any) => [p.person, p]));
    assert.deepEqual(Object.keys(byName).sort(), ["Ann", "Ben", "Newcomer"]);
    assert.equal(byName.Ann.days.length, 7);
    assert.equal(byName.Ann.days[0].day, "Monday");
    assert.deepEqual([byName.Ann.days[1].calorieBudget, byName.Ann.days[1].snackAllowanceCalories, byName.Ann.days[1].planningTargetCalories], [2000, 200, 1800]);
    assert.deepEqual([byName.Ben.days[1].calorieBudget, byName.Ben.days[1].snackAllowanceCalories, byName.Ben.days[1].planningTargetCalories], [1500, 300, 1200], "Ben's own 20% snack allowance");
    assert.equal(byName.Newcomer.days[0].planningTargetCalories, null);
    assert.equal(byName.Newcomer.days[0].noCalorieBudgetSetUp, true, "it says there is none, not why");
  });

  test("it is the same set of numbers weekCalories(everyone) gives -- the calorie schedule included", async () => {
    addGoal(db, tr(ann), TODAY, { planLbPerWeek: 0, activityLevel: "light", macroProtein: 20, macroCarbs: 50, macroFat: 30, calorieBudgetOverrideKcal: 2000, calorieSchedule: { highDays: [6, 0], extraKcal: 300 }, effectiveFrom: "2026-03-01" });
    try {
      const r = await callAs(ann, "plan_meals_within_calorie_budgets", { weekStart: MONDAY });
      const expected = weekCalories(db, ann, MONDAY, NOW, { everyone: true });
      for (const person of r.people) {
        const e = expected.people.find((p) => p.name === person.person)!;
        assert.deepEqual(person.days.map((d: any) => d.planningTargetCalories), e.days.map((d) => d.planningTargetKcal), person.person);
      }
      const ann_ = r.people.find((p: any) => p.person === "Ann");
      assert.ok(ann_.days[5].planningTargetCalories > ann_.days[1].planningTargetCalories, "Saturday is a high day");
    } finally {
      addGoal(db, tr(ann), TODAY, { planLbPerWeek: 0, activityLevel: "light", macroProtein: 20, macroCarbs: 50, macroFat: 30, calorieBudgetOverrideKcal: 2000, calorieSchedule: null, effectiveFrom: "2026-03-02" });
    }
  });

  test("it works even at visibility Nothing -- and still reveals no diary, weight, steps or photo", async () => {
    // Ben shares NOTHING with Ann (the default), has eaten, has a weight, and a personal food.
    assert.equal((await callAs(ann, "get_calorie_day_summary", { person: "Ben" })).error?.length > 0, true);
    const r = await callAs(ann, "plan_meals_within_calorie_budgets", { weekStart: MONDAY });
    const text = JSON.stringify(r);
    for (const secret of ["secret fudge", "Lasagna", "weight", "photo", "steps", "loggedKcal", "plannedKcal", "caloriesEaten", "profile"]) {
      assert.equal(text.toLowerCase().includes(secret.toLowerCase()), false, `leaked: ${secret}`);
    }
    // Only these keys per day, plus the plan check.
    const keys = new Set(r.people.flatMap((p: any) => p.days.flatMap((d: any) => Object.keys(d))));
    for (const k of keys) {
      assert.ok(["day", "date", "calorieBudget", "snackAllowanceCalories", "planningTargetCalories", "plannedMealCalories", "roomUnderTargetCalories", "noCalorieBudgetSetUp"].includes(k as string), `unexpected key ${k}`);
    }
  });

  test("with a saved plan it checks each person's planned meals against the target (recipes only, 1 serving each)", async () => {
    const recipeId = newId("recipe");
    putScopedItem("recipes", ann, {
      id: recipeId, name: "Test lasagna", ingredients: ["pasta"], scope: "joint", createdBy: ann, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
      nutrition: { perServing: { kcal: 700, protein: 30, carbs: 60, fat: 25, satFat: 0, sugars: 0, fiber: 0, cholesterolMg: 0, sodiumMg: 0 }, origin: "calculated", complete: true },
    });
    putScopedItem("meal_plans", ann, {
      id: newId("plan"), weekStart: MONDAY, scope: "joint", createdBy: ann, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
      meals: [
        { id: newId("meal"), day: "Monday", slot: "dinner", name: "Test lasagna", ingredients: ["pasta"], status: "proposed", audience: "family", recipeId },
        { id: newId("meal"), day: "Monday", slot: "lunch", name: "Mystery stew", ingredients: ["x"], status: "proposed", audience: "family" },
        { id: newId("meal"), day: "Tuesday", slot: "dinner", name: "Denied thing", ingredients: ["x"], status: "denied", audience: "family", recipeId },
      ],
    });
    const r = await callAs(ann, "plan_meals_within_calorie_budgets", { weekStart: MONDAY });
    assert.equal(r.savedPlanForThisWeek, true);
    const ann_ = r.people.find((p: any) => p.person === "Ann");
    const ben_ = r.people.find((p: any) => p.person === "Ben");
    assert.deepEqual([ann_.days[0].plannedMealCalories, ann_.days[0].roomUnderTargetCalories], [700, 1100]);
    assert.deepEqual([ben_.days[0].plannedMealCalories, ben_.days[0].roomUnderTargetCalories], [700, 500]);
    assert.equal(ann_.days[1].plannedMealCalories, 0, "a denied meal counts for nothing");
    assert.deepEqual(r.plannedMealsWithUnknownCalories.map((m: any) => [m.dish, m.reason]), [["Mystery stew", "it has no recipe"]]);
  });

  test("the planner is a read-only health tool, and the grocery money budget is nowhere in it", () => {
    const tool = buildTools(ann, true).find((t) => t.name === "plan_meals_within_calorie_budgets")!;
    assert.equal(tool.mutates, false);
    assert.equal(tool.sensitivity, "health");
    assert.match(tool.description, /calories, not money/);
  });
});

describe("the food catalogue", () => {
  test("search_food_calories: household foods first, then USDA, each with calories per serving", async () => {
    const r = await callAs(ann, "search_food_calories", { query: "toast" });
    assert.equal(r[0].name, "Toast");
    assert.equal(r[0].from, "household food");
    assert.deepEqual(r[0].servings, [{ serving: "1 slice", grams: 30, calories: 80, isDefault: true }]);

    const eggs = await callAs(ann, "search_food_calories", { query: "egg", limit: 3 });
    const whole = eggs.find((f: any) => f.foodId === egg);
    assert.equal(whole.from, "USDA catalogue");
    assert.equal(whole.caloriesPer100g, 143);
    assert.deepEqual(whole.servings.map((s: any) => [s.serving, s.calories]), [["100 g", 143], ["1 large", 71.5]]);
  });

  test("it says nothing about anyone's diary, and one person's personal food is invisible to the other", async () => {
    assert.deepEqual(await callAs(ann, "search_food_calories", { query: "secret fudge" }).then((r) => r.error?.length > 0), true);
    const mine = await callAs(ben, "search_food_calories", { query: "secret fudge" });
    assert.equal(mine[0].from, "your own food");
    assert.equal(mine[0].servings[0].calories, 300);
  });

  test("an empty query or no match is an honest error", async () => {
    assert.match((await callAs(ann, "search_food_calories", { query: "  " })).error, /which food/i);
    assert.match((await callAs(ann, "search_food_calories", { query: "zzzzqx" })).error, /No food matching/);
  });
});

describe("the system prompt tells the two budgets apart", () => {
  test("a local model is told money and calorie budgets are different, and which tool answers which", async () => {
    const { systemPrompt } = await import("../assistant/systemPrompt.ts");
    const prompt = systemPrompt(ann, { hideFinancial: false, hideHealth: false });
    assert.match(prompt, /two different things/);
    assert.match(prompt, /MONEY budget[^]*get_budget_summary/);
    assert.match(prompt, /CALORIE budget[^]*get_calorie_day_summary/);
    assert.match(prompt, /Calories or money\?/);
    assert.match(prompt, /plan_meals_within_calorie_budgets/);
    // User decision: "log tonight's dinner" on a phone/PC login is never done by the assistant.
    assert.match(prompt, /cannot mark a planned meal as eaten/);
  });
});
