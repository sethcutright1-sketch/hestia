// PUT /api/mealplan/meals/:id with a new day and/or meal (phase 5c's Move control): the cell must be free for that
// audience, a leftover stays after its original, and the original stays before its leftovers. Diaries follow a
// legal move (phase 4); a refused move changes nothing.
//   dad  admin    bea  parent
// The week is 2026-09-07 (a Monday).

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { loadDb, cleanupDb } from "./helpers/testdb.ts";
import { callRoute } from "./helpers/router.ts";
import { mealEntries, siteRecipeFor } from "./helpers/planWorld.ts";
import { setRecipeModel } from "../nutrition/recipeAi.ts";

const loaded = await loadDb();
const { createUser, putScopedItem, getScopedItems, deleteScopedItem, newId } = loaded;
const db = loaded.db as any;
const { mealPlanRoutes, buildMealPlan, currentPlan } = await import("../routes/mealplan.ts");

let dad: string, bea: string;
const call = (who: string, method: string, url: string, body?: unknown) => callRoute(mealPlanRoutes, method, url, { session: { userId: who }, body });
const WEEK = "2026-09-07";
const meal = (o: Record<string, any> = {}) => ({
  id: newId("meal"), day: "Monday", slot: "dinner", name: "Chili", ingredients: ["beans"], status: "proposed", audience: "family", ...o,
});
function seedPlan(meals: any[]) {
  for (const old of getScopedItems("meal_plans", dad) as any[]) deleteScopedItem("meal_plans", dad, old.id);
  putScopedItem("meal_plans", dad, buildMealPlan(dad, WEEK, meals as any));
}
const where = (id: string) => { const m = currentPlan(dad)!.meals.find((x) => x.id === id)!; return `${m.day} ${m.slot}`; };

before(() => {
  dad = createUser("dad-mv", "x", "Dad", "admin");
  bea = createUser("bea-mv", "x", "Bea", "parent");
});
after(() => {
  setRecipeModel(undefined);
  cleanupDb();
});
beforeEach(() => setRecipeModel(undefined));

describe("moving a meal", () => {
  test("onto a free cell it moves, and the planned diary entries follow", async () => {
    const r = siteRecipeFor(db, dad, "Chili M1", 450);
    seedPlan([meal({ id: "mv-1", recipeId: r.id, status: "approved" })]);
    await call(dad, "PUT", "/meals/mv-1", { status: "proposed" });
    const up = await call(dad, "PUT", "/meals/mv-1", { status: "approved" });
    assert.equal(up.status, 200);
    const moved = await call(bea, "PUT", "/meals/mv-1", { day: "Friday", slot: "lunch" });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal(where("mv-1"), "Friday lunch");
    assert.ok(mealEntries(db, "mv-1").every((e) => e.local_date === "2026-09-11" && e.slot_key === "lunch"));
    // Saying where it already is changes nothing and is not an error.
    assert.equal((await call(bea, "PUT", "/meals/mv-1", { day: "Friday", slot: "lunch" })).status, 200);
  });

  test("onto a cell that already has a meal for the same audience is refused (409) and nothing changes", async () => {
    seedPlan([meal({ id: "a", day: "Monday", slot: "dinner" }), meal({ id: "b", day: "Tuesday", slot: "dinner" })]);
    const r = await call(dad, "PUT", "/meals/a", { day: "Tuesday" });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /Tuesday dinner already has a meal/);
    assert.equal(where("a"), "Monday dinner");
    // A person's own meal can share a cell with the family one.
    seedPlan([meal({ id: "fam" }), meal({ id: "sam", day: "Tuesday", slot: "dinner", audience: "individual", memberId: "sam" })]);
    assert.equal((await call(dad, "PUT", "/meals/sam", { day: "Monday" })).status, 200);
    assert.equal(where("sam"), "Monday dinner");
  });

  test("a bad day or meal is a 400 and an unknown meal a 404, with nothing changed", async () => {
    seedPlan([meal({ id: "x" })]);
    assert.equal((await call(dad, "PUT", "/meals/x", { day: "Funday" })).status, 400);
    assert.equal((await call(dad, "PUT", "/meals/x", { slot: "second-breakfast" })).status, 400);
    assert.equal((await call(dad, "PUT", "/meals/nope", { day: "Friday" })).status, 404);
    assert.equal(where("x"), "Monday dinner");
  });

  test("a leftover can move to a later free lunch or dinner only; the original can't move to or past it", async () => {
    const r = siteRecipeFor(db, dad, "Big pot M2", 400, { yieldServings: 6, ingredients: ["beans"] });
    seedPlan([
      meal({ id: "pot", day: "Monday", slot: "dinner", recipeId: r.id }),
      meal({ id: "left", day: "Wednesday", slot: "lunch", recipeId: r.id, leftoverOf: "pot", ingredients: [], name: "Leftover Big pot" }),
    ]);
    const earlier = await call(dad, "PUT", "/meals/left", { day: "Monday", slot: "lunch" });
    assert.equal(earlier.status, 409);
    assert.match(earlier.body.error, /later meal than the one they come from \(Monday dinner\)/);
    assert.equal((await call(dad, "PUT", "/meals/left", { slot: "breakfast" })).status, 409, "leftovers go on a lunch or dinner");
    assert.equal((await call(dad, "PUT", "/meals/left", { day: "Thursday", slot: "dinner" })).status, 200);
    assert.equal(where("left"), "Thursday dinner");

    const past = await call(dad, "PUT", "/meals/pot", { day: "Friday" });
    assert.equal(past.status, 409);
    assert.match(past.body.error, /leftovers on Thursday dinner/);
    assert.equal((await call(dad, "PUT", "/meals/pot", { day: "Wednesday", slot: "dinner" })).status, 200);
    assert.equal(where("pot"), "Wednesday dinner");
  });
});
