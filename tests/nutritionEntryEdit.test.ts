// Editing a diary entry's amount from the Food section: a plain quantity change scales the stored
// snapshot (as it always did); a serving change measures the entry again against the food.

import { test } from "node:test";
import assert from "node:assert/strict";

import { newApi } from "./helpers/nutritionApi.ts";
import { TODAY } from "./helpers/nutritionWorld.ts";

const rice = {
  name: "Rice", basis: "per100g", nutrients: { kcal: 130, protein: 3, carbs: 28, fat: 0 },
  servings: [{ label: "1 cup", grams: 160, isDefault: true }, { label: "100 g", grams: 100 }],
};

test("a serving change re-measures the entry against the food; a quantity change still scales the snapshot", async (t) => {
  const api = await newApi(t);
  const food = (await api.call("ann", "POST", "/foods", rice)).body;
  const cup = food.servings.find((s: any) => s.label === "1 cup");
  const hundred = food.servings.find((s: any) => s.label === "100 g");
  const added = (await api.call("ann", "POST", `/diary/${TODAY}`, { slot: "lunch", foodId: food.id, quantity: 1, servingId: cup.id })).body.entry;
  assert.deepEqual([added.unit, added.grams, added.nutrients.kcal], ["1 cup", 160, 208]);

  // 150 g by weight
  const byWeight = (await api.call("ann", "PATCH", `/diary/entry/${added.id}`, { grams: 150 })).body.entry;
  assert.deepEqual([byWeight.unit, byWeight.quantity, byWeight.grams, byWeight.nutrients.kcal], ["g", 150, 150, 195]);

  // 2 x the 100 g serving
  const other = (await api.call("ann", "PATCH", `/diary/entry/${added.id}`, { servingId: hundred.id, quantity: 2 })).body.entry;
  assert.deepEqual([other.unit, other.quantity, other.grams, other.nutrients.kcal], ["100 g", 2, 200, 260]);

  // back to cups, then a plain quantity change scales that snapshot
  await api.call("ann", "PATCH", `/diary/entry/${added.id}`, { servingId: cup.id, quantity: 1 });
  const half = (await api.call("ann", "PATCH", `/diary/entry/${added.id}`, { quantity: 0.5 })).body.entry;
  assert.deepEqual([half.unit, half.quantity, half.nutrients.kcal], ["1 cup", 0.5, 104]);

  // the day total follows
  assert.equal((await api.call("ann", "GET", `/days/${TODAY}`)).body.eaten, 104);
});

test("a serving change is refused for a quick add, a foreign serving, or a food that is gone; the entry stays as it was", async (t) => {
  const api = await newApi(t);
  const food = (await api.call("ann", "POST", "/foods", rice)).body;
  const quick = (await api.call("ann", "POST", `/diary/${TODAY}`, { slot: "lunch", kcal: 300, name: "Mystery" })).body.entry;
  assert.equal((await api.call("ann", "PATCH", `/diary/entry/${quick.id}`, { grams: 100 })).status, 400);

  const e = (await api.call("ann", "POST", `/diary/${TODAY}`, { slot: "lunch", foodId: food.id, grams: 100 })).body.entry;
  assert.equal((await api.call("ann", "PATCH", `/diary/entry/${e.id}`, { servingId: "not-a-serving" })).status, 400);
  await api.call("ann", "DELETE", `/foods/${food.id}`);
  assert.equal((await api.call("ann", "PATCH", `/diary/entry/${e.id}`, { grams: 50 })).status, 400);
  const still = (await api.call("ann", "GET", `/diary/${TODAY}`)).body.slots.find((s: any) => s.key === "lunch").entries.find((x: any) => x.id === e.id);
  assert.deepEqual([still.unit, still.grams, still.nutrients.kcal], ["g", 100, 130]);
  // quantity alone still works on a deleted food
  assert.equal((await api.call("ann", "PATCH", `/diary/entry/${e.id}`, { quantity: 200 })).body.entry.nutrients.kcal, 260);
});
