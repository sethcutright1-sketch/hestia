// ingredients.ts -- matching food names written by different hands.
//
// These decide what lands on a shopping list (buying something already in the
// pantry, or failing to buy something needed) and whether a meal that conflicts
// with someone's dislikes gets caught. The comment on matchesAny calls out the
// case that matters most: "rice" should match "white rice" but not "rice
// vinegar", which is a different thing you'd still need to buy.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { normalizeName, matchesAny, computeMissing, computeMissingByMeal, findDislikeConflicts } from "../ingredients.ts";

describe("normalizeName", () => {
  test("trims, lowercases, and drops one trailing plural s", () => {
    assert.equal(normalizeName("  Bananas "), "banana");
    assert.equal(normalizeName("RICE"), "rice");
    assert.equal(normalizeName("Milk"), "milk");
  });

  test("survives empty and missing input", () => {
    assert.equal(normalizeName(""), "");
    assert.equal(normalizeName(undefined as any), "");
    assert.equal(normalizeName(null as any), "");
  });
});

describe("matchesAny", () => {
  test("matches an exact name and a whole word inside a longer one", () => {
    assert.equal(matchesAny("white rice", ["rice"]), true);
    assert.equal(matchesAny("Rice", ["rice"]), true);
    assert.equal(matchesAny("bananas", ["Banana"]), true);
  });

  test("does not match a different ingredient that merely contains the word", () => {
    // The documented case. "rice vinegar" is not rice.
    assert.equal(matchesAny("rice vinegar", ["rice"]), false);
  });

  test("does not match on a bare substring inside a word", () => {
    assert.equal(matchesAny("butterscotch chips", ["butter"]), false);
  });

  test("an empty ingredient or an empty pantry matches nothing", () => {
    assert.equal(matchesAny("", ["rice"]), false);
    assert.equal(matchesAny("rice", []), false);
    assert.equal(matchesAny("rice", [""]), false);
  });

  test("a name with regex metacharacters is matched literally, not as a pattern", () => {
    // escapeRegExp exists for this: an unescaped "." would match any character
    // and quietly start matching unrelated ingredients.
    assert.equal(matchesAny("half and half", ["a.d"]), false);
    assert.equal(matchesAny("chocolate m&m", ["m&m"]), true);
  });
});

describe("computeMissing", () => {
  const pantry = ["Rice", "Olive Oil", "Salt"];

  test("returns only what the pantry does not already cover", () => {
    const meals = [{ ingredients: ["rice", "chicken", "broccoli"] }];
    assert.deepEqual(computeMissing(meals, pantry), ["chicken", "broccoli"]);
  });

  test("skips denied meals -- you don't shop for a dinner you rejected", () => {
    const meals = [
      { ingredients: ["chicken"], status: "approved" },
      { ingredients: ["anchovies"], status: "denied" },
    ];
    assert.deepEqual(computeMissing(meals, pantry), ["chicken"]);
  });

  test("counts proposed meals, so the list is useful before everything is approved", () => {
    const meals = [{ ingredients: ["chicken"], status: "proposed" }];
    assert.deepEqual(computeMissing(meals, pantry), ["chicken"]);
  });

  test("dedupes an ingredient two meals both call for", () => {
    const meals = [{ ingredients: ["Chicken"] }, { ingredients: ["chickens"] }];
    assert.deepEqual(computeMissing(meals, pantry), ["Chicken"]);
  });

  test("keeps the original spelling rather than the normalized key", () => {
    // What gets written onto a shopping list is read by a person in a store.
    assert.deepEqual(computeMissing([{ ingredients: ["Fresh Basil"] }], pantry), ["Fresh Basil"]);
  });

  test("handles meals with no ingredients at all", () => {
    assert.deepEqual(computeMissing([{}, { ingredients: [] }], pantry), []);
  });

  test("an empty pantry means everything is missing", () => {
    assert.deepEqual(computeMissing([{ ingredients: ["rice", "salt"] }], []), ["rice", "salt"]);
  });
});

describe("findDislikeConflicts", () => {
  const members = [
    { id: "m1", name: "Alice", dislikes: ["mushrooms"] },
    { id: "m2", name: "Bob", dislikes: ["cilantro", "olives"] },
  ];

  test("flags a family meal against everyone's dislikes", () => {
    const meals = [{ id: "meal-1", ingredients: ["mushrooms", "cream"], audience: "family" as const }];
    const conflicts = findDislikeConflicts(meals, members);
    assert.equal(conflicts.length, 1);
    assert.deepEqual(conflicts[0], { mealId: "meal-1", member: "Alice", ingredient: "mushrooms" });
  });

  test("an individual meal only conflicts with that person's dislikes", () => {
    // A dish made just for Bob can't conflict with Alice's list -- she isn't
    // eating it.
    const meals = [
      { id: "meal-2", ingredients: ["mushrooms"], audience: "individual" as const, memberId: "m2" },
    ];
    assert.deepEqual(findDislikeConflicts(meals, members), []);
  });

  test("an individual meal still conflicts with its own eater's dislikes", () => {
    const meals = [
      { id: "meal-3", ingredients: ["cilantro"], audience: "individual" as const, memberId: "m2" },
    ];
    const conflicts = findDislikeConflicts(meals, members);
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].member, "Bob");
  });

  test("skips denied meals", () => {
    const meals = [{ id: "meal-4", ingredients: ["mushrooms"], status: "denied" }];
    assert.deepEqual(findDislikeConflicts(meals, members), []);
  });

  test("reports every conflict rather than stopping at the first", () => {
    // The comment is explicit that conflicts are surfaced, never silently
    // dropped -- the household decides whether tonight is worth an argument.
    const meals = [{ id: "meal-5", ingredients: ["mushrooms", "cilantro", "olives"] }];
    assert.equal(findDislikeConflicts(meals, members).length, 3);
  });

  test("members with no dislikes are skipped cleanly", () => {
    const meals = [{ id: "meal-6", ingredients: ["mushrooms"] }];
    assert.deepEqual(findDislikeConflicts(meals, [{ id: "m3", name: "Kid" }]), []);
  });

  test("matches a dislike inside a longer ingredient name", () => {
    const meals = [{ id: "meal-7", ingredients: ["sliced mushrooms"] }];
    assert.equal(findDislikeConflicts(meals, members).length, 1);
  });
});

describe("computeMissingByMeal", () => {
  const meal = (id: string, ingredients: string[], status = "proposed") =>
    ({ id, name: `Meal ${id}`, day: "Monday", slot: "dinner", ingredients, status });

  test("lists each meal's own shortfall, repeating shared ingredients", () => {
    const rows = computeMissingByMeal([meal("a", ["chicken", "rice"]), meal("b", ["chicken", "kale"])], ["rice"]);
    assert.deepEqual(rows.map((r) => [r.mealId, r.missing]), [["a", ["chicken"]], ["b", ["chicken", "kale"]]]);
  });

  test("marks a split-off meal with who it is for, so it differs from the family meal in the same slot", () => {
    const family = meal("a", ["turkey"]);
    const sam = { ...meal("b", ["turkey"]), audience: "individual" as const, memberId: "sam" };
    const rows = computeMissingByMeal([family, sam], []);
    assert.deepEqual(rows.map((r) => r.memberId), [undefined, "sam"]);
  });

  test("skips denied meals and meals with nothing missing", () => {
    const rows = computeMissingByMeal([meal("a", ["rice"]), meal("b", ["kale"], "denied")], ["rice"]);
    assert.deepEqual(rows, []);
  });
});
