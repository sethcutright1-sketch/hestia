// The assistant's replace_denied_meal tool: the same refill as the Meal Plan screen's "Suggest replacement" button
// (routes/mealplan.ts replaceDeniedMeal), reached by the id get_meal_plan gives. The ranking rules are covered in
// tests/mealRefill.test.ts and the route in tests/mealplanReplaceDenied.test.ts; here: the tool's own behaviour.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import { loadDb, cleanupDb } from "./helpers/testdb.ts";
import { siteRecipeFor } from "./helpers/planWorld.ts";

const loaded = await loadDb();
const { createUser, putScopedItem, getScopedItems, deleteScopedItem, newId } = loaded;
const db = loaded.db as any;
const { buildTools } = await import("../assistant/registry.ts");
const { buildMealPlan, currentPlan } = await import("../routes/mealplan.ts");

let alice: string;
after(cleanupDb);
before(() => { alice = createUser("alice-rd-tool", "not-a-real-hash", "Alice"); });

const callAs = (name: string, args: Record<string, any>): Promise<any> => {
  const tool = buildTools(alice).find((t) => t.name === name);
  assert.ok(tool, name);
  return tool.run(args);
};
const meal = (o: Record<string, any> = {}) => ({
  id: newId("meal"), day: "Monday", slot: "dinner", name: "Chili", ingredients: ["beans"], status: "proposed", audience: "family", ...o,
});
function seedPlan(meals: any[]) {
  for (const old of getScopedItems("meal_plans", alice) as any[]) deleteScopedItem("meal_plans", alice, old.id);
  putScopedItem("meal_plans", alice, buildMealPlan(alice, "2026-09-07", meals as any));
}

describe("replace_denied_meal", () => {
  test("is offered, and marked as one that changes data", () => {
    const tool = buildTools(alice).find((t) => t.name === "replace_denied_meal");
    assert.ok(tool);
    assert.equal(tool.mutates, true);
  });

  test("swaps a denied meal for a proposed one from another recipe and says what happened", async () => {
    const chili = siteRecipeFor(db, alice, "Chili RT1", 450, { ingredients: ["beans"] });
    siteRecipeFor(db, alice, "Tacos RT1", 400, { ingredients: ["tortillas"] });
    seedPlan([meal({ id: "t1", day: "Friday", slot: "lunch", name: "Chili RT1", recipeId: chili.id, status: "denied" })]);
    const r = await callAs("replace_denied_meal", { id: "t1" });
    assert.equal(r.error, undefined, JSON.stringify(r));
    assert.equal(r.replaced, "Chili RT1");
    assert.deepEqual([r.day, r.slot, r.status], ["Friday", "lunch", "proposed"]);
    assert.notEqual(r.now, "Chili RT1");
    const plan = currentPlan(alice)!;
    assert.equal(plan.meals.length, 1);
    assert.equal(plan.meals[0].name, r.now);
    assert.ok(Array.isArray(r.missingIngredients), "the usual plan summary comes back");
  });

  test("a meal that is not denied is refused and nothing changes", async () => {
    seedPlan([meal({ id: "t2", status: "proposed" })]);
    const r = await callAs("replace_denied_meal", { id: "t2" });
    assert.match(r.error, /Only a denied meal/);
    assert.equal(r.nothingChanged, true);
    assert.equal(currentPlan(alice)!.meals[0].id, "t2");
  });

  test("an unknown or missing id is an error that points at get_meal_plan", async () => {
    seedPlan([meal({ id: "t3" })]);
    assert.match((await callAs("replace_denied_meal", { id: "nope" })).error, /get_meal_plan/);
    assert.match((await callAs("replace_denied_meal", {})).error, /id is required/);
  });

  test("finds the meal in whichever week's plan holds it", async () => {
    const chili = siteRecipeFor(db, alice, "Chili RT4", 450);
    siteRecipeFor(db, alice, "Tacos RT4", 400);
    seedPlan([meal({ id: "t4", name: "Chili RT4", recipeId: chili.id, status: "denied" })]);
    // The plan's week (2026-09-07) is not this week, and no week argument is needed.
    assert.equal((await callAs("replace_denied_meal", { id: "t4" })).error, undefined);
  });
});
