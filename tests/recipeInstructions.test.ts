// "How to make it": the steps a recipe can carry (nutrition/recipeModel.ts cleanInstructions), where they come
// from (a page's schema.org recipeInstructions, the method section of pasted text, the typed form), how they are
// stored and read back through the recipe book's routes, the assistant's get_recipe lookup, and the recipe
// viewer's words and read-only rendering. A recipe saved before this existed must come through unchanged.

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { loadDb, cleanupDb } from "./helpers/testdb.ts";
import { callRoute } from "./helpers/router.ts";
import { MAX_STEPS, MAX_STEP_CHARS, cleanInstructions, cleanStep } from "../nutrition/recipeModel.ts";
import { extractRecipesFromHtml, instructionTexts, parseRecipeText } from "../routes/recipeImport.ts";
import { caloriesText, recipeViewModel, safeLink, servingsText, stepsToText } from "../src/sections/mealplan/recipeView.ts";
import RecipeView from "../src/sections/mealplan/RecipeView.tsx";
import type { Recipe } from "../src/api.ts";

const loaded = await loadDb();
const { createUser, getScopedItems, db } = loaded;
const { mealPlanRoutes } = await import("../routes/mealplan.ts");
const { buildTools } = await import("../assistant/registry.ts");

let alice: string;
let bob: string;
let kiosk: string;
const as = (id: () => string) => () => ({ session: { userId: id() } });
const asAlice = as(() => alice);
const asKiosk = as(() => kiosk);

before(() => {
  alice = createUser("alice-ri", "not-a-real-hash", "Alice");
  bob = createUser("bob-ri", "not-a-real-hash", "Bob");
  kiosk = createUser("kiosk-ri", "not-a-real-hash", "Kitchen", "kiosk");
});
after(cleanupDb);
beforeEach(() => {
  db.exec("DELETE FROM recipes; DELETE FROM nutrition_food_servings; DELETE FROM nutrition_foods");
});

const post = (who: () => object, url: string, body: unknown) => callRoute(mealPlanRoutes, "POST", url, { ...who(), body });
const listFor = async (who: () => object) => (await callRoute(mealPlanRoutes, "GET", "/", who())).body.recipes as any[];

const ldPage = (recipe: object) => `<html><head><script type="application/ld+json">${JSON.stringify(recipe)}</script></head></html>`;
const base = { "@type": "Recipe", name: "Pancakes", recipeIngredient: ["2 cups flour", "1 egg"] };
const stepsOf = (instructions: unknown) => extractRecipesFromHtml(ldPage({ ...base, recipeInstructions: instructions }))[0].instructions;

describe("cleaning steps", () => {
  test("numbering and bullets come off, blanks go, whitespace is folded", () => {
    assert.deepEqual(
      cleanInstructions(["1. Mix the flour.", "  2) Add the egg  ", "Step 3: Fry it.", "Step 4 - Serve.", "- Eat", "", "   ", "10 minutes later, wash up."]),
      ["Mix the flour.", "Add the egg", "Fry it.", "Serve.", "Eat", "10 minutes later, wash up."],
    );
    assert.equal(cleanStep("Stir\n\n  well"), "Stir well");
  });

  test("a bare 'Step 2' label line is not a step, and text splits on lines", () => {
    assert.deepEqual(cleanInstructions("Step 1\nMix.\nStep 2\nBake.\r\n3. Cool."), ["Mix.", "Bake.", "Cool."]);
  });

  test("capped at 60 steps of 2000 characters, anything that is not a list or text is nothing", () => {
    const many = Array.from({ length: 80 }, (_, i) => `do thing ${i}`);
    assert.equal(cleanInstructions(many).length, MAX_STEPS);
    assert.equal(MAX_STEPS, 60);
    const long = cleanInstructions(["x".repeat(5000)]);
    assert.equal(long[0].length, MAX_STEP_CHARS);
    assert.equal(MAX_STEP_CHARS, 2000);
    assert.deepEqual([cleanInstructions(undefined), cleanInstructions(null), cleanInstructions(42), cleanInstructions({})], [[], [], [], []]);
  });
});

describe("steps in a page's JSON-LD", () => {
  test("one string, with line breaks and numbering", () => {
    assert.deepEqual(stepsOf("1. Mix.\n2. Fry."), ["Mix.", "Fry."]);
  });

  test("a list of strings", () => {
    assert.deepEqual(stepsOf(["Mix.", "Fry."]), ["Mix.", "Fry."]);
  });

  test("HowToStep objects (text first, name when there is no text)", () => {
    assert.deepEqual(
      stepsOf([{ "@type": "HowToStep", text: "Mix." }, { "@type": "HowToStep", name: "Fry.", text: "" }, { "@type": "HowToStep", name: "Serve" }]),
      ["Mix.", "Fry.", "Serve"],
    );
  });

  test("HowToSection objects: their steps are in order, the section title is not a step", () => {
    assert.deepEqual(
      stepsOf([
        { "@type": "HowToSection", name: "For the batter", itemListElement: [{ "@type": "HowToStep", text: "Whisk." }, { "@type": "HowToStep", text: "Rest it." }] },
        { "@type": "HowToSection", name: "To cook", itemListElement: { "@type": "HowToStep", text: "Fry." } },
      ]),
      ["Whisk.", "Rest it.", "Fry."],
    );
  });

  test("HTML tags are stripped and entities decoded; block tags separate steps", () => {
    assert.deepEqual(
      stepsOf("<p>Heat the oven to 350&deg;F &amp; grease a <b>tin</b>.</p><p>Don&#39;t overmix &#x2014; 30&nbsp;seconds.</p><ol><li>Bake</li><li>Cool</li></ol>"),
      ["Heat the oven to 350°F & grease a tin.", "Don't overmix — 30 seconds.", "Bake", "Cool"],
    );
    // An escaped tag in the text is text, not a tag.
    assert.deepEqual(stepsOf(["Use &lt;b&gt; sparingly"]), ["Use <b> sparingly"]);
  });

  test("nothing, or nonsense, means no instructions field at all; the rest of the recipe is unaffected", () => {
    for (const bad of [undefined, null, 5, [], "", "  ", [{ "@type": "HowToStep" }]]) {
      const [r] = extractRecipesFromHtml(ldPage({ ...base, recipeInstructions: bad }));
      assert.equal(r.instructions, undefined, JSON.stringify(bad));
      assert.deepEqual(r.ingredients, ["flour", "egg"]);
    }
    assert.deepEqual(instructionTexts({ itemListElement: [] }), []);
  });
});

describe("steps in pasted text", () => {
  test("the section under Instructions / Method / Directions / Steps is kept, numbering stripped", () => {
    for (const heading of ["Instructions", "Method:", "Directions", "STEPS", "Preparation"]) {
      const r = parseRecipeText(`Pancakes\n\nIngredients:\n- 2 cups flour\n- 1 egg\n\n${heading}\n1. Mix the flour and egg.\n2) Fry in a pan.\nStep 3: Serve hot.\n`);
      assert.ok(r, heading);
      assert.deepEqual(r.instructions, ["Mix the flour and egg.", "Fry in a pan.", "Serve hot."], heading);
      assert.deepEqual(r.ingredients, ["flour", "egg"], "the method does not leak into the ingredients");
    }
  });

  test("no method section, or an empty one, leaves the field off", () => {
    assert.equal(parseRecipeText("Toast\nIngredients\nbread")!.instructions, undefined);
    assert.equal(parseRecipeText("Toast\nIngredients\nbread\nMethod:\n\n")!.instructions, undefined);
  });
});

describe("the recipe book routes", () => {
  test("typed with steps: saved, trimmed, and read back by everyone who can see it", async () => {
    const res = await post(asAlice, "/recipes", { name: "Pancakes", ingredients: "2 cups flour, 1 egg", instructions: "1. Mix.\n\n2. Fry.\n" });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.recipe.instructions, ["Mix.", "Fry."]);
    assert.deepEqual((await listFor(as(() => bob))).map((r) => r.instructions), [["Mix.", "Fry."]]);
  });

  test("typed without steps: no field; saving the same name again without steps keeps the old ones", async () => {
    const first = (await post(asAlice, "/recipes", { name: "Pancakes", ingredients: ["flour"] })).body.recipe;
    assert.equal("instructions" in first, false);
    await post(asAlice, "/recipes", { name: "Pancakes", ingredients: ["flour"], instructions: ["Fry."] });
    const again = (await post(asAlice, "/recipes", { name: "pancakes", ingredients: ["flour"] })).body.recipe;
    assert.deepEqual(again.instructions, ["Fry."], "a save that says nothing about steps leaves them alone");
  });

  test("an import row carries its steps, capped; a recipe from before this existed is returned byte for byte", async () => {
    const legacy = { id: "recipe-old", name: "Old stew", ingredients: ["beef", "carrots"], scope: "joint", createdBy: alice, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };
    db.prepare("INSERT INTO recipes (item_id, owner_user_id, data) VALUES (?, NULL, ?)").run(legacy.id, JSON.stringify(legacy));
    const rows = [{ name: "Soup", ingredients: ["leek"], instructions: Array.from({ length: 70 }, (_, i) => `do thing ${i + 1}`) }, { name: "Salad", ingredients: ["kale"], instructions: "not a list but text\nsecond line" }];
    const res = await post(asAlice, "/recipes/import", { recipes: rows });
    assert.equal(res.body.imported, 2);
    const byName = Object.fromEntries((await listFor(asAlice)).map((r) => [r.name, r]));
    assert.equal(byName["Soup"].instructions.length, 60);
    assert.deepEqual(byName["Salad"].instructions, ["not a list but text", "second line"]);
    assert.deepEqual(byName["Old stew"], legacy);
  });

  test("the kiosk login reads a joint recipe's steps but never another person's personal recipe", async () => {
    await post(asAlice, "/recipes", { name: "Family pie", ingredients: ["beef"], instructions: ["Bake."] });
    await post(asAlice, "/recipes", { name: "Secret loaf", ingredients: ["rye"], instructions: ["Knead."], scope: "personal" });
    const seen = await listFor(asKiosk);
    assert.deepEqual(seen.map((r) => [r.name, r.instructions]), [["Family pie", ["Bake."]]]);
    assert.deepEqual((await listFor(asAlice)).map((r) => r.name).sort(), ["Family pie", "Secret loaf"]);
  });
});

describe("the assistant", () => {
  const tool = (userId: string, name: string) => {
    const t = buildTools(userId).find((x) => x.name === name);
    assert.ok(t, name);
    return t as { run: (args: Record<string, any>) => Promise<any> };
  };
  const stored = () => getScopedItems("recipes", alice) as any[];

  test("get_recipe returns the steps and the lines as written; list_recipes stays short", async () => {
    await post(asAlice, "/recipes", { name: "Pancakes", ingredients: "2 cups flour, 1 egg", instructions: ["Mix.", "Fry."] });
    const got = await tool(alice, "get_recipe").run({ name: "pancakes" });
    assert.deepEqual([got.name, got.ingredients, got.instructions], ["Pancakes", ["2 cups flour", "1 egg"], ["Mix.", "Fry."]]);
    const list = await tool(alice, "list_recipes").run({});
    assert.deepEqual(Object.keys(list[0]).sort(), ["caloriesPerServing", "ingredients", "name"]);
    assert.doesNotMatch(JSON.stringify(list), /Fry/);
  });

  test("get_recipe says null when a recipe has no steps, suggests close names, and never shows a personal recipe", async () => {
    await post(asAlice, "/recipes", { name: "Toast", ingredients: ["bread"] });
    await post(asAlice, "/recipes", { name: "Secret loaf", ingredients: ["rye"], instructions: ["Knead."], scope: "personal" });
    assert.equal((await tool(alice, "get_recipe").run({ name: "Toast" })).instructions, null);
    const missing = await tool(alice, "get_recipe").run({ name: "Toats" });
    assert.match(missing.error, /No recipe named/);
    assert.deepEqual(missing.validValues, ["Toast"]);
    assert.match((await tool(alice, "get_recipe").run({ name: "Secret loaf" })).error, /No recipe named/);
  });

  test("save_recipe takes steps, keeps old ones when none are given, and reports how many", async () => {
    const saved = await tool(alice, "save_recipe").run({ name: "Omelette", ingredients: ["2 eggs"], instructions: ["Whisk.", " ", "Cook."] });
    assert.equal(saved.steps, 2);
    assert.deepEqual(stored().find((r) => r.name === "Omelette").instructions, ["Whisk.", "Cook."]);
    await tool(alice, "save_recipe").run({ name: "Omelette", ingredients: ["2 eggs", "cheese"] });
    assert.deepEqual(stored().find((r) => r.name === "Omelette").instructions, ["Whisk.", "Cook."]);
  });
});

describe("the viewer", () => {
  const recipe = (over: Partial<Recipe> = {}): Recipe => ({
    id: "r1", name: "Pancakes", ingredients: ["flour", "egg"], scope: "joint", createdBy: "u", createdAt: "x", updatedAt: "x", ...over,
  });
  const zero = { kcal: 0, protein: 0, carbs: 0, fat: 0, satFat: 0, sugars: 0, fiber: 0, cholesterolMg: 0, sodiumMg: 0 };
  const noop = () => {};

  test("the words: servings, calories (keeping 'partly estimated'), lines before names, only web links", () => {
    assert.equal(servingsText(recipe({ yieldServings: 4 })), "Makes 4 servings");
    assert.equal(servingsText(recipe({ yieldServings: 1 })), "Makes 1 serving");
    assert.equal(servingsText(recipe({ yieldServings: 4, yieldAssumed: true })), "Makes 4 servings (assumed)");
    assert.equal(servingsText(recipe()), null);
    assert.equal(caloriesText(recipe()), "No calories yet");
    assert.equal(caloriesText(recipe({ nutrition: { perServing: { ...zero, kcal: 319.6 }, origin: "calculated", complete: true } })), "320 kcal/serving");
    assert.equal(caloriesText(recipe({ nutrition: { perServing: { ...zero, kcal: 320 }, origin: "mixed", complete: false } })), "320 kcal/serving (partly estimated)");
    assert.equal(safeLink("javascript:alert(1)"), null);
    assert.equal(safeLink("https://example.com/p"), "https://example.com/p");
    const vm = recipeViewModel(recipe({ lines: [{ text: "2 cups flour", pantryName: "flour" }, { text: "1 egg", pantryName: "egg" }], instructions: ["Mix."] }));
    assert.deepEqual([vm.ingredients, vm.steps], [["2 cups flour", "1 egg"], ["Mix."]]);
    assert.deepEqual(recipeViewModel(recipe()).ingredients, ["flour", "egg"]);
    assert.equal(stepsToText(["a", "b"]), "a\nb");
    assert.equal(stepsToText(undefined), "");
  });

  test("a recipe with steps shows the title, ingredients and numbered steps; the kiosk gets no Add / Edit", () => {
    const r = recipe({ yieldServings: 4, instructions: ["Mix.", "Fry."], sourceUrl: "https://example.com/p" });
    const html = renderToStaticMarkup(h(RecipeView, { recipe: r, onClose: noop }));
    assert.match(html, /role="dialog"/);
    assert.match(html, /Pancakes/);
    assert.match(html, /Ingredients/);
    assert.match(html, /<ol[^>]*>.*Mix\..*Fry\./s);
    assert.match(html, /Makes 4 servings/);
    assert.match(html, /href="https:\/\/example.com\/p"/);
    assert.doesNotMatch(html, /Edit|Add instructions|<textarea/);
  });

  test("no steps: says so; Add instructions only when editing is allowed", () => {
    const readOnly = renderToStaticMarkup(h(RecipeView, { recipe: recipe(), onClose: noop }));
    assert.match(readOnly, /No instructions saved yet/);
    assert.doesNotMatch(readOnly, /Add instructions/);
    const editable = renderToStaticMarkup(h(RecipeView, { recipe: recipe(), onClose: noop, canEdit: true }));
    assert.match(editable, /No instructions saved yet/);
    assert.match(editable, /Add instructions/);
  });

  test("with editing allowed, a recipe with steps shows Edit, and opens in the box when asked", () => {
    const r = recipe({ instructions: ["Mix.", "Fry."] });
    assert.match(renderToStaticMarkup(h(RecipeView, { recipe: r, onClose: noop, canEdit: true })), /Edit/);
    const box = renderToStaticMarkup(h(RecipeView, { recipe: r, onClose: noop, canEdit: true, startEditing: true }));
    // The recipes overhaul replaced the one text box with a step list: one box per step, move/remove buttons, add a step,
    // and a way to paste a block (the old "one step per line" box is still how the Type it form takes steps).
    assert.match(box, /aria-label="Step 1"[^>]*>Mix\.<\/textarea>/);
    assert.match(box, /aria-label="Step 2"[^>]*>Fry\.<\/textarea>/);
    assert.match(box, /Add a step/);
    assert.match(box, /Paste a block of steps/);
    assert.match(box, /Save steps/);
    // The kiosk can't be talked into the edit box.
    assert.doesNotMatch(renderToStaticMarkup(h(RecipeView, { recipe: r, onClose: noop, canEdit: false, startEditing: true })), /<textarea/);
  });
});
