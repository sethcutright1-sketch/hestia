// nutrition/data/recipes.ts against a private household: the recipe book's JSON documents, the
// read-only food each recipe with calories becomes, joint/personal rules, "calculate from lines"
// (with a fake model -- no test reaches a real Ollama), and the guarantee that editing a recipe
// never rewrites what was already logged.

import { test, after } from "node:test";
import assert from "node:assert/strict";

import { cleanupDb } from "./helpers/testdb.ts";
import { addGeneric, customFood, newWorld, TODAY, type World } from "./helpers/nutritionWorld.ts";
import { addEntry } from "../nutrition/data/diary.ts";
import { createFood, getFood, searchFoods, servingsOf, updateFood } from "../nutrition/data/foods.ts";
import {
  calculateFromLines, deleteRecipeDoc, getRecipeRecord, listRecipeDocs, parseLinesInput, proposeMatches,
  refreshRecipesUsingFood, requireRecipe, saveRecipe,
} from "../nutrition/data/recipes.ts";
import { NutritionError } from "../nutrition/data/errors.ts";
import type { RecipeModel } from "../nutrition/recipeAi.ts";
import type { Line, RecipeDoc } from "../nutrition/recipeModel.ts";
import { all, get, run } from "../nutrition/data/sql.ts";

after(cleanupDb);

let counter = 0;
function doc(w: World, over: Partial<RecipeDoc> = {}): RecipeDoc {
  const now = "2026-03-01T00:00:00.000Z";
  return { id: `recipe-${++counter}`, name: `Dish ${counter}`, ingredients: [], scope: "joint", createdBy: w.ids.ann, createdAt: now, updatedAt: now, ...over };
}
const line = (text: string, over: Partial<Line> = {}): Line => ({ text, pantryName: text, ...over });
const kcalOf = (d: RecipeDoc) => d.nutrition?.perServing.kcal;
const foodRows = (w: World, recipeId: string) => all<any>(w.db, "SELECT * FROM nutrition_foods WHERE recipe_id = ?", recipeId);

/** A fake model that answers from a script and records what it was asked. */
function fakeModel(over: Partial<RecipeModel> = {}): RecipeModel & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async parseLines(texts) { asked.push(`parse:${texts.join("|")}`); return texts.map(() => null); },
    async estimateKcal(input) { asked.push(`estimate:${input.ingredients.map((i) => i.text).join("|")}`); return {}; },
    ...over,
  };
}

/** Oats (per 100 g, with a "1 cup" 80 g serving) and a bar (per serving, 210 kcal). */
function pantry(w: World) {
  const oats = createFood(w.db, w.ann, { name: "Rolled oats", basis: "per100g", nutrients: { kcal: 380, protein: 13 }, servings: [{ label: "100 g", grams: 100, isDefault: true }, { label: "1 cup", grams: 80 }] });
  const bar = createFood(w.db, w.ann, customFood("Protein bar", 210));
  return { oats, bar, cup: servingsOf(w.db, oats.id).find((s) => s.label === "1 cup")! };
}

test("a recipe with linked lines gets a calorie figure and a read-only per-serving food; ingredients come from the lines", async (t) => {
  const w = await newWorld(t);
  const { oats, bar, cup } = pantry(w);
  const saved = saveRecipe(w.db, w.ids.ann, doc(w, {
    name: "Oat bake", yieldServings: 4,
    lines: [
      line("2 cups rolled oats", { pantryName: "rolled oats", foodId: oats.id, quantity: 2, servingId: cup.id }),
      line("2 protein bars", { pantryName: "protein bars", foodId: bar.id, quantity: 2 }),
      line("salt", {}),
    ],
  }));
  // 2 cups = 160 g = 608 kcal; 2 bars = 420; total 1028; / 4 = 257
  assert.equal(kcalOf(saved), 257);
  assert.deepEqual([saved.nutrition?.origin, saved.nutrition?.complete], ["calculated", true]);
  assert.deepEqual(saved.ingredients, ["rolled oats", "protein bars", "salt"]);

  const food = getFood(w.db, saved.foodId!)!;
  assert.deepEqual([food.source, food.basis, food.recipe_id, food.name, food.owner_user_id], ["recipe", "per_serving", saved.id, "Oat bake", null]);
  assert.equal(JSON.parse(food.nutrients).kcal, 257);
  assert.deepEqual(servingsOf(w.db, food.id).map((s) => [s.label, s.grams, s.is_default]), [["1 serving", null, 1]]);
  assert.equal(foodRows(w, saved.id).length, 1);
});

test("a total cooked weight puts a gram weight on the one serving; the same food and serving rows are updated, never duplicated", async (t) => {
  const w = await newWorld(t);
  const { bar } = pantry(w);
  const first = saveRecipe(w.db, w.ids.ann, doc(w, { name: "Chili", yieldServings: 4, lines: [line("4 bars", { pantryName: "bars", foodId: bar.id, quantity: 4 })] }));
  const servingId = servingsOf(w.db, first.foodId!)[0].id;
  assert.equal(servingsOf(w.db, first.foodId!)[0].grams, null);

  const second = saveRecipe(w.db, w.ids.ann, { ...first, totalCookedG: 1000, servingLabel: "bowl", yieldServings: 5 });
  assert.equal(second.foodId, first.foodId);
  const servings = servingsOf(w.db, second.foodId!);
  assert.deepEqual(servings.map((s) => [s.id, s.label, s.grams]), [[servingId, "1 bowl", 200]]);
  assert.equal(kcalOf(second), 168, "840 kcal / 5");
  assert.equal(JSON.parse(getFood(w.db, second.foodId!)!.nutrients).kcal, 168);
  assert.equal(foodRows(w, first.id).length, 1);
});

test("the recipe's food is found by search and logged like any food; editing the recipe afterwards leaves the diary entry alone", async (t) => {
  const w = await newWorld(t);
  const { bar } = pantry(w);
  const saved = saveRecipe(w.db, w.ids.ann, doc(w, { name: "Lasagna bake", yieldServings: 2, lines: [line("4 bars", { pantryName: "bars", foodId: bar.id, quantity: 4 })] }));
  assert.deepEqual(searchFoods(w.db, w.ids.ben, "lasagna", 5).map((f) => f.id), [saved.foodId], "the other login finds a joint recipe's food");

  const { row } = addEntry(w.db, w.ann, TODAY, TODAY, { slot: "dinner", foodId: saved.foodId, quantity: 2 });
  assert.equal(JSON.parse(row.nutrients_total).kcal, 840);

  saveRecipe(w.db, w.ids.ann, { ...saved, name: "Lasagna", yieldServings: 8 });
  const entry = get<any>(w.db, "SELECT * FROM nutrition_diary_entries WHERE id = ?", row.id)!;
  assert.equal(JSON.parse(entry.nutrients_total).kcal, 840, "a logged entry is a snapshot");
  assert.equal(entry.name_snapshot, "Lasagna bake");
  assert.equal(JSON.parse(getFood(w.db, saved.foodId!)!.nutrients).kcal, 105, "the food follows the recipe");
});

test("a recipe with no lines, or no calories, has no food: existing recipes carry on unchanged", async (t) => {
  const w = await newWorld(t);
  const legacy = saveRecipe(w.db, w.ids.ann, doc(w, { name: "Old stew", ingredients: ["beef", "carrots"] }));
  assert.equal(legacy.nutrition, undefined);
  assert.equal(legacy.foodId, undefined);
  assert.deepEqual(legacy.ingredients, ["beef", "carrots"]);
  assert.deepEqual(foodRows(w, legacy.id), []);

  const unlinked = saveRecipe(w.db, w.ids.ann, doc(w, { lines: [line("beef"), line("carrots")] }));
  assert.equal(unlinked.nutrition, undefined, "lines but no figure yet");
  assert.deepEqual(foodRows(w, unlinked.id), []);
});

test("an incomplete figure says so; linking the rest completes it", async (t) => {
  const w = await newWorld(t);
  const { bar } = pantry(w);
  const part = saveRecipe(w.db, w.ids.ann, doc(w, { yieldServings: 2, lines: [line("1 bar", { pantryName: "bar", foodId: bar.id, quantity: 1 }), line("mystery sauce")] }));
  assert.deepEqual([part.nutrition?.complete, kcalOf(part)], [false, 105]);
  const done = saveRecipe(w.db, w.ids.ann, { ...part, lines: [part.lines![0], { ...part.lines![1], estimated: true, estimatedKcal: 100 }] });
  assert.deepEqual([done.nutrition?.origin, done.nutrition?.complete, kcalOf(done)], ["mixed", false, 155]);
});

test("a site-only figure becomes the recipe's calories and a food; it is replaced by the calculated figure but remembered beside it", async (t) => {
  const w = await newWorld(t);
  const { bar } = pantry(w);
  const site = saveRecipe(w.db, w.ids.ann, doc(w, {
    name: "Site curry", yieldServings: 4, lines: [line("1 bar", { pantryName: "bar" })],
    nutrition: { perServing: { kcal: 320, protein: 18, carbs: 0, fat: 0, satFat: 0, sugars: 0, fiber: 0, cholesterolMg: 0, sodiumMg: 0 }, siteKcalPerServing: 320, origin: "site", complete: true },
  }));
  assert.deepEqual([site.nutrition?.origin, kcalOf(site), site.nutrition?.perServing.protein], ["site", 320, 18]);
  assert.equal(JSON.parse(getFood(w.db, site.foodId!)!.nutrients).kcal, 320);

  const linked = saveRecipe(w.db, w.ids.ann, { ...site, lines: [line("2 bars", { pantryName: "bar", foodId: bar.id, quantity: 2 })] });
  assert.deepEqual([linked.nutrition?.origin, kcalOf(linked), linked.nutrition?.siteKcalPerServing], ["calculated", 105, 320]);

  const unlinkedAgain = saveRecipe(w.db, w.ids.ann, { ...linked, lines: [line("2 bars", { pantryName: "bar" })] });
  assert.deepEqual([unlinkedAgain.nutrition?.origin, kcalOf(unlinkedAgain)], ["site", 320], "falls back to the site's figure");
});

test("joint recipes follow the food rules: a personal food can't be newly linked, but a link the recipe already had is left alone", async (t) => {
  const w = await newWorld(t);
  const mine = createFood(w.db, w.ann, customFood("My secret shake", 300, { scope: "personal" }));
  const shared = createFood(w.db, w.ann, customFood("Shared bar", 200));

  assert.throws(() => saveRecipe(w.db, w.ids.ann, doc(w, { lines: [line("shake", { foodId: mine.id, quantity: 1 })] })),
    (e: any) => e instanceof NutritionError && e.status === 400 && /personal food/.test(e.message) && /recipe/.test(e.message));
  assert.deepEqual(all(w.db, "SELECT item_id FROM recipes"), [], "nothing was written");

  const personal = saveRecipe(w.db, w.ids.ann, doc(w, { scope: "personal", yieldServings: 1, lines: [line("shake", { foodId: mine.id, quantity: 1 }), line("bar", { foodId: shared.id, quantity: 1 })] }));
  assert.equal(kcalOf(personal), 500);
  assert.throws(() => saveRecipe(w.db, w.ids.ann, { ...personal, scope: "joint" }), /personal food/, "can't be shared while it holds one");
  assert.equal(getRecipeRecord(w.db, personal.id)!.doc.scope, "personal");

  // Sharing after dropping the personal food works; and a joint recipe keeps links it already had.
  const shareable = saveRecipe(w.db, w.ids.ann, { ...personal, scope: "joint", lines: [personal.lines![1]] });
  assert.equal(getRecipeRecord(w.db, shareable.id)!.ownerUserId, null);
});

test("a personal recipe and its food belong to their owner alone", async (t) => {
  const w = await newWorld(t);
  const { bar } = pantry(w);
  const secret = saveRecipe(w.db, w.ids.ann, doc(w, { name: "Ann's secret loaf", scope: "personal", yieldServings: 1, lines: [line("bar", { foodId: bar.id, quantity: 1 })] }));
  assert.equal(getRecipeRecord(w.db, secret.id)!.ownerUserId, w.ids.ann);
  assert.equal(getFood(w.db, secret.foodId!)!.owner_user_id, w.ids.ann);

  assert.deepEqual(listRecipeDocs(w.db, w.ids.ann).map((r) => r.name), ["Ann's secret loaf"]);
  assert.deepEqual(listRecipeDocs(w.db, w.ids.ben), []);
  assert.throws(() => requireRecipe(w.db, w.ids.ben, secret.id), (e: any) => e.status === 404);
  assert.deepEqual(searchFoods(w.db, w.ids.ben, "loaf", 5), []);
  assert.deepEqual(searchFoods(w.db, w.ids.ann, "loaf", 5).map((f) => f.id), [secret.foodId]);

  // Ben can neither overwrite nor delete it.
  assert.throws(() => saveRecipe(w.db, w.ids.ben, { ...secret, name: "Taken" }), (e: any) => e.status === 403);
  assert.equal(deleteRecipeDoc(w.db, w.ids.ben, secret.id), false);
  assert.equal(getRecipeRecord(w.db, secret.id)!.doc.name, "Ann's secret loaf");
  assert.equal(getFood(w.db, secret.foodId!)!.deleted_at, null);
});

test("a joint recipe can be edited by either login", async (t) => {
  const w = await newWorld(t);
  const { bar } = pantry(w);
  const joint = saveRecipe(w.db, w.ids.ann, doc(w, { yieldServings: 1, lines: [line("bar", { foodId: bar.id, quantity: 1 })] }));
  const edited = saveRecipe(w.db, w.ids.ben, { ...joint, yieldServings: 2 });
  assert.equal(kcalOf(edited), 105);
  assert.equal(getFood(w.db, joint.foodId!)!.owner_user_id, null);
});

test("deleting a recipe soft-deletes its food; the diary keeps what was logged; the food is gone from search", async (t) => {
  const w = await newWorld(t);
  const { bar } = pantry(w);
  const saved = saveRecipe(w.db, w.ids.ann, doc(w, { name: "Gone pie", yieldServings: 1, lines: [line("bar", { foodId: bar.id, quantity: 1 })] }));
  const { row } = addEntry(w.db, w.ann, TODAY, TODAY, { slot: "lunch", foodId: saved.foodId });
  assert.equal(deleteRecipeDoc(w.db, w.ids.ann, saved.id), true);
  assert.equal(getRecipeRecord(w.db, saved.id), undefined);
  assert.ok(getFood(w.db, saved.foodId!)!.deleted_at);
  assert.deepEqual(searchFoods(w.db, w.ids.ann, "pie", 5), []);
  assert.equal(get<any>(w.db, "SELECT deleted_at FROM nutrition_diary_entries WHERE id = ?", row.id)!.deleted_at, null);
  assert.equal(deleteRecipeDoc(w.db, w.ids.ann, saved.id), false);
});

test("a recipe that loses its calories drops out of search, and comes back as the same food when they return", async (t) => {
  const w = await newWorld(t);
  const { bar } = pantry(w);
  const saved = saveRecipe(w.db, w.ids.ann, doc(w, { name: "Flicker soup", yieldServings: 1, lines: [line("bar", { foodId: bar.id, quantity: 1 })] }));
  const cleared = saveRecipe(w.db, w.ids.ann, { ...saved, lines: [line("bar")] });
  assert.equal(cleared.nutrition, undefined);
  assert.deepEqual(searchFoods(w.db, w.ids.ann, "flicker", 5), []);
  const back = saveRecipe(w.db, w.ids.ann, { ...cleared, lines: saved.lines });
  assert.equal(back.foodId, saved.foodId);
  assert.deepEqual(searchFoods(w.db, w.ids.ann, "flicker", 5).map((f) => f.id), [saved.foodId]);
  assert.equal(foodRows(w, saved.id).length, 1);
});

test("editing an ingredient food re-adds the recipes that use it", async (t) => {
  const w = await newWorld(t);
  const { bar } = pantry(w);
  const saved = saveRecipe(w.db, w.ids.ann, doc(w, { yieldServings: 1, lines: [line("bar", { foodId: bar.id, quantity: 2 })] }));
  const other = saveRecipe(w.db, w.ids.ann, doc(w, { yieldServings: 1, lines: [line("x", { foodId: createFood(w.db, w.ann, customFood("Other", 10)).id, quantity: 1 })] }));
  assert.equal(kcalOf(saved), 420);
  updateFood(w.db, w.ann, bar.id, { nutrients: { kcal: 250 } });
  assert.equal(refreshRecipesUsingFood(w.db, bar.id), 1);
  const after = getRecipeRecord(w.db, saved.id)!.doc;
  assert.equal(kcalOf(after), 500);
  assert.equal(JSON.parse(getFood(w.db, saved.foodId!)!.nutrients).kcal, 500);
  assert.equal(kcalOf(getRecipeRecord(w.db, other.id)!.doc), 10);
});

test("lines are validated: text required, the food must be visible and not a recipe, the amount must fit it", async (t) => {
  const w = await newWorld(t);
  const { oats, bar } = pantry(w);
  const theirs = createFood(w.db, w.ben, customFood("Ben's", 100, { scope: "personal" }));
  const bad = (raw: unknown) => assert.throws(() => parseLinesInput(w.db, w.ids.ann, raw), (e: any) => e instanceof NutritionError && e.status >= 400 && e.status < 500);

  bad([]);
  bad("nope");
  bad([{ foodId: bar.id }]);
  bad([{ text: "x", foodId: "does-not-exist", quantity: 1 }]);
  bad([{ text: "x", foodId: theirs.id, quantity: 1 }]);
  bad([{ text: "x", foodId: bar.id, grams: 50 }]);
  bad([{ text: "x", foodId: oats.id, quantity: 1, servingId: "not-mine" }]);
  assert.throws(() => parseLinesInput(w.db, w.ids.ann, Array(101).fill({ text: "x" })), /at most 100/);

  const recipeFood = saveRecipe(w.db, w.ids.ann, doc(w, { yieldServings: 1, lines: [line("bar", { foodId: bar.id, quantity: 1 })] })).foodId!;
  assert.throws(() => parseLinesInput(w.db, w.ids.ann, [{ text: "x", foodId: recipeFood, quantity: 1 }]), /recipe/i);

  const ok = parseLinesInput(w.db, w.ids.ann, [
    { text: "2 cups rolled oats", foodId: oats.id, quantity: 2, servingId: servingsOf(w.db, oats.id).find((s) => s.label === "1 cup")!.id },
    { text: "150 g oats", foodId: oats.id, grams: 150 },
    { text: "salt, to taste" },
    { text: "dressing", estimated: true, estimatedKcal: 120.4 },
    { text: "3 bars", pantry_name: "bars", food_id: bar.id, quantity: 3 },
  ]);
  assert.deepEqual(ok.map((l) => [l.pantryName, l.foodId ? "linked" : "-", l.quantity, l.grams, l.estimatedKcal]), [
    ["rolled oats", "linked", 2, undefined, undefined],
    ["oats", "linked", undefined, 150, undefined],
    ["salt, to taste", "-", undefined, undefined, undefined],
    ["dressing", "-", undefined, undefined, 120],
    ["bars", "linked", 3, undefined, undefined],
  ]);
  assert.equal(ok[3].estimated, true);
});

test("proposeMatches: candidates for a line, own foods before the catalogue, a joint recipe sees no personal foods, recipes aren't offered", async (t) => {
  const w = await newWorld(t);
  const { bar } = pantry(w);
  addGeneric(w.db, "Rice, white, raw", 360);
  addGeneric(w.db, "Rice, white, cooked", 130);
  const mineRice = createFood(w.db, w.ann, { name: "Rice", basis: "per100g", nutrients: { kcal: 350 } });
  createFood(w.db, w.ann, customFood("Rice secret", 10, { scope: "personal" }));
  saveRecipe(w.db, w.ids.ann, doc(w, { name: "Rice pudding", yieldServings: 1, lines: [line("bar", { foodId: bar.id, quantity: 1 })] }));

  const d = doc(w, { lines: [line("200 g rice"), line("1 cup rice"), line("salt"), line("2 cups cream of nothing")] });
  const { proposals } = await proposeMatches(w.db, w.ids.ann, d, null);
  const names = (i: number) => proposals[i].candidates.map((c) => c.name);

  assert.equal(proposals[0].candidates[0].foodId, mineRice.id, "the person's own exact food first");
  assert.ok(!names(0).includes("Rice secret"), "personal foods are never offered to a joint recipe");
  assert.ok(!names(0).includes("Rice pudding"), "recipes aren't ingredients");
  assert.equal(proposals[0].suggestedFoodId, mineRice.id, "exact name, exact weight: taken");
  assert.deepEqual(proposals[0].candidates[0].amount, { grams: 200, approx: false });
  assert.equal(proposals[1].suggestedFoodId, null, "a cup of rice is a density guess: suggested to a person, never auto-linked");
  assert.equal(proposals[1].candidates[0].amount?.approx, true);
  assert.deepEqual(proposals[2].candidates, [], "salt needs no food");
  assert.equal(proposals[2].parsed.negligible, true);

  const personalDoc = { ...d, scope: "personal" as const };
  const personal = await proposeMatches(w.db, w.ids.ann, personalDoc, null);
  assert.ok(personal.proposals[0].candidates.map((c) => c.name).includes("Rice secret"), "a personal recipe may use the person's own foods");
});

test("calculateFromLines links clear matches, estimates the rest with the model, and says what is still open", async (t) => {
  const w = await newWorld(t);
  pantry(w);
  const chicken = createFood(w.db, w.ann, { name: "Chicken breast", basis: "per100g", nutrients: { kcal: 165, protein: 31 } });
  addGeneric(w.db, "Olive oil", 884);
  const model = fakeModel({ async estimateKcal(input) { model.asked.push(`estimate:${input.ingredients.map((i) => i.text).join("|")}`); return { [input.ingredients[0].index]: 220 }; } });

  const saved = saveRecipe(w.db, w.ids.ann, doc(w, { name: "Chicken tray", yieldServings: 2, lines: [line("400 g chicken breast", { pantryName: "chicken breast" }), line("secret spice mix"), line("salt to taste")] }));
  assert.equal(saved.nutrition, undefined);

  const { recipe, report } = await calculateFromLines(w.db, w.ids.ann, saved.id, { estimate: true, model });
  assert.deepEqual(report.linked, [0]);
  assert.deepEqual(report.estimated, [1]);
  assert.deepEqual(report.unresolved, []);
  assert.deepEqual([recipe.lines![0].foodId, recipe.lines![0].grams], [chicken.id, 400]);
  assert.deepEqual([recipe.lines![1].estimated, recipe.lines![1].estimatedKcal, recipe.lines![1].foodId], [true, 220, undefined]);
  assert.equal(kcalOf(recipe), (660 + 220) / 2);
  assert.deepEqual([recipe.nutrition?.origin, recipe.nutrition?.complete], ["mixed", false]);
  assert.equal(recipe.yieldAssumed, undefined, "the recipe had a yield of its own");
  assert.deepEqual(model.asked, ["estimate:secret spice mix"], "linked lines and negligible lines are not sent to the model");
  assert.ok(recipe.foodId, "and it is now a food");
});

test("calculate without a model still links what it can, estimates nothing, and the recipe says it is incomplete", async (t) => {
  const w = await newWorld(t);
  const chicken = createFood(w.db, w.ann, { name: "Chicken breast", basis: "per100g", nutrients: { kcal: 165 } });
  const saved = saveRecipe(w.db, w.ids.ann, doc(w, { lines: [line("200 g chicken breast", { pantryName: "chicken breast" }), line("mystery")] }));
  const { recipe, report } = await calculateFromLines(w.db, w.ids.ann, saved.id, { estimate: true, model: null });
  assert.equal(report.modelAvailable, false);
  assert.deepEqual([report.linked, report.estimated, report.unresolved], [[0], [], [1]]);
  assert.equal(recipe.lines![0].foodId, chicken.id);
  assert.deepEqual([recipe.nutrition?.origin, recipe.nutrition?.complete], ["calculated", false]);
  assert.equal(recipe.yieldServings, undefined);
  assert.equal(recipe.yieldAssumed, true, "no yield was ever given: 4 was assumed, and the recipe says so");
  assert.equal(kcalOf(recipe), 82.5, "330 kcal / 4 assumed servings");
});

test("a model that fails (not running, or garbage) leaves the recipe as honest as before and the error in the report", async (t) => {
  const w = await newWorld(t);
  const saved = saveRecipe(w.db, w.ids.ann, doc(w, { yieldServings: 2, lines: [line("something")] }));
  const down = fakeModel({ async estimateKcal() { throw new Error("Ollama is not reachable"); } });
  const { recipe, report } = await calculateFromLines(w.db, w.ids.ann, saved.id, { estimate: true, model: down });
  assert.equal(report.modelError, "Ollama is not reachable");
  assert.equal(recipe.nutrition, undefined, "nothing could be counted, so no figure and no food");
  assert.deepEqual(report.unresolved, [0]);

  const nonsense = fakeModel({ async estimateKcal() { return { 0: -50, 5: 100 } as any; } });
  assert.equal((await calculateFromLines(w.db, w.ids.ann, saved.id, { estimate: true, model: nonsense })).recipe.nutrition, undefined);
});

test("the model reads amounts the regex can't (\"two cups\"), and its answer is what gets linked", async (t) => {
  const w = await newWorld(t);
  const flour = createFood(w.db, w.ann, { name: "Flour", basis: "per100g", nutrients: { kcal: 364 }, servings: [{ label: "100 g", grams: 100, isDefault: true }, { label: "1 cup", grams: 125 }] });
  const saved = saveRecipe(w.db, w.ids.ann, doc(w, { yieldServings: 1, lines: [line("two cups of sifted flour", { pantryName: "flour" })] }));
  const model = fakeModel({ async parseLines(texts) { model.asked.push(`parse:${texts.join("|")}`); return [{ quantity: 2, unit: "cup", ingredient: "flour" }]; } });
  const { recipe } = await calculateFromLines(w.db, w.ids.ann, saved.id, { model });
  assert.deepEqual(model.asked, ["parse:two cups of sifted flour"]);
  assert.deepEqual([recipe.lines![0].foodId, recipe.lines![0].quantity], [flour.id, 2]);
  assert.equal(kcalOf(recipe), 910);

  // Lines the regex reads fine never go to the model.
  const plain = saveRecipe(w.db, w.ids.ann, doc(w, { yieldServings: 1, lines: [line("2 cups flour", { pantryName: "flour" })] }));
  const m2 = fakeModel();
  await calculateFromLines(w.db, w.ids.ann, plain.id, { model: m2 });
  assert.deepEqual(m2.asked, []);
});

test("calculate never changes a link someone confirmed, and a legacy recipe (names only) gets lines made from its ingredients", async (t) => {
  const w = await newWorld(t);
  const { bar } = pantry(w);
  createFood(w.db, w.ann, { name: "Chicken breast", basis: "per100g", nutrients: { kcal: 165 } });
  const saved = saveRecipe(w.db, w.ids.ann, doc(w, { yieldServings: 1, lines: [line("200 g chicken breast", { pantryName: "chicken breast", foodId: bar.id, quantity: 1 })] }));
  const { recipe } = await calculateFromLines(w.db, w.ids.ann, saved.id, { model: null });
  assert.equal(recipe.lines![0].foodId, bar.id, "the person's link stands");

  const legacy = saveRecipe(w.db, w.ids.ann, doc(w, { name: "Legacy", ingredients: ["chicken breast", "rice"] }));
  const out = await calculateFromLines(w.db, w.ids.ann, legacy.id, { model: null });
  assert.deepEqual(out.recipe.lines!.map((l) => l.text), ["chicken breast", "rice"]);
  assert.deepEqual(out.recipe.ingredients, ["chicken breast", "rice"], "pantry matching sees exactly what it saw before");
  assert.equal(out.recipe.nutrition, undefined, "no amounts, nothing to add up");
});

test("calculate on someone else's personal recipe is a 404", async (t) => {
  const w = await newWorld(t);
  const secret = saveRecipe(w.db, w.ids.ann, doc(w, { scope: "personal", lines: [line("x")] }));
  await assert.rejects(calculateFromLines(w.db, w.ids.ben, secret.id, { model: null }), (e: any) => e.status === 404);
});

test("the recipes table row is what db.ts's scoped items read: owner NULL when joint", async (t) => {
  const w = await newWorld(t);
  const joint = saveRecipe(w.db, w.ids.ann, doc(w, {}));
  const personal = saveRecipe(w.db, w.ids.ann, doc(w, { scope: "personal" }));
  assert.equal(get<any>(w.db, "SELECT owner_user_id FROM recipes WHERE item_id = ?", joint.id)!.owner_user_id, null);
  assert.equal(get<any>(w.db, "SELECT owner_user_id FROM recipes WHERE item_id = ?", personal.id)!.owner_user_id, w.ids.ann);
  run(w.db, "DELETE FROM recipes");
});
