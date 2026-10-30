// The range buttons on this device (src/sections/food/weightRange.ts): the words on the buttons, and remembering the choice in
// localStorage without ever failing when the browser will not let a page use it.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_WEIGHT_RANGE, RANGE_LABELS, RANGE_STORAGE_KEY, RANGE_WORDS, WEIGHT_RANGES, loadRange, saveRange, type RangeStorage,
} from "../src/sections/food/weightRange.ts";

const memory = (initial: Record<string, string> = {}): RangeStorage & { data: Record<string, string> } => {
  const data = { ...initial };
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => { data[k] = v; } };
};
const refusing: RangeStorage = {
  getItem: () => { throw new Error("SecurityError: storage is blocked"); },
  setItem: () => { throw new Error("QuotaExceededError"); },
};

test("the buttons read 1M 3M 6M 1Y All, each with words for a screen reader", () => {
  assert.deepEqual(WEIGHT_RANGES.map((r) => RANGE_LABELS[r]), ["1M", "3M", "6M", "1Y", "All"]);
  assert.ok(WEIGHT_RANGES.every((r) => RANGE_WORDS[r].length > 0));
  assert.equal(DEFAULT_WEIGHT_RANGE, "1y");
});

test("loadRange: the last choice on this device; 1Y when there is none or it is not one of the five", () => {
  assert.equal(loadRange(memory()), "1y");
  for (const r of WEIGHT_RANGES) assert.equal(loadRange(memory({ [RANGE_STORAGE_KEY]: r })), r);
  for (const junk of ["", "1Y", "year", "2y", "null", "{}"]) assert.equal(loadRange(memory({ [RANGE_STORAGE_KEY]: junk })), "1y", junk);
});

test("saveRange then loadRange round-trips on the same device", () => {
  const store = memory();
  saveRange("3m", store);
  assert.equal(store.data[RANGE_STORAGE_KEY], "3m");
  assert.equal(loadRange(store), "3m");
  saveRange("all", store);
  assert.equal(loadRange(store), "all");
});

test("a browser that refuses (private window, blocked site data, no storage at all) never throws and falls back to 1Y", () => {
  assert.equal(loadRange(refusing), "1y");
  assert.doesNotThrow(() => saveRange("6m", refusing));
  assert.equal(loadRange(null), "1y");
  assert.doesNotThrow(() => saveRange("6m", null));
});

test("with no argument the browser's own storage is used, and where it does not exist (Node) that is the same as refusing", () => {
  assert.equal(loadRange(), "1y");
  assert.doesNotThrow(() => saveRange("1m"));
});
