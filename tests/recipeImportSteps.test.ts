// Recipe import, round two (routes/recipeImport.ts, routes/mealplan.ts): steps and servings come in from CSV and JSON
// uploads (NUTRITION_ASSUMPTIONS R.10), and a recipe's source link can be re-read to see what changed, without writing.

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { loadDb, cleanupDb } from "./helpers/testdb.ts";
import { callRoute } from "./helpers/router.ts";
import { parseRecipesFromCsv, parseRecipesFromJson, pickPageRecipe } from "../routes/recipeImport.ts";

const loaded = await loadDb();
const { createUser, getScopedItems, setConfig, db } = loaded as any;
const { mealPlanRoutes, pageFetcher } = await import("../routes/mealplan.ts");

describe("steps and servings from uploads", () => {
  test("CSV: an instructions column, one step per line or separated by ' | ', and a servings column", () => {
    const csv = [
      "name,ingredients,instructions,servings",
      '"Chili","beef, beans","1. Brown the beef.\n2. Add beans and simmer.",6',
      "Soup,water; salt,Boil water | Add salt,4 servings",
    ].join("\n");
    const [chili, soup] = parseRecipesFromCsv(csv);
    assert.deepEqual(chili.instructions, ["Brown the beef.", "Add beans and simmer."]);
    assert.equal(chili.yieldServings, 6);
    assert.deepEqual(soup.instructions, ["Boil water", "Add salt"]);
    assert.equal(soup.yieldServings, 4);
  });

  test("CSV without those columns reads as before", () => {
    const [r] = parseRecipesFromCsv("name,ingredients\nToast,bread; butter");
    assert.deepEqual(r, { name: "Toast", ingredients: ["bread", "butter"] });
  });

  test("JSON: steps as a list or text, under any of the usual names", () => {
    const json = JSON.stringify([
      { name: "A", ingredients: ["x"], instructions: ["Do one", "Do two"] },
      { name: "B", ingredients: ["y"], directions: "First\nSecond" },
      { name: "C", ingredients: ["z"], method: ["Only"], yield: "8 servings" },
      { name: "D", ingredients: ["w"], steps: "Step 1: Mix. Step 2: Bake." },
    ]);
    const [a, b, c, d] = parseRecipesFromJson(json);
    assert.deepEqual(a.instructions, ["Do one", "Do two"]);
    assert.deepEqual(b.instructions, ["First", "Second"]);
    assert.deepEqual(c.instructions, ["Only"]);
    assert.equal(c.yieldServings, 8);
    assert.ok(d.instructions && d.instructions.length >= 1);
  });

  test("steps are capped like every other path", () => {
    const steps = Array.from({ length: 80 }, (_, i) => `Step number ${i} here`);
    const [r] = parseRecipesFromJson(JSON.stringify([{ name: "Long", ingredients: ["x"], instructions: steps }]));
    assert.equal(r.instructions!.length, 60);
  });
});

describe("pickPageRecipe", () => {
  const found = [{ name: "Beef Chili", ingredients: ["beef"] }, { name: "Cornbread", ingredients: ["corn"] }];
  test("the same name (ignoring case and punctuation), else the only recipe on the page, else none", () => {
    assert.equal(pickPageRecipe(found, "beef chili!")?.name, "Beef Chili");
    assert.equal(pickPageRecipe([found[1]], "Something else")?.name, "Cornbread");
    assert.equal(pickPageRecipe(found, "Something else"), null);
    assert.equal(pickPageRecipe([], "Anything"), null);
  });
});

describe("POST /recipes/:id/refresh-from-url", () => {
  let alice: string, bob: string;
  const as = (userId: string) => ({ session: { userId } });
  const call = (method: string, url: string, userId: string) => callRoute(mealPlanRoutes, method, url, as(userId));
  const page = (recipe: object) => `<html><head><script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "Recipe", ...recipe })}</script></head></html>`;
  const realFetch = pageFetcher.fetch;
  let fetched: string[] = [];

  function addRecipe(over: Record<string, unknown> = {}) {
    const id = `recipe-${Math.random().toString(16).slice(2, 10)}`;
    const d = {
      id, name: "Beef Chili", ingredients: ["beef", "beans"], scope: "joint", createdBy: alice, createdAt: "x", updatedAt: "x",
      lines: [{ text: "2 cups beef", pantryName: "beef" }, { text: "1 can beans", pantryName: "beans" }],
      sourceUrl: "https://example.com/chili", yieldServings: 4, instructions: ["Brown beef.", "Simmer."], ...over,
    };
    db.prepare("INSERT INTO recipes (item_id, owner_user_id, data) VALUES (?, ?, ?)").run(id, d.scope === "personal" ? alice : null, JSON.stringify(d));
    return d as any;
  }

  before(() => {
    alice = createUser("alice-ri", "not-a-real-hash", "Alice", "parent");
    bob = createUser("bob-ri", "not-a-real-hash", "Bob", "parent");
  });
  after(() => { pageFetcher.fetch = realFetch; cleanupDb(); });
  beforeEach(() => {
    db.exec("DELETE FROM recipes");
    setConfig("lock_pin_hash", null);
    fetched = [];
    pageFetcher.fetch = async (url: string) => { fetched.push(url); return page({ name: "Beef Chili", recipeIngredient: ["2 cups beef", "1 can beans"], recipeInstructions: ["Brown beef.", "Simmer."], recipeYield: "4 servings" }); };
  });

  test("a page that still matches says nothing differs, and writes nothing", async () => {
    const r = addRecipe();
    const before = JSON.stringify(getScopedItems("recipes", alice));
    const res = await call("POST", `/recipes/${r.id}/refresh-from-url`, alice);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(fetched, ["https://example.com/chili"]);
    assert.deepEqual(res.body.differs, { lines: false, instructions: false, yieldServings: false });
    assert.equal(JSON.stringify(getScopedItems("recipes", alice)), before);
  });

  test("a changed page reports exactly what differs and what it now holds", async () => {
    const r = addRecipe();
    pageFetcher.fetch = async () => page({ name: "Beef Chili", recipeIngredient: ["2 cups beef", "1 can beans", "1 onion"], recipeInstructions: ["Brown beef.", "Add onion.", "Simmer."], recipeYield: "6" });
    const res = await call("POST", `/recipes/${r.id}/refresh-from-url`, alice);
    assert.deepEqual(res.body.differs, { lines: true, instructions: true, yieldServings: true });
    assert.deepEqual(res.body.page.lines, ["2 cups beef", "1 can beans", "1 onion"]);
    assert.deepEqual(res.body.page.instructions, ["Brown beef.", "Add onion.", "Simmer."]);
    assert.equal(res.body.page.yieldServings, 6);
  });

  test("a recipe with no source link is a 400; a page without the recipe is a 422; a failed fetch is a 400 with its message", async () => {
    const none = addRecipe({ sourceUrl: undefined });
    assert.equal((await call("POST", `/recipes/${none.id}/refresh-from-url`, alice)).status, 400);
    const r = addRecipe();
    pageFetcher.fetch = async () => page({ name: "Totally different dish", recipeIngredient: ["x"] }) + page({ name: "Another", recipeIngredient: ["y"] });
    assert.equal((await call("POST", `/recipes/${r.id}/refresh-from-url`, alice)).status, 422);
    pageFetcher.fetch = async () => { throw new Error("That link resolves to a private network."); };
    const failed = await call("POST", `/recipes/${r.id}/refresh-from-url`, alice);
    assert.equal(failed.status, 400);
    assert.match(failed.body.error, /private network/);
  });

  test("someone else's personal recipe is a 404 and nothing is fetched", async () => {
    const mine = addRecipe({ scope: "personal" });
    assert.equal((await call("POST", `/recipes/${mine.id}/refresh-from-url`, bob)).status, 404);
    assert.deepEqual(fetched, []);
  });
});
