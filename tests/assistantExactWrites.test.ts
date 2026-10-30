// Writes that target an existing thing by name must match it EXACTLY. findByName's substring fallback is right for reads
// ("Weekly Grocery" -> the Weekly Groceries list) but, on a write, one wrong hit changes or deletes the wrong thing:
// add_pantry_item("flour") updated "Almond flour" instead of adding flour. This pins both halves: writes are exact and
// refuse with suggestions; reads still fuzzy-match.

import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

import { loadDb, cleanupDb } from "./helpers/testdb.ts";
import type { ScopedTable } from "../db.ts";

const { createUser, putScopedItem, getScopedItems, deleteScopedItem } = await loadDb();
const { buildTools } = await import("../assistant/registry.ts");

let alice: string;
const NOW = "2026-10-01T00:00:00.000Z";

after(cleanupDb);

function callAs(name: string, args: Record<string, any> = {}): Promise<any> {
  const tool = buildTools(alice).find((t) => t.name === name);
  assert.ok(tool, name);
  return tool.run(args);
}
const pantry = () => (getScopedItems("pantry_items", alice) as any[]).map((i) => `${i.name}|${i.quantity}`).sort();

before(() => {
  alice = createUser("alice-exact", "not-a-real-hash", "Alice");
});

function clear(collection: ScopedTable) {
  for (const row of getScopedItems(collection, alice) as any[]) deleteScopedItem(collection, alice, row.id);
}
function seedPantry(...rows: [string, string][]) {
  clear("pantry_items");
  rows.forEach(([name, quantity], i) =>
    putScopedItem("pantry_items", alice, { id: `p${i}`, name, quantity, scope: "joint", updatedAt: NOW, updatedBy: alice })
  );
}

describe("pantry", () => {
  beforeEach(() => seedPantry(["Almond flour", "1 bag"], ["Rice", "2 boxes"]));

  test("add_pantry_item('flour') ADDS flour; it does not update Almond flour", async () => {
    const r = await callAs("add_pantry_item", { name: "flour", quantity: "5 lb" });
    assert.equal(r.action, "added");
    assert.equal(r.name, "flour");
    assert.deepEqual(pantry(), ["Almond flour|1 bag", "Rice|2 boxes", "flour|5 lb"]);
  });

  test("an exact name (any casing) still updates in place instead of duplicating", async () => {
    const r = await callAs("add_pantry_item", { name: "  rice ", quantity: "3 boxes" });
    assert.equal(r.action, "updated");
    assert.equal(r.name, "Rice", "the stored spelling is kept");
    assert.deepEqual(pantry(), ["Almond flour|1 bag", "Rice|3 boxes"]);
  });

  test("remove_pantry_item with a partial name deletes nothing and suggests the real name", async () => {
    const r = await callAs("remove_pantry_item", { name: "flour" });
    assert.match(r.error, /No item in the pantry named "flour"/);
    assert.deepEqual(r.validValues, ["Almond flour"]);
    assert.match(r.hint, /Did you mean "Almond flour"/);
    assert.deepEqual(pantry(), ["Almond flour|1 bag", "Rice|2 boxes"]);
  });

  test("remove_pantry_item with the exact name deletes just that item", async () => {
    const r = await callAs("remove_pantry_item", { name: "almond FLOUR" });
    assert.deepEqual(r, { removed: "Almond flour" });
    assert.deepEqual(pantry(), ["Rice|2 boxes"]);
  });

  test("a name that matches nothing and is close to nothing has no suggestions", async () => {
    const r = await callAs("remove_pantry_item", { name: "bananas" });
    assert.match(r.error, /No item in the pantry named "bananas"/);
    assert.equal(r.validValues, undefined);
  });
});

describe("shopping lists", () => {
  beforeEach(async () => {
    clear("shopping_lists");
    await callAs("create_shopping_list", { name: "Weekly Groceries" });
    await callAs("create_shopping_list", { name: "Hardware Run" });
  });

  test("add_shopping_item to a partial list name is refused, with the real name suggested", async () => {
    const r = await callAs("add_shopping_item", { list: "Weekly", name: "milk" });
    assert.match(r.error, /No shopping list named "Weekly"/);
    assert.deepEqual(r.validValues, ["Weekly Groceries"]);
    const lists = getScopedItems("shopping_lists", alice) as any[];
    assert.ok(lists.every((l) => l.items.length === 0), "nothing was added anywhere");
  });

  test("add_shopping_item to the exact name works, in any casing", async () => {
    const r = await callAs("add_shopping_item", { list: "weekly groceries", name: "milk" });
    assert.equal(r.to, "Weekly Groceries");
    assert.equal(r.totalItems, 1);
  });

  test("reads still fuzzy-match: get_shopping_list 'Weekly Grocery' finds Weekly Groceries via the hint path, 'Weekly' finds it directly", async () => {
    // A partial name is a substring of the real one, so the read resolves it.
    const partial = await callAs("get_shopping_list", { list: "Weekly" });
    assert.equal(partial.name, "Weekly Groceries");
    // A near-miss is not a substring: the read answers with the did-you-mean.
    const near = await callAs("get_shopping_list", { list: "Weekly Grocery" });
    assert.deepEqual(near.validValues, ["Weekly Groceries"]);
  });
});

describe("meal requests", () => {
  beforeEach(() => {
    clear("meal_requests");
    for (const [id, name] of [["mr1", "Tacos al pastor"], ["mr2", "Lasagna"]]) {
      putScopedItem("meal_requests", alice, { id, name, notes: "", scope: "joint", createdBy: alice, createdAt: NOW, updatedAt: NOW });
    }
  });
  const names = () => (getScopedItems("meal_requests", alice) as any[]).map((r) => r.name).sort();

  test("remove_meal_request with a partial name clears nothing and suggests the real one", async () => {
    const r = await callAs("remove_meal_request", { name: "Tacos" });
    assert.match(r.error, /No meal request named "Tacos"/);
    assert.deepEqual(r.validValues, ["Tacos al pastor"]);
    assert.deepEqual(names(), ["Lasagna", "Tacos al pastor"]);
  });

  test("the exact name clears it", async () => {
    assert.deepEqual(await callAs("remove_meal_request", { name: "lasagna" }), { cleared: "Lasagna" });
    assert.deepEqual(names(), ["Tacos al pastor"]);
  });
});

describe("reads keep the fuzzy fallback", () => {
  test("get_recipe finds a recipe from part of its name", async () => {
    putScopedItem("recipes", alice, { id: "r1", name: "Chicken Stir Fry", ingredients: ["chicken"], scope: "joint", createdBy: alice, createdAt: NOW, updatedAt: NOW });
    const r = await callAs("get_recipe", { name: "stir fry" });
    assert.equal(r.name, "Chicken Stir Fry");
  });
});
