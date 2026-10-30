// assistant/tools/shared.ts -- the helpers every domain tool module calls.
//
// These decide whether a model's tool call finds the row the person meant.
// Getting them wrong doesn't throw; it just quietly acts on the wrong item, or
// tells the model nothing exists when something does.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { round2, inMonth, findByName, cleanNames, closestNames, suggestNames, notFound } from "../assistant/tools/shared.ts";

describe("round2", () => {
  test("clears binary floating-point dust", () => {
    // The reason this function exists: 0.1 + 0.2 is 0.30000000000000004, and
    // that string ends up in front of a person on a budget screen.
    assert.equal(round2(0.1 + 0.2), 0.3);
    assert.equal(round2(1.1 * 3), 3.3);
  });

  test("rounds half away from zero at the cent, within float limits", () => {
    assert.equal(round2(2.675), 2.68);
    // Documented, not endorsed: 1.005 is really 1.00499...  in binary, so it
    // rounds DOWN. Any money path that needs exact half-up behaviour has to
    // work in integer cents, not floats -- this function cannot give it.
    assert.equal(round2(1.005), 1);
  });

  test("leaves already-round values alone and keeps sign", () => {
    assert.equal(round2(12), 12);
    assert.equal(round2(-4.567), -4.57);
    assert.equal(round2(0), 0);
  });
});

describe("inMonth", () => {
  test("no month filter matches everything", () => {
    assert.equal(inMonth({ date: "2026-03-15" }), true);
    assert.equal(inMonth({}), true);
  });

  test("matches on the YYYY-MM prefix", () => {
    assert.equal(inMonth({ date: "2026-03-15" }, "2026-03"), true);
    assert.equal(inMonth({ date: "2026-04-01" }, "2026-03"), false);
    // Same month number, different year -- a prefix match on "-03" alone would
    // wrongly pass this.
    assert.equal(inMonth({ date: "2025-03-15" }, "2026-03"), false);
  });

  test("a record with no date never matches a specific month", () => {
    assert.equal(inMonth({}, "2026-03"), false);
    assert.equal(inMonth({ date: undefined }, "2026-03"), false);
  });
});

describe("findByName", () => {
  const items = [
    { id: "list-1", name: "Milk Chocolate" },
    { id: "list-2", name: "Milk" },
    { id: "list-3", name: "Weekly Groceries" },
  ];

  test("an exact name wins over a substring that was listed first", () => {
    // The ordering inside findByName is the whole point: asking for "milk"
    // must not get "Milk Chocolate" just because it appears earlier.
    assert.equal(findByName(items, "milk")?.id, "list-2");
  });

  test("matches names case- and whitespace-insensitively", () => {
    assert.equal(findByName(items, "  WEEKLY groceries ")?.id, "list-3");
  });

  test("falls back to an exact id", () => {
    assert.equal(findByName(items, "list-1")?.id, "list-1");
  });

  test("falls back to a substring when nothing matches exactly", () => {
    assert.equal(findByName(items, "chocolate")?.id, "list-1");
  });

  test("returns undefined when nothing matches at all", () => {
    assert.equal(findByName(items, "bananas"), undefined);
  });

  describe("{ exact: true }, for writes", () => {
    test("matches by name (case- and whitespace-insensitive) or by id, like the default", () => {
      assert.equal(findByName(items, "  MILK ", { exact: true })?.id, "list-2");
      assert.equal(findByName(items, "list-3", { exact: true })?.id, "list-3");
    });

    test("never falls back to a substring", () => {
      assert.equal(findByName(items, "chocolate", { exact: true }), undefined);
      assert.equal(findByName(items, "Weekly", { exact: true }), undefined);
      // ...while the default still does, which is what reads rely on.
      assert.equal(findByName(items, "Weekly")?.id, "list-3");
    });
  });
});

describe("suggestNames", () => {
  const pantry = [{ name: "Almond flour" }, { name: "Rice" }, { name: "Olive oil" }];

  test("offers a name that contains the request, which closestNames misses", () => {
    assert.deepEqual(closestNames(pantry, "flour"), []);
    assert.deepEqual(suggestNames(pantry, "flour"), ["Almond flour"]);
  });

  test("offers a name the request contains, and typo-close names, without duplicates", () => {
    assert.deepEqual(suggestNames(pantry, "rice krispies"), ["Rice"]);
    assert.deepEqual(suggestNames(pantry, "Ryce"), ["Rice"]);
    assert.deepEqual(suggestNames(pantry, "rice"), ["Rice"]);
  });

  test("nothing close, or a blank request, suggests nothing", () => {
    assert.deepEqual(suggestNames(pantry, "bananas"), []);
    assert.deepEqual(suggestNames(pantry, "   "), []);
  });
});

describe("cleanNames", () => {
  test("trims, drops blanks, and preserves order", () => {
    assert.deepEqual(cleanNames(["  Milk ", "", "   ", "Bread"]), ["Milk", "Bread"]);
  });

  test("dedupes on the normalized name, keeping the first spelling given", () => {
    // normalizeName strips a trailing "s", so these are one item -- a list
    // that says both "Apple" and "apples" should be shopped for once.
    assert.deepEqual(cleanNames(["Apple", "apples", "APPLE"]), ["Apple"]);
  });

  test("a non-array (the model sent prose, or nothing) is empty, not a crash", () => {
    assert.deepEqual(cleanNames("milk, bread"), []);
    assert.deepEqual(cleanNames(undefined), []);
    assert.deepEqual(cleanNames(null), []);
  });

  test("coerces non-string entries rather than dropping them", () => {
    assert.deepEqual(cleanNames([42, "Bread"]), ["42", "Bread"]);
  });
});

describe("closestNames", () => {
  const items = [{ name: "Milk" }, { name: "Bread" }, { name: "Bananas" }];

  test("suggests a near typo", () => {
    assert.deepEqual(closestNames(items, "mlik"), ["Milk"]);
    assert.deepEqual(closestNames(items, "bred"), ["Bread"]);
  });

  test("suggests nothing when nothing is actually close", () => {
    // The important half: a wrong suggestion sends the model confidently down
    // the wrong path, which is worse than an honest dead end.
    assert.deepEqual(closestNames(items, "lawnmower"), []);
  });

  test("an empty needle suggests nothing", () => {
    assert.deepEqual(closestNames(items, "   "), []);
  });

  test("respects the limit and orders by closeness", () => {
    const many = [{ name: "Milk" }, { name: "Milky" }, { name: "Milt" }, { name: "Mild" }];
    const got = closestNames(many, "milk", 2);
    assert.equal(got.length, 2);
    assert.equal(got[0], "Milk");
  });
});

describe("notFound", () => {
  test("omits the hint entirely when there is nothing to suggest", () => {
    const err = notFound("shopping list", "lawnmower", []);
    assert.equal(err.error, 'No shopping list named "lawnmower".');
    assert.equal("hint" in err, false);
    assert.equal("validValues" in err, false);
  });

  test("offers the real names when some are close", () => {
    const err = notFound("shopping list", "grocerys", ["Groceries"]);
    assert.equal(err.hint, 'Did you mean "Groceries"?');
    assert.deepEqual(err.validValues, ["Groceries"]);
  });

  test("joins several candidates readably", () => {
    const err = notFound("pantry item", "milc", ["Milk", "Milky Way"]);
    assert.equal(err.hint, 'Did you mean "Milk" or "Milky Way"?');
  });
});
