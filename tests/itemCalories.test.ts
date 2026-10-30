// Calories on pantry and shopping-list items (itemCalories.ts, routes/itemCaloriesFill.ts and the
// two "calories/fill" routes). The barcode service, the food catalogue and the model are all fakes:
// nothing here reaches a network or a model.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import { loadDb, cleanupDb } from "./helpers/testdb.ts";
import { callRoute } from "./helpers/router.ts";
import { fillMissingCalories, parseEstimates, estimateWithProvider, type CalorieItem } from "../itemCalories.ts";

const { createUser, putScopedItem, getScopedItem } = await loadDb();
const { pantryRoutes } = await import("../routes/pantry.ts");
const { groceryRoutes } = await import("../routes/grocery.ts");
const { sameFoodName, setFillSourcesForTests } = await import("../routes/itemCaloriesFill.ts");

const fixedNow = () => new Date("2026-10-17T12:00:00.000Z");
const labelFor = (kcal: number) => ({ randomWeight: false, nameOnly: false, source: "off", servingText: "1 cup", servingGrams: 240, perServing: { kcal }, per100g: null }) as any;

describe("fillMissingCalories", () => {
  test("tries barcode, then catalogue, then the model, and records which one answered", async () => {
    const items: CalorieItem[] = [{ name: "Cheerios", barcode: "0016000275287" }, { name: "milk" }, { name: "weird jam" }];
    const summary = await fillMissingCalories(items, {
      lookup: async () => labelFor(110),
      foodByName: (n) => (n === "milk" ? { kcal: 122, serving: "1 cup (244 g)" } : null),
      estimate: async (names) => Object.fromEntries(names.map((n) => [n, { kcal: 55, serving: "1 tbsp" }])),
      modelLabel: "Claude (test)",
      now: fixedNow,
    });
    assert.deepEqual(items.map((i) => [i.calories?.source, i.calories?.kcal, i.calories?.model]), [
      ["barcode", 110, null],
      ["food_db", 122, null],
      ["estimate", 55, "Claude (test)"],
    ]);
    assert.equal(items[0].calories?.at, "2026-10-17T12:00:00.000Z");
    assert.deepEqual(summary, { alreadyHad: 0, barcode: 1, foodDb: 1, estimated: 1, stillMissing: 0 });
  });

  test("never overwrites a figure an item already has, and never asks the model about it", async () => {
    const had = { kcal: 999, serving: null, source: "barcode" as const, model: null, at: "x" };
    const items: CalorieItem[] = [{ name: "oats", calories: had }];
    let asked = 0;
    const summary = await fillMissingCalories(items, { estimate: async () => { asked++; return {}; } });
    assert.equal(items[0].calories, had);
    assert.equal(asked, 0);
    assert.equal(summary.alreadyHad, 1);
  });

  test("a model failure or no model leaves items blank instead of failing", async () => {
    const items: CalorieItem[] = [{ name: "a" }, { name: "b" }];
    const failed = await fillMissingCalories(items, { estimate: async () => { throw new Error("down"); } });
    assert.equal(failed.stillMissing, 2);
    const none = await fillMissingCalories(items, {});
    assert.equal(none.stillMissing, 2);
  });

  test("asks the model in batches of 25 and once per distinct name", async () => {
    const items: CalorieItem[] = Array.from({ length: 60 }, (_, i) => ({ name: `food ${i % 55}` }));
    const batches: number[] = [];
    await fillMissingCalories(items, { estimate: async (names) => { batches.push(names.length); return {}; } });
    assert.deepEqual(batches, [25, 25, 5]);
  });
});

describe("parseEstimates", () => {
  test("reads the array through a code fence and chatter, keeping only sane answers about names that were asked", () => {
    const reply = 'Sure!\n```json\n[{"name":"milk","kcal":122.4,"serving":"1 cup"},{"name":"rock","kcal":-5},{"name":"cake","kcal":99999},{"name":"stranger","kcal":10},{"name":"rice","kcal":200}]\n```';
    assert.deepEqual(parseEstimates(reply, ["milk", "rock", "cake", "rice"]), {
      milk: { kcal: 122, serving: "1 cup" },
      rice: { kcal: 200, serving: null },
    });
  });

  test("prose, bad JSON and non-arrays give nothing", () => {
    assert.deepEqual(parseEstimates("I can't help", ["milk"]), {});
    assert.deepEqual(parseEstimates("[not json]", ["milk"]), {});
    assert.deepEqual(parseEstimates('{"name":"milk","kcal":1}', ["milk"]), {});
  });
});

describe("estimateWithProvider", () => {
  test("sends only the names, with no tools, and parses the reply", async () => {
    let seen: any;
    const provider = {
      id: "anthropic",
      label: "Fake",
      chat: async (messages: any[], tools: any[]) => {
        seen = { messages, tools };
        return { reply: '[{"name":"milk","kcal":120,"serving":"1 cup"}]', steps: [], exhausted: false };
      },
    } as any;
    assert.deepEqual(await estimateWithProvider(provider, ["milk"]), { milk: { kcal: 120, serving: "1 cup" } });
    assert.deepEqual(seen.tools, []);
    assert.equal(seen.messages[1].content, '["milk"]');
  });
});

describe("sameFoodName", () => {
  test("matches the part of a catalogue name before the first comma, plural or not", () => {
    assert.equal(sameFoodName("Milk, whole", "milk"), true);
    assert.equal(sameFoodName("Eggs, large", "egg"), true);
    assert.equal(sameFoodName("Egg", "eggs"), true);
    assert.equal(sameFoodName("Milk chocolate", "milk"), false);
    assert.equal(sameFoodName("Chocolate milk", "milk"), false);
  });
});

describe("routes", () => {
  let admin: string;
  before(() => {
    admin = createUser("calorie-admin", "not-a-real-hash", "Cal");
    setFillSourcesForTests({
      lookup: async (b) => (b === "0016000275287" ? labelFor(110) : Promise.reject(new Error("unknown"))),
      foodByName: (n) => (n === "milk" ? { kcal: 122, serving: "1 cup" } : null),
    });
  });
  after(() => {
    setFillSourcesForTests(null);
    cleanupDb();
  });

  const as = () => ({ session: { userId: admin } });
  const pantryItem = (id: string, name: string, over: Record<string, unknown> = {}) =>
    putScopedItem("pantry_items", admin, { id, name, quantity: "1", scope: "joint", updatedAt: "", updatedBy: admin, ...over });

  test("pantry fill uses barcode data and the catalogue, saves only the gained figures, and says what is left", async () => {
    pantryItem("p-cheerios", "Cheerios", { barcode: "0016000275287" });
    pantryItem("p-milk", "milk");
    pantryItem("p-mystery", "mystery sauce");
    const res = await callRoute(pantryRoutes, "POST", "/calories/fill", { ...as(), body: {} });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.summary, { alreadyHad: 0, barcode: 1, foodDb: 1, estimated: 0, stillMissing: 1 });
    assert.equal((getScopedItem("pantry_items", admin, "p-cheerios") as any).calories.source, "barcode");
    assert.equal((getScopedItem("pantry_items", admin, "p-milk") as any).calories.kcal, 122);
    assert.equal((getScopedItem("pantry_items", admin, "p-mystery") as any).calories, undefined);
  });

  test("an unknown model is refused before anything is changed", async () => {
    pantryItem("p-x", "x");
    const res = await callRoute(pantryRoutes, "POST", "/calories/fill", { ...as(), body: { provider: "skynet" } });
    assert.equal(res.status, 400);
  });

  test("editing a pantry item keeps its figure, but renaming it drops the figure", async () => {
    pantryItem("p-edit", "milk", { calories: { kcal: 122, serving: "1 cup", source: "food_db", model: null, at: "x" } });
    await callRoute(pantryRoutes, "PUT", "/p-edit", { ...as(), body: { quantity: "2" } });
    assert.equal((getScopedItem("pantry_items", admin, "p-edit") as any).calories.kcal, 122);
    await callRoute(pantryRoutes, "PUT", "/p-edit", { ...as(), body: { name: "oat milk" } });
    assert.equal((getScopedItem("pantry_items", admin, "p-edit") as any).calories, undefined);
  });

  test("list fill gives list items figures, and renaming a list item drops its figure", async () => {
    const now = new Date().toISOString();
    putScopedItem("shopping_lists", admin, {
      id: "list-cal", name: "Cal", scope: "joint", status: "active", createdBy: admin, createdAt: now, updatedAt: now,
      items: [{ id: "i1", name: "milk", quantity: "", category: "Other", notes: "", checked: false, addedBy: admin }],
    });
    const res = await callRoute(groceryRoutes, "POST", "/lists/list-cal/calories/fill", { ...as(), body: {} });
    assert.equal(res.status, 200);
    assert.equal(res.body.list.items[0].calories.source, "food_db");
    const renamed = await callRoute(groceryRoutes, "PUT", "/lists/list-cal/items/i1", { ...as(), body: { name: "soy milk" } });
    assert.equal(renamed.body.item.calories, undefined);
  });
});
