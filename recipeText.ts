// The one function that turns an ingredient line into the name pantry matching uses
// ("2 1/2 cups all-purpose flour, sifted" -> "all-purpose flour"). It lives in its own file so
// both the recipe importer (routes/recipeImport.ts) and the calorie code (nutrition/recipeModel.ts)
// can use it without importing each other. recipeImport.ts re-exports it, so existing imports work.

const UNITS = [
  "cup", "cups", "c", "tbsp", "tbs", "tablespoon", "tablespoons", "tsp", "teaspoon",
  "teaspoons", "oz", "ounce", "ounces", "lb", "lbs", "pound", "pounds", "g", "gram",
  "grams", "kg", "kilogram", "kilograms", "ml", "l", "liter", "liters", "litre",
  "litres", "pint", "pints", "quart", "quarts", "gallon", "gallons", "clove", "cloves",
  "can", "cans", "jar", "jars", "package", "packages", "pkg", "packet", "packets",
  "pinch", "pinches", "dash", "dashes", "slice", "slices", "stick", "sticks", "bunch",
  "bunches", "head", "heads", "sprig", "sprigs", "stalk", "stalks", "piece", "pieces",
  "handful", "handfuls", "large", "small", "medium", "whole",
];

const UNIT_SET = new Set(UNITS);

/**
 * "2 1/2 cups all-purpose flour, sifted" -> "all-purpose flour".
 *
 * Strips leading bullets and quantities, a parenthetical size, a unit word, a
 * leading "of", and any trailing preparation note after a comma. Everything it
 * removes is packaging around the ingredient rather than part of its identity;
 * when in doubt it keeps the text, since a slightly noisy name still shops
 * correctly while an over-trimmed one ("all-purpose" alone) does not.
 */
export function stripQuantity(line: string): string {
  let out = String(line ?? "").trim();
  if (!out) return "";

  // Leading bullet or list marker: "-", "*", "•", "1.", "1)".
  out = out.replace(/^[-*•▢□◦]+\s*/, "").replace(/^\d+[.)]\s+/, "");

  // Parenthetical sizes anywhere: "1 (14 oz) can diced tomatoes".
  out = out.replace(/\([^)]*\)/g, " ");

  // Leading amount: digits, decimals, fractions (1/2), unicode fractions, and
  // ranges ("2-3", "2 to 3"). Repeated because "2 1/2" is two tokens.
  const amount = /^(?:\d+[\d.,/]*|[¼½¾⅓⅔⅛⅜⅝⅞])(?:\s*(?:-|–|to)\s*(?:\d+[\d.,/]*|[¼½¾⅓⅔⅛⅜⅝⅞]))?\s*/;
  while (amount.test(out)) {
    const next = out.replace(amount, "");
    if (next === out) break;
    out = next;
  }

  // A unit word now sitting at the front, then an optional "of".
  const firstWord = out.split(/\s+/)[0]?.toLowerCase().replace(/\.$/, "") ?? "";
  if (UNIT_SET.has(firstWord)) out = out.slice(out.indexOf(out.split(/\s+/)[0]) + firstWord.length).trim();
  out = out.replace(/^of\s+/i, "");

  // Trailing preparation: "chicken breasts, diced and seasoned".
  out = out.split(",")[0];

  // "Salt and pepper to taste" -> "Salt and pepper".
  out = out.replace(/\s+(?:to taste|as needed|for serving|for garnish|optional)\s*$/i, "");

  return out.replace(/\s{2,}/g, " ").trim();
}
