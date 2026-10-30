// What the Food section's forms send: Quick add, Create food, and the Exercise form. Each takes the
// text boxes as typed and returns either a request body or the message to show, so the rules (what is
// required, how nutrition facts "per serving" or "per 100 g" become servings, who a new food is shared
// with) are tested without a browser (tests/foodForms.test.ts).

import { canonicalGtin } from "../../../nutrition/barcode.ts";

export type Built<T> = { ok: true; body: T } | { ok: false; error: string };

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

/** An optional number box: "" is nothing, a number >= 0 is a value, anything else is bad. */
export function optionalNumber(text: string): number | null | "bad" {
  const t = text.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : "bad";
}

// ---- Quick add --------------------------------------------------------------------------------

export interface QuickAddForm {
  kcal: string;
  name: string;
  protein: string;
  carbs: string;
  fat: string;
}

export interface QuickAddBody {
  slot: string;
  id: string;
  source: "quick";
  kcal: number;
  name?: string;
  protein?: number;
  carbs?: number;
  fat?: number;
}

/** Calories are required; the name and the three macros are optional. */
export function buildQuickAdd(f: QuickAddForm, slot: string, id: string): Built<QuickAddBody> {
  const kcal = optionalNumber(f.kcal);
  if (kcal === null || kcal === "bad") return fail("Enter the calories.");
  const body: QuickAddBody = { slot, id, source: "quick", kcal };
  const name = f.name.trim();
  if (name) body.name = name;
  for (const key of ["protein", "carbs", "fat"] as const) {
    const v = optionalNumber(f[key]);
    if (v === "bad") return fail(`${key[0].toUpperCase()}${key.slice(1)} must be a number, or left empty.`);
    if (v !== null) body[key] = v;
  }
  return { ok: true, body };
}

// ---- Create food ------------------------------------------------------------------------------

export const NUTRIENT_FIELDS: Array<{ key: string; label: string; required?: boolean }> = [
  { key: "kcal", label: "Calories (kcal)", required: true },
  { key: "protein", label: "Protein g" },
  { key: "carbs", label: "Carbs g" },
  { key: "fat", label: "Fat g" },
  { key: "satFat", label: "Saturated fat g" },
  { key: "sugars", label: "Sugars g" },
  { key: "fiber", label: "Fiber g" },
  { key: "cholesterolMg", label: "Cholesterol mg" },
  { key: "sodiumMg", label: "Sodium mg" },
];

export interface CreateFoodForm {
  name: string;
  brand: string;
  barcode: string;
  /** What the nutrition facts on the label are for. */
  basis: "per_serving" | "per100g";
  servingLabel: string;
  servingGrams: string;
  nutrients: Record<string, string>;
  /** The "Only me" switch. Off (the default) shares the new food with the household. */
  onlyMe: boolean;
}

export const emptyCreateFood = (): CreateFoodForm => ({
  name: "", brand: "", barcode: "", basis: "per_serving", servingLabel: "", servingGrams: "", nutrients: {}, onlyMe: false,
});

export interface CreateFoodBody {
  name: string;
  brand?: string;
  gtin14?: string;
  basis: "per_serving" | "per100g";
  nutrients: Record<string, number>;
  servings: Array<{ label: string; grams: number | null; isDefault?: boolean }>;
  scope: "joint" | "personal";
}

export function buildCreateFood(f: CreateFoodForm): Built<CreateFoodBody> {
  const name = f.name.trim();
  if (!name) return fail("Give the food a name.");

  const nutrients: Record<string, number> = {};
  for (const { key, label, required } of NUTRIENT_FIELDS) {
    const v = optionalNumber(f.nutrients[key] ?? "");
    if (v === "bad") return fail(`${label.replace(/ \(kcal\)| g$| mg$/, "")} must be a number, or left empty.`);
    if (v === null && required) return fail("Enter the calories from the label.");
    nutrients[key] = v ?? 0;
  }

  const label = f.servingLabel.trim();
  const gramsText = f.servingGrams.trim();
  let grams: number | null = null;
  if (gramsText !== "") {
    const g = Number(gramsText);
    if (!Number.isFinite(g) || g <= 0) return fail("The serving weight must be a number above 0, or left empty.");
    grams = g;
  }

  let servings: CreateFoodBody["servings"];
  if (f.basis === "per_serving") {
    servings = [{ label: label || "1 serving", grams }];
  } else {
    // Per 100 g: the 100 g row is always there; a named serving with a weight is added on top and becomes the default.
    const extra = label !== "" && grams !== null;
    servings = [{ label: "100 g", grams: 100, isDefault: !extra }];
    if (extra) servings.push({ label, grams, isDefault: true });
  }

  const body: CreateFoodBody = { name, basis: f.basis, nutrients, servings, scope: f.onlyMe ? "personal" : "joint" };
  const brand = f.brand.trim();
  if (brand) body.brand = brand;
  const code = f.barcode.trim();
  if (code) {
    const canon = canonicalGtin(code);
    if (!canon) return fail("That barcode isn't valid (check the digits), or leave the barcode empty.");
    body.gtin14 = canon.gtin14;
  }
  return { ok: true, body };
}

// ---- Exercise ---------------------------------------------------------------------------------

export interface ExerciseForm {
  name: string;
  minutes: string;
  kcal: string;
}

export interface ExerciseBody {
  name: string;
  /** null clears minutes on an edit; on an add it simply means none. */
  minutes: number | null;
  kcal: number;
}

/** Name and calories burned are required; minutes are optional. */
export function buildExercise(f: ExerciseForm): Built<ExerciseBody> {
  const name = f.name.trim();
  if (!name) return fail("Give the exercise a name.");
  const kcal = optionalNumber(f.kcal);
  if (kcal === null || kcal === "bad") return fail("Enter the calories burned.");
  if (kcal > 20_000) return fail("Calories burned can be at most 20,000.");
  const minutes = optionalNumber(f.minutes);
  if (minutes === "bad") return fail("Minutes must be a number, or left empty.");
  if (minutes !== null && minutes > 1440) return fail("Minutes can be at most 1,440 (a whole day).");
  return { ok: true, body: { name, minutes, kcal } };
}

/** "Run - 30 min - 300 kcal burned". */
export function exerciseLine(e: { name: string; minutes: number | null; kcal: number }): string {
  const bits = [e.name];
  if (e.minutes !== null) bits.push(`${Math.round(e.minutes * 10) / 10} min`);
  bits.push(`${Math.round(e.kcal).toLocaleString("en-US")} kcal burned`);
  return bits.join(" - ");
}
