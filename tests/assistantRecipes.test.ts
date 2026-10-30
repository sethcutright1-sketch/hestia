// The assistant saving an invented dish (merge plan decision 2): save_recipe stores the ingredient
// lines, links foods only where the match is clearly right, has the local model estimate the rest,
// and ends with a calorie figure and an honest "partly estimated" flag. The model is a fake; with no
// model at all (the default in tests) the save still works and says what is missing.

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { loadDb, cleanupDb } from "./helpers/testdb.ts";
import { addGeneric } from "./helpers/nutritionWorld.ts";
import { setRecipeModel, type RecipeModel } from "../nutrition/recipeAi.ts";
import { createFood } from "../nutrition/data/foods.ts";
import type { Db } from "../nutrition/data/sql.ts";

const loaded = await loadDb();
const { putScopedItem, getScopedItems, createUser } = loaded;
const db = loaded.db as unknown as Db;
const { buildTools } = await import("../assistant/registry.ts");

let alice: string;
let bob: string;

const call = (userId: string, name: string, args: Record<string, any> = {}): Promise<any> => {
  const tool = buildTools(userId).find((t) => t.name === name);
  assert.ok(tool, `no such tool: ${name}`);
  return tool.run(args);
};
const stored = () => (getScopedItems("recipes", alice) as any[]);

before(() => {
  alice = createUser("alice-ar", "not-a-real-hash", "Alice");
  bob = createUser("bob-ar", "not-a-real-hash", "Bob");
});
after(() => {
  setRecipeModel(undefined);
  cleanupDb();
});
beforeEach(() => {
  setRecipeModel(undefined);
  db.exec("DELETE FROM recipes; DELETE FROM nutrition_food_servings; DELETE FROM nutrition_foods");
});

const tracker = (id: string) => ({ id, displayName: "x", role: "admin" as const, profile: null });

/** A model that estimates 100 kcal per ingredient it is asked about, and records what it was asked. */
function estimator(per = 100) {
  const asked: string[][] = [];
  const model: RecipeModel = {
    async parseLines(texts) { return texts.map(() => null); },
    async estimateKcal(input) { asked.push(input.ingredients.map((i) => i.text)); return Object.fromEntries(input.ingredients.map((i) => [i.index, per])); },
  };
  return { model, asked };
}

describe("save_recipe works out the calories", () => {
  test("a clearly matching food is linked with its exact amount; the rest is estimated and the figure says so", async () => {
    createFood(db, tracker(alice), { name: "Chicken breast", basis: "per100g", nutrients: { kcal: 165 } });
    const { model, asked } = estimator(100);
    setRecipeModel(model);

    const res = await call(alice, "save_recipe", { name: "Chicken rice bowl", ingredients: ["200 g chicken breast", "1 cup cooked rice", "soy sauce"], servings: 2 });
    assert.equal(res.saved, "Chicken rice bowl");
    assert.deepEqual(res.ingredients, ["chicken breast", "cooked rice", "soy sauce"], "pantry matching sees names, not amounts");
    assert.deepEqual([res.servings, res.servingsAssumed], [2, undefined]);
    assert.equal(res.caloriesPerServing, 265, "(330 from the chicken + 2 x 100 estimated) / 2");
    assert.equal(res.caloriesPartlyEstimated, true);
    assert.deepEqual(asked, [["1 cup cooked rice", "soy sauce"]], "the linked line is not sent to the model");

    const r = stored()[0];
    assert.deepEqual(r.lines.map((l: any) => [l.text, !!l.foodId, l.estimated ?? false]), [
      ["200 g chicken breast", true, false], ["1 cup cooked rice", false, true], ["soy sauce", false, true],
    ]);
    assert.deepEqual([r.nutrition.origin, r.nutrition.complete, r.scope], ["mixed", false, "joint"]);
    assert.ok(r.foodId, "and the recipe is now a food, so search and the diary can use it");
  });

  test("the auto-link rule is conservative: an ambiguous catalogue match is estimated instead of guessed", async () => {
    addGeneric(db, "Rice, white, raw", 360);
    addGeneric(db, "Rice, white, cooked", 130);
    const { model } = estimator(150);
    setRecipeModel(model);
    const res = await call(alice, "save_recipe", { name: "Rice dish", ingredients: ["100 g rice"], servings: 1 });
    assert.equal(res.caloriesPerServing, 150);
    assert.equal(stored()[0].lines[0].foodId, undefined);
    assert.equal(stored()[0].lines[0].estimated, true);
  });

  test("without the amount nothing can be linked, so the model estimates the whole line", async () => {
    createFood(db, tracker(alice), { name: "Chicken", basis: "per100g", nutrients: { kcal: 165 } });
    const { model } = estimator(220);
    setRecipeModel(model);
    const res = await call(alice, "save_recipe", { name: "Plain chicken", ingredients: ["chicken"], servings: 1 });
    assert.equal(res.caloriesPerServing, 220);
    assert.equal(res.caloriesPartlyEstimated, true);
  });

  test("a fully linked dish is complete, with no estimate and no model call", async () => {
    createFood(db, tracker(alice), { name: "Chicken breast", basis: "per100g", nutrients: { kcal: 165 } });
    createFood(db, tracker(alice), { name: "Olive oil", basis: "per100g", nutrients: { kcal: 884 } });
    const { model, asked } = estimator();
    setRecipeModel(model);
    const res = await call(alice, "save_recipe", { name: "Pan chicken", ingredients: ["400 g chicken breast", "20 g olive oil", "salt to taste"], servings: 2 });
    assert.equal(res.caloriesPerServing, 418, "(660 + 176.8) / 2");
    assert.equal(res.caloriesPartlyEstimated, false);
    assert.deepEqual(asked, []);
  });

  test("no yield given: 4 is assumed and the result says so", async () => {
    createFood(db, tracker(alice), { name: "Chicken breast", basis: "per100g", nutrients: { kcal: 100 } });
    const res = await call(alice, "save_recipe", { name: "Quiet chicken", ingredients: ["400 g chicken breast"] });
    assert.deepEqual([res.servings, res.servingsAssumed, res.caloriesPerServing], [null, true, 100]);
    assert.equal(stored()[0].yieldAssumed, true);
  });

  test("with the local model off the dish still saves; only exact matches count and the result explains", async () => {
    // (HOUSEHOLD_LOCAL_MODEL=off in tests: getRecipeModel() is null.)
    const res = await call(alice, "save_recipe", { name: "Soup", ingredients: ["carrots", "stock"], servings: 3 });
    assert.equal(res.error, undefined);
    assert.equal(res.saved, "Soup");
    assert.equal(res.caloriesPerServing, null);
    assert.match(res.note, /model is off/);
    assert.deepEqual(stored()[0].ingredients, ["carrots", "stock"]);
  });

  test("a model that blows up does not lose the recipe", async () => {
    setRecipeModel({ async parseLines() { throw new Error("boom"); }, async estimateKcal() { throw new Error("Ollama is not reachable"); } });
    const res = await call(alice, "save_recipe", { name: "Stew", ingredients: ["beef", "a dozen potatoes"], servings: 4 });
    assert.equal(res.saved, "Stew");
    assert.equal(res.caloriesPerServing, null);
    assert.match(res.note, /Ollama is not reachable/);
    assert.equal(stored().length, 1);
  });

  test("saving the same dish again updates it: one row, estimates not asked for twice", async () => {
    const { model, asked } = estimator(100);
    setRecipeModel(model);
    await call(alice, "save_recipe", { name: "Mystery pie", ingredients: ["mystery meat"], servings: 2 });
    await call(alice, "save_recipe", { name: "mystery pie", ingredients: ["mystery meat"], servings: 2 });
    assert.equal(stored().length, 1);
    assert.equal(asked.length, 1, "the estimate is kept, not re-asked");
    await call(alice, "save_recipe", { name: "Mystery pie", ingredients: ["mystery meat", "gravy"], servings: 2 });
    assert.deepEqual(asked[1], ["gravy"], "only the new line is estimated");
    assert.equal(stored()[0].lines[0].estimatedKcal, 100);
  });

  test("the placeholder-name backstop and the empty-ingredients error are unchanged", async () => {
    assert.match((await call(alice, "save_recipe", { name: "Random Meal", ingredients: ["beef"] })).error, /not a dish/i);
    assert.match((await call(alice, "save_recipe", { name: "Stew", ingredients: [] })).error, /at least one ingredient/);
    assert.equal(stored().length, 0);
  });

  test("a silly servings value is ignored rather than trusted", async () => {
    for (const servings of [0, -3, 5000, "four", NaN]) {
      const res = await call(alice, "save_recipe", { name: `Dish for ${String(servings)}`, ingredients: ["chicken"], servings });
      assert.equal(res.servingsAssumed, true, String(servings));
    }
  });
});

describe("list_recipes treats \"everything\" words as no filter", () => {
  beforeEach(() => {
    putScopedItem("recipes", alice, { id: "r-a", name: "Chicken Stir Fry", ingredients: ["chicken", "peppers"], scope: "joint", createdBy: alice, createdAt: "x", updatedAt: "x" });
    putScopedItem("recipes", alice, { id: "r-b", name: "Veggie Tacos", ingredients: ["tortillas", "peppers"], scope: "joint", createdBy: alice, createdAt: "x", updatedAt: "x" });
    // Even a "list everything" call must not surface a personal recipe.
    putScopedItem("recipes", alice, { id: "r-p", name: "Secret loaf", ingredients: ["flour"], scope: "personal", createdBy: alice, createdAt: "x", updatedAt: "x" });
  });
  const names = (r: any) => r.map((x: any) => x.name).sort();

  test('"*", "all" and the other obvious all-words list every joint recipe, however they are cased or padded', async () => {
    const everything = names(await call(alice, "list_recipes"));
    assert.deepEqual(everything, ["Chicken Stir Fry", "Veggie Tacos"]);
    for (const query of ["*", "all", "ALL", "  Any ", "everything", "recipes", "saved", "all recipes", "saved recipes", "", "   "]) {
      const r = await call(alice, "list_recipes", { query });
      assert.ok(Array.isArray(r), `"${query}" should list everything as an array`);
      assert.deepEqual(names(r), everything, `query ${JSON.stringify(query)}`);
    }
  });

  test("a real search still filters, and a real dish word is not an all-word", async () => {
    assert.deepEqual(names(await call(alice, "list_recipes", { query: "chicken" })), ["Chicken Stir Fry"]);
    assert.deepEqual(names(await call(alice, "list_recipes", { query: "peppers" })), ["Chicken Stir Fry", "Veggie Tacos"]);
  });

  test("a search that matches nothing says so and hands over every recipe name", async () => {
    const r = await call(alice, "list_recipes", { query: "sushi" });
    assert.deepEqual(r.matches, []);
    assert.match(r.note, /No recipe matched "sushi"/);
    assert.match(r.note, /All saved recipes: Chicken Stir Fry, Veggie Tacos\./);
    assert.deepEqual(names(r.recipes), ["Chicken Stir Fry", "Veggie Tacos"]);
  });

  test("with no recipes at all a search is just empty", async () => {
    db.exec("DELETE FROM recipes");
    assert.deepEqual(await call(alice, "list_recipes", { query: "sushi" }), []);
    assert.deepEqual(await call(alice, "list_recipes", { query: "*" }), []);
  });
});

describe("the assistant and personal recipes", () => {
  test("list_recipes shows joint recipes with their calories, never a personal one; and save_recipe never overwrites one", async () => {
    putScopedItem("recipes", alice, { id: "r-priv", name: "Secret loaf", ingredients: ["flour"], scope: "personal", createdBy: alice, createdAt: "x", updatedAt: "x" });
    putScopedItem("recipes", alice, { id: "r-joint", name: "Family pie", ingredients: ["beef"], scope: "joint", createdBy: alice, createdAt: "x", updatedAt: "x",
      nutrition: { perServing: { kcal: 612.4, protein: 0, carbs: 0, fat: 0, satFat: 0, sugars: 0, fiber: 0, cholesterolMg: 0, sodiumMg: 0 }, origin: "calculated", complete: true } });
    const list = await call(alice, "list_recipes");
    assert.deepEqual(list, [{ name: "Family pie", ingredients: ["beef"], caloriesPerServing: 612 }]);
    // A search that matches nothing says so AND hands over the whole book (still no personal recipe in it), so "no
    // match" is not read as "no recipes". It used to be a bare [].
    const none = await call(alice, "list_recipes", { query: "flour" });
    assert.deepEqual(none.matches, []);
    assert.match(none.note, /No recipe matched "flour".*All saved recipes: Family pie\./);
    assert.deepEqual(none.recipes, list);
    assert.doesNotMatch(JSON.stringify(none), /Secret loaf/);

    await call(alice, "save_recipe", { name: "Secret loaf", ingredients: ["rye"] });
    assert.deepEqual((getScopedItems("recipes", alice) as any[]).find((r) => r.id === "r-priv").ingredients, ["flour"], "the personal recipe is untouched");
    assert.equal((getScopedItems("recipes", alice) as any[]).filter((r) => r.name === "Secret loaf").length, 2, "a new joint one was made beside it");
    assert.deepEqual((getScopedItems("recipes", bob) as any[]).map((r) => r.name).sort(), ["Family pie", "Secret loaf"].sort());
  });
});

// ---- the recipes overhaul: tags, times, notes and per-person marks reach the tools -----------------

describe("the assistant and the overhaul's new recipe fields", () => {
  const add = (over: Record<string, unknown>) => {
    const id = `recipe-${Math.random().toString(16).slice(2, 10)}`;
    const doc = { id, name: "Chili", ingredients: ["beef", "beans"], scope: "joint", createdBy: alice, createdAt: "x", updatedAt: "x", ...over };
    db.prepare("INSERT INTO recipes (item_id, owner_user_id, data) VALUES (?, ?, ?)").run(id, doc.scope === "personal" ? alice : null, JSON.stringify(doc));
    return doc as any;
  };
  const mark = (userId: string, recipeId: string, favorite: number, rating: number | null) =>
    db.prepare("INSERT INTO nutrition_recipe_marks (recipe_id, user_id, favorite, rating, updated_at) VALUES (?, ?, ?, ?, 'x')").run(recipeId, userId, favorite, rating);
  beforeEach(() => db.exec("DELETE FROM nutrition_recipe_marks; DELETE FROM nutrition_recipe_photos"));

  test("list_recipes shows tags and the asker's favourite only when there is one, and a query matches tags", async () => {
    const chili = add({ name: "Chili", tags: ["quick", "crockpot"] });
    add({ name: "Soup", ingredients: ["lentils"] });
    mark(alice, chili.id, 1, 5);
    const list = await call(alice, "list_recipes");
    const c = list.find((r: any) => r.name === "Chili");
    const s = list.find((r: any) => r.name === "Soup");
    assert.deepEqual([c.tags, c.favorite], [["quick", "crockpot"], true]);
    assert.equal("tags" in JSON.parse(JSON.stringify(s)), false, "a recipe with no tags carries no tags field");
    assert.equal("favorite" in JSON.parse(JSON.stringify(s)), false);
    const byTag = await call(alice, "list_recipes", { query: "crockpot" });
    assert.deepEqual(byTag.map((r: any) => r.name), ["Chili"]);
  });

  test("another login's favourites and ratings are never shown to the asker", async () => {
    const chili = add({ name: "Chili" });
    mark(bob, chili.id, 1, 5);
    const list = await call(alice, "list_recipes");
    assert.equal(JSON.parse(JSON.stringify(list[0])).favorite, undefined);
    const full = JSON.parse(JSON.stringify(await call(alice, "get_recipe", { name: "Chili" })));
    assert.equal(full.yourRating, undefined);
    assert.equal(full.yourFavorite, undefined);
    const bobs = JSON.parse(JSON.stringify(await call(bob, "get_recipe", { name: "Chili" })));
    assert.deepEqual([bobs.yourRating, bobs.yourFavorite], [5, true]);
  });

  test("get_recipe gives times, tags and notes when the recipe has them, and nothing extra when it doesn't", async () => {
    add({ name: "Chili", prepMinutes: 15, cookMinutes: 90, tags: ["quick"], notes: "Less salt." });
    add({ name: "Plain", ingredients: ["x"] });
    const full = JSON.parse(JSON.stringify(await call(alice, "get_recipe", { name: "Chili" })));
    assert.deepEqual([full.prepMinutes, full.cookMinutes, full.tags, full.notes], [15, 90, ["quick"], "Less salt."]);
    const plain = JSON.parse(JSON.stringify(await call(alice, "get_recipe", { name: "Plain" })));
    for (const k of ["prepMinutes", "cookMinutes", "tags", "notes", "yourRating", "yourFavorite"]) assert.equal(k in plain, false, k);
  });

  test("a photo is never exposed: no tool returns a photo field or its bytes", async () => {
    const chili = add({ name: "Chili", photoAt: "2026-10-28T00:00:00Z" });
    db.prepare("INSERT INTO nutrition_recipe_photos (recipe_id, mime, bytes, width, height, updated_at) VALUES (?, 'image/png', x'89504e47', 1, 1, 'x')").run(chili.id);
    const text = JSON.stringify([await call(alice, "list_recipes"), await call(alice, "get_recipe", { name: "Chili" })]);
    assert.ok(!/photo/i.test(text), text);
  });

  test("save_recipe can add tags, merges them with the recipe's own, and never touches a rating", async () => {
    const chili = add({ name: "Chili", tags: ["crockpot"] });
    mark(alice, chili.id, 1, 4);
    const res = await call(alice, "save_recipe", { name: "Chili", ingredients: ["beef", "beans"], tags: ["Quick", "crockpot"] });
    assert.equal(res.saved, "Chili");
    const row = stored().find((r) => r.id === chili.id);
    assert.deepEqual(row.tags, ["crockpot", "quick"]);
    const kept = db.prepare("SELECT favorite, rating FROM nutrition_recipe_marks WHERE recipe_id = ?").get(chili.id) as any;
    assert.deepEqual([kept.favorite, kept.rating], [1, 4]);
  });

  test("a personal recipe's tags and notes stay out of the assistant's reach", async () => {
    add({ name: "Secret sauce", scope: "personal", tags: ["private"], notes: "grandma's" });
    assert.deepEqual(await call(alice, "list_recipes"), []);
    const r = await call(alice, "get_recipe", { name: "Secret sauce" });
    assert.ok(r.error, "not found as far as the assistant is concerned");
  });
});
