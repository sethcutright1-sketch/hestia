// /api/nutrition/recipes/*: calories for the recipe book (routes/nutrition/recipes.ts), plus what the
// FOOD routes say about a recipe's food. The local model is a fake here and "off" by default.

import { test, after } from "node:test";
import assert from "node:assert/strict";

import { cleanupDb } from "./helpers/testdb.ts";
import { newApi, type Api } from "./helpers/nutritionApi.ts";
import { TODAY, addGeneric, customFood } from "./helpers/nutritionWorld.ts";
import { saveRecipe } from "../nutrition/data/recipes.ts";
import type { RecipeModel } from "../nutrition/recipeAi.ts";
import type { Line, RecipeDoc } from "../nutrition/recipeModel.ts";
import { get } from "../nutrition/data/sql.ts";

after(cleanupDb);

let n = 0;
function recipe(api: Api, over: Partial<RecipeDoc> = {}, who: "ann" | "ben" = "ann"): RecipeDoc {
  const t = "2026-03-01T00:00:00.000Z";
  return saveRecipe(api.w.db, api.w.ids[who], { id: `r-${++n}`, name: `Dish ${n}`, ingredients: [], scope: "joint", createdBy: api.w.ids[who], createdAt: t, updatedAt: t, ...over });
}
const L = (text: string, over: Partial<Line> = {}): Line => ({ text, pantryName: text, ...over });
const food = async (api: Api, body: unknown, who: "ann" | "ben" = "ann") => (await api.call(who, "POST", "/foods", body)).body;

test("GET /recipes lists what you can see with its calories; GET /recipes/:id shows each line and what it adds", async (t) => {
  const api = await newApi(t);
  const bar = await food(api, customFood("Protein bar", 200));
  const a = recipe(api, { name: "Bars", yieldServings: 2, lines: [L("2 bars", { foodId: bar.id, quantity: 2 }), L("mystery")] });
  const legacy = recipe(api, { name: "Old stew", ingredients: ["beef"] });
  recipe(api, { name: "Ann's own", scope: "personal", ingredients: ["x"] });

  const list = await api.call("ben", "GET", "/recipes");
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.map((r: any) => [r.name, r.kcalPerServing, r.lineCount]), [["Bars", 200, 2], ["Old stew", null, 0]], "joint only; no calories yet for the old one");
  assert.equal(list.body[0].nutrition.complete, false);
  assert.equal(list.body[0].foodId, a.foodId);
  assert.equal((await api.call("ann", "GET", "/recipes")).body.length, 3);

  const detail = (await api.call("ben", "GET", `/recipes/${a.id}`)).body;
  assert.deepEqual(detail.lines.map((l: any) => [l.text, l.foodName, l.kcal, l.negligible]), [["2 bars", "Protein bar", 400, false], ["mystery", null, null, false]]);
  assert.equal(detail.kcalPerServing, 200);
  assert.equal((await api.call("ben", "GET", `/recipes/${legacy.id}`)).body.lines[0].text, "beef", "lines are shown even when the recipe has none stored");

  // "mine" means "I created it", in the list and the detail alike -- even for a joint recipe.
  assert.deepEqual(list.body.map((r: any) => r.mine), [false, false], "Ben created neither");
  assert.equal(detail.mine, false);
  assert.deepEqual((await api.call("ann", "GET", "/recipes")).body.map((r: any) => r.mine), [true, true, true], "Ann created all three, joint or not");
  assert.equal((await api.call("ann", "GET", `/recipes/${a.id}`)).body.mine, true);
  assert.equal((await api.call("ben", "GET", "/recipes/nope")).status, 404);
  const secret = (await api.call("ann", "GET", "/recipes")).body.find((r: any) => r.name === "Ann's own");
  assert.equal((await api.call("ben", "GET", `/recipes/${secret.id}`)).status, 404, "someone else's personal recipe doesn't exist for you");
});

test("PUT /recipes/:id: yield, serving label, cooked weight, source and lines; the calories and the recipe's food follow", async (t) => {
  const api = await newApi(t);
  const bar = await food(api, customFood("Protein bar", 200));
  const r = recipe(api, { name: "Chili", yieldServings: 4, lines: [L("4 bars", { foodId: bar.id, quantity: 4 })] });
  assert.equal(r.nutrition?.perServing.kcal, 200);

  const put = await api.call("ann", "PUT", `/recipes/${r.id}`, { yieldServings: 2, servingLabel: "bowl", totalCookedG: 1000, sourceUrl: "https://example.com/chili" });
  assert.equal(put.status, 200);
  assert.deepEqual([put.body.kcalPerServing, put.body.yieldServings, put.body.servingLabel, put.body.totalCookedG, put.body.sourceUrl], [400, 2, "bowl", 1000, "https://example.com/chili"]);
  const f = (await api.call("ann", "GET", `/foods/${put.body.foodId}`)).body;
  assert.deepEqual([f.source, f.recipeId, f.scope, f.nutrients.kcal, f.servings.map((s: any) => [s.label, s.grams])], ["recipe", r.id, "joint", 400, [["1 bowl", 500]]]);

  const cleared = await api.call("ann", "PUT", `/recipes/${r.id}`, { totalCookedG: null, sourceUrl: null });
  assert.equal(cleared.body.totalCookedG, undefined);
  assert.equal((await api.call("ann", "GET", `/foods/${r.foodId}`)).body.servings[0].grams, null);

  const relines = await api.call("ann", "PUT", `/recipes/${r.id}`, { lines: [{ text: "1 bar", pantryName: "bar", foodId: bar.id, quantity: 1 }, { text: "salt" }] });
  assert.deepEqual([relines.body.kcalPerServing, relines.body.ingredients], [100, ["bar", "salt"]]);

  for (const bad of [{ yieldServings: 0 }, { yieldServings: "four" }, { totalCookedG: -5 }, { sourceUrl: "ftp://x" }, { sourceUrl: "nonsense" }, { scope: "family" }, { name: " " }, { lines: [] }, { lines: [{ text: "x", foodId: "nope", quantity: 1 }] }, { lines: [{ foodId: bar.id }] }]) {
    assert.equal((await api.call("ann", "PUT", `/recipes/${r.id}`, bad)).status >= 400, true, JSON.stringify(bad));
  }
  assert.equal((await api.call("ann", "GET", `/recipes/${r.id}`)).body.kcalPerServing, 100, "rejected edits changed nothing");
});

test("a joint recipe refuses a personal food; only its creator changes who it's shared with", async (t) => {
  const api = await newApi(t);
  const mine = await food(api, customFood("Secret shake", 300, { scope: "personal" }));
  const r = recipe(api, { name: "Shared", yieldServings: 1, ingredients: ["x"] });
  const refused = await api.call("ann", "PUT", `/recipes/${r.id}`, { lines: [{ text: "shake", foodId: mine.id, quantity: 1 }] });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /personal food/);

  const p = await api.call("ann", "PUT", `/recipes/${r.id}`, { scope: "personal" });
  assert.equal(p.body.scope, "personal");
  assert.equal((await api.call("ben", "GET", `/recipes/${r.id}`)).status, 404, "now only Ann's");
  const joint = recipe(api, { name: "Ann's joint", ingredients: ["y"] });
  assert.equal((await api.call("ben", "PUT", `/recipes/${joint.id}`, { scope: "personal" })).status, 403, "Ben didn't add it");
  assert.equal((await api.call("ben", "PUT", `/recipes/${joint.id}`, { yieldServings: 6 })).status, 200, "but he may edit it");
});

test("links: confirm a food and an amount for a line (or clear it); the figure, completeness and the food update", async (t) => {
  const api = await newApi(t);
  const oats = await food(api, { name: "Rolled oats", basis: "per100g", nutrients: { kcal: 380 }, servings: [{ label: "100 g", grams: 100, isDefault: true }, { label: "1 cup", grams: 80 }] });
  const cup = oats.servings.find((s: any) => s.label === "1 cup");
  const r = recipe(api, { name: "Porridge", yieldServings: 2, lines: [L("2 cups rolled oats", { pantryName: "rolled oats" }), L("water")] });
  assert.equal(r.nutrition, undefined);

  const linked = await api.call("ann", "POST", `/recipes/${r.id}/links`, { links: [{ index: 0, foodId: oats.id, quantity: 2, servingId: cup.id }] });
  assert.equal(linked.status, 200);
  assert.deepEqual([linked.body.kcalPerServing, linked.body.nutrition.complete, linked.body.nutrition.origin], [304, true, "calculated"], "water needs no food");
  assert.deepEqual(linked.body.lines[0].kcal, 608);
  assert.equal(linked.body.lines[0].pantryName, "rolled oats", "pantry name untouched");

  const byGrams = await api.call("ann", "POST", `/recipes/${r.id}/links`, { links: [{ index: 0, foodId: oats.id, grams: 200 }] });
  assert.equal(byGrams.body.kcalPerServing, 380);
  assert.equal(byGrams.body.lines[0].servingId, undefined);

  const cleared = await api.call("ann", "POST", `/recipes/${r.id}/links`, { links: [{ index: 0, clear: true }] });
  assert.equal(cleared.body.kcalPerServing, null);
  assert.equal(cleared.body.foodId, r.foodId ?? linked.body.foodId, "the same food row, now out of search");
  assert.deepEqual((await api.call("ann", "GET", "/foods/search?q=porridge")).body, []);

  for (const bad of [{}, { links: [] }, { links: [{ index: 9, foodId: oats.id, grams: 1 }] }, { links: [{ index: -1, clear: true }] }, { links: [{ index: 0, foodId: oats.id, servingId: "nope" }] }, { links: ["x"] }, { links: [{ index: 0, foodId: "nope", grams: 1 }] }]) {
    assert.ok((await api.call("ann", "POST", `/recipes/${r.id}/links`, bad)).status >= 400, JSON.stringify(bad));
  }
  // An estimate can be set by a person too, and counts as one.
  const est = await api.call("ann", "POST", `/recipes/${r.id}/links`, { links: [{ index: 0, estimated: true, estimatedKcal: 500 }] });
  assert.deepEqual([est.body.kcalPerServing, est.body.nutrition.origin, est.body.nutrition.complete], [250, "mixed", false]);
});

test("parse: how each line reads, with the model only for amounts in words", async (t) => {
  const asked: string[] = [];
  const model: RecipeModel = {
    async parseLines(texts) { asked.push(...texts); return texts.map(() => ({ quantity: 12, unit: null, ingredient: "eggs" })); },
    async estimateKcal() { return {}; },
  };
  const api = await newApi(t, { recipeModel: () => model });
  const r = recipe(api, { name: "Eggs", ingredients: ["x"], lines: [L("1/2 cup milk"), L("a dozen eggs"), L("salt to taste"), L("butter")] });
  const res = await api.call("ann", "POST", `/recipes/${r.id}/parse`, {});
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.lines.map((l: any) => [l.quantity, l.unit, l.ingredient, l.negligible, l.via]), [
    [0.5, "cup", "milk", false, "regex"], [12, null, "eggs", false, "model"], [null, null, "salt", true, "regex"], [null, null, "butter", false, "regex"],
  ]);
  assert.deepEqual(asked, ["a dozen eggs"]);

  // With no model the regex answer stands, and nothing fails.
  const offline = await newApi(t);
  const r2 = recipe(offline, { name: "Eggs2", ingredients: ["x"], lines: [L("a dozen eggs")] });
  const res2 = await offline.call("ann", "POST", `/recipes/${r2.id}/parse`, {});
  assert.deepEqual(res2.body.lines.map((l: any) => [l.quantity, l.via]), [[null, "regex"]]);
});

test("a model that errors is reported, not fatal: parse and match still answer", async (t) => {
  const broken: RecipeModel = { async parseLines() { throw new Error("Ollama is not reachable"); }, async estimateKcal() { throw new Error("Ollama is not reachable"); } };
  const api = await newApi(t, { recipeModel: () => broken });
  const r = recipe(api, { name: "Eggs", ingredients: ["x"], lines: [L("a dozen eggs")] });
  const parsed = await api.call("ann", "POST", `/recipes/${r.id}/parse`, {});
  assert.equal(parsed.status, 200);
  assert.equal(parsed.body.modelError, "Ollama is not reachable");
  const match = await api.call("ann", "POST", `/recipes/${r.id}/match`, {});
  assert.equal(match.status, 200);
  assert.equal(match.body.modelError, "Ollama is not reachable");
  const calc = await api.call("ann", "POST", `/recipes/${r.id}/calculate`, { estimate: true });
  assert.equal(calc.status, 200);
  assert.equal(calc.body.report.modelError, "Ollama is not reachable");
  assert.equal(calc.body.recipe.kcalPerServing, null);
});

test("match: candidate foods per line, best first, with the amount each would be and which one would be auto-linked", async (t) => {
  const api = await newApi(t);
  addGeneric(api.w.db, "Chicken, broilers or fryers, breast, raw", 120);
  const mine = await food(api, { name: "Chicken breast", basis: "per100g", nutrients: { kcal: 165 } });
  const r = recipe(api, { name: "Tray", ingredients: ["x"], lines: [L("400 g chicken breast"), L("1 cup chicken breast"), L("salt")] });
  const res = (await api.call("ann", "POST", `/recipes/${r.id}/match`, {})).body.lines;
  assert.equal(res[0].candidates[0].foodId, mine.id);
  assert.deepEqual([res[0].candidates[0].confidence, res[0].candidates[0].amount, res[0].suggestedFoodId], ["exact", { grams: 400, approx: false }, mine.id]);
  assert.ok(res[0].candidates.some((c: any) => c.confidence === "possible" && c.scope === "generic"), "the catalogue row is offered too, as 'possible'");
  assert.equal(res[1].suggestedFoodId, null, "a volume of a weight-only food is a guess: offered, not auto-linked");
  assert.equal(res[1].candidates[0].amount.approx, true);
  assert.deepEqual(res[2].candidates, []);
  assert.equal((await api.call("ann", "GET", `/recipes/${r.id}`)).body.nutrition, undefined, "match writes nothing");
});

test("calculate: links clear matches, estimates the rest on request, reports what is open; a PUT'd yield replaces the assumed one", async (t) => {
  const model: RecipeModel = {
    async parseLines(texts) { return texts.map(() => null); },
    async estimateKcal(input) { return Object.fromEntries(input.ingredients.map((i) => [i.index, 150])); },
  };
  const api = await newApi(t, { recipeModel: () => model });
  await food(api, { name: "Chicken breast", basis: "per100g", nutrients: { kcal: 165 } });
  const r = recipe(api, { name: "Tray", ingredients: ["x"], lines: [L("400 g chicken breast"), L("homemade spice")] });

  const dry = await api.call("ann", "POST", `/recipes/${r.id}/calculate`, {});
  assert.equal(dry.status, 200);
  assert.deepEqual([dry.body.report.linked, dry.body.report.estimated, dry.body.report.unresolved], [[0], [], [1]]);
  assert.deepEqual([dry.body.recipe.nutrition.complete, dry.body.recipe.yieldAssumed], [false, true]);
  assert.equal(dry.body.recipe.kcalPerServing, 165, "660 kcal over the 4 servings assumed");

  const full = await api.call("ann", "POST", `/recipes/${r.id}/calculate`, { estimate: true, yieldServings: 2 });
  assert.deepEqual([full.body.report.estimated, full.body.report.unresolved], [[1], []]);
  assert.deepEqual([full.body.recipe.kcalPerServing, full.body.recipe.nutrition.origin, full.body.recipe.nutrition.complete, full.body.recipe.yieldServings, full.body.recipe.yieldAssumed], [405, "mixed", false, 2, undefined]);
  assert.deepEqual(full.body.recipe.lines.map((l: any) => [!!l.foodId, l.estimated ?? false, l.kcal]), [[true, false, 660], [false, true, 150]]);

  assert.equal((await api.call("ann", "POST", `/recipes/${r.id}/calculate`, { yieldServings: 0 })).status, 400);
  assert.equal((await api.call("ann", "POST", "/recipes/nope/calculate", {})).status, 404);
  assert.equal((await api.call("kiosk", "POST", `/recipes/${r.id}/calculate`, {})).status, 403);
});

test("a recipe's food is read-only in the food routes: PATCH and DELETE say to edit the recipe; it can't take a barcode", async (t) => {
  const api = await newApi(t);
  const bar = await food(api, customFood("Protein bar", 200));
  const r = recipe(api, { name: "Bars bake", yieldServings: 1, lines: [L("1 bar", { foodId: bar.id, quantity: 1 })] });
  const id = r.foodId!;

  const patch = await api.call("ann", "PATCH", `/foods/${id}`, { name: "Renamed" });
  assert.equal(patch.status, 409);
  assert.match(patch.body.error, /edit the recipe instead/);
  assert.equal(patch.body.recipeId, r.id);
  const del = await api.call("ann", "DELETE", `/foods/${id}`);
  assert.equal(del.status, 409);
  assert.match(del.body.error, /edit the recipe instead/);
  assert.equal((await api.call("ben", "PATCH", `/foods/${id}`, { scope: "personal" })).status, 409);
  assert.equal((await api.call("ann", "POST", `/foods/${id}/barcode`, { code: "016000275287" })).status, 409);
  assert.equal(get<any>(api.w.db, "SELECT name, deleted_at FROM nutrition_foods WHERE id = ?", id)!.name, "Bars bake");
  assert.equal(get<any>(api.w.db, "SELECT deleted_at FROM nutrition_foods WHERE id = ?", id)!.deleted_at, null);

  // Reading and logging it works like any food.
  const got = (await api.call("ann", "GET", `/foods/${id}`)).body;
  assert.deepEqual([got.source, got.recipeId, got.basis, got.nutrients.kcal], ["recipe", r.id, "per_serving", 200]);
  const logged = await api.call("ann", "POST", `/diary/${TODAY}`, { slot: "dinner", foodId: id, quantity: 1.5 });
  assert.equal(logged.status, 201);
  assert.equal(logged.body.entry.nutrients.kcal, 300);
  assert.equal((await api.call("ann", "GET", "/foods/search?q=bars%20bake")).body[0].id, id);
  // A recipe isn't offered as a food to put a scanned barcode on.
  assert.deepEqual((await api.call("ann", "GET", "/foods/link-candidates?q=bars%20bake")).body.map((f: any) => f.id), []);
});

test("editing an ingredient food through the food routes re-adds the recipes that use it", async (t) => {
  const api = await newApi(t);
  const bar = await food(api, customFood("Protein bar", 200));
  const r = recipe(api, { name: "Two bars", yieldServings: 1, lines: [L("2 bars", { foodId: bar.id, quantity: 2 })] });
  assert.equal((await api.call("ann", "GET", `/recipes/${r.id}`)).body.kcalPerServing, 400);
  assert.equal((await api.call("ann", "PATCH", `/foods/${bar.id}`, { nutrients: { kcal: 250 } })).status, 200);
  assert.equal((await api.call("ann", "GET", `/recipes/${r.id}`)).body.kcalPerServing, 500);
  assert.equal((await api.call("ann", "GET", `/foods/${r.foodId}`)).body.nutrients.kcal, 500);
});

test("personal recipes and their foods stay with their owner across the routes", async (t) => {
  const api = await newApi(t);
  const bar = await food(api, customFood("Protein bar", 200));
  const r = recipe(api, { name: "Ann's secret loaf", scope: "personal", yieldServings: 1, lines: [L("bar", { foodId: bar.id, quantity: 1 })] });
  assert.deepEqual((await api.call("ben", "GET", "/foods/search?q=loaf")).body, []);
  assert.equal((await api.call("ben", "GET", `/foods/${r.foodId}`)).status, 404);
  assert.equal((await api.call("ben", "POST", `/recipes/${r.id}/calculate`, {})).status, 404);
  assert.equal((await api.call("ben", "POST", `/recipes/${r.id}/links`, { links: [{ index: 0, clear: true }] })).status, 404);
  assert.equal((await api.call("ben", "PUT", `/recipes/${r.id}`, { name: "Mine now" })).status, 404);
  assert.equal((await api.call("ann", "GET", "/foods/search?q=loaf")).body[0].scope, "personal");
});

// ---- POST /recipes: "Save as recipe" from a meal that was eaten (phase 5c) --------------------------------------

test("POST /recipes: a new joint recipe from eaten foods, one linked line each, calories added up, default yield 1", async (t) => {
  const api = await newApi(t);
  const bar = await food(api, customFood("Protein bar", 200));
  const yogurt = addGeneric(api.w.db, "Greek yogurt", 60);
  const r = await api.call("ann", "POST", "/recipes", {
    name: "Breakfast bowl",
    items: [{ foodId: yogurt, grams: 150 }, { foodId: bar.id, quantity: 2 }],
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual([r.body.name, r.body.scope, r.body.yieldServings, r.body.mine], ["Breakfast bowl", "joint", 1, true]);
  assert.deepEqual(r.body.lines.map((l: any) => [l.text, l.pantryName, l.foodName, l.kcal]), [
    ["150 g Greek yogurt", "Greek yogurt", "Greek yogurt", 90],
    ["2 bar Protein bar", "Protein bar", "Protein bar", 400],
  ], "each line is linked to its food at the eaten amount");
  assert.equal(r.body.kcalPerServing, 490);
  assert.deepEqual([r.body.nutrition.origin, r.body.nutrition.complete], ["calculated", true]);
  assert.deepEqual(r.body.ingredients, ["Greek yogurt", "Protein bar"], "the pantry names still drive pantry and grocery matching");
  assert.ok(r.body.foodId, "it is a food now, so the diary and the plan can use it");

  // The other login sees it in the household recipe book; it can go on the meal plan (joint).
  const list = (await api.call("ben", "GET", "/recipes")).body;
  assert.deepEqual(list.map((x: any) => [x.name, x.scope, x.kcalPerServing]), [["Breakfast bowl", "joint", 490]]);

  // A yield other than 1 divides the calories.
  const six = await api.call("ann", "POST", "/recipes", { name: "Batch", yieldServings: 2, items: [{ foodId: bar.id, quantity: 4 }] });
  assert.deepEqual([six.status, six.body.yieldServings, six.body.kcalPerServing], [201, 2, 400]);
});

test("POST /recipes never replaces a recipe, and refuses bad bodies", async (t) => {
  const api = await newApi(t);
  const bar = await food(api, customFood("Protein bar", 200));
  const ok = { name: "Bowl", items: [{ foodId: bar.id }] };
  assert.equal((await api.call("ann", "POST", "/recipes", ok)).status, 201);
  const again = await api.call("ben", "POST", "/recipes", { ...ok, name: "  bowl " });
  assert.equal(again.status, 409, "same name (any case), even from the other login: the joint recipe is theirs too");
  assert.match(again.body.error, /already have a recipe called/);
  assert.equal((await api.call("ann", "GET", "/recipes")).body.length, 1);

  for (const bad of [{}, { name: "x" }, { name: "x", items: [] }, { name: "", items: [{ foodId: bar.id }] }, { name: "x", items: ["bar"] },
    { name: "x", items: [{}] }, { name: "x", items: [{ foodId: bar.id }], scope: "everyone" }, { name: "x", items: [{ foodId: bar.id }], yieldServings: 0 }]) {
    assert.equal((await api.call("ann", "POST", "/recipes", bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await api.call("ann", "POST", "/recipes", { name: "x", items: [{ foodId: "nope" }] })).status, 404);
  assert.equal((await api.call("kiosk", "POST", "/recipes", ok)).status, 403, "the kiosk has no diary and no recipes here");
});

test("POST /recipes: a personal food can't go in a joint recipe (clear message), but can in a personal one that stays private", async (t) => {
  const api = await newApi(t);
  const mine = await food(api, customFood("Secret shake", 300, { scope: "personal" }));
  const shared = await food(api, customFood("Oats", 150));
  const joint = await api.call("ann", "POST", "/recipes", { name: "Mix", items: [{ foodId: shared.id }, { foodId: mine.id }] });
  assert.equal(joint.status, 400);
  assert.match(joint.body.error, /"Secret shake" is a personal food/);
  assert.equal((await api.call("ann", "GET", "/recipes")).body.length, 0, "nothing was saved");

  const personal = await api.call("ann", "POST", "/recipes", { name: "Mix", scope: "personal", items: [{ foodId: shared.id }, { foodId: mine.id }] });
  assert.deepEqual([personal.status, personal.body.scope, personal.body.kcalPerServing], [201, "personal", 450]);
  assert.equal((await api.call("ben", "GET", "/recipes")).body.length, 0, "Ben can't see it");
  assert.equal((await api.call("ben", "GET", `/recipes/${personal.body.id}`)).status, 404);
  assert.equal((await api.call("ben", "POST", "/recipes", { name: "Mix", items: [{ foodId: shared.id }] })).status, 201, "Ben's own 'Mix' doesn't clash with Ann's private one");
});

test("POST /recipes: a recipe's own food can't be a line of another recipe yet", async (t) => {
  const api = await newApi(t);
  const bar = await food(api, customFood("Protein bar", 200));
  const inner = (await api.call("ann", "POST", "/recipes", { name: "Inner", items: [{ foodId: bar.id }] })).body;
  const outer = await api.call("ann", "POST", "/recipes", { name: "Outer", items: [{ foodId: inner.foodId }] });
  assert.equal(outer.status, 400);
  assert.match(outer.body.error, /itself a recipe/);
});

test("PUT /recipes/:id edits the steps: text or a list, capped, null clears; the kiosk is refused; personal recipes stay the owner's", async (t) => {
  const api = await newApi(t);
  const joint = recipe(api, { name: "Pie", ingredients: ["beef"] });
  const mine = recipe(api, { name: "Ann's loaf", scope: "personal", ingredients: ["rye"] });

  const put = (who: "ann" | "ben" | "kiosk", id: string, body: unknown) => api.call(who, "PUT", `/recipes/${id}`, body);
  assert.equal("instructions" in (await api.call("ben", "GET", `/recipes/${joint.id}`)).body, false, "a recipe from before steps existed has none");

  const text = await put("ben", joint.id, { instructions: "1. Brown the beef.\n\n2. Bake." });
  assert.deepEqual([text.status, text.body.instructions], [200, ["Brown the beef.", "Bake."]], "any login that can see a joint recipe can edit it, as before");
  const list = await put("ann", joint.id, { instructions: Array.from({ length: 70 }, (_, i) => `do thing ${i}`) });
  assert.equal(list.body.instructions.length, 60);
  assert.equal((await put("ann", joint.id, { name: "Pie (renamed)" })).body.instructions.length, 60, "a PUT that doesn't mention steps leaves them");
  assert.equal((await put("ann", joint.id, { instructions: 5 })).status, 400);
  const cleared = await put("ann", joint.id, { instructions: null });
  assert.equal("instructions" in cleared.body, false);

  await put("ann", mine.id, { instructions: ["Knead."] });
  assert.equal((await put("ben", mine.id, { instructions: ["Ruin it."] })).status, 404, "someone else's personal recipe can't be seen, let alone edited");
  assert.equal((await put("kiosk", joint.id, { instructions: ["Nope."] })).status, 403);
  assert.deepEqual((await api.call("ann", "GET", `/recipes/${mine.id}`)).body.instructions, ["Knead."]);
});
