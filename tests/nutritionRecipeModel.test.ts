// nutrition/recipeModel.ts: the pure half of recipes with calories. The line parser, unit
// conversion, the "which food is this?" rule, the calorie arithmetic, and the readers for what a
// recipe page says about itself. Nothing here touches a database or a model.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  buildNutrition, calculateNutrition, hasWordAmount, ingredientsOfLines, isNegligible, linesFromNames, matchConfidence,
  nameTokens, pantryNameOf, parseIngredientLine, parseSiteKcal, parseSiteNutrition, parseYield, pickConfident,
  resolveAmount, siteFiguresOf, type FoodLike, type Line,
} from "../nutrition/recipeModel.ts";
import type { Nutrients } from "../nutrition/nutrients.ts";

const n = (kcal: number, protein = 0): Nutrients => ({ kcal, protein, carbs: 0, fat: 0, satFat: 0, sugars: 0, fiber: 0, cholesterolMg: 0, sodiumMg: 0 });

describe("pantry names and ingredients", () => {
  test("a written line with an amount is stripped exactly as the importer always did; a bare name is left alone", () => {
    assert.equal(pantryNameOf("2 1/2 cups all-purpose flour, sifted"), "all-purpose flour");
    assert.equal(pantryNameOf("200 g chicken breast"), "chicken breast");
    assert.equal(pantryNameOf("whole milk"), "whole milk", "'whole' is only a unit word after a number");
    assert.equal(pantryNameOf("large onion"), "large onion");
    assert.equal(pantryNameOf("7up"), "7up", "a digit inside a word is not a quantity");
    assert.equal(pantryNameOf("  chicken  "), "chicken");
  });

  test("ingredients are the lines' pantry names, once each", () => {
    const lines: Line[] = [
      { text: "2 cups rice", pantryName: "rice" }, { text: "1 cup Rice", pantryName: "Rice" }, { text: "salt", pantryName: "salt" },
      { text: "", pantryName: "  " },
    ];
    assert.deepEqual(ingredientsOfLines(lines), ["rice", "salt"]);
    assert.deepEqual(linesFromNames(["beef", " ", "2 onions"]), [{ text: "beef", pantryName: "beef" }, { text: "2 onions", pantryName: "onions" }]);
  });
});

describe("parseIngredientLine", () => {
  const p = (t: string) => parseIngredientLine(t);

  test("whole numbers, decimals, fractions, mixed numbers and unicode fractions", () => {
    assert.equal(p("2 cups rice").quantity, 2);
    assert.equal(p("1.5 lb beef").quantity, 1.5);
    assert.equal(p("1/2 cup milk").quantity, 0.5);
    assert.equal(p("2 1/2 cups flour").quantity, 2.5);
    assert.equal(p("½ tsp salt").quantity, 0.5);
    assert.equal(p("2½ cups flour").quantity, 2.5);
    assert.equal(p("1 ¼ cups water").quantity, 1.25);
  });

  test("ranges take the middle", () => {
    assert.equal(p("2-3 cloves garlic").quantity, 2.5);
    assert.equal(p("2 to 4 tbsp oil").quantity, 3);
  });

  test("units are read and normalised, including two-word fluid ounces", () => {
    assert.deepEqual([p("2 tablespoons butter").unit, p("2 Tbsp butter").unit, p("3 tsps sugar").unit], ["tbsp", "tbsp", "tsp"]);
    assert.equal(p("8 fl oz milk").unit, "fl oz");
    assert.equal(p("8 fluid ounces milk").unit, "fl oz");
    assert.equal(p("8 oz cheese").unit, "oz");
    assert.equal(p("1 c rice").unit, "cup");
    assert.equal(p("500 g flour").unitKind, "weight");
    assert.equal(p("1 cup flour").unitKind, "volume");
    assert.equal(p("3 cloves garlic").unitKind, "count");
  });

  test("no unit is no unit: '2 eggs', and a size word is not a unit", () => {
    assert.deepEqual([p("2 eggs").quantity, p("2 eggs").unit, p("2 eggs").name], [2, null, "eggs"]);
    assert.equal(p("2 large eggs").unit, null);
    assert.equal(p("chicken").quantity, null);
  });

  test("a parenthetical size on a can becomes grams per can", () => {
    const a = p("1 (14 oz) can diced tomatoes");
    assert.deepEqual([a.quantity, a.unit, a.name], [1, "can", "diced tomatoes"]);
    assert.ok(Math.abs(a.sizeG! - 396.9) < 0.2);
    const b = p("2 cans (400 g) chickpeas");
    assert.equal(b.sizeG, 400);
    assert.equal(p("2 cups rice (uncooked)").sizeG, null, "only count units carry a size");
  });

  test("the name is what pantry matching would use", () => {
    assert.equal(p("2 1/2 cups all-purpose flour, sifted").name, "all-purpose flour");
    assert.equal(p("- 1 onion, diced").name, "onion");
  });

  test("negligible: a pinch, to taste, water, salt and pepper", () => {
    for (const t of ["a pinch of nutmeg", "1 pinch salt", "salt to taste", "water", "2 cups water", "salt and pepper", "black pepper"]) {
      assert.equal(p(t).negligible, true, t);
    }
    for (const t of ["1 cup rice", "olive oil", "2 tbsp butter"]) assert.equal(p(t).negligible, false, t);
    assert.equal(isNegligible({ text: "salt", pantryName: "salt" }), true);
  });

  test("amounts in words are flagged for the model to read, not guessed at", () => {
    assert.equal(hasWordAmount("two cups flour"), true);
    assert.equal(hasWordAmount("a dozen eggs"), true);
    assert.equal(hasWordAmount("2 cups flour"), false);
    assert.equal(hasWordAmount("chicken"), false);
    assert.equal(p("two cups flour").quantity, null);
  });
});

describe("resolveAmount", () => {
  const serving = (label: string, grams: number | null, isDefault = false) => ({ id: `s-${label}`, label, grams, isDefault });
  const generic: FoodLike = { basis: "per100g", servings: [serving("100 g", 100, true)] };
  const oats: FoodLike = { basis: "per100g", servings: [serving("100 g", 100, true), serving("1 cup", 80)] };
  const bar: FoodLike = { basis: "per_serving", servings: [serving("1 bar", 50, true)] };
  const egg: FoodLike = { basis: "per_serving", servings: [serving("1 large egg", 50, true)] };
  const r = (t: string, f: FoodLike) => resolveAmount(parseIngredientLine(t), f);

  test("weight units give exact grams on a per-100 g food", () => {
    assert.deepEqual(r("200 g chicken", generic), { grams: 200, approx: false });
    assert.deepEqual(r("1 lb beef", generic), { grams: 453.59, approx: false });
    assert.deepEqual(r("8 oz cheese", generic), { grams: 226.8, approx: false });
  });

  test("on a per-serving food a weight becomes a fraction of the serving, when its weight is known", () => {
    assert.deepEqual(r("100 g bar", bar), { quantity: 2, approx: false });
    assert.equal(r("100 g thing", { basis: "per_serving", servings: [serving("1 each", null, true)] }), null);
  });

  test("a serving named in the same unit is used as is", () => {
    assert.deepEqual(r("2 cups oats", oats), { quantity: 2, servingId: "s-1 cup", approx: false });
    assert.deepEqual(r("1/2 cup oats", oats), { quantity: 0.5, servingId: "s-1 cup", approx: false });
    assert.deepEqual(r("2 cups of bars", { basis: "per_serving", servings: [serving("1 cup", 100, true)] }), { quantity: 2, approx: false });
  });

  test("a count of items uses a serving that counts them, not a weight serving", () => {
    assert.deepEqual(r("3 eggs", egg), { quantity: 3, approx: false });
    assert.equal(r("3 eggs", generic), null, "'100 g' is not an egg");
  });

  test("a can with a stated size is exact", () => {
    assert.deepEqual(r("1 (400 g) can tomatoes", generic), { grams: 400, approx: false });
  });

  test("a volume with no matching serving is a density guess and says so", () => {
    assert.equal(r("1 cup flour", generic)?.approx, true);
    assert.equal(r("1 cup flour", generic)?.grams, 125.39);
    assert.equal(r("1 cup water", generic)?.grams, 236.59, "unknown foods default to 1 g/ml");
  });

  test("no quantity means no amount", () => {
    assert.equal(r("chicken", generic), null);
  });
});

describe("matching a line to a food", () => {
  test("name tokens fold plurals and drop prep words and filler", () => {
    assert.deepEqual(nameTokens("Diced Tomatoes"), ["tomato"]);
    assert.deepEqual(nameTokens("freshly chopped parsley"), ["freshly", "parsley"]);
    assert.deepEqual(nameTokens("Chicken breasts"), ["chicken", "breast"]);
    assert.deepEqual(nameTokens("Rice, white, long-grain"), ["rice", "white", "long", "grain"]);
  });

  test("exact = the ingredient's words are the food's words up to the first comma; possible = contained; else weak", () => {
    assert.equal(matchConfidence("chicken breast", "Chicken breast"), "exact");
    assert.equal(matchConfidence("chicken breasts", "Chicken breast, raw"), "exact");
    assert.equal(matchConfidence("chicken breast", "Chicken, broilers or fryers, breast, raw"), "possible");
    assert.equal(matchConfidence("chicken breast", "Chicken thigh"), "weak");
    assert.equal(matchConfidence("rice", "Rice vinegar"), "possible", "never auto-linked, only suggested");
    assert.equal(matchConfidence("", "Rice"), "weak");
  });

  test("pickConfident: one exact match is taken; zero or several are not", () => {
    const own = (id: string, name: string) => ({ id, name, source: "custom" });
    const gen = (id: string, name: string) => ({ id, name, source: "usda_generic" });
    assert.equal(pickConfident("chicken breast", [own("a", "Chicken breast"), gen("b", "Chicken, breast, raw")]), "a");
    assert.equal(pickConfident("chicken breast", [gen("b", "Chicken, broilers or fryers, breast, raw")]), null, "possible is not enough");
    assert.equal(pickConfident("rice", [gen("a", "Rice, white, raw"), gen("b", "Rice, white, cooked")]), null, "ambiguous catalogue rows");
    assert.equal(pickConfident("rice", [gen("a", "Rice")]), "a");
    assert.equal(pickConfident("rice", [own("a", "Rice"), own("b", "Rice")]), null, "two of the person's own foods");
    assert.equal(pickConfident("rice", [own("a", "Rice"), gen("b", "Rice")]), "a", "a food a person made beats the catalogue");
    assert.equal(pickConfident("rice", []), null);
  });
});

describe("calculateNutrition", () => {
  const amounts: Record<string, Nutrients> = { oats: n(304, 10), bars: n(420, 20) };
  const amountOf = (l: Line) => amounts[l.foodId!] ?? null;

  test("sums linked lines and divides by the servings", () => {
    const lines: Line[] = [{ text: "oats", pantryName: "oats", foodId: "oats" }, { text: "2 bars", pantryName: "bars", foodId: "bars" }];
    const c = calculateNutrition(lines, 4, amountOf)!;
    assert.equal(c.total.kcal, 724);
    assert.equal(c.perServing.kcal, 181);
    assert.equal(c.perServing.protein, 7.5);
    assert.equal(c.origin, "calculated");
    assert.equal(c.complete, true);
    assert.deepEqual([c.linked, c.estimated, c.missing], [[0, 1], [], []]);
  });

  test("a line with no food and no estimate makes the figure incomplete", () => {
    const lines: Line[] = [{ text: "oats", pantryName: "oats", foodId: "oats" }, { text: "mystery", pantryName: "mystery" }];
    const c = calculateNutrition(lines, 2, amountOf)!;
    assert.equal(c.complete, false);
    assert.deepEqual(c.missing, [1]);
    assert.equal(c.origin, "calculated");
  });

  test("an estimate counts, is kcal only, makes the origin mixed and the figure incomplete", () => {
    const lines: Line[] = [
      { text: "oats", pantryName: "oats", foodId: "oats" },
      { text: "dressing", pantryName: "dressing", estimated: true, estimatedKcal: 200 },
    ];
    const c = calculateNutrition(lines, 2, amountOf)!;
    assert.equal(c.total.kcal, 504);
    assert.equal(c.perServing.kcal, 252);
    assert.equal(c.perServing.protein, 5);
    assert.deepEqual([c.origin, c.complete, c.estimated], ["mixed", false, [1]]);
  });

  test("negligible lines (salt, a pinch, water) never block completeness", () => {
    const lines: Line[] = [{ text: "oats", pantryName: "oats", foodId: "oats" }, { text: "salt to taste", pantryName: "salt" }, { text: "2 cups water", pantryName: "water" }];
    assert.equal(calculateNutrition(lines, 1, amountOf)!.complete, true);
  });

  test("a linked line whose food can't be measured falls back to its estimate, else counts as missing", () => {
    const lines: Line[] = [
      { text: "gone", pantryName: "gone", foodId: "nope", estimated: true, estimatedKcal: 90 },
      { text: "oats", pantryName: "oats", foodId: "oats" },
      { text: "gone2", pantryName: "gone2", foodId: "nope" },
    ];
    const c = calculateNutrition(lines, 1, amountOf)!;
    assert.deepEqual([c.linked, c.estimated, c.missing], [[1], [0], [2]]);
    assert.equal(c.total.kcal, 394);
  });

  test("nothing counted is null, and so is a yield that isn't a positive number", () => {
    assert.equal(calculateNutrition([{ text: "x", pantryName: "x" }], 4, amountOf), null);
    assert.equal(calculateNutrition([{ text: "oats", pantryName: "oats", foodId: "oats" }], 0, amountOf), null);
  });

  test("rounding happens once, at the end", () => {
    const third = (): Nutrients => n(100);
    const c = calculateNutrition([{ text: "a", pantryName: "a", foodId: "x" }], 3, third)!;
    assert.equal(c.perServing.kcal, 33.33);
  });

  test("buildNutrition: calculated beats site but keeps the site figure; site alone stands; neither is nothing", () => {
    const calc = calculateNutrition([{ text: "oats", pantryName: "oats", foodId: "oats" }], 2, amountOf);
    const site = { kcal: 180, nutrients: n(180, 5) };
    assert.deepEqual(buildNutrition(calc, site), { perServing: calc!.perServing, siteKcalPerServing: 180, origin: "calculated", complete: true });
    assert.deepEqual(buildNutrition(calc), { perServing: calc!.perServing, origin: "calculated", complete: true });
    assert.deepEqual(buildNutrition(null, site), { perServing: site.nutrients, siteKcalPerServing: 180, origin: "site", complete: true });
    assert.equal(buildNutrition(null), undefined);
    assert.equal(siteFiguresOf(undefined), undefined);
    assert.deepEqual(siteFiguresOf(buildNutrition(calc, site)), { kcal: 180, nutrients: { ...n(0), kcal: 180 } });
    assert.deepEqual(siteFiguresOf(buildNutrition(null, site)), site);
  });
});

describe("what a recipe page says about itself", () => {
  test("calories: numbers, 'kcal', 'calories', 'Cal', thousands separators, kilojoules, junk", () => {
    assert.equal(parseSiteKcal(250), 250);
    assert.equal(parseSiteKcal("250"), 250);
    assert.equal(parseSiteKcal("250 kcal"), 250);
    assert.equal(parseSiteKcal("250 calories"), 250);
    assert.equal(parseSiteKcal("250 Cal"), 250);
    assert.equal(parseSiteKcal("1,200 calories"), 1200);
    assert.equal(parseSiteKcal("1046 kJ"), 250);
    assert.equal(parseSiteKcal("12.5 kcal"), 12.5);
    for (const bad of ["", "lots", 0, -5, 99999, null, undefined, {}, "0 kcal"]) assert.equal(parseSiteKcal(bad as any), undefined, String(bad));
  });

  test("yield: numbers, 'serves', 'makes', ranges, arrays that prefer the servings entry", () => {
    assert.equal(parseYield(4), 4);
    assert.equal(parseYield("4"), 4);
    assert.equal(parseYield("4 servings"), 4);
    assert.equal(parseYield("Serves 6"), 6);
    assert.equal(parseYield("6-8 servings"), 6);
    assert.equal(parseYield(["12", "6 servings"]), 6);
    assert.equal(parseYield(["12"]), 12);
    for (const bad of ["", "a lot", 0, 5000, null, undefined]) assert.equal(parseYield(bad as any), undefined, String(bad));
  });

  test("the nutrition node: calories required; protein, fat, carbs, sodium read with their units", () => {
    assert.equal(parseSiteNutrition({ proteinContent: "10 g" }), undefined, "no calories, no figure");
    assert.equal(parseSiteNutrition(null), undefined);
    const got = parseSiteNutrition({
      "@type": "NutritionInformation", calories: "320 calories", proteinContent: "18 g", carbohydrateContent: "40.5 g",
      fatContent: "9 g", saturatedFatContent: "3 g", sugarContent: "6 g", fiberContent: "4 g", cholesterolContent: "55 mg", sodiumContent: "720 mg",
    })!;
    assert.deepEqual(got.nutrients, { kcal: 320, protein: 18, carbs: 40.5, fat: 9, satFat: 3, sugars: 6, fiber: 4, cholesterolMg: 55, sodiumMg: 720 });
    assert.equal(parseSiteNutrition({ calories: "320 kcal" })!.nutrients.protein, 0);
  });
});
