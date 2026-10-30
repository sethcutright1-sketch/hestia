// The recipe calls the screens make (all under /api/mealplan/recipes), in one place so every screen asks the same way and
// answers a locked kitchen screen the same way.
//
// A kiosk login must enter the household PIN before it changes a recipe (the server answers 423 `locked`); every other login is
// never asked. `writeMessage` turns that 423 into a sentence, and opens the PIN prompt the app already has (App.tsx).

import { api, ApiError, type Recipe, type RecipeMark } from "../../api.ts";

const base = (id: string) => `/api/mealplan/recipes/${encodeURIComponent(id)}`;

export interface PatchBody {
  name?: string;
  /** `from` is the position the line had before the edit, so a typo fix keeps its calorie link. */
  lines?: { text: string; from?: number }[];
  instructions?: string[] | null;
  yieldServings?: number | null;
  prepMinutes?: number | null;
  cookMinutes?: number | null;
  tags?: string[] | null;
  notes?: string | null;
  sourceUrl?: string | null;
  scope?: "joint" | "personal";
}

/** Change a recipe. `relink` is how many calorie links the edit dropped (a changed amount or food). */
export const patchRecipe = (id: string, body: PatchBody) => api.patch<{ recipe: Recipe; relink: number }>(base(id), body);

export const duplicateRecipe = (id: string) => api.post<{ recipe: Recipe }>(`${base(id)}/duplicate`);

export const recipeUsage = (id: string) => api.get<{ plannedMeals: number; upcoming: number }>(`${base(id)}/usage`);

export const deleteRecipe = (id: string) => api.del<{ success: boolean }>(base(id));

export const setRecipePhoto = (id: string, base64: string) => api.put<{ recipe: Recipe }>(`${base(id)}/photo`, { data: base64, mime: "image/jpeg" });

export const removeRecipePhoto = (id: string) => api.del<{ recipe: Recipe }>(`${base(id)}/photo`);

/** Your own favourite star and rating; what you leave out stays as it was, `rating: null` clears it. */
export const setRecipeMark = (id: string, body: { favorite?: boolean; rating?: number | null }) => api.put<{ mark: RecipeMark }>(`${base(id)}/mark`, body);

export interface PageRefresh {
  sourceUrl: string;
  page: { name: string; lines: string[]; instructions: string[]; yieldServings: number | null };
  differs: { lines: boolean; instructions: boolean; yieldServings: boolean };
}

/** What the recipe's source page says now (a preview: nothing is saved). */
export const refreshFromPage = (id: string) => api.post<PageRefresh>(`${base(id)}/refresh-from-url`);

export interface RecalculateResult {
  recipes: number;
  before: number;
  after: number;
  improved: number;
}

/** Link every recipe's clear matches in one go (needs a food diary login: the calorie routes). */
export const improveAllCalories = () => api.post<RecalculateResult>("/api/nutrition/recipes/recalculate-all");

/** True when the server said the household PIN lock is closed (423). */
export const isLocked = (err: unknown): boolean => err instanceof ApiError && err.status === 423;

/**
 * The sentence to show for a failed recipe change. A locked kitchen screen is told to enter the PIN, and the PIN prompt is
 * opened so it can; anything else shows the server's own words.
 */
export function writeMessage(err: unknown, onRequestUnlock?: () => void): string {
  if (isLocked(err)) {
    onRequestUnlock?.();
    return "Changing recipes needs the household PIN here. Enter it, then try again.";
  }
  return err instanceof Error ? err.message : "Something went wrong.";
}
