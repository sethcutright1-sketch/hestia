// The amount step's arithmetic (src/sections/food/amount.ts): servings or grams, the live kcal, where an
// edit starts, and what an edit sends. The preview must agree with what the server then stores, so those
// cases are checked against the real diary routes.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { newApi } from "./helpers/nutritionApi.ts";
import { TODAY } from "./helpers/nutritionWorld.ts";
import {
  GRAMS, canMeasureInGrams, computeAmount, defaultKcal, defaultServingLabel, editPatch, gramsToServings, qtyOnUnitChange, startAmount,
} from "../src/sections/food/amount.ts";
import type { Food } from "../src/sections/food/types.ts";

const food = (over: Partial<Food>): Food => ({
  id: "f1", name: "Food", brand: null, gtin14: null, basis: "per100g",
  nutrients: { kcal: 130, protein: 3, carbs: 28, fat: 0.4, satFat: 0, sugars: 0, fiber: 0, cholesterolMg: 0, sodiumMg: 0 },
  source: "custom", sourceRef: null, recipeId: null, scope: "joint", ownerUserId: null, createdByUserId: null, usageCount: 0, lastUsedAt: null,
  servings: [{ id: "cup", label: "1 cup", grams: 160, isDefault: true }, { id: "g100", label: "100 g", grams: 100, isDefault: false }],
  ...over,
});

const bar = food({
  id: "bar", name: "Bar", basis: "per_serving", nutrients: { kcal: 200, protein: 10, carbs: 20, fat: 5, satFat: 0, sugars: 0, fiber: 0, cholesterolMg: 0, sodiumMg: 0 },
  servings: [{ id: "bar1", label: "1 bar", grams: 50, isDefault: true }],
});
const barNoWeight = food({ ...bar, id: "bar2", servings: [{ id: "s", label: "1 piece", grams: null, isDefault: true }] });

describe("computeAmount", () => {
  test("a per-100 g food: servings of a named serving, or grams", () => {
    const cups = computeAmount(food({}), { qty: "2", unit: "cup" })!;
    assert.deepEqual([cups.nutrients.kcal, cups.grams, cups.unit, cups.quantity], [416, 320, "1 cup", 2]);
    assert.deepEqual(cups.body, { quantity: 2, servingId: "cup" });
    const g = computeAmount(food({}), { qty: "150", unit: GRAMS })!;
    assert.deepEqual([g.nutrients.kcal, g.grams, g.unit, g.quantity], [195, 150, "g", 150]);
    assert.deepEqual(g.body, { grams: 150 });
  });

  test("a per-serving food: a count of its serving, scaled", () => {
    const c = computeAmount(bar, { qty: "1.5", unit: "bar1" })!;
    assert.deepEqual([c.nutrients.kcal, c.nutrients.protein, c.grams, c.unit], [300, 15, 75, "1 bar"]);
    assert.deepEqual(c.body, { quantity: 1.5, servingId: "bar1" });
  });

  test("a per-serving food with a known serving weight can be measured in grams, as a fraction of a serving", () => {
    assert.equal(canMeasureInGrams(bar), true);
    const c = computeAmount(bar, { qty: "25", unit: GRAMS })!;
    assert.deepEqual([c.quantity, c.nutrients.kcal, c.grams, c.unit], [0.5, 100, 25, "1 bar"]);
    assert.deepEqual(c.body, { quantity: 0.5, servingId: "bar1" });
  });

  test("a per-serving food with no serving weight can't be measured in grams", () => {
    assert.equal(canMeasureInGrams(barNoWeight), false);
    assert.equal(computeAmount(barNoWeight, { qty: "25", unit: GRAMS }), null);
    assert.equal(canMeasureInGrams(food({})), true);
  });

  test("nothing usable until the number is above 0", () => {
    for (const qty of ["", " ", "0", "-1", "abc", "1e999x"]) assert.equal(computeAmount(food({}), { qty, unit: "cup" }), null, JSON.stringify(qty));
  });

  test("an unknown unit falls back to the default serving", () => {
    assert.equal(computeAmount(food({}), { qty: "1", unit: "nope" })!.unit, "1 cup");
  });
});

describe("parity with the server", () => {
  test("the preview equals what the diary stores, for servings and grams, per-100 g and per-serving foods", async (t) => {
    const api = await newApi(t);
    const made = await api.call("ann", "POST", "/foods", {
      name: "Rice", basis: "per100g", nutrients: { kcal: 130, protein: 3, carbs: 28, fat: 0.4 },
      servings: [{ label: "1 cup", grams: 158, isDefault: true }, { label: "100 g", grams: 100 }],
    });
    const madeBar = await api.call("ann", "POST", "/foods", {
      name: "Bar", basis: "per_serving", nutrients: { kcal: 187, protein: 9, carbs: 21, fat: 6.5 }, servings: [{ label: "1 bar", grams: 47 }],
    });
    const cases: Array<[Food, { qty: string; unit: string }]> = [];
    for (const f of [made.body as Food, madeBar.body as Food]) {
      const def = f.servings.find((s) => s.isDefault)!;
      cases.push([f, { qty: "1", unit: def.id }], [f, { qty: "2.5", unit: def.id }], [f, { qty: "0.33", unit: def.id }]);
      if (f.basis === "per100g") cases.push([f, { qty: "137", unit: GRAMS }], [f, { qty: "1", unit: f.servings.find((s) => !s.isDefault)!.id }]);
      else cases.push([f, { qty: "33", unit: GRAMS }]);
    }
    for (const [f, input] of cases) {
      const mine = computeAmount(f, input)!;
      const res = await api.call("ann", "POST", `/diary/${TODAY}`, { slot: "lunch", foodId: f.id, ...mine.body });
      assert.equal(res.status, 201, JSON.stringify([f.name, input, res.body]));
      const e = res.body.entry;
      assert.deepEqual(
        [mine.nutrients.kcal, mine.nutrients.protein, mine.nutrients.carbs, mine.nutrients.fat, mine.unit, mine.grams],
        [e.nutrients.kcal, e.nutrients.protein, e.nutrients.carbs, e.nutrients.fat, e.unit, e.grams],
        JSON.stringify([f.name, input]),
      );
    }
  });
});

describe("startAmount", () => {
  test("a new entry starts at 1 of the default serving", () => {
    assert.deepEqual(startAmount(food({})), { qty: "1", unit: "cup" });
    assert.deepEqual(startAmount(bar), { qty: "1", unit: "bar1" });
  });
  test("an existing entry starts at the amount it was logged in", () => {
    assert.deepEqual(startAmount(food({}), { foodId: "f1", grams: 150 }), { qty: "150", unit: GRAMS });
    assert.deepEqual(startAmount(food({}), { foodId: "f1", quantity: 2, servingId: "g100" }), { qty: "2", unit: "g100" });
    assert.deepEqual(startAmount(bar, { foodId: "bar", quantity: 0.5 }), { qty: "0.5", unit: "bar1" });
  });
  test("a serving id that no longer exists falls back to the default serving", () => {
    assert.deepEqual(startAmount(food({}), { foodId: "f1", quantity: 3, servingId: "gone" }), { qty: "3", unit: "cup" });
  });
});

describe("qtyOnUnitChange", () => {
  test("to grams: 100 for a per-100 g food, the serving's weight for a per-serving one", () => {
    assert.equal(qtyOnUnitChange(food({}), "1", "cup", GRAMS), "100");
    assert.equal(qtyOnUnitChange(bar, "1", "bar1", GRAMS), "50");
  });
  test("back from the untouched gram default resets to 1; a number the person typed is kept", () => {
    assert.equal(qtyOnUnitChange(food({}), "100", GRAMS, "cup"), "1");
    assert.equal(qtyOnUnitChange(food({}), "2", GRAMS, "cup"), "2");
    assert.equal(qtyOnUnitChange(food({}), "3", "cup", "cup"), "3");
  });
});

describe("gramsToServings / defaults", () => {
  test("grams over the serving weight", () => {
    assert.equal(gramsToServings(bar, 25), 0.5);
    assert.equal(gramsToServings(bar, 0), null);
    assert.equal(gramsToServings(barNoWeight, 25), null);
  });
  test("result-row defaults", () => {
    assert.equal(defaultKcal(food({})), 208); // 160 g of a 130 kcal/100 g food
    assert.equal(defaultKcal(bar), 200);
    assert.equal(defaultServingLabel(food({})), "1 cup");
    assert.equal(defaultServingLabel(food({ servings: [] })), "100 g");
    assert.equal(defaultServingLabel(bar), "1 bar");
  });
});

describe("editPatch", () => {
  const f = food({});
  const start = { qty: "1", unit: "cup" };
  test("changing only the number keeps the entry's own values: just a quantity", () => {
    const now = { qty: "2", unit: "cup" };
    assert.deepEqual(editPatch(start, now, computeAmount(f, now)!, "1 cup"), { quantity: 2 });
  });
  test("changing the unit re-measures: servingId, or grams", () => {
    const toG = { qty: "150", unit: GRAMS };
    assert.deepEqual(editPatch(start, toG, computeAmount(f, toG)!, "1 cup"), { grams: 150 });
    const toServing = { qty: "2", unit: "g100" };
    assert.deepEqual(editPatch(start, toServing, computeAmount(f, toServing)!, "1 cup"), { quantity: 2, servingId: "g100" });
  });
  test("a gram edit of an entry that wasn't stored in grams re-measures instead of treating grams as a count", () => {
    const gStart = { qty: "160", unit: GRAMS };
    const now = { qty: "200", unit: GRAMS };
    assert.deepEqual(editPatch(gStart, now, computeAmount(f, now)!, "1 cup"), { grams: 200 });
    assert.deepEqual(editPatch(gStart, now, computeAmount(f, now)!, "g"), { quantity: 200 });
  });
});
