// The recipe importer: turning someone else's format into ours.
//
// Two things are load-bearing here and both are easy to get quietly wrong.
//
// First, quantity stripping. The pantry match in ingredients.ts works on the
// head noun, so a stored "2 1/2 cups all-purpose flour" never matches a pantry
// holding "flour" -- every imported recipe would then insist on buying things
// already in the cupboard, and nothing would look broken.
//
// Second, the URL fetch. It makes the server issue requests a user typed the
// address for, on a LAN that also hosts Ollama and this app's own admin routes,
// from a process whose .env.local holds live Plaid credentials. The guard is
// tested here against the addresses that actually matter rather than assumed.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  stripQuantity,
  parseRecipeText,
  parseRecipesFromJson,
  parseRecipesFromCsv,
  parseRecipesFromFile,
  extractRecipesFromHtml,
  assertSafeImportUrl,
} from "../routes/recipeImport.ts";

describe("stripQuantity", () => {
  test("drops amounts, units and bullets, keeping the food", () => {
    const cases: [string, string][] = [
      ["2 chicken breasts", "chicken breasts"],
      ["- 1 onion", "onion"],
      ["• 3 cloves garlic", "garlic"],
      ["2 1/2 cups all-purpose flour", "all-purpose flour"],
      ["1/2 tsp salt", "salt"],
      ["½ cup milk", "milk"],
      ["1. 200g beef mince", "beef mince"],
      ["1 (14 oz) can diced tomatoes", "diced tomatoes"],
      ["2 tbsp of olive oil", "olive oil"],
      ["3 chicken breasts, diced and seasoned", "chicken breasts"],
      ["Salt and pepper to taste", "Salt and pepper"],
      ["2-3 large potatoes", "potatoes"],
    ];
    for (const [input, expected] of cases) {
      assert.equal(stripQuantity(input), expected, `stripQuantity(${JSON.stringify(input)})`);
    }
  });

  test("leaves an already-clean name alone", () => {
    for (const name of ["chicken", "olive oil", "red pepper flakes"]) {
      assert.equal(stripQuantity(name), name);
    }
  });

  test("never strips a name down to nothing", () => {
    // Over-trimming is worse than under-trimming: a blank ingredient is
    // dropped entirely and silently shrinks the shopping list.
    for (const input of ["2 cups", "1 large", "3", "cup"]) {
      const out = stripQuantity(input);
      assert.equal(typeof out, "string");
    }
  });

  test("handles empty and junk input without throwing", () => {
    for (const input of ["", "   ", "-", "•"]) {
      assert.equal(stripQuantity(input), "");
    }
  });
});

describe("parseRecipeText", () => {
  test("reads a title, an Ingredients heading and a list", () => {
    const parsed = parseRecipeText(`Chicken Fajitas

Ingredients:
- 2 chicken breasts
- 1 red pepper
- 1 onion

Instructions:
1. Slice everything.
2. Fry it.`);

    assert.ok(parsed);
    assert.equal(parsed.name, "Chicken Fajitas");
    assert.deepEqual(parsed.ingredients, ["chicken breasts", "red pepper", "onion"]);
  });

  test("stops at the method, so steps never become ingredients", () => {
    const parsed = parseRecipeText(`Soup

Ingredients:
- 1 carrot

Method:
- Chop the carrot
- Boil for 20 minutes`);

    assert.ok(parsed);
    assert.deepEqual(parsed.ingredients, ["carrot"]);
  });

  test("works without an Ingredients heading", () => {
    const parsed = parseRecipeText(`Beans on Toast
2 slices bread
1 can baked beans`);

    assert.ok(parsed);
    assert.equal(parsed.name, "Beans on Toast");
    assert.deepEqual(parsed.ingredients, ["bread", "baked beans"]);
  });

  test("drops a markdown heading marker from the title", () => {
    const parsed = parseRecipeText("# Lasagne\n- 1 onion");
    assert.equal(parsed?.name, "Lasagne");
  });

  test("de-duplicates repeated ingredients", () => {
    const parsed = parseRecipeText("Stew\n- 1 onion\n- 2 onions\n- 1 Onion");
    assert.deepEqual(parsed?.ingredients, ["onion", "onions"]);
  });

  test("returns null rather than a half-recipe", () => {
    // A nameless or ingredient-less result would save a row the user then has
    // to find and delete.
    assert.equal(parseRecipeText(""), null);
    assert.equal(parseRecipeText("   \n  "), null);
    assert.equal(parseRecipeText("Just a title and nothing else"), null);
    assert.equal(parseRecipeText("Ingredients:\n- 1 onion"), null);
  });
});

describe("parseRecipesFromJson", () => {
  test("accepts a bare array", () => {
    const out = parseRecipesFromJson('[{"name":"Chilli","ingredients":["beef","beans"]}]');
    assert.deepEqual(out, [{ name: "Chilli", ingredients: ["beef", "beans"] }]);
  });

  test("accepts {recipes: [...]}, which is what this app's own export looks like", () => {
    const out = parseRecipesFromJson('{"recipes":[{"name":"Chilli","ingredients":["beef"]}]}');
    assert.equal(out.length, 1);
  });

  test("accepts title/ingredients-as-string from other apps", () => {
    const out = parseRecipesFromJson('[{"title":"Curry","ingredients":"chicken, rice, peas"}]');
    assert.deepEqual(out, [{ name: "Curry", ingredients: ["chicken", "rice", "peas"] }]);
  });

  test("skips unusable rows instead of failing the whole file", () => {
    const out = parseRecipesFromJson('[{"name":"Good","ingredients":["beef"]},{"name":"No ingredients"},null,42]');
    assert.deepEqual(out.map((r) => r.name), ["Good"]);
  });

  test("says so plainly when the file isn't JSON at all", () => {
    assert.throws(() => parseRecipesFromJson("not json"), /valid JSON/i);
    assert.throws(() => parseRecipesFromJson('"a string"'), /array of recipes/i);
  });
});

describe("parseRecipesFromCsv", () => {
  test("reads name and ingredients columns", () => {
    const out = parseRecipesFromCsv('name,ingredients\nChilli,"beef, beans, tomatoes"\nCurry,"chicken, rice"');
    assert.deepEqual(out, [
      { name: "Chilli", ingredients: ["beef", "beans", "tomatoes"] },
      { name: "Curry", ingredients: ["chicken", "rice"] },
    ]);
  });

  test("a quoted ingredients cell survives the comma split", () => {
    // The whole reason for a real CSV reader rather than split(",").
    const out = parseRecipesFromCsv('name,ingredients\n"Pie, steak and ale","beef, ale, pastry"');
    assert.equal(out[0].name, "Pie, steak and ale");
    assert.equal(out[0].ingredients.length, 3);
  });

  test("handles doubled quotes and other column orders", () => {
    const out = parseRecipesFromCsv('ingredients,title\n"beef","Bob""s Chilli"');
    assert.equal(out[0].name, 'Bob"s Chilli');
  });

  test("names the missing column instead of importing nothing quietly", () => {
    assert.throws(() => parseRecipesFromCsv("name,method\nChilli,fry it"), /ingredients.*column/i);
    assert.throws(() => parseRecipesFromCsv("name,ingredients"), /header row/i);
  });
});

describe("parseRecipesFromFile", () => {
  test("routes by extension", () => {
    assert.equal(parseRecipesFromFile("x.json", '[{"name":"A","ingredients":["b"]}]').length, 1);
    assert.equal(parseRecipesFromFile("x.csv", "name,ingredients\nA,b").length, 1);
  });

  test("falls back to sniffing the content when the name has no extension", () => {
    // A file saved out of a browser often arrives without a suffix.
    assert.equal(parseRecipesFromFile("download", '[{"name":"A","ingredients":["b"]}]').length, 1);
    assert.equal(parseRecipesFromFile("download", "name,ingredients\nA,b").length, 1);
  });
});

describe("extractRecipesFromHtml", () => {
  const page = (jsonLd: string) =>
    `<html><head><script type="application/ld+json">${jsonLd}</script></head><body>x</body></html>`;

  test("reads a schema.org Recipe", () => {
    const out = extractRecipesFromHtml(
      page('{"@type":"Recipe","name":"Lasagne","recipeIngredient":["500g beef mince","1 onion"]}')
    );
    // Pantry names are exactly what they always were; the page's own lines now come along too.
    assert.deepEqual(out, [{
      name: "Lasagne",
      ingredients: ["beef mince", "onion"],
      lines: [{ text: "500g beef mince", pantryName: "beef mince" }, { text: "1 onion", pantryName: "onion" }],
    }]);
  });

  test("finds one nested in @graph, which is how most sites publish it", () => {
    const out = extractRecipesFromHtml(
      page('{"@graph":[{"@type":"WebPage"},{"@type":"Recipe","name":"Pie","recipeIngredient":["beef"]}]}')
    );
    assert.equal(out[0].name, "Pie");
  });

  test("copes with @type as an array", () => {
    const out = extractRecipesFromHtml(
      page('{"@type":["Recipe","NewsArticle"],"name":"Stew","recipeIngredient":["beef"]}')
    );
    assert.equal(out.length, 1);
  });

  test("one malformed block doesn't cost us a good one", () => {
    const html =
      `<script type="application/ld+json">{ broken</script>` +
      page('{"@type":"Recipe","name":"Good","recipeIngredient":["beef"]}');
    assert.equal(extractRecipesFromHtml(html)[0].name, "Good");
  });

  test("returns nothing for a page with no recipe, rather than guessing from the markup", () => {
    // Scraping visible HTML is what puts the nav menu on the shopping list.
    assert.deepEqual(extractRecipesFromHtml("<html><body><ul><li>Home</li><li>About</li></ul></body></html>"), []);
    assert.deepEqual(extractRecipesFromHtml(page('{"@type":"NewsArticle","name":"Not a recipe"}')), []);
    assert.deepEqual(extractRecipesFromHtml(""), []);
  });
});

describe("assertSafeImportUrl", () => {
  test("refuses this machine, the LAN, and the cloud metadata address", async () => {
    const blocked = [
      "http://localhost:3200/api/budget",
      "http://127.0.0.1/",
      "http://0.0.0.0/",
      "http://10.0.0.5/",
      "http://192.168.1.50:3200/",
      "http://172.16.0.1/",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::1]/",
      "http://[::ffff:192.168.1.1]/",
    ];
    for (const url of blocked) {
      await assert.rejects(
        () => assertSafeImportUrl(url),
        /private network/i,
        `${url} should have been refused`
      );
    }
  });

  test("sees through IPv6 spellings of a private IPv4 address", async () => {
    // The case that caught a real hole: new URL() rewrites ::ffff:192.168.1.1
    // as ::ffff:c0a8:101, so checking how the address is written misses it.
    // Both spellings, and the compressed loopback forms, must be refused.
    const blocked = [
      "http://[::ffff:192.168.1.1]/",
      "http://[::ffff:c0a8:101]/",
      "http://[::ffff:127.0.0.1]/",
      "http://[::ffff:169.254.169.254]/",
      "http://[0:0:0:0:0:0:0:1]/",
      "http://[fd00::1]/",
      "http://[fc00::1]/",
      "http://[fe80::1]/",
    ];
    for (const url of blocked) {
      await assert.rejects(() => assertSafeImportUrl(url), /private network/i, `${url} should have been refused`);
    }
  });

  test("a public IPv6 address is still allowed", async () => {
    // The guard has to be a filter, not a blanket IPv6 ban.
    const url = await assertSafeImportUrl("https://[2606:2800:220:1:248:1893:25c8:1946]/pie");
    assert.ok(url.hostname.includes("2606"));
  });

  test("refuses the tailnet range too", async () => {
    // 100.64/10 is CGNAT, which is where Tailscale addresses live -- the app is
    // reachable on one, so it is exactly as reachable as localhost here.
    await assert.rejects(() => assertSafeImportUrl("http://100.94.7.51:3200/"), /private network/i);
  });

  test("refuses anything that isn't http or https", async () => {
    for (const url of ["file:///C:/Windows/win.ini", "ftp://example.com/", "data:text/html,x"]) {
      await assert.rejects(() => assertSafeImportUrl(url), /http and https/i);
    }
  });

  test("refuses text that isn't a URL", async () => {
    for (const url of ["", "   ", "not a url", "chicken fajitas"]) {
      await assert.rejects(() => assertSafeImportUrl(url), /web address/i);
    }
  });

  test("allows a public literal address", async () => {
    // No DNS involved, so this asserts the address rules rather than the network.
    const url = await assertSafeImportUrl("https://93.184.216.34/recipes/pie");
    assert.equal(url.hostname, "93.184.216.34");
  });
});

describe("website import keeps quantities, the yield and the site's calories (merge plan decision 8)", () => {
  const page = (jsonLd: string) =>
    `<html><head><script type="application/ld+json">${jsonLd}</script></head><body>x</body></html>`;
  const recipe = (extra: Record<string, unknown>) =>
    extractRecipesFromHtml(page(JSON.stringify({ "@type": "Recipe", name: "Pancakes", recipeIngredient: ["2 1/2 cups all-purpose flour, sifted", "1 (14 oz) can coconut milk", "salt to taste"], ...extra })))[0];

  test("every original line is kept as written, beside the pantry name pantry matching still uses", () => {
    const r = recipe({});
    assert.deepEqual(r.lines, [
      { text: "2 1/2 cups all-purpose flour, sifted", pantryName: "all-purpose flour" },
      { text: "1 (14 oz) can coconut milk", pantryName: "coconut milk" },
      { text: "salt to taste", pantryName: "salt" },
    ]);
    assert.deepEqual(r.ingredients, ["all-purpose flour", "coconut milk", "salt"]);
    assert.deepEqual(r.ingredients, r.lines!.map((l) => l.pantryName));
  });

  test("a line that repeats an ingredient is still a line of its own (each needs its calories), though the ingredient is listed once", () => {
    const r = recipe({ recipeIngredient: ["1 onion", "2 onions", "1 Onion"] });
    assert.equal(r.lines!.length, 3);
    assert.deepEqual(r.ingredients, ["onion", "onions"]);
  });

  test("recipeYield becomes yieldServings, whichever way the site spells it", () => {
    assert.equal(recipe({ recipeYield: 4 }).yieldServings, 4);
    assert.equal(recipe({ recipeYield: "6 servings" }).yieldServings, 6);
    assert.equal(recipe({ recipeYield: ["12", "6 servings"] }).yieldServings, 6);
    assert.equal(recipe({}).yieldServings, undefined);
    assert.equal(recipe({ recipeYield: "a crowd" }).yieldServings, undefined);
  });

  test("nutrition.calories (per serving) becomes the site figure: a number, '250 kcal', '250 calories'", () => {
    for (const calories of [250, "250", "250 kcal", "250 calories", "250 Calories"]) {
      assert.equal(recipe({ nutrition: { "@type": "NutritionInformation", calories } }).nutrition?.siteKcalPerServing, 250, String(calories));
    }
    const full = recipe({ nutrition: { calories: "320 calories", proteinContent: "18 g", fatContent: "9 g" } }).nutrition!;
    assert.equal(full.siteKcalPerServing, 320);
    assert.deepEqual([full.perServing.kcal, full.perServing.protein, full.perServing.fat], [320, 18, 9]);
  });

  test("no usable calories, no figure; and no key is added to a plain recipe", () => {
    assert.equal(recipe({ nutrition: { proteinContent: "10 g" } }).nutrition, undefined);
    assert.equal(recipe({ nutrition: { calories: "lots" } }).nutrition, undefined);
    assert.deepEqual(Object.keys(recipe({})).sort(), ["ingredients", "lines", "name"]);
  });
});

describe("pasted text keeps its lines too", () => {
  test("each ingredient line is kept as written; the pantry names are unchanged", () => {
    const parsed = parseRecipeText("Fajitas\n\nIngredients:\n- 2 chicken breasts\n- 1 red pepper, sliced\n\nMethod:\nFry.");
    assert.deepEqual(parsed?.ingredients, ["chicken breasts", "red pepper"]);
    assert.deepEqual(parsed?.lines, [
      { text: "2 chicken breasts", pantryName: "chicken breasts" },
      { text: "1 red pepper, sliced", pantryName: "red pepper" },
    ]);
  });
});
