// POST /api/mealplan/meals/:id/replace-denied: a denied meal's slot is filled with one saved recipe (mealRefill.ts
// has the ranking rules; tests/mealRefill.test.ts covers them). Here: the route's own behaviour -- what goes in,
// what goes out, and that a refusal changes nothing.
//   dad  admin    bea  parent
// The week is 2026-09-07 (a Monday).

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { loadDb, cleanupDb } from "./helpers/testdb.ts";
import { callRoute } from "./helpers/router.ts";
import { siteRecipeFor } from "./helpers/planWorld.ts";
import { setRecipeModel } from "../nutrition/recipeAi.ts";

const loaded = await loadDb();
const { createUser, putScopedItem, getScopedItems, deleteScopedItem, newId } = loaded;
const db = loaded.db as any;
const { mealPlanRoutes, buildMealPlan, currentPlan } = await import("../routes/mealplan.ts");

let dad: string;
const call = (method: string, url: string, body?: unknown) => callRoute(mealPlanRoutes, method, url, { session: { userId: dad }, body });
const WEEK = "2026-09-07";
const meal = (o: Record<string, any> = {}) => ({
  id: newId("meal"), day: "Monday", slot: "dinner", name: "Chili", ingredients: ["beans"], status: "proposed", audience: "family", ...o,
});
function seedPlan(meals: any[]) {
  for (const old of getScopedItems("meal_plans", dad) as any[]) deleteScopedItem("meal_plans", dad, old.id);
  putScopedItem("meal_plans", dad, buildMealPlan(dad, WEEK, meals as any));
}
const plan = () => currentPlan(dad)!;

before(() => { dad = createUser("dad-rd", "x", "Dad", "admin"); });
after(() => { setRecipeModel(undefined); cleanupDb(); });
beforeEach(() => setRecipeModel(undefined));

describe("replacing a denied meal", () => {
  test("the denied meal goes and a proposed meal from another recipe takes its day and slot", async () => {
    const chili = siteRecipeFor(db, dad, "Chili RD1", 450, { ingredients: ["beans"] });
    const tacos = siteRecipeFor(db, dad, "Tacos RD1", 400, { ingredients: ["tortillas"] });
    seedPlan([meal({ id: "d1", day: "Wednesday", slot: "lunch", name: "Chili RD1", recipeId: chili.id, status: "denied" })]);
    const r = await call("POST", "/meals/d1/replace-denied");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(plan().meals.length, 1);
    const now = plan().meals[0];
    assert.equal(now.recipeId, tacos.id);
    assert.equal(now.name, "Tacos RD1");
    assert.deepEqual([now.day, now.slot, now.status, now.audience], ["Wednesday", "lunch", "proposed", "family"]);
    assert.equal(r.body.meal.id, now.id);
  });

  test("its leftovers go with it", async () => {
    const chili = siteRecipeFor(db, dad, "Chili RD2", 450, { yieldServings: 6 });
    siteRecipeFor(db, dad, "Tacos RD2", 400);
    seedPlan([
      meal({ id: "d2", name: "Chili RD2", recipeId: chili.id, status: "denied" }),
      meal({ id: "l2", day: "Thursday", slot: "lunch", name: "Leftover Chili RD2", recipeId: chili.id, leftoverOf: "d2", ingredients: [] }),
    ]);
    assert.equal((await call("POST", "/meals/d2/replace-denied")).status, 200);
    assert.equal(plan().meals.length, 1);
    assert.ok(!plan().meals[0].leftoverOf && plan().meals[0].recipeId !== chili.id);
    assert.equal(plan().meals[0].status, "proposed");
  });

  test("a meal for one person stays that person's", async () => {
    const chili = siteRecipeFor(db, dad, "Chili RD3", 450);
    siteRecipeFor(db, dad, "Tacos RD3", 400);
    seedPlan([meal({ id: "d3", name: "Chili RD3", recipeId: chili.id, status: "denied", audience: "individual", memberId: "sam" })]);
    assert.equal((await call("POST", "/meals/d3/replace-denied")).status, 200);
    assert.deepEqual([plan().meals[0].audience, plan().meals[0].memberId], ["individual", "sam"]);
  });

  test("a meal that isn't denied is refused (409) and nothing changes", async () => {
    const chili = siteRecipeFor(db, dad, "Chili RD4", 450);
    siteRecipeFor(db, dad, "Tacos RD4", 400);
    seedPlan([meal({ id: "d4", name: "Chili RD4", recipeId: chili.id, status: "proposed" })]);
    const r = await call("POST", "/meals/d4/replace-denied");
    assert.equal(r.status, 409);
    assert.match(r.body.error, /Only a denied meal/);
    assert.equal(plan().meals[0].id, "d4");
  });

  test("with no recipe that qualifies it says so (409) and leaves the denied meal alone", async () => {
    const only = siteRecipeFor(db, dad, "Only RD5", 450);
    seedPlan([meal({ id: "d5", name: "Only RD5", recipeId: only.id, status: "denied" })]);
    // Every other saved recipe in this test world is already refused or planned, so make them so.
    const others = (getScopedItems("recipes", dad) as any[]).filter((x) => x.id !== only.id);
    seedPlan([
      meal({ id: "d5", name: "Only RD5", recipeId: only.id, status: "denied" }),
      ...others.map((x, i) => meal({ id: `o${i}`, day: "Tuesday", slot: i % 2 ? "lunch" : "dinner", name: x.name, recipeId: x.id, status: "proposed" })),
    ]);
    const r = await call("POST", "/meals/d5/replace-denied");
    assert.equal(r.status, 409);
    assert.match(r.body.error, /No saved recipe fits/);
    assert.ok(plan().meals.some((m) => m.id === "d5" && m.status === "denied"));
  });

  test("an unknown meal is a 404", async () => {
    seedPlan([meal({ id: "x" })]);
    assert.equal((await call("POST", "/meals/nope/replace-denied")).status, 404);
  });
});
