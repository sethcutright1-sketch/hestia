// Calories for Kroger products (krogerNutrition.ts). The lookup is a fake: nothing here reaches
// Open Food Facts or USDA.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { caloriesOf, caloriesByUpc } from "../krogerNutrition.ts";

function result(over: Record<string, unknown> = {}): any {
  return { randomWeight: false, nameOnly: false, source: "off", servingText: "1 cup", servingGrams: 240, perServing: null, per100g: null, ...over };
}

describe("caloriesOf", () => {
  test("uses the per-serving figure, rounded, with the label's serving wording", () => {
    assert.deepEqual(caloriesOf(result({ perServing: { kcal: 121.6 } })), { kcal: 122, serving: "1 cup" });
  });

  test("scales per-100 g to the serving only when the serving's weight is known", () => {
    assert.deepEqual(caloriesOf(result({ per100g: { kcal: 50 }, servingGrams: 240 })), { kcal: 120, serving: "1 cup" });
    assert.equal(caloriesOf(result({ per100g: { kcal: 50 }, servingGrams: null })), null);
  });

  test("a serving with no wording still counts", () => {
    assert.deepEqual(caloriesOf(result({ perServing: { kcal: 90 }, servingText: null })), { kcal: 90, serving: null });
  });

  test("name-only answers, UPCitemdb, random-weight labels and missing data show nothing", () => {
    assert.equal(caloriesOf(result({ nameOnly: true, perServing: { kcal: 90 } })), null);
    assert.equal(caloriesOf(result({ source: "upcitemdb", perServing: { kcal: 90 } })), null);
    assert.equal(caloriesOf(result({ randomWeight: true, perServing: { kcal: 90 } })), null);
    assert.equal(caloriesOf(result({ source: null })), null);
    assert.equal(caloriesOf(result({ perServing: { kcal: null } })), null);
  });
});

describe("caloriesByUpc", () => {
  test("looks each code up once, skips failures, and keeps going", async () => {
    const asked: string[] = [];
    const found = await caloriesByUpc(["1", "2", "2", "3"], async (upc) => {
      asked.push(upc);
      if (upc === "2") throw new Error("boom");
      return result({ perServing: { kcal: Number(upc) * 10 } });
    });
    assert.deepEqual(asked.sort(), ["1", "2", "3"]);
    assert.deepEqual([...found.keys()].sort(), ["1", "3"]);
  });

  test("past the budget it returns what it has and starts nothing new", async () => {
    const asked: string[] = [];
    const never = new Promise<never>(() => {});
    const found = await caloriesByUpc(
      ["fast", "slow", "later"],
      async (upc) => {
        asked.push(upc);
        if (upc === "fast") return result({ perServing: { kcal: 10 } });
        return never;
      },
      { budgetMs: 20, concurrency: 1 }
    );
    assert.deepEqual([...found.keys()], ["fast"]);
    assert.deepEqual(asked, ["fast", "slow"], "'later' was never started");
  });
});
