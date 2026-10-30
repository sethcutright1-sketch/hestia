// The scan tab's decisions (src/sections/food/scanFlow.ts): is it a barcode, is it an in-store label,
// what did the lookup's answer mean, which words to look for among your own foods.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  candidateQuery, checkCode, createPrefill, digitsOnly, displayCode, isScannableRead, lookupOutcome,
} from "../src/sections/food/scanFlow.ts";

describe("checkCode", () => {
  test("a real UPC-A, EAN-13 and EAN-8 are ok, with the 14-digit key", () => {
    assert.deepEqual(checkCode("016000275287"), { kind: "ok", gtin14: "00016000275287" });
    assert.deepEqual(checkCode("5449000000996"), { kind: "ok", gtin14: "05449000000996" });
    assert.deepEqual(checkCode("73513537"), { kind: "ok", gtin14: "00000073513537" });
    assert.deepEqual(checkCode(" 0160 0027 5287 "), { kind: "ok", gtin14: "00016000275287" }, "spaces are ignored");
  });

  test("a wrong check digit or length is invalid, not a lookup", () => {
    assert.deepEqual(checkCode("016000275288"), { kind: "invalid" });
    assert.deepEqual(checkCode("12345"), { kind: "invalid" });
    assert.deepEqual(checkCode(""), { kind: "invalid" });
    assert.deepEqual(checkCode("hello"), { kind: "invalid" });
  });

  test("in-store labels (UPC-A starting 2, EAN-13 starting 02) are labels and never looked up", () => {
    // 212345678909: UPC-A starting with 2 (check digit computed)
    assert.deepEqual(checkCode("212345678909"), { kind: "label", gtin14: "00212345678909" });
    // the same number as an EAN-13 starting 02
    assert.deepEqual(checkCode("0212345678909"), { kind: "label", gtin14: "00212345678909" });
    // a normal product starting with 0 or 5 is not a label
    assert.equal(checkCode("016000275287").kind, "ok");
    assert.equal(checkCode("5449000000996").kind, "ok");
  });

  test("UPC-E is expanded only when the camera says it is UPC-E", () => {
    assert.deepEqual(checkCode("04252614", "upc_e"), { kind: "ok", gtin14: "00042100005264" });
    assert.deepEqual(checkCode("04252614"), { kind: "invalid" }, "as an EAN-8 its check digit fails");
  });
});

describe("isScannableRead", () => {
  test("only a valid barcode ends a camera scan; a misread frame is ignored", () => {
    assert.equal(isScannableRead("016000275287"), true);
    assert.equal(isScannableRead("016000275288"), false);
    assert.equal(isScannableRead("https://example.com"), false);
  });
  test("an in-store label is still a valid read (it is then shown as a label)", () => {
    assert.equal(isScannableRead("212345678909"), true);
  });
});

describe("lookupOutcome", () => {
  test("200 and 201 are a food", () => {
    assert.equal(lookupOutcome({ status: 200 }), "food");
    assert.equal(lookupOutcome({ status: 201 }), "food");
  });
  test("404 'not found' and 503 'couldn't reach the databases' are different screens", () => {
    assert.equal(lookupOutcome({ status: 404, body: { lookupHit: false } }), "miss");
    assert.equal(lookupOutcome({ status: 503, body: { unavailable: true } }), "unavailable");
  });
  test("a 503 that is not ours (a proxy) is a plain error, never 'unavailable' or 'not found'", () => {
    assert.equal(lookupOutcome({ status: 503, body: {} }), "error");
    assert.equal(lookupOutcome({ status: 502 }), "error");
    assert.equal(lookupOutcome({ status: 504 }), "error");
  });
  test("422 randomWeight is a label; 422 without it is an error; 400 is invalid", () => {
    assert.equal(lookupOutcome({ status: 422, body: { randomWeight: true } }), "label");
    assert.equal(lookupOutcome({ status: 422, body: {} }), "error");
    assert.equal(lookupOutcome({ status: 400 }), "invalid");
  });
  test("no answer at all is the network; anything else is an error", () => {
    assert.equal(lookupOutcome(null), "network");
    assert.equal(lookupOutcome({ status: 500 }), "error");
    assert.equal(lookupOutcome({ status: 423 }), "error");
  });
});

describe("candidateQuery", () => {
  test("sizes, counts and unit words are dropped; the first words of the name stay", () => {
    assert.equal(candidateQuery({ name: "Cheerios Cereal 18 oz" }), "Cheerios Cereal");
    assert.equal(candidateQuery({ name: "Greek Yogurt, 32 oz (2 lb) tub" }), "Greek Yogurt tub");
    assert.equal(candidateQuery({ name: "Oat-milk 1.5 L" }), "Oat milk");
  });
  test("falls back to the brand, then to nothing", () => {
    assert.equal(candidateQuery({ name: "  ", brand: "Kellogg's" }), "Kellogg s");
    assert.equal(candidateQuery({}), "");
    assert.equal(candidateQuery({ name: null, brand: null }), "");
  });
  test("at most six words", () => {
    assert.equal(candidateQuery({ name: "a1 b2 c3 d4 e5 f6 g7 h8" }).split(" ").length, 6);
  });
});

describe("displayCode / createPrefill / digitsOnly", () => {
  test("the shortest form the number is printed in", () => {
    assert.equal(displayCode("00016000275287"), "016000275287");
    assert.equal(displayCode("05449000000996"), "5449000000996");
    assert.equal(displayCode("00000073513537"), "73513537");
  });
  test("Create food is pre-filled with what the databases did know and the code as printed", () => {
    assert.deepEqual(createPrefill("00016000275287", { name: "Mystery Snack", brand: "Acme" }), { name: "Mystery Snack", brand: "Acme", barcode: "016000275287" });
    assert.deepEqual(createPrefill("00016000275287", null), { name: "", brand: "", barcode: "016000275287" });
  });
  test("typed digits", () => {
    assert.equal(digitsOnly("0160-0027 5287"), "016000275287");
  });
});
