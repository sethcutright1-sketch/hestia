import { test } from "node:test";
import assert from "node:assert/strict";
import { scaleNutrients, sumNutrients, fromServing, emptyNutrients, type Nutrients } from "../nutrition/nutrients.ts";

const banana: Nutrients = { kcal: 89, protein: 1.09, carbs: 22.84, fat: 0.33, satFat: 0.11, sugars: 12.23, fiber: 2.6, cholesterolMg: 0, sodiumMg: 1 };

test("scaleNutrients: per-100 g to grams, rounded at the edge", () => {
  const n = scaleNutrients(banana, 118);
  assert.equal(n.kcal, 105.02);
  assert.equal(n.protein, 1.29);
  assert.equal(n.sodiumMg, 1.18);
});

test("fromServing multiplies per-serving values", () => {
  assert.equal(fromServing({ ...emptyNutrients(), kcal: 150, fat: 5.5 }, 1.5).kcal, 225);
  assert.equal(fromServing({ ...emptyNutrients(), kcal: 150, fat: 5.5 }, 1.5).fat, 8.25);
});

test("sumNutrients doesn't accumulate float error", () => {
  const tenth: Nutrients = { ...emptyNutrients(), protein: 0.1 };
  const total = sumNutrients([tenth, { ...tenth, protein: 0.2 }]);
  assert.equal(total.protein, 0.3); // naive 0.1 + 0.2 = 0.30000000000000004
  assert.deepEqual(sumNutrients([]), emptyNutrients());
});
