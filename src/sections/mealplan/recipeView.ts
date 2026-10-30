// The words and lists the recipe viewer (RecipeView.tsx) shows, as plain functions so they can be tested without
// a browser. Nothing here fetches or changes anything.

import type { Recipe } from "../../api.ts";
import { photoUrl, timesText } from "./recipeList.ts";

export interface RecipeViewModel {
  title: string;
  /** "Makes 4 servings" (or "... (assumed)" when nobody said); null when the recipe has no yield. */
  servings: string | null;
  /** "320 kcal/serving" with " (partly estimated)" when it is; "No calories yet" when there is no figure. */
  calories: string;
  /** The lines as written ("2 1/2 cups flour") when the recipe has them, else its ingredient names. */
  ingredients: string[];
  steps: string[];
  /** Only a web address; anything else is dropped. */
  sourceUrl: string | null;
  tags: string[];
  /** "Prep 15 min · Cook 1 h"; null when no time is set. */
  times: string | null;
  notes: string | null;
  /** Where the photo is served from; null when the recipe has none. */
  photo: string | null;
}

/** The same wording the meal plan card uses. */
export function caloriesText(r: Pick<Recipe, "nutrition">): string {
  if (!r.nutrition) return "No calories yet";
  const kcal = Math.round(r.nutrition.perServing.kcal);
  return `${kcal} kcal/serving${r.nutrition.complete ? "" : " (partly estimated)"}`;
}

export function servingsText(r: Pick<Recipe, "yieldServings" | "yieldAssumed">): string | null {
  if (r.yieldServings === undefined || r.yieldServings === null) return null;
  return `Makes ${r.yieldServings} serving${r.yieldServings === 1 ? "" : "s"}${r.yieldAssumed ? " (assumed)" : ""}`;
}

export function safeLink(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

export function recipeViewModel(r: Recipe): RecipeViewModel {
  const written = (r.lines ?? []).map((l) => l.text.trim()).filter(Boolean);
  return {
    title: r.name,
    servings: servingsText(r),
    calories: caloriesText(r),
    ingredients: written.length > 0 ? written : r.ingredients,
    steps: r.instructions ?? [],
    sourceUrl: safeLink(r.sourceUrl),
    tags: r.tags ?? [],
    times: timesText(r),
    notes: r.notes ?? null,
    photo: photoUrl(r),
  };
}

/** The steps as the edit box shows them: one per line. */
export const stepsToText = (steps: string[] | undefined): string => (steps ?? []).join("\n");
