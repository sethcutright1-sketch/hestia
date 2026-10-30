// The recipe book's routes after recipes gained lines, yield and calories (routes/mealplan.ts):
// everything old still behaves, and the new optional fields ride along. Runs against the app's own
// (throwaway) database, so what is checked is the rows the meal plan, grocery list and assistant read.

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { loadDb, cleanupDb } from "./helpers/testdb.ts";
import { callRoute } from "./helpers/router.ts";

const loaded = await loadDb();
const { createUser, getScopedItems, db } = loaded;
const { mealPlanRoutes } = await import("../routes/mealplan.ts");

let alice: string;
let bob: string;
const asAlice = () => ({ session: { userId: alice } });
const asBob = () => ({ session: { userId: bob } });

before(() => {
  alice = createUser("alice-rc", "not-a-real-hash", "Alice");
  bob = createUser("bob-rc", "not-a-real-hash", "Bob");
});
after(cleanupDb);
beforeEach(() => {
  db.exec("DELETE FROM recipes; DELETE FROM nutrition_food_servings; DELETE FROM nutrition_foods");
});

const post = (who: () => object, url: string, body: unknown) => callRoute(mealPlanRoutes, "POST", url, { ...who(), body });
const stored = (who: string) => getScopedItems("recipes", who) as any[];
const foodsFor = (recipeId: string) => db.prepare("SELECT * FROM nutrition_foods WHERE recipe_id = ?").all(recipeId) as any[];

describe("typed and assistant-style recipes", () => {
  test("a recipe typed with quantities keeps the line as written and matches the pantry on the name", async () => {
    const res = await post(asAlice, "/recipes", { name: "Pancakes", ingredients: "2 cups all-purpose flour, 1 egg, milk" });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.recipe.ingredients, ["all-purpose flour", "egg", "milk"]);
    assert.deepEqual(res.body.recipe.lines.map((l: any) => l.text), ["2 cups all-purpose flour", "1 egg", "milk"]);
    assert.equal(res.body.recipe.nutrition, undefined, "no calories yet");
    assert.equal(res.body.recipe.foodId, undefined);
    assert.equal(res.body.recipe.scope, "joint");
  });

  test("saving the same ingredients again leaves the lines alone; a changed list keeps the links on lines that didn't change", async () => {
    const first = (await post(asAlice, "/recipes", { name: "Chilli", ingredients: ["beef", "beans"] })).body.recipe;
    // Someone links 'beef' to a food (what phase 5's editor will do).
    const food = db.prepare("INSERT INTO nutrition_foods (id, name, basis, nutrients, source, created_at) VALUES ('food-beef', 'Beef', 'per100g', '{\"kcal\":250}', 'custom', 'x')").run();
    assert.ok(food);
    db.prepare("INSERT INTO nutrition_food_servings (id, food_id, label, grams, is_default) VALUES ('s1', 'food-beef', '100 g', 100, 1)").run();
    const linked = { ...first, lines: [{ ...first.lines[0], foodId: "food-beef", grams: 500 }, first.lines[1]] };
    db.prepare("UPDATE recipes SET data = ? WHERE item_id = ?").run(JSON.stringify(linked), first.id);

    const again = (await post(asAlice, "/recipes", { name: "chilli", ingredients: ["beans", "BEEF"] })).body.recipe;
    assert.equal(again.id, first.id);
    assert.equal(again.lines[0].foodId, "food-beef", "same ingredients, any order or case: nothing was rewritten");

    const changed = (await post(asAlice, "/recipes", { name: "Chilli", ingredients: ["beef", "beans", "rice"] })).body.recipe;
    assert.equal(changed.lines[0].foodId, "food-beef", "the unchanged line keeps its link");
    assert.equal(changed.lines.length, 3);
    assert.equal(changed.lines[2].foodId, undefined);
    assert.equal(changed.nutrition.origin, "calculated");
    assert.equal(changed.nutrition.complete, false, "two lines are still unlinked");
    assert.equal(changed.nutrition.perServing.kcal, 312.5, "1250 kcal / 4 assumed servings");
  });

  test("a recipe saved before calories existed (names only) lists, ranks and deletes as before", async () => {
    const legacy = { id: "recipe-old", name: "Old stew", ingredients: ["beef", "carrots"], scope: "joint", createdBy: alice, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };
    db.prepare("INSERT INTO recipes (item_id, owner_user_id, data) VALUES (?, NULL, ?)").run(legacy.id, JSON.stringify(legacy));
    const list = await callRoute(mealPlanRoutes, "GET", "/", asBob());
    assert.deepEqual(list.body.recipes, [legacy]);
    const gone = await callRoute(mealPlanRoutes, "DELETE", "/recipes/recipe-old", asBob());
    assert.equal(gone.status, 200);
    assert.deepEqual(stored(bob), []);
    assert.equal((await callRoute(mealPlanRoutes, "DELETE", "/recipes/recipe-old", asBob())).status, 404);
  });
});

describe("personal recipes", () => {
  test("only their owner sees one: not in Bob's list, not deletable by him, and Bob's same-named recipe is his own", async () => {
    const mine = (await post(asAlice, "/recipes", { name: "Secret loaf", ingredients: ["flour"], scope: "personal" })).body.recipe;
    assert.equal(mine.scope, "personal");
    assert.equal(db.prepare("SELECT owner_user_id AS o FROM recipes WHERE item_id = ?").get(mine.id)!.o, alice);

    assert.deepEqual((await callRoute(mealPlanRoutes, "GET", "/", asAlice())).body.recipes.map((r: any) => r.name), ["Secret loaf"]);
    assert.deepEqual((await callRoute(mealPlanRoutes, "GET", "/", asBob())).body.recipes, []);
    assert.equal((await callRoute(mealPlanRoutes, "DELETE", `/recipes/${mine.id}`, asBob())).status, 404);

    const bobs = (await post(asBob, "/recipes", { name: "secret loaf", ingredients: ["rye"] })).body.recipe;
    assert.notEqual(bobs.id, mine.id);
    assert.equal(bobs.scope, "joint");
    assert.deepEqual(stored(alice).map((r) => r.id).sort(), [mine.id, bobs.id].sort());
    assert.deepEqual(stored(alice).find((r) => r.id === mine.id).ingredients, ["flour"], "Ann's was not touched");
  });
});

describe("importing recipes with lines, yield and the site's calories", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    name: "Site curry",
    ingredients: ["chicken", "rice"],
    lines: [{ text: "500 g chicken thighs", pantryName: "chicken thighs" }, { text: "1 1/2 cups basmati rice", pantryName: "basmati rice" }],
    yieldServings: 4,
    sourceUrl: "https://example.com/curry",
    nutrition: { siteKcalPerServing: 520, perServing: { kcal: 520, protein: 30, carbs: 50, fat: 20 } },
    ...over,
  });

  test("lines, yield, source and the site's figure are stored; ingredients come from the lines; the recipe is a food", async () => {
    const res = await post(asAlice, "/recipes/import", { recipes: [row()] });
    assert.equal(res.body.imported, 1);
    const r = stored(alice)[0];
    assert.deepEqual(r.ingredients, ["chicken thighs", "basmati rice"], "pantry matching names, derived from the lines");
    assert.deepEqual(r.lines.map((l: any) => l.text), ["500 g chicken thighs", "1 1/2 cups basmati rice"]);
    assert.deepEqual([r.yieldServings, r.sourceUrl], [4, "https://example.com/curry"]);
    assert.deepEqual([r.nutrition.origin, r.nutrition.siteKcalPerServing, r.nutrition.perServing.kcal, r.nutrition.perServing.protein, r.nutrition.complete], ["site", 520, 520, 30, true]);

    const food = foodsFor(r.id);
    assert.equal(food.length, 1);
    assert.deepEqual([food[0].source, food[0].basis, food[0].owner_user_id, food[0].name, r.foodId], ["recipe", "per_serving", null, "Site curry", food[0].id]);
    assert.equal(JSON.parse(food[0].nutrients).kcal, 520);
  });

  test("garbage in the extras is ignored, not trusted: a bad url, a silly yield, a calorie figure out of range, a non-list of lines", async () => {
    await post(asAlice, "/recipes/import", { recipes: [row({ sourceUrl: "javascript:alert(1)", yieldServings: 99999, nutrition: { siteKcalPerServing: 90000 }, lines: "nope" })] });
    const r = stored(alice)[0];
    assert.equal(r.sourceUrl, undefined);
    assert.equal(r.yieldServings, undefined);
    assert.equal(r.nutrition, undefined);
    assert.deepEqual(r.ingredients, ["chicken", "rice"], "falls back to the ingredient names");
    assert.equal(foodsFor(r.id).length, 0, "no calories, no food");
  });

  test("importing an older shape (name + ingredients only) works exactly as before", async () => {
    const res = await post(asAlice, "/recipes/import", { recipes: [{ name: "Plain", ingredients: ["a", "b"] }, { name: "", ingredients: ["x"] }, { name: "Empty", ingredients: [] }] });
    assert.deepEqual([res.body.imported, res.body.skipped], [1, ["(unnamed)", "Empty"]]);
    assert.deepEqual(stored(alice)[0].ingredients, ["a", "b"]);
  });

  test("re-importing the same recipe updates it in place: one row, one food, links kept for unchanged lines", async () => {
    await post(asAlice, "/recipes/import", { recipes: [row()] });
    const first = stored(alice)[0];
    db.prepare("INSERT INTO nutrition_foods (id, name, basis, nutrients, source, created_at) VALUES ('rice', 'Rice', 'per100g', '{\"kcal\":130}', 'custom', 'x')").run();
    db.prepare("INSERT INTO nutrition_food_servings (id, food_id, label, grams, is_default) VALUES ('s-rice', 'rice', '100 g', 100, 1)").run();
    const withLink = { ...first, lines: [first.lines[0], { ...first.lines[1], foodId: "rice", grams: 300 }] };
    db.prepare("UPDATE recipes SET data = ? WHERE item_id = ?").run(JSON.stringify(withLink), first.id);

    await post(asAlice, "/recipes/import", { recipes: [row({ nutrition: { siteKcalPerServing: 480 } })] });
    assert.equal(stored(alice).length, 1);
    const r = stored(alice)[0];
    assert.equal(r.id, first.id);
    assert.equal(r.lines[1].foodId, "rice", "the confirmed link survived a re-import of the same line");
    assert.equal(r.nutrition.siteKcalPerServing, 480, "the site's new figure sits beside the calculated one");
    assert.equal(r.nutrition.origin, "calculated");
    assert.equal(r.nutrition.perServing.kcal, 97.5, "390 kcal / 4 servings; the chicken line is unlinked, so incomplete");
    assert.equal(r.nutrition.complete, false);
    assert.equal(foodsFor(r.id).length, 1);
  });

  test("a personal recipe's food is personal; deleting any recipe soft-deletes its food", async () => {
    await post(asAlice, "/recipes/import", { recipes: [row({ scope: "personal" })] });
    const r = stored(alice)[0];
    assert.equal(foodsFor(r.id)[0].owner_user_id, alice);
    assert.equal((await callRoute(mealPlanRoutes, "DELETE", `/recipes/${r.id}`, asAlice())).status, 200);
    assert.ok(foodsFor(r.id)[0].deleted_at);
    assert.deepEqual(stored(alice), []);
  });
});
