// tests/budgetFormat.test.ts -- src/sections/budget/format.ts's formatMoney,
// the one place amounts get thousands separators before being displayed.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { formatMoney } from "../src/sections/budget/format.ts";

describe("formatMoney", () => {
  test("adds thousands separators", () => {
    assert.equal(formatMoney(1200, "$"), "$1,200.00");
  });

  test("a negative amount gets a leading minus before the currency symbol", () => {
    assert.equal(formatMoney(-1200, "$"), "-$1,200.00");
  });

  test("sign: true adds a leading plus for positive amounts, but not zero", () => {
    assert.equal(formatMoney(50, "$", { sign: true }), "+$50.00");
    assert.equal(formatMoney(0, "$", { sign: true }), "$0.00");
  });

  test("sign: true still uses a minus, not a double sign, for negatives", () => {
    assert.equal(formatMoney(-50, "$", { sign: true }), "-$50.00");
  });

  test("decimals: 0 rounds to whole dollars", () => {
    assert.equal(formatMoney(1234.5, "$", { decimals: 0 }), "$1,235");
  });

  test("respects a non-default currency symbol", () => {
    assert.equal(formatMoney(1200, "€"), "€1,200.00");
  });
});
