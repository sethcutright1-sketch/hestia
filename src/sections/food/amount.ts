// The amount step of Add food, and the same arithmetic when an entry is edited: "how much of this
// food", in servings or in grams, with the calories it makes shown live.
//
// This mirrors the server's computeFromFood (nutrition/data/diary.ts) using the server's own
// nutrient maths (nutrition/nutrients.ts), so the preview and the stored entry agree to the
// calorie. The server stays the authority: it recomputes everything when the entry is written.

import { fromServing, round2, scaleNutrients } from "../../../nutrition/nutrients.ts";
import type { Amount, Food, FoodServing, Nutrients } from "./types.ts";

/** What the amount step holds: the number typed, and the unit picked (a serving's id, or "grams"). */
export interface AmountInput {
  qty: string;
  unit: string;
}

export const GRAMS = "grams";

export interface ComputedAmount {
  nutrients: Nutrients;
  quantity: number;
  /** The unit label the entry will show: a serving's label, or "g". */
  unit: string;
  grams: number | null;
  /** The amount fields to send (add it with `foodId` on top; PATCH it as it is). */
  body: Omit<Amount, "foodId">;
}

export const defaultServing = (food: Pick<Food, "servings">): FoodServing | null =>
  food.servings.find((s) => s.isDefault) ?? food.servings[0] ?? null;

/** Can this food be measured in grams? A per-100 g food always can; a per-serving one only when its serving has a weight. */
export const canMeasureInGrams = (food: Pick<Food, "basis" | "servings">): boolean =>
  food.basis === "per100g" || !!defaultServing(food)?.grams;

/** kcal in one default serving, for result rows. */
export function defaultKcal(food: Food): number {
  const s = defaultServing(food);
  if (food.basis === "per_serving") return Math.round(food.nutrients.kcal);
  return Math.round(s?.grams ? scaleNutrients(food.nutrients, s.grams).kcal : food.nutrients.kcal);
}

export function defaultServingLabel(food: Food): string {
  return defaultServing(food)?.label ?? (food.basis === "per100g" ? "100 g" : "1 serving");
}

/**
 * Servings that weigh `grams`, for a per-serving food whose serving has a known weight (a recipe with a
 * cooked weight, a "1 bar (50 g)" custom food). The diary stores per-serving foods in servings only, so
 * 150 g of a 300 g serving is logged as 0.5 servings; its grams still come out right.
 */
export function gramsToServings(food: Pick<Food, "servings">, grams: number): number | null {
  const s = defaultServing(food);
  if (!s?.grams || !(grams > 0)) return null;
  return Math.round((grams / s.grams) * 1_000_000) / 1_000_000;
}

const positive = (text: string): number | null => {
  const n = Number(text);
  return text.trim() !== "" && Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * What logging `food` in this amount would make, or null while the number isn't usable.
 *   per-serving food: a count of its one serving (or grams, as a fraction of it, when the serving has a weight);
 *   per-100 g food: grams, or a count of a named serving.
 */
export function computeAmount(food: Food, input: AmountInput): ComputedAmount | null {
  const n = positive(input.qty);
  if (n === null) return null;
  const def = defaultServing(food);

  if (input.unit === GRAMS) {
    if (food.basis === "per100g") {
      return { nutrients: scaleNutrients(food.nutrients, n), quantity: n, unit: "g", grams: n, body: { grams: n } };
    }
    const q = gramsToServings(food, n);
    return q && def ? servingAmount(food, def, q) : null;
  }

  const serving = food.servings.find((s) => s.id === input.unit) ?? def;
  if (!serving) return null;
  return servingAmount(food, serving, n);
}

function servingAmount(food: Food, serving: FoodServing, quantity: number): ComputedAmount | null {
  if (food.basis === "per_serving") {
    return {
      nutrients: fromServing(food.nutrients, quantity),
      quantity,
      unit: serving.label,
      grams: serving.grams ? round2(serving.grams * quantity) : null,
      body: { quantity, servingId: serving.id },
    };
  }
  if (serving.grams === null) return null;
  const grams = round2(serving.grams * quantity);
  return {
    nutrients: scaleNutrients(food.nutrients, grams),
    quantity,
    unit: serving.label,
    grams,
    body: { quantity, servingId: serving.id },
  };
}

const text = (n: number): string => String(round2(n));

/**
 * Where the amount step starts: 1 of the default serving for a new entry, or the amount an existing
 * entry was logged in (its `relog`, which the server works out) when it is being edited.
 */
export function startAmount(food: Food, relog?: Amount | null): AmountInput {
  const def = defaultServing(food);
  if (relog && relog.grams != null && !relog.servingId && food.basis === "per100g") return { qty: text(relog.grams), unit: GRAMS };
  if (relog && relog.quantity != null) {
    const known = relog.servingId && food.servings.some((s) => s.id === relog.servingId);
    return { qty: text(relog.quantity), unit: known ? relog.servingId! : def?.id ?? GRAMS };
  }
  return { qty: "1", unit: def?.id ?? GRAMS };
}

/** Moving from grams to a serving (or back) resets the number to something sensible for the new unit. */
export function qtyOnUnitChange(food: Food, currentQty: string, from: string, to: string): string {
  if (from === to) return currentQty;
  const def = defaultServing(food);
  const gramsDefault = food.basis === "per_serving" ? text(def?.grams ?? 100) : "100";
  if (to === GRAMS) return gramsDefault;
  return currentQty === gramsDefault ? "1" : currentQty;
}

/**
 * What to PATCH on an entry when its amount was edited. Changing only the number in the unit the entry
 * already had sends `{ quantity }` alone, so the entry keeps the label values it was logged with (the
 * server scales its stored snapshot); changing the unit sends the full re-measure (`servingId` / `grams`),
 * which the server computes against the food as it is now.
 *
 * `entryUnit` is the unit label stored on the entry. When the amount step starts in grams but the entry
 * wasn't stored in grams (its serving was renamed since, so the server could only offer its weight), the
 * number typed is grams, not the entry's own unit, so that edit has to re-measure too.
 */
export function editPatch(start: AmountInput, now: AmountInput, computed: ComputedAmount, entryUnit: string): Record<string, number | string> {
  const sameUnit = start.unit === now.unit && (now.unit !== GRAMS || entryUnit === "g");
  if (sameUnit) return { quantity: computed.quantity };
  return { ...computed.body } as Record<string, number | string>;
}
