// Helpers for the meal plan <-> food diary tests (phase 4): recipes with a known calorie figure, plan meals in
// the shape nutrition/data/mealPlanSync.ts takes, a few extra logins, and shortcuts to read entries back.

import { emptyNutrients } from "../../nutrition/nutrients.ts";
import { saveRecipe, newRecipeId } from "../../nutrition/data/recipes.ts";
import type { SyncMeal } from "../../nutrition/data/mealPlanSync.ts";
import { all, run, type Db } from "../../nutrition/data/sql.ts";
import type { RecipeDoc } from "../../nutrition/recipeModel.ts";
import type { World } from "./nutritionWorld.ts";

let counter = 0;

/** A joint recipe whose calories per serving are `kcal` (the figure a website gave), saved by `userId`. Becomes a read-only food. */
export function siteRecipeFor(db: Db, userId: string, name: string, kcal: number, over: Partial<RecipeDoc> = {}): RecipeDoc {
  const now = "2026-03-01T00:00:00.000Z";
  return saveRecipe(db, userId, {
    id: newRecipeId(), name, ingredients: ["ingredient"], scope: "joint", createdBy: userId, createdAt: now, updatedAt: now,
    yieldServings: 4, lines: [{ text: "1 thing", pantryName: "thing" }],
    nutrition: { perServing: { ...emptyNutrients(), kcal }, siteKcalPerServing: kcal, origin: "site", complete: true },
    ...over,
  });
}

/** The same in a nutritionWorld (saved by ann). */
export const siteRecipe = (w: World, name: string, kcal: number, over: Partial<RecipeDoc> = {}): RecipeDoc =>
  siteRecipeFor(w.db, w.ids.ann, name, kcal, over);

/** A planned meal for the sync, approved by default, for the given logins. */
export function syncMeal(recipe: RecipeDoc | null, targets: string[], over: Partial<SyncMeal> = {}): SyncMeal {
  return {
    id: `meal-test-${++counter}`, date: "2026-03-12", slotKey: "dinner", recipeId: recipe?.id ?? null, status: "approved",
    targetUserIds: targets, ...over,
  };
}

/** Another parent login in a test world (the world has ann, ben and the kiosk). */
export function addLogin(w: World, username: string, role = "parent"): string {
  const id = `user-${username}-${++counter}`;
  run(w.db, "INSERT INTO users (id, username, password_hash, display_name, created_at, role) VALUES (?, ?, 'x', ?, ?, ?)",
    id, username, username[0].toUpperCase() + username.slice(1), new Date(Date.now() + counter).toISOString(), role);
  return id;
}

export interface EntryView {
  id: string;
  user_id: string;
  local_date: string;
  slot_key: string;
  status: string;
  source: string;
  group_id: string | null;
  meal_plan_id: string | null;
  plan_slot_key: string | null;
  quantity: number;
  food_id: string | null;
  nutrients_total: string;
  deleted_at: string | null;
}

/** Every entry the plan made for a meal (deleted ones too when asked), oldest first. */
export function mealEntries(db: Db, mealId: string, opts: { deleted?: boolean; userId?: string } = {}): EntryView[] {
  return all<EntryView>(db,
    `SELECT * FROM nutrition_diary_entries WHERE meal_plan_id = ? ${opts.userId ? "AND user_id = ?" : ""}
       ${opts.deleted ? "" : "AND deleted_at IS NULL"} ORDER BY logged_at, rowid`,
    ...(opts.userId ? [mealId, opts.userId] : [mealId]));
}

export const kcalOf = (e: EntryView): number => JSON.parse(e.nutrients_total).kcal;
