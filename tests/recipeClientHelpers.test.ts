// The pure helpers behind the recipes overhaul screens (src/sections/mealplan): finding and sorting recipes, Cook mode's
// logic, and the step list editor. No browser: these are plain functions.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import type { Recipe } from "../src/api.ts";
import { allTags, filterRecipes, minutesText, photoUrl, sortRecipes, timesText, totalMinutes, type Marks } from "../src/sections/mealplan/recipeList.ts";
import { adjustServings, clampStep, keyAction, scaledIngredients, servingsFactor, stepLabel } from "../src/sections/mealplan/cookMode.ts";
import { addStep, appendPasted, moveStep, removeStep, sameSteps, stepsToSave, updateStep } from "../src/sections/mealplan/stepsEdit.ts";
import { ingredientText, withIngredientText, type ParsedRecipe } from "../src/sections/mealplan/ImportPreview.tsx";

const recipe = (name: string, over: Partial<Recipe> = {}): Recipe => ({
  id: `id-${name}`, name, ingredients: ["beef"], scope: "joint", createdBy: "u", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", ...over,
});
const kcal = (n: number): Recipe["nutrition"] => ({ perServing: { kcal: n } as any, origin: "calculated", complete: true });

const chili = recipe("Beef Chili", { tags: ["quick", "crockpot"], ingredients: ["beef", "beans"], nutrition: kcal(450), prepMinutes: 15, cookMinutes: 60, createdAt: "2026-03-01T00:00:00Z" });
const tacos = recipe("Tacos", { tags: ["quick"], ingredients: ["tortillas", "beef"], nutrition: kcal(380), prepMinutes: 10, createdAt: "2026-02-01T00:00:00Z" });
const soup = recipe("Lentil soup", { ingredients: ["lentils"], lines: [{ text: "1 cup red lentils", pantryName: "lentils" }], createdAt: "2026-04-01T00:00:00Z" });
const all = [chili, tacos, soup];
const marks: Marks = { [chili.id]: { favorite: true, rating: 4 }, [soup.id]: { favorite: false, rating: 5 } };
const names = (rs: Recipe[]) => rs.map((r) => r.name);

describe("filterRecipes", () => {
  test("no filter keeps everything", () => {
    assert.deepEqual(names(filterRecipes(all, marks, {})), ["Beef Chili", "Tacos", "Lentil soup"]);
  });
  test("every word must appear in the name, an ingredient, a line or a tag, in any order and case", () => {
    assert.deepEqual(names(filterRecipes(all, marks, { query: "BEEF quick" })), ["Beef Chili", "Tacos"]);
    assert.deepEqual(names(filterRecipes(all, marks, { query: "red lentils" })), ["Lentil soup"]);
    assert.deepEqual(names(filterRecipes(all, marks, { query: "crockpot chili" })), ["Beef Chili"]);
    assert.deepEqual(filterRecipes(all, marks, { query: "zzz" }), []);
  });
  test("tag, favourites and minimum rating", () => {
    assert.deepEqual(names(filterRecipes(all, marks, { tag: "quick" })), ["Beef Chili", "Tacos"]);
    assert.deepEqual(names(filterRecipes(all, marks, { favoritesOnly: true })), ["Beef Chili"]);
    assert.deepEqual(names(filterRecipes(all, marks, { minRating: 5 })), ["Lentil soup"]);
    assert.deepEqual(names(filterRecipes(all, marks, { minRating: 4 })), ["Beef Chili", "Lentil soup"]);
  });
  test("filters combine", () => {
    assert.deepEqual(names(filterRecipes(all, marks, { query: "beef", favoritesOnly: true, tag: "quick" })), ["Beef Chili"]);
  });
});

describe("sortRecipes", () => {
  test("by name, without changing the list it was given", () => {
    const copy = [...all];
    assert.deepEqual(names(sortRecipes(all, marks, "name")), ["Beef Chili", "Lentil soup", "Tacos"]);
    assert.deepEqual(all, copy);
  });
  test("favourites first, best rated, newest", () => {
    assert.deepEqual(names(sortRecipes(all, marks, "favorites")), ["Beef Chili", "Lentil soup", "Tacos"]);
    assert.deepEqual(names(sortRecipes(all, marks, "rating")), ["Lentil soup", "Beef Chili", "Tacos"]);
    assert.deepEqual(names(sortRecipes(all, marks, "newest")), ["Lentil soup", "Beef Chili", "Tacos"]);
  });
  test("fewest calories and quickest put a recipe without the figure last", () => {
    assert.deepEqual(names(sortRecipes(all, marks, "kcal")), ["Tacos", "Beef Chili", "Lentil soup"]);
    assert.deepEqual(names(sortRecipes(all, marks, "quickest")), ["Tacos", "Beef Chili", "Lentil soup"]);
  });
});

describe("tags, times and photos", () => {
  test("allTags counts, most used first", () => {
    assert.deepEqual(allTags(all), [{ tag: "quick", count: 2 }, { tag: "crockpot", count: 1 }]);
  });
  test("times", () => {
    assert.equal(totalMinutes(chili), 75);
    assert.equal(totalMinutes(soup), null);
    assert.equal(minutesText(75), "1 h 15 min");
    assert.equal(minutesText(60), "1 h");
    assert.equal(minutesText(45), "45 min");
    assert.equal(timesText(chili), "Prep 15 min · Cook 1 h");
    assert.equal(timesText(soup), null);
  });
  test("a photo address carries the cache-buster and only exists with a photo", () => {
    assert.equal(photoUrl(soup), null);
    assert.equal(photoUrl({ id: "r 1", photoAt: "2026-10-28T10:00:00Z" }), "/api/mealplan/recipes/r%201/photo?v=2026-10-28T10%3A00%3A00Z");
  });
});

describe("Cook mode", () => {
  test("the step stays inside the list", () => {
    assert.equal(clampStep(-3, 5), 0);
    assert.equal(clampStep(9, 5), 4);
    assert.equal(clampStep(2, 5), 2);
    assert.equal(clampStep(3, 0), 0);
    assert.equal(stepLabel(2, 8), "Step 3 of 8");
    assert.equal(stepLabel(20, 8), "Step 8 of 8");
  });
  test("keys", () => {
    assert.equal(keyAction("ArrowRight"), "next");
    assert.equal(keyAction(" "), "next");
    assert.equal(keyAction("ArrowLeft"), "prev");
    assert.equal(keyAction("Escape"), "close");
    assert.equal(keyAction("a"), null);
  });
  test("servings stepper is kept between 1 and 99, and scales the amounts", () => {
    assert.equal(adjustServings(1, -1), 1);
    assert.equal(adjustServings(99, 1), 99);
    assert.equal(adjustServings(4, 2), 6);
    assert.equal(servingsFactor(4, 6), 1.5);
    assert.equal(servingsFactor(undefined, 6), 1);
    assert.deepEqual(scaledIngredients(["2 cups flour", "salt to taste", "1-2 cloves garlic"], 2), ["4 cups flour", "salt to taste", "1-2 cloves garlic"]);
  });
});

describe("step list editing", () => {
  const steps = ["Mix", "Bake", "Serve"];
  test("move up and down, and off an end does nothing", () => {
    assert.deepEqual(moveStep(steps, 1, -1), ["Bake", "Mix", "Serve"]);
    assert.deepEqual(moveStep(steps, 1, 1), ["Mix", "Serve", "Bake"]);
    assert.deepEqual(moveStep(steps, 0, -1), steps);
    assert.deepEqual(moveStep(steps, 2, 1), steps);
    assert.deepEqual(steps, ["Mix", "Bake", "Serve"], "the original is not changed");
  });
  test("remove, update, add", () => {
    assert.deepEqual(removeStep(steps, 1), ["Mix", "Serve"]);
    assert.deepEqual(updateStep(steps, 2, "Eat"), ["Mix", "Bake", "Eat"]);
    assert.deepEqual(addStep(steps), ["Mix", "Bake", "Serve", ""]);
    assert.equal(addStep(Array.from({ length: 60 }, () => "x")).length, 60, "capped at 60");
  });
  test("a pasted block is split, numbering removed, and added after the steps already there", () => {
    assert.deepEqual(appendPasted(["Mix", ""], "1. Bake for 20 min.\n2) Cool.\n\nStep 3: Serve."), ["Mix", "Bake for 20 min.", "Cool.", "Serve."]);
  });
  test("what is saved is cleaned; no change is noticed", () => {
    assert.deepEqual(stepsToSave(["  Mix  ", "", "1. Bake"]), ["Mix", "Bake"]);
    assert.equal(sameSteps(["Mix ", "", "Bake"], ["Mix", "Bake"]), true);
    assert.equal(sameSteps(["Mix"], ["Mix", "Bake"]), false);
    assert.equal(sameSteps([], undefined), true);
  });
});

describe("the import preview's editable ingredients", () => {
  const parsed: ParsedRecipe = {
    name: "Pancakes", ingredients: ["flour", "egg"], lines: [{ text: "2 cups flour", pantryName: "flour" }, { text: "1 egg", pantryName: "egg" }],
    instructions: ["Mix."], yieldServings: 4,
  };
  test("the box shows the lines as written when the parser kept them, else the names, one per line", () => {
    assert.equal(ingredientText(parsed), "2 cups flour\n1 egg");
    assert.equal(ingredientText({ name: "x", ingredients: ["a", "b"] }), "a\nb");
  });
  test("editing the text drops the parser's lines so they are rebuilt, keeps everything else, and ignores blank lines", () => {
    const edited = withIngredientText(parsed, "3 cups flour\n\n  1 egg \nmilk");
    assert.equal(edited.lines, undefined);
    assert.deepEqual(edited.ingredients, ["3 cups flour", "1 egg", "milk"]);
    assert.deepEqual([edited.name, edited.instructions, edited.yieldServings], ["Pancakes", ["Mix."], 4]);
    assert.ok(parsed.lines, "the original row is not changed");
  });
});
