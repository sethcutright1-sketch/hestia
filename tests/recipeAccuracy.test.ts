// Calorie accuracy without a model (nutrition/data/recipes.ts): the household's "usual food" for an ingredient breaks a tie the
// name match alone can't, and "Improve calories" links every recipe's clear matches in one go. Nothing here asks a model
// (calculateFromLines is called with none), so no test needs Ollama.

import { test, after } from "node:test";
import assert from "node:assert/strict";

import { cleanupDb } from "./helpers/testdb.ts";
import { customFood, newWorld, type World } from "./helpers/nutritionWorld.ts";
import { createFood } from "../nutrition/data/foods.ts";
import { calculateFromLines, householdFoodHistory, proposeMatches, recalculateAllRecipes, requireRecipe, saveRecipe } from "../nutrition/data/recipes.ts";
import type { Line, RecipeDoc } from "../nutrition/recipeModel.ts";

after(cleanupDb);

let counter = 0;
function doc(w: World, over: Partial<RecipeDoc> = {}): RecipeDoc {
  const now = "2026-03-01T00:00:00.000Z";
  return { id: `recipe-acc-${++counter}`, name: `Dish ${counter}`, ingredients: [], scope: "joint", createdBy: w.ids.ann, createdAt: now, updatedAt: now, yieldServings: 2, ...over };
}
const line = (text: string, over: Partial<Line> = {}): Line => ({ text, pantryName: text, ...over });

/** Two foods that both read as an exact match for "egg": the name alone can't pick one. */
function eggs(w: World) {
  const large = createFood(w.db, w.ann, customFood("Egg, large", 70));
  const small = createFood(w.db, w.ann, customFood("Egg, small", 50));
  return { large, small };
}

test("with two equally good foods and no history, an ingredient stays unlinked", async (t) => {
  const w = await newWorld(t);
  eggs(w);
  const recipe = saveRecipe(w.db, w.ids.ann, doc(w, { lines: [line("2 egg", { pantryName: "egg" })] }));
  const out = await calculateFromLines(w.db, w.ids.ann, recipe.id, { autoLink: true, model: null });
  assert.deepEqual(out.report.linked, []);
  assert.equal(out.recipe.lines![0].foodId, undefined);
});

test("the food the household's other recipes already use for an ingredient breaks the tie", async (t) => {
  const w = await newWorld(t);
  const { large } = eggs(w);
  saveRecipe(w.db, w.ids.ann, doc(w, { lines: [line("1 egg", { pantryName: "egg", foodId: large.id, quantity: 1 })] }));
  const recipe = saveRecipe(w.db, w.ids.ann, doc(w, { lines: [line("2 eggs", { pantryName: "eggs" })] }));
  const out = await calculateFromLines(w.db, w.ids.ann, recipe.id, { autoLink: true, model: null });
  assert.deepEqual(out.report.linked, [0]);
  assert.equal(out.recipe.lines![0].foodId, large.id);
  assert.equal(out.recipe.nutrition?.perServing.kcal, 70, "2 eggs of 70 kcal, 2 servings");
});

test("the match screen suggests the usual food too, and lists it among the candidates", async (t) => {
  const w = await newWorld(t);
  const { large } = eggs(w);
  saveRecipe(w.db, w.ids.ann, doc(w, { lines: [line("1 egg", { pantryName: "egg", foodId: large.id, quantity: 1 })] }));
  const recipe = saveRecipe(w.db, w.ids.ann, doc(w, { lines: [line("3 eggs", { pantryName: "eggs" })] }));
  const { proposals } = await proposeMatches(w.db, w.ids.ann, requireRecipe(w.db, w.ids.ann, recipe.id).doc, null);
  assert.equal(proposals[0].suggestedFoodId, large.id);
  assert.ok(proposals[0].candidates.some((c) => c.foodId === large.id));
});

test("an even split between two foods means there is no usual food", async (t) => {
  const w = await newWorld(t);
  const { large, small } = eggs(w);
  saveRecipe(w.db, w.ids.ann, doc(w, { lines: [line("1 egg", { pantryName: "egg", foodId: large.id, quantity: 1 })] }));
  saveRecipe(w.db, w.ids.ann, doc(w, { lines: [line("1 egg", { pantryName: "egg", foodId: small.id, quantity: 1 })] }));
  assert.equal(householdFoodHistory(w.db, w.ids.ann).get("egg"), undefined);
  const recipe = saveRecipe(w.db, w.ids.ann, doc(w, { lines: [line("2 eggs", { pantryName: "eggs" })] }));
  const out = await calculateFromLines(w.db, w.ids.ann, recipe.id, { autoLink: true, model: null });
  assert.deepEqual(out.report.linked, []);
});

test("a personal food someone else linked is never the usual food for a shared recipe", async (t) => {
  const w = await newWorld(t);
  eggs(w);
  const secret = createFood(w.db, w.ben, customFood("Egg, ben's", 90, { scope: "personal" }));
  // ben's own personal recipe uses his personal egg; ann can't see that recipe, and a joint recipe can't use his food anyway.
  saveRecipe(w.db, w.ids.ben, doc(w, { scope: "personal", createdBy: w.ids.ben, lines: [line("1 egg", { pantryName: "egg", foodId: secret.id, quantity: 1 })] }));
  assert.equal(householdFoodHistory(w.db, w.ids.ann).get("egg"), undefined);
  const recipe = saveRecipe(w.db, w.ids.ann, doc(w, { lines: [line("2 eggs", { pantryName: "eggs" })] }));
  const out = await calculateFromLines(w.db, w.ids.ann, recipe.id, { autoLink: true, model: null });
  assert.deepEqual(out.report.linked, []);
});

test("Improve calories links what it can in every recipe and reports before and after", async (t) => {
  const w = await newWorld(t);
  const { large } = eggs(w);
  const done = saveRecipe(w.db, w.ids.ann, doc(w, { lines: [line("1 egg", { pantryName: "egg", foodId: large.id, quantity: 1 })] }));
  assert.equal(done.nutrition?.complete, true);
  saveRecipe(w.db, w.ids.ann, doc(w, { lines: [line("2 eggs", { pantryName: "eggs" })] }));
  saveRecipe(w.db, w.ids.ann, doc(w, { lines: [line("1 cup mystery stuff", { pantryName: "mystery stuff" })] }));
  const out = await recalculateAllRecipes(w.db, w.ids.ann);
  assert.deepEqual(out, { recipes: 3, before: 2, after: 1, improved: 1 });
});

test("Improve calories never asks a model and never guesses a figure", async (t) => {
  const w = await newWorld(t);
  saveRecipe(w.db, w.ids.ann, doc(w, { lines: [line("1 cup mystery stuff", { pantryName: "mystery stuff" })] }));
  await recalculateAllRecipes(w.db, w.ids.ann);
  const stored = requireRecipe(w.db, w.ids.ann, "recipe-acc-" + counter).doc;
  assert.equal(stored.lines![0].estimated, undefined);
  assert.equal(stored.nutrition?.complete ?? false, false);
});
