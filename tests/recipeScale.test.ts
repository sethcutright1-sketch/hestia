// scaleLineText / formatAmount (nutrition/recipeModel.ts): the servings stepper in the recipe viewer and Cook mode
// multiplies the leading amount of an ingredient line and nothing else.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { scaleLineText, formatAmount } from "../nutrition/recipeModel.ts";

describe("formatAmount", () => {
  test("whole numbers stay whole", () => {
    assert.equal(formatAmount(3), "3");
    assert.equal(formatAmount(2.99), "3");
  });
  test("lands on the fractions a cook measures in", () => {
    assert.equal(formatAmount(0.5), "½");
    assert.equal(formatAmount(1.25), "1 ¼");
    assert.equal(formatAmount(2.333), "2 ⅓");
    assert.equal(formatAmount(0.75), "¾");
  });
  test("falls back to a short decimal when no fraction is close", () => {
    assert.equal(formatAmount(0.45), "0.45");
  });
});

describe("scaleLineText", () => {
  test("scales a plain amount", () => {
    assert.equal(scaleLineText("2 cups flour", 2), "4 cups flour");
    assert.equal(scaleLineText("2 cups flour", 0.5), "1 cups flour");
  });
  test("reads mixed numbers, fractions, unicode fractions and decimals", () => {
    assert.equal(scaleLineText("2 1/2 cups flour", 2), "5 cups flour");
    assert.equal(scaleLineText("1/2 tsp salt", 3), "1 ½ tsp salt");
    assert.equal(scaleLineText("1½ cups milk", 2), "3 cups milk");
    assert.equal(scaleLineText("1.5 lb beef", 2), "3 lb beef");
  });
  test("keeps a leading bullet", () => {
    assert.equal(scaleLineText("- 2 eggs", 3), "- 6 eggs");
  });
  test("a factor of 1 or an unusable factor changes nothing", () => {
    assert.equal(scaleLineText("2 cups flour", 1), "2 cups flour");
    assert.equal(scaleLineText("2 cups flour", 0), "2 cups flour");
    assert.equal(scaleLineText("2 cups flour", -2), "2 cups flour");
    assert.equal(scaleLineText("2 cups flour", NaN), "2 cups flour");
  });
  test("a line with no amount is left alone", () => {
    assert.equal(scaleLineText("salt to taste", 2), "salt to taste");
    assert.equal(scaleLineText("fresh basil", 3), "fresh basil");
  });
  test("a range is left alone", () => {
    assert.equal(scaleLineText("1-2 cloves garlic", 2), "1-2 cloves garlic");
    assert.equal(scaleLineText("1 to 2 cloves garlic", 2), "1 to 2 cloves garlic");
  });
  test("a number that is part of a name is not an amount", () => {
    assert.equal(scaleLineText("7up", 2), "7up");
  });
  test("only the first amount is scaled", () => {
    assert.equal(scaleLineText("1 (14 oz) can tomatoes", 2), "2 (14 oz) can tomatoes");
  });
});
