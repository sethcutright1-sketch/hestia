import { test } from "node:test";
import assert from "node:assert/strict";
import { gs1CheckDigitValid, expandUpcE, canonicalGtin, lookupVariants, isRandomWeight } from "../nutrition/barcode.ts";

test("check digit: valid across lengths", () => {
  assert.ok(gs1CheckDigitValid("016000275287")); // UPC-A Cheerios
  assert.ok(gs1CheckDigitValid("0016000275287")); // EAN-13 form
  assert.ok(gs1CheckDigitValid("00016000275287")); // GTIN-14 form
  assert.ok(gs1CheckDigitValid("73513537")); // EAN-8
  assert.ok(!gs1CheckDigitValid("016000275288"));
  assert.ok(!gs1CheckDigitValid("abc"));
});

test("UPC-E expands to UPC-A", () => {
  assert.equal(expandUpcE("04252614"), "042100005264");
  assert.equal(expandUpcE("425261"), "042100005264"); // 6-digit: check computed
  assert.equal(expandUpcE("0425261"), "042100005264"); // 7-digit
  // One case per expansion rule (last digit 0-2, 3, 4, 5-9); the 11-digit body is
  // worked out by hand and the computed check digit must make a valid UPC-A.
  const cases: Record<string, string> = {
    "123450": "01200000345",
    "123451": "01210000345",
    "123453": "01230000045",
    "123454": "01234000005",
    "123455": "01234500005",
    "123459": "01234500009",
  };
  for (const [core, body] of Object.entries(cases)) {
    const up = expandUpcE(core);
    assert.equal(up.slice(0, 11), body, core);
    assert.ok(gs1CheckDigitValid(up), core);
  }
  assert.equal(expandUpcE("21234565"), ""); // number system 2 has no UPC-E
  assert.equal(expandUpcE("123"), "");
});

test("canonicalGtin: Cheerios forms collapse to one key", () => {
  const a = canonicalGtin("016000275287");
  assert.equal(a?.gtin14, "00016000275287");
  assert.equal(canonicalGtin("0016000275287")?.gtin14, a?.gtin14);
  assert.equal(canonicalGtin("00016000275287")?.gtin14, a?.gtin14);
});

test("canonicalGtin: UPC-E only expands with the format hint", () => {
  assert.equal(canonicalGtin("04252614", "upc_e")?.gtin14, "00042100005264");
  assert.equal(canonicalGtin("04252614"), null); // as EAN-8 the checksum fails
});

test("canonicalGtin: rejects bad checksum/length, accepts EAN-8, strips non-digits", () => {
  assert.equal(canonicalGtin("016000275288"), null);
  assert.equal(canonicalGtin("123"), null);
  assert.equal(canonicalGtin(""), null);
  assert.equal(canonicalGtin("73513537", "ean_8")?.gtin14, "00000073513537");
  assert.equal(canonicalGtin(" 0-16000-27528-7 ")?.gtin14, "00016000275287");
});

test("lookupVariants", () => {
  assert.deepEqual(lookupVariants("00016000275287"), ["00016000275287", "0016000275287", "016000275287"]);
  assert.deepEqual(lookupVariants("00000073513537"), [
    "00000073513537",
    "0000073513537",
    "000073513537",
    "73513537",
  ]);
  assert.deepEqual(lookupVariants("10016000275284"), ["10016000275284"]);
});

test("isRandomWeight", () => {
  assert.ok(isRandomWeight("00212345000005")); // UPC-A starting 2
  assert.ok(isRandomWeight("02123450000005")); // EAN-13 starting 2
  assert.ok(!isRandomWeight("00016000275287"));
});
