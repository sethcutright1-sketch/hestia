// Cook mode (CookMode.tsx): the logic of a full-screen, step-by-step view for cooking, as plain functions so it can be
// tested without a browser: which step is showing, what the keys do, and the ingredients scaled to the servings picked.

import { scaleLineText } from "../../../nutrition/recipeModel.ts";

/** The step number kept inside the list (0 for a recipe with no steps). */
export function clampStep(index: number, count: number): number {
  if (count <= 0) return 0;
  return Math.min(Math.max(0, Math.trunc(index) || 0), count - 1);
}

/** "Step 3 of 8". */
export const stepLabel = (index: number, count: number): string => `Step ${clampStep(index, count) + 1} of ${count}`;

/** What a key does in Cook mode: next and previous step, or leave. Anything else is not ours. */
export function keyAction(key: string): "next" | "prev" | "close" | null {
  if (key === "ArrowRight" || key === "ArrowDown" || key === "PageDown" || key === " ") return "next";
  if (key === "ArrowLeft" || key === "ArrowUp" || key === "PageUp") return "prev";
  if (key === "Escape") return "close";
  return null;
}

/** The servings to show: the stepper's change applied, never below 1 or above 99. */
export function adjustServings(current: number, delta: number): number {
  return Math.min(99, Math.max(1, Math.round(current + delta)));
}

/** How much to multiply a recipe's amounts by to make `wanted` servings from the `base` it makes. */
export function servingsFactor(base: number | undefined, wanted: number): number {
  return base && base > 0 && wanted > 0 ? wanted / base : 1;
}

/** The ingredient lines with their leading amounts scaled (see scaleLineText: ranges and lines with no amount stay as written). */
export function scaledIngredients(lines: string[], factor: number): string[] {
  return lines.map((l) => scaleLineText(l, factor));
}
