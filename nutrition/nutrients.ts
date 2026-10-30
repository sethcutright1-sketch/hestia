// Nutrient arithmetic shared by the diary, the Lose It! importer and the assistant.
//
// The nine fields are exactly the nutrient columns in a Lose It! export, so an
// import loses nothing. Values are plain numbers (a missing value is stored as 0):
// "unknown" and "zero" are indistinguishable on a label-less food anyway, and it
// keeps every sum total.
//
// Rounding rule: intermediate math stays in full float precision and results are
// rounded to 2 dp only where a value leaves a function. Rounding each addend and
// then summing would drift by a calorie or two over a day.

export interface Nutrients {
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  satFat: number;
  sugars: number;
  fiber: number;
  cholesterolMg: number;
  sodiumMg: number;
}

export const NUTRIENT_KEYS = [
  "kcal", "protein", "carbs", "fat", "satFat", "sugars", "fiber", "cholesterolMg", "sodiumMg",
] as const satisfies ReadonlyArray<keyof Nutrients>;

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function emptyNutrients(): Nutrients {
  return { kcal: 0, protein: 0, carbs: 0, fat: 0, satFat: 0, sugars: 0, fiber: 0, cholesterolMg: 0, sodiumMg: 0 };
}

function map(n: Nutrients, f: (v: number) => number): Nutrients {
  const out = emptyNutrients();
  for (const k of NUTRIENT_KEYS) out[k] = round2(f(n[k] ?? 0));
  return out;
}

/** Nutrients for `grams` of a food whose values are stated per 100 g. */
export function scaleNutrients(per100: Nutrients, grams: number): Nutrients {
  return map(per100, (v) => (v * grams) / 100);
}

/** Nutrients for `quantity` servings of a food whose values are stated per serving. */
export function fromServing(perServing: Nutrients, quantity: number): Nutrients {
  return map(perServing, (v) => v * quantity);
}

export function sumNutrients(list: Nutrients[]): Nutrients {
  const out = emptyNutrients();
  for (const n of list) for (const k of NUTRIENT_KEYS) out[k] += n[k] ?? 0;
  return map(out, (v) => v);
}
