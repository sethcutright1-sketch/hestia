// The recipes overhaul's server editing (routes/mealplan.ts): PATCH /recipes/:id, POST /recipes/:id/duplicate and
// GET /recipes/:id/usage, plus the rule that follows an edit into the meal plan (nutrition/data/recipePlanSync.ts:
// "this week and future weeks") and the kiosk's PIN (auth.ts requireKioskPin).
//   alice  parent (adds recipes)   bob  parent   kiosk  the shared kitchen screen

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { loadDb, cleanupDb } from "./helpers/testdb.ts";
import { callRoute } from "./helpers/router.ts";
import { addDays, mondayOf, serverToday } from "../nutrition/dates.ts";

const loaded = await loadDb();
const { createUser, getScopedItems, putScopedItem, setConfig, db } = loaded as any;
const { mealPlanRoutes, buildMealPlan } = await import("../routes/mealplan.ts");

let alice: string, bob: string, kiosk: string;
const as = (userId: string, extra: Record<string, unknown> = {}) => ({ session: { userId, ...extra } });
const call = (method: string, url: string, who: object, body?: unknown) => callRoute(mealPlanRoutes, method, url, { ...who, body });

const THIS_WEEK = mondayOf(serverToday())!;
const NEXT_WEEK = addDays(THIS_WEEK, 7);
const PAST_WEEK = addDays(THIS_WEEK, -14);

const recipeRow = (id: string) => (getScopedItems("recipes", alice) as any[]).find((r) => r.id === id);
function addRecipe(over: Record<string, unknown> = {}) {
  const id = `recipe-${Math.random().toString(16).slice(2, 10)}`;
  const doc = {
    id, name: "Chili", ingredients: ["beef", "beans"], scope: "joint", createdBy: alice,
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    lines: [{ text: "2 cups beef", pantryName: "beef" }, { text: "1 can beans", pantryName: "beans" }],
    ...over,
  };
  db.prepare("INSERT INTO recipes (item_id, owner_user_id, data) VALUES (?, ?, ?)").run(id, doc.scope === "personal" ? alice : null, JSON.stringify(doc));
  return doc as any;
}
function seedPlans(recipeId: string, name: string, ingredients: string[]) {
  db.exec("DELETE FROM meal_plans");
  for (const week of [PAST_WEEK, THIS_WEEK, NEXT_WEEK]) {
    putScopedItem("meal_plans", alice, buildMealPlan(alice, week, [
      { id: `m-${week}`, day: "Monday", slot: "dinner", name, ingredients, status: "proposed", audience: "family", recipeId },
      { id: `l-${week}`, day: "Tuesday", slot: "lunch", name: `Leftover ${name}`, ingredients: [], status: "proposed", audience: "family", recipeId, leftoverOf: `m-${week}` },
    ] as any));
  }
}
const planMeal = (week: string, id: string) => (getScopedItems("meal_plans", alice) as any[]).find((p) => p.weekStart === week).meals.find((m: any) => m.id === id);

before(() => {
  alice = createUser("alice-re", "not-a-real-hash", "Alice", "parent");
  bob = createUser("bob-re", "not-a-real-hash", "Bob", "parent");
  kiosk = createUser("kiosk-re", "not-a-real-hash", "Kitchen", "kiosk");
});
after(cleanupDb);
beforeEach(() => {
  db.exec("DELETE FROM recipes; DELETE FROM meal_plans; DELETE FROM nutrition_food_servings; DELETE FROM nutrition_foods");
  setConfig("lock_pin_hash", null);
});

describe("PATCH /recipes/:id", () => {
  test("tags, times and notes are saved, cleaned, and can be cleared", async () => {
    const r = addRecipe();
    const res = await call("PATCH", `/recipes/${r.id}`, as(alice), { tags: ["Quick", "#Crockpot", "quick"], prepMinutes: "15", cookMinutes: 90, notes: "  Less salt.  " });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.recipe.tags, ["quick", "crockpot"]);
    assert.deepEqual([res.body.recipe.prepMinutes, res.body.recipe.cookMinutes, res.body.recipe.notes], [15, 90, "Less salt."]);
    const cleared = await call("PATCH", `/recipes/${r.id}`, as(alice), { tags: null, prepMinutes: null, notes: "" });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.recipe.tags, undefined);
    assert.equal(cleared.body.recipe.prepMinutes, undefined);
    assert.equal(cleared.body.recipe.notes, undefined);
    assert.equal(cleared.body.recipe.cookMinutes, 90, "what the request did not mention is left alone");
  });

  test("a recipe saved before any of this still loads and edits", async () => {
    const legacy = { id: "recipe-old", name: "Old stew", ingredients: ["beef", "carrots"], scope: "joint", createdBy: alice, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };
    db.prepare("INSERT INTO recipes (item_id, owner_user_id, data) VALUES (?, NULL, ?)").run(legacy.id, JSON.stringify(legacy));
    const res = await call("PATCH", "/recipes/recipe-old", as(bob), { name: "Old beef stew" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.recipe.name, "Old beef stew");
    assert.deepEqual(res.body.recipe.ingredients, ["beef", "carrots"]);
  });

  test("bad values are 400s and change nothing", async () => {
    const r = addRecipe();
    for (const body of [{ prepMinutes: "soon" }, { cookMinutes: 99999 }, { tags: 7 }, { notes: 5 }, { name: "   " }, { scope: "everyone" }]) {
      const res = await call("PATCH", `/recipes/${r.id}`, as(alice), body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    assert.equal(recipeRow(r.id).name, "Chili");
  });

  test("renaming to a name another recipe has is a 409", async () => {
    const a = addRecipe({ name: "Tacos" });
    addRecipe({ name: "Soup" });
    const res = await call("PATCH", `/recipes/${a.id}`, as(alice), { name: "soup" });
    assert.equal(res.status, 409);
    assert.equal(recipeRow(a.id).name, "Tacos");
  });

  test("someone else's personal recipe is a 404, and only the creator changes who it is shared with", async () => {
    const mine = addRecipe({ name: "Secret sauce", scope: "personal" });
    assert.equal((await call("PATCH", `/recipes/${mine.id}`, as(bob), { name: "Mine now" })).status, 404);
    const shared = addRecipe({ name: "Family pie" });
    const res = await call("PATCH", `/recipes/${shared.id}`, as(bob), { scope: "personal" });
    assert.equal(res.status, 403);
    assert.equal(recipeRow(shared.id).scope, "joint");
  });
});

describe("editing ingredient lines", () => {
  function linkBeef(recipeId: string) {
    db.prepare("INSERT INTO nutrition_foods (id, name, basis, nutrients, source, created_at) VALUES ('food-beef', 'Beef', 'per100g', '{\"kcal\":250}', 'custom', 'x')").run();
    db.prepare("INSERT INTO nutrition_food_servings (id, food_id, label, grams, is_default) VALUES ('s-beef', 'food-beef', '100 g', 100, 1)").run();
    const doc = recipeRow(recipeId);
    doc.lines[0] = { ...doc.lines[0], foodId: "food-beef", grams: 500 };
    db.prepare("UPDATE recipes SET data = ? WHERE item_id = ?").run(JSON.stringify(doc), recipeId);
  }

  test("a typo fix keeps the calorie link", async () => {
    const r = addRecipe({ lines: [{ text: "2 cups beeff", pantryName: "beeff" }, { text: "1 can beans", pantryName: "beans" }] });
    linkBeef(r.id);
    const res = await call("PATCH", `/recipes/${r.id}`, as(alice), { lines: [{ text: "2 cups beef", from: 0 }, { text: "1 can beans", from: 1 }] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.relink, 0);
    assert.equal(res.body.recipe.lines[0].foodId, "food-beef");
    assert.deepEqual(res.body.recipe.ingredients, ["beef", "beans"], "ingredient names follow the new text");
  });

  test("a changed amount or a different food drops the link and says how many", async () => {
    const r = addRecipe();
    linkBeef(r.id);
    const amount = await call("PATCH", `/recipes/${r.id}`, as(alice), { lines: [{ text: "1 cup beef", from: 0 }, { text: "1 can beans", from: 1 }] });
    assert.equal(amount.body.relink, 1);
    assert.equal(amount.body.recipe.lines[0].foodId, undefined);
    assert.equal(amount.body.recipe.nutrition?.complete ?? false, false);

    const r2 = addRecipe({ name: "Chili 2" });
    db.prepare("UPDATE recipes SET data = ? WHERE item_id = ?").run(JSON.stringify({ ...recipeRow(r2.id), lines: [{ ...r2.lines[0], foodId: "food-beef", grams: 500 }, r2.lines[1]] }), r2.id);
    const food = await call("PATCH", `/recipes/${r2.id}`, as(alice), { lines: [{ text: "2 cups quinoa", from: 0 }, { text: "1 can beans", from: 1 }] });
    assert.equal(food.body.relink, 1);
    assert.equal(food.body.recipe.lines[0].foodId, undefined);
  });

  test("adding, removing and reordering lines keeps the links that still match", async () => {
    const r = addRecipe();
    linkBeef(r.id);
    const res = await call("PATCH", `/recipes/${r.id}`, as(alice), { lines: [{ text: "1 can beans", from: 1 }, { text: "1 tsp salt" }, { text: "2 cups beef", from: 0 }] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.recipe.lines.map((l: any) => l.foodId), [undefined, undefined, "food-beef"]);
    assert.equal(res.body.relink, 0);
  });
});

describe("an edit reaches the meal plan (this week and future weeks)", () => {
  test("a rename and new ingredients update planned meals now and later, not a week that is over", async () => {
    const r = addRecipe();
    seedPlans(r.id, "Chili", ["beef", "beans"]);
    const res = await call("PATCH", `/recipes/${r.id}`, as(alice), {
      name: "Beef chili", lines: [{ text: "2 cups beef", from: 0 }, { text: "1 can beans", from: 1 }, { text: "1 onion" }],
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    for (const week of [THIS_WEEK, NEXT_WEEK]) {
      assert.deepEqual([planMeal(week, `m-${week}`).name, planMeal(week, `m-${week}`).ingredients], ["Beef chili", ["beef", "beans", "onion"]], week);
      assert.equal(planMeal(week, `l-${week}`).name, "Leftover Beef chili");
      assert.deepEqual(planMeal(week, `l-${week}`).ingredients, [], "a leftover keeps no ingredients of its own");
    }
    assert.deepEqual([planMeal(PAST_WEEK, `m-${PAST_WEEK}`).name, planMeal(PAST_WEEK, `m-${PAST_WEEK}`).ingredients], ["Chili", ["beef", "beans"]]);
  });

  test("the plan's status stays, and an edit that changes neither name nor ingredients touches nothing", async () => {
    const r = addRecipe();
    seedPlans(r.id, "Chili", ["beef", "beans"]);
    const before = JSON.stringify(getScopedItems("meal_plans", alice));
    await call("PATCH", `/recipes/${r.id}`, as(alice), { tags: ["quick"], notes: "Nice." });
    assert.equal(JSON.stringify(getScopedItems("meal_plans", alice)), before);
  });

  test("the shopping list follows: what the plan is missing comes from the new ingredients", async () => {
    const r = addRecipe();
    seedPlans(r.id, "Chili", ["beef", "beans"]);
    await call("PATCH", `/recipes/${r.id}`, as(alice), { lines: [{ text: "2 cups beef", from: 0 }, { text: "1 can beans", from: 1 }, { text: "1 onion" }] });
    const week = await call("GET", `/?weekStart=${THIS_WEEK}`, { ...as(alice), query: { weekStart: THIS_WEEK } });
    assert.deepEqual(week.body.missing, ["beef", "beans", "onion"]);
  });
});

describe("duplicate and usage", () => {
  test("a copy gets a new id and a free name, keeps lines and steps, and has no food of its own copied", async () => {
    const r = addRecipe({ instructions: ["Brown the beef."], tags: ["quick"] });
    const one = await call("POST", `/recipes/${r.id}/duplicate`, as(bob));
    assert.equal(one.status, 201, JSON.stringify(one.body));
    assert.notEqual(one.body.recipe.id, r.id);
    assert.equal(one.body.recipe.name, "Chili (copy)");
    assert.deepEqual(one.body.recipe.instructions, ["Brown the beef."]);
    assert.deepEqual(one.body.recipe.tags, ["quick"]);
    assert.equal(one.body.recipe.createdBy, bob);
    const two = await call("POST", `/recipes/${r.id}/duplicate`, as(alice));
    assert.equal(two.body.recipe.name, "Chili (copy 2)");
  });

  test("someone else's personal recipe can't be copied (404)", async () => {
    const mine = addRecipe({ name: "Secret", scope: "personal" });
    assert.equal((await call("POST", `/recipes/${mine.id}/duplicate`, as(bob))).status, 404);
  });

  test("usage counts planned meals (leftovers not counted) and the ones still to come", async () => {
    const r = addRecipe();
    seedPlans(r.id, "Chili", ["beef"]);
    const res = await call("GET", `/recipes/${r.id}/usage`, as(alice));
    assert.deepEqual(res.body, { plannedMeals: 3, upcoming: 2 });
    assert.equal((await call("GET", "/recipes/nope/usage", as(alice))).status, 404);
  });
});

describe("the kiosk needs the household PIN to change recipes", () => {
  const writes = (id: string): [string, string, unknown?][] => [
    ["PATCH", `/recipes/${id}`, { notes: "x" }],
    ["POST", `/recipes/${id}/duplicate`],
    ["POST", "/recipes", { name: "Kiosk soup", ingredients: ["water"] }],
    ["POST", "/recipes/import", { recipes: [{ name: "Kiosk stew", ingredients: ["beef"] }] }],
    ["DELETE", `/recipes/${id}`],
  ];

  test("with a PIN set and the kiosk locked, every recipe write is a 423 and nothing changes", async () => {
    setConfig("lock_pin_hash", "set");
    const r = addRecipe();
    for (const [method, url, body] of writes(r.id)) {
      const res = await call(method, url, as(kiosk), body);
      assert.equal(res.status, 423, `${method} ${url}`);
      assert.deepEqual(res.body, { error: "locked" });
    }
    assert.equal(recipeRow(r.id).notes, undefined);
    assert.equal((getScopedItems("recipes", alice) as any[]).length, 1);
  });

  test("once unlocked the kiosk can change a recipe", async () => {
    setConfig("lock_pin_hash", "set");
    const r = addRecipe();
    const res = await call("PATCH", `/recipes/${r.id}`, as(kiosk, { unlockedUntil: Date.now() + 60_000 }), { notes: "Kid-approved." });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(recipeRow(r.id).notes, "Kid-approved.");
  });

  test("with no PIN set the lock is open, as for Budget", async () => {
    const r = addRecipe();
    assert.equal((await call("PATCH", `/recipes/${r.id}`, as(kiosk), { notes: "ok" })).status, 200);
  });

  test("any other login is never asked, PIN or not", async () => {
    setConfig("lock_pin_hash", "set");
    const r = addRecipe();
    assert.equal((await call("PATCH", `/recipes/${r.id}`, as(bob), { notes: "ok" })).status, 200);
  });

  test("the kiosk can still read: usage and the plan need no PIN", async () => {
    setConfig("lock_pin_hash", "set");
    const r = addRecipe();
    assert.equal((await call("GET", `/recipes/${r.id}/usage`, as(kiosk))).status, 200);
  });
});
