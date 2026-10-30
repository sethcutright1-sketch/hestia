// The recipe overhaul's pure helpers (nutrition/recipeModel.ts): tags, minutes, notes, rating, and the rule for
// whether an edited ingredient line still means the same thing (so a calorie link survives a typo fix but not a
// changed amount or a different food).

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { cleanTags, cleanMinutes, cleanNotes, cleanRating, sameLineMeaning, editDistance, MAX_TAGS, MAX_TAG_CHARS, MAX_NOTES_CHARS } from "../nutrition/recipeModel.ts";

describe("cleanTags", () => {
  test("lower-cases, trims, drops a leading #, folds spaces and removes duplicates", () => {
    assert.deepEqual(cleanTags(["Quick ", "#Crockpot", "kid   friendly", "QUICK"]), ["quick", "crockpot", "kid friendly"]);
  });
  test("reads comma or line separated text", () => {
    assert.deepEqual(cleanTags("quick, dinner\nfreezer"), ["quick", "dinner", "freezer"]);
  });
  test("drops empties, caps each tag and the count", () => {
    const many = Array.from({ length: 30 }, (_, i) => `t${i}`);
    assert.equal(cleanTags(many).length, MAX_TAGS);
    assert.equal(cleanTags(["x".repeat(100)])[0].length, MAX_TAG_CHARS);
    assert.deepEqual(cleanTags(["", "  ", "#"]), []);
  });
  test("anything else is an empty list", () => {
    assert.deepEqual(cleanTags(undefined), []);
    assert.deepEqual(cleanTags(42), []);
  });
});

describe("cleanMinutes", () => {
  test("whole minutes from a number or numeric text", () => {
    assert.equal(cleanMinutes(25), 25);
    assert.equal(cleanMinutes("45"), 45);
    assert.equal(cleanMinutes(10.4), 10);
  });
  test("blank, zero, negative, too long or not a number is not set", () => {
    for (const v of [undefined, null, "", 0, -5, 1441, "abc", NaN]) assert.equal(cleanMinutes(v), undefined, String(v));
  });
});

describe("cleanNotes and cleanRating", () => {
  test("notes are trimmed and capped; blank is not set", () => {
    assert.equal(cleanNotes("  Use less salt.  "), "Use less salt.");
    assert.equal(cleanNotes("   "), undefined);
    assert.equal(cleanNotes("x".repeat(MAX_NOTES_CHARS + 50))!.length, MAX_NOTES_CHARS);
  });
  test("a rating is a whole number 1 to 5, else not rated", () => {
    assert.equal(cleanRating(4), 4);
    assert.equal(cleanRating("5"), 5);
    for (const v of [0, 6, 2.5, -1, "", null, undefined, "great"]) assert.equal(cleanRating(v), undefined, String(v));
  });
});

describe("editDistance", () => {
  test("counts single-letter edits", () => {
    assert.equal(editDistance("rice", "rice"), 0);
    assert.equal(editDistance("rice", "ricee"), 1);
    assert.equal(editDistance("rice", "quinoa"), 5);
  });
});

describe("sameLineMeaning", () => {
  test("the same line, or a case or spacing change, is the same", () => {
    assert.equal(sameLineMeaning("2 cups rice", "2 cups rice"), true);
    assert.equal(sameLineMeaning("2 cups rice", "2 Cups  Rice"), true);
  });
  test("a typo fix in the food name keeps its meaning", () => {
    assert.equal(sameLineMeaning("2 cups ricee", "2 cups rice"), true);
    assert.equal(sameLineMeaning("1 tbsp olive oyl", "1 tbsp olive oil"), true);
  });
  test("a changed amount does not", () => {
    assert.equal(sameLineMeaning("2 cups rice", "1 cup rice"), false);
    assert.equal(sameLineMeaning("2 cups rice", "2 tbsp rice"), false);
  });
  test("a different food does not", () => {
    assert.equal(sameLineMeaning("2 cups rice", "2 cups quinoa"), false);
    assert.equal(sameLineMeaning("1 egg", "1 egg white"), false);
  });
  test("an amount written two ways is still the same amount", () => {
    assert.equal(sameLineMeaning("2 1/2 cups flour", "2.5 cups flour"), true);
  });
});
