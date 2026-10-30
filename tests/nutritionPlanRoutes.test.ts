// /api/nutrition for the meal plan (phase 4): the snack allowance, the week's calorie view, "Log all", "Use from
// pantry?", and the plan side of the kiosk board. Clock 2026-03-10 15:00Z: ann's (New York) today is 2026-03-10.

import { test, after } from "node:test";
import assert from "node:assert/strict";

import { cleanupDb } from "./helpers/testdb.ts";
import { newApi, type Api } from "./helpers/nutritionApi.ts";
import { TODAY } from "./helpers/nutritionWorld.ts";
import { siteRecipe, syncMeal } from "./helpers/planWorld.ts";
import { syncMealEntries } from "../nutrition/data/mealPlanSync.ts";
import { weekCalories } from "../nutrition/data/planCalories.ts";
import { all, get, run } from "../nutrition/data/sql.ts";

after(cleanupDb);

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Ann with a profile (the world gives her one), a weight and a calorie goal; Ben the same, so both have budgets. */
async function withBudgets(api: Api) {
  for (const who of ["ann", "ben"] as const) await api.call(who, "POST", "/weights", { weightKg: who === "ann" ? 65 : 80 });
}

const goal = {
  planLbPerWeek: 0, activityLevel: "light", macroProtein: 20, macroCarbs: 50, macroFat: 30,
};

// ---- snack allowance ------------------------------------------------------------------------

test("snack allowance: defaults to 10%, per login, 0 to 50, and the day summary uses it", async (t) => {
  const api = await newApi(t);
  await withBudgets(api);
  const first = await api.call("ann", "GET", "/me/snack-allowance");
  assert.deepEqual(first.body, { snackAllowancePct: 10, defaultPct: 10, min: 0, max: 50 });

  assert.equal((await api.call("ann", "PUT", "/me/snack-allowance", { snackAllowancePct: 25 })).body.snackAllowancePct, 25);
  assert.equal((await api.call("ann", "GET", "/me/snack-allowance")).body.snackAllowancePct, 25);
  assert.equal((await api.call("ben", "GET", "/me/snack-allowance")).body.snackAllowancePct, 10, "per login: Ben still has the default");

  for (const ok of [0, 50, 12.34]) {
    assert.equal((await api.call("ann", "PUT", "/me/snack-allowance", { snackAllowancePct: ok })).status, 200, String(ok));
  }
  assert.equal((await api.call("ann", "GET", "/me/snack-allowance")).body.snackAllowancePct, 12.3, "one decimal place");
  for (const bad of [-1, 50.1, 51, "10", null, NaN, Infinity, undefined]) {
    const r = await api.call("ann", "PUT", "/me/snack-allowance", { snackAllowancePct: bad });
    assert.equal(r.status, 400, String(bad));
    assert.match(r.body.error, /0 to 50/);
  }
  assert.equal((await api.call("ann", "GET", "/me/snack-allowance")).body.snackAllowancePct, 12.3, "refused writes changed nothing");
  assert.equal((await api.call("kiosk", "GET", "/me/snack-allowance")).status, 403);
  assert.equal((await api.call("kiosk", "PUT", "/me/snack-allowance", { snackAllowancePct: 5 })).status, 403);

  await api.call("ann", "PUT", "/me/snack-allowance", { snackAllowancePct: 20 });
  const day = (await api.call("ann", "GET", `/days/${TODAY}`)).body;
  assert.ok(day.calorieBudget > 0);
  assert.equal(day.snackAllowancePct, 20);
  assert.equal(day.planningTargetKcal, round2(day.calorieBudget * 0.8), "calorie budget x (1 - 20%)");
  const ben = (await api.call("ben", "GET", `/days/${TODAY}`)).body;
  assert.equal(ben.snackAllowancePct, 10);
  assert.equal(ben.planningTargetKcal, round2(ben.calorieBudget * 0.9));

  // No calorie budget (no weight yet) -> no planning target either, never NaN.
  const bare = await newApi(t);
  const none = (await bare.call("ann", "GET", `/days/${TODAY}`)).body;
  assert.deepEqual([none.calorieBudget, none.planningTargetKcal, none.snackAllowancePct], [null, null, 10]);
});

test("a login with no profile can still choose a snack allowance, and a database row can't hold 51", async (t) => {
  const api = await newApi(t, { profiles: false });
  assert.equal((await api.call("ben", "PUT", "/me/snack-allowance", { snackAllowancePct: 30 })).status, 200);
  assert.equal(get<any>(api.w.db, "SELECT snack_allowance_pct AS p FROM nutrition_user_settings WHERE user_id = ?", api.w.ids.ben)!.p, 30);
  assert.throws(() => run(api.w.db, "UPDATE nutrition_user_settings SET snack_allowance_pct = 51"), /CHECK/);
  assert.throws(() => run(api.w.db, "INSERT INTO nutrition_user_settings (user_id, snack_allowance_pct, updated_at) VALUES (?, 10, 'x')", api.w.ids.kiosk), /only admin and parent/);
});

// ---- the week's calorie view ------------------------------------------------------------------

test("the week's calorie view: each tracker's calorie budget (schedule applied), snack allowance, planned and logged kcal", async (t) => {
  const api = await newApi(t);
  await withBudgets(api);
  // Ann's higher-calorie days are Saturday and Sunday.
  assert.equal((await api.call("ann", "POST", "/me/goals", { ...goal, calorieSchedule: { highDays: [6, 0], extraKcal: 300 } })).status, 201);
  await api.call("ann", "PUT", "/me/snack-allowance", { snackAllowancePct: 20 });

  const chili = siteRecipe(api.w, "Chili", 450);
  // Monday 2026-03-09: ann logged breakfast; Saturday the 14th: the chili is planned for both.
  const food = (await api.call("ann", "POST", "/foods", { name: "Toast", basis: "per_serving", nutrients: { kcal: 120 }, servings: [{ label: "1 slice", grams: 30 }] })).body;
  await api.call("ann", "POST", "/diary/2026-03-09", { slot: "breakfast", foodId: food.id, quantity: 2, status: "logged" });
  syncMealEntries(api.w.db, { prev: null, next: syncMeal(chili, [api.w.ids.ann, api.w.ids.ben], { date: "2026-03-14" }), now: new Date("2026-03-10T15:00:00Z") });

  const res = await api.call("ann", "GET", "/plan/calories?weekStart=2026-03-11");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.weekStart, "2026-03-09", "any date snaps to its Monday");
  assert.deepEqual(res.body.dates, ["2026-03-09", "2026-03-10", "2026-03-11", "2026-03-12", "2026-03-13", "2026-03-14", "2026-03-15"]);
  // Each login sees only their own numbers (phase 5 decision: visibility is per person, default Nothing).
  assert.deepEqual(res.body.people.map((p: any) => [p.name, p.isMe, p.snackAllowancePct]), [["Ann", true, 20]]);
  assert.equal(JSON.stringify(res.body).includes(api.w.ids.ben), false, "nothing of Ben's reaches Ann");

  const ann = res.body.people[0].days;
  assert.equal(ann.length, 7);
  const [mon, , , , , sat, sun] = ann;
  assert.ok(sat.calorieBudget > mon.calorieBudget, "the calorie schedule is applied: Saturday is a higher day");
  assert.equal(sat.calorieBudget, sun.calorieBudget);
  for (const d of ann) {
    assert.equal(d.planningTargetKcal, round2(d.calorieBudget * 0.8), d.date);
    assert.equal(d.snackAllowanceKcal, round2(d.calorieBudget * 0.2), d.date);
  }
  assert.deepEqual([mon.loggedKcal, mon.plannedKcal, mon.plannedPlusLoggedKcal], [240, 0, 240]);
  assert.equal(mon.roomKcal, round2(mon.planningTargetKcal - 240));
  assert.deepEqual([sat.loggedKcal, sat.plannedKcal, sat.roomKcal], [0, 450, round2(sat.planningTargetKcal - 450)]);
  const benView = (await api.call("ben", "GET", "/plan/calories?weekStart=2026-03-11")).body;
  assert.deepEqual(benView.people.map((p: any) => [p.name, p.isMe]), [["Ben", true]]);
  const ben = benView.people[0].days;
  assert.deepEqual([ben[0].loggedKcal, ben[5].plannedKcal], [0, 450], "Ben's planned chili; his own numbers");
  // Server-side callers (the assistant's weekly planning) can still ask for everyone.
  const all7 = weekCalories(api.w.db, api.w.ids.ann, "2026-03-11", new Date("2026-03-10T15:00:00Z"), { everyone: true });
  assert.deepEqual(all7.people.map((p) => p.name), ["Ann", "Ben"]);

  // Looking is read-only: no day got its budget frozen by being viewed.
  const frozenBefore = all(api.w.db, "SELECT * FROM nutrition_day_logs ORDER BY user_id, local_date");
  await api.call("ann", "GET", "/plan/calories?weekStart=2026-03-02");
  assert.deepEqual(all(api.w.db, "SELECT * FROM nutrition_day_logs ORDER BY user_id, local_date"), frozenBefore);

  // Default week = the week of the caller's own today; a logged entry deleted no longer counts.
  assert.equal((await api.call("ann", "GET", "/plan/calories")).body.weekStart, "2026-03-09");
  assert.equal((await api.call("ann", "GET", "/plan/calories?weekStart=nope")).status, 400);
});

test("the calorie view is health data: the kiosk gets nothing, and without a weight there is no calorie budget but no crash", async (t) => {
  const api = await newApi(t);
  const kiosk = await api.call("kiosk", "GET", "/plan/calories");
  assert.equal(kiosk.status, 403);
  assert.equal(JSON.stringify(kiosk.body).includes("kcal"), false);
  const res = await api.call("ben", "GET", "/plan/calories");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.people[0].days[0].missing, ["weight"]);
  assert.deepEqual([res.body.people[0].days[0].calorieBudget, res.body.people[0].days[0].planningTargetKcal, res.body.people[0].days[0].roomKcal], [null, null, null]);
});

// ---- log all ------------------------------------------------------------------------------------

test("POST /diary/:date/log-all logs the caller's planned entries in that meal and nothing else", async (t) => {
  const api = await newApi(t);
  const chili = siteRecipe(api.w, "Chili", 450);
  const salad = siteRecipe(api.w, "Salad", 200);
  const ids = [api.w.ids.ann, api.w.ids.ben];
  const now = new Date("2026-03-10T15:00:00Z");
  syncMealEntries(api.w.db, { prev: null, next: syncMeal(chili, ids, { date: TODAY, slotKey: "dinner" }), now });
  syncMealEntries(api.w.db, { prev: null, next: syncMeal(salad, ids, { date: TODAY, slotKey: "dinner" }), now });
  syncMealEntries(api.w.db, { prev: null, next: syncMeal(salad, ids, { date: TODAY, slotKey: "lunch" }), now });

  const r = await api.call("ann", "POST", `/diary/${TODAY}/log-all`, { slot: "dinner" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.logged.length, 2);
  assert.equal(r.body.summary.eaten, 650);
  assert.equal(r.body.summary.plannedKcal, 200, "her planned lunch is still planned");
  const day = (await api.call("ben", "GET", `/diary/${TODAY}`)).body;
  assert.deepEqual(day.slots.flatMap((s: any) => s.entries).map((e: any) => e.status), ["planned", "planned", "planned"], "Ben's are untouched");

  assert.equal((await api.call("ann", "POST", `/diary/${TODAY}/log-all`, {})).status, 400);
  assert.equal((await api.call("ann", "POST", `/diary/2026-03-12/log-all`, { slot: "dinner" })).status, 400, "not ahead of the day");
  assert.equal((await api.call("kiosk", "POST", `/diary/${TODAY}/log-all`, { slot: "dinner" })).status, 403);
});

// ---- use from pantry ----------------------------------------------------------------------------------

const pantryItem = (api: Api, name: string, extra: Record<string, unknown>) => {
  const id = `pantry-${name}`;
  run(api.w.db, "INSERT INTO pantry_items (item_id, owner_user_id, data) VALUES (?, NULL, ?)", id,
    JSON.stringify({ id, name, quantity: "", scope: "joint", updatedAt: "2026-03-01T00:00:00Z", updatedBy: api.w.ids.ann, ...extra }));
  return id;
};
const pantryDoc = (api: Api, id: string) => JSON.parse(get<{ data: string }>(api.w.db, "SELECT data FROM pantry_items WHERE item_id = ?", id)!.data);

async function loggedRecipeEntry(api: Api) {
  const recipe = siteRecipe(api.w, "Pepper rice", 400, {
    ingredients: ["peppers", "rice", "salt", "saffron"],
    lines: [
      { text: "2 peppers", pantryName: "peppers" }, { text: "1 cup white rice", pantryName: "rice" },
      { text: "salt", pantryName: "salt" }, { text: "a pinch of saffron", pantryName: "saffron" },
    ],
  });
  const e = (await api.call("ann", "POST", `/diary/${TODAY}`, { slot: "dinner", foodId: recipe.foodId, quantity: 1, status: "logged" })).body.entry;
  return { recipe, entry: e };
}

test("use from pantry: the recipe's lines matched to pantry items (the pantry's own matching), with amounts pre-filled", async (t) => {
  const api = await newApi(t);
  const peppers = pantryItem(api, "Peppers", { stockCount: 5, quantity: "5", barcode: "123" });
  const rice = pantryItem(api, "Rice", { quantity: "3" }); // hand-typed number: countable
  const salt = pantryItem(api, "Salt", { quantity: "a big tub" }); // words: matched, but can't be counted
  pantryItem(api, "Rice vinegar", { quantity: "1" }); // a vinegar, not rice (head-noun matching)
  const { entry } = await loggedRecipeEntry(api);

  const r = await api.call("ann", "GET", `/diary/entry/${entry.id}/pantry-use`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.recipeName, "Pepper rice");
  assert.deepEqual(r.body.items.map((i: any) => [i.name, i.pantryItemId, i.stock, i.countable, i.suggested, i.lines]), [
    ["Peppers", peppers, 5, true, 2, ["2 peppers"]],          // a bare count: the line's own number
    ["Rice", rice, 3, true, 1, ["1 cup white rice"]],          // a measure: one unit
    ["Salt", salt, null, false, 1, ["salt"]],
  ]);
  assert.equal(r.body.unmatchedLines, 1, "saffron isn't in the pantry");
  assert.equal(r.body.alreadyUsed, false);
  assert.equal(pantryDoc(api, peppers).stockCount, 5, "asking changes nothing");
});

test("use from pantry: confirming reduces stock, never below zero, all or nothing, once per entry", async (t) => {
  const api = await newApi(t);
  const peppers = pantryItem(api, "Peppers", { stockCount: 5, quantity: "5", barcode: "123" });
  const rice = pantryItem(api, "Rice", { quantity: "1" });
  const salt = pantryItem(api, "Salt", { quantity: "a big tub" });
  const { entry } = await loggedRecipeEntry(api);
  const url = `/diary/entry/${entry.id}/pantry-use`;

  // One bad item refuses the whole request: nothing changes.
  const bad = await api.call("ann", "POST", url, { items: [{ pantryItemId: peppers, amount: 2 }, { pantryItemId: salt, amount: 1 }] });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /Salt isn't counted/);
  for (const [body, status] of [
    [{ items: [{ pantryItemId: peppers, amount: 0 }] }, 400],
    [{ items: [{ pantryItemId: peppers, amount: -1 }] }, 400],
    [{ items: [{ pantryItemId: peppers, amount: "2" }] }, 400],
    [{ items: [{ pantryItemId: peppers, amount: 2 }, { pantryItemId: peppers, amount: 1 }] }, 400],
    [{ items: [{ pantryItemId: "pantry-nope", amount: 1 }] }, 404],
    [{ items: [] }, 400],
    [{}, 400],
  ] as const) {
    assert.equal((await api.call("ann", "POST", url, body)).status, status, JSON.stringify(body));
  }
  assert.deepEqual([pantryDoc(api, peppers).stockCount, pantryDoc(api, rice).quantity], [5, "1"], "nothing was touched");

  // Rice has 1 and the recipe wants 4: it goes to 0, not below, and says it clamped.
  const ok = await api.call("ann", "POST", url, { items: [{ pantryItemId: peppers, amount: 2 }, { pantryItemId: rice, amount: 4 }] });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(ok.body.updated, [
    { pantryItemId: peppers, name: "Peppers", before: 5, after: 3, clamped: false },
    { pantryItemId: rice, name: "Rice", before: 1, after: 0, clamped: true },
  ]);
  assert.deepEqual([pantryDoc(api, peppers).stockCount, pantryDoc(api, peppers).quantity], [3, "3"], "stockCount and its display string stay in step");
  assert.deepEqual([pantryDoc(api, rice).quantity, "stockCount" in pantryDoc(api, rice)], ["0", false], "a hand-typed quantity stays a quantity");

  // A double tap or a retry cannot take the same items out twice.
  assert.equal((await api.call("ann", "POST", url, { items: [{ pantryItemId: peppers, amount: 2 }] })).status, 409);
  assert.equal(pantryDoc(api, peppers).stockCount, 3);
  assert.equal((await api.call("ann", "GET", url)).body.alreadyUsed, true);
});

test("use from pantry: only for your own logged entry that came from a recipe", async (t) => {
  const api = await newApi(t);
  const peppers = pantryItem(api, "Peppers", { stockCount: 5, quantity: "5" });
  const { recipe, entry } = await loggedRecipeEntry(api);
  const url = `/diary/entry/${entry.id}/pantry-use`;
  const body = { items: [{ pantryItemId: peppers, amount: 1 }] };

  assert.equal((await api.call("ben", "GET", url)).status, 404, "someone else's entry");
  assert.equal((await api.call("ben", "POST", url, body)).status, 404);
  assert.equal((await api.call("kiosk", "POST", url, body)).status, 403);

  // Only pantry items the caller can see: a row someone made personal is Ben's alone (the pantry is joint today, the rule is db.ts's).
  const bens = "pantry-bens";
  run(api.w.db, "INSERT INTO pantry_items (item_id, owner_user_id, data) VALUES (?, ?, ?)", bens, api.w.ids.ben,
    JSON.stringify({ id: bens, name: "Ben's peppers", quantity: "9", stockCount: 9, scope: "personal" }));
  assert.equal((await api.call("ann", "POST", url, { items: [{ pantryItemId: bens, amount: 1 }] })).status, 404);
  assert.equal(pantryDoc(api, bens).stockCount, 9);
  assert.equal((await api.call("ann", "GET", url)).body.items.some((i: any) => i.pantryItemId === bens), false, "and it isn't even suggested");

  const planned = (await api.call("ann", "POST", `/diary/${TODAY}`, { slot: "lunch", foodId: recipe.foodId, status: "planned" })).body.entry;
  assert.equal((await api.call("ann", "POST", `/diary/entry/${planned.id}/pantry-use`, body)).status, 409, "log it first");
  assert.equal((await api.call("ann", "GET", `/diary/entry/${planned.id}/pantry-use`)).status, 200, "suggestions are fine before");

  const quick = (await api.call("ann", "POST", `/diary/${TODAY}`, { slot: "snacks", name: "Mystery", kcal: 100, status: "logged" })).body.entry;
  assert.equal((await api.call("ann", "GET", `/diary/entry/${quick.id}/pantry-use`)).status, 404, "not from a recipe");
  assert.equal((await api.call("ann", "GET", `/diary/entry/nope/pantry-use`)).status, 404);
});

// ---- the kiosk's plan board -------------------------------------------------------------------------

function addPlan(api: Api) {
  const doc = {
    id: "mealplan-1", weekStart: "2026-03-09", scope: "joint", createdBy: api.w.ids.ann, createdAt: "x", updatedAt: "x",
    meals: [
      { id: "m-dinner", day: "Tuesday", slot: "dinner", name: "Chili", ingredients: [], status: "approved", audience: "family", recipeId: "r1" },
      { id: "m-lunch", day: "Tuesday", slot: "lunch", name: "Soup", ingredients: [], status: "approved", audience: "individual", memberId: "member-sam", recipeId: "r2" },
      { id: "m-brunch", day: "Tuesday", slot: "brunch", name: "Pancakes", ingredients: [], status: "approved", audience: "family" },
      { id: "m-proposed", day: "Tuesday", slot: "breakfast", name: "Oats", ingredients: [], status: "proposed", audience: "family" },
      { id: "m-denied", day: "Tuesday", slot: "snacks", name: "Cake", ingredients: [], status: "denied", audience: "family" },
      { id: "m-left", day: "Wednesday", slot: "lunch", name: "Leftover Chili", ingredients: [], status: "approved", audience: "family", leftoverOf: "m-dinner" },
    ],
  };
  run(api.w.db, "INSERT INTO meal_plans (item_id, owner_user_id, data) VALUES (?, NULL, ?)", doc.id, JSON.stringify(doc));
  run(api.w.db, "INSERT INTO household_members (item_id, owner_user_id, data) VALUES ('member-sam', NULL, ?)", JSON.stringify({ id: "member-sam", name: "Sam", likes: [], dislikes: [], scope: "joint" }));
}

test("kiosk board, plan side: hidden shows nothing; plan only and plan + quick logging show the day's approved meals, with no calories", async (t) => {
  const api = await newApi(t);
  addPlan(api);
  assert.equal((await api.call("kiosk", "GET", "/kiosk/today")).status, 403, "hidden: nothing, not even the plan");
  assert.equal((await api.call("kiosk", "GET", "/kiosk/day/2026-03-10")).status, 403);

  for (const setting of ["plan_only", "plan_and_quick_log"]) {
    api.kioskSetting.value = setting;
    const today = (await api.call("kiosk", "GET", "/kiosk/today")).body;
    assert.equal(today.date, TODAY);
    // In meal order; an approved meal in a slot nobody has switched on (brunch) still shows, under its key.
    assert.deepEqual(today.meals.map((m: any) => [m.slotKey, m.slotLabel, m.name, m.who]), [
      ["lunch", "Lunch", "Soup", "Sam"],
      ["dinner", "Dinner", "Chili", "Everyone"],
      ["brunch", "brunch", "Pancakes", "Everyone"],
    ], setting);
    for (const m of today.meals) assert.deepEqual(Object.keys(m).sort(), ["id", "leftover", "name", "slotKey", "slotLabel", "who"], "no calories, nothing from a diary");
    assert.equal(JSON.stringify(today.meals).includes("kcal"), false);

    const wed = (await api.call("kiosk", "GET", "/kiosk/day/2026-03-11")).body;
    assert.deepEqual(wed.meals.map((m: any) => [m.name, m.who, m.leftover]), [["Leftover Chili", "Everyone", true]]);
    assert.deepEqual((await api.call("kiosk", "GET", "/kiosk/day/2026-03-20")).body.meals, [], "a day with no plan");
    assert.deepEqual((await api.call("kiosk", "GET", "/KIOSK/day/2026-03-11/")).body.meals.map((m: any) => m.name), ["Leftover Chili"], "the gate still matches the way Express routes");
  }
  // Nobody else may use the kiosk routes.
  assert.equal((await api.call("ann", "GET", "/kiosk/today")).status, 403);
});
