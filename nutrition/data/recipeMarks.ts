// A login's own favourite star and 1-5 rating for a recipe (nutrition migration 14, table nutrition_recipe_marks).
//
// Per person (the owner's call, "per login"): every function takes the caller's user id and only ever reads or writes that
// login's rows, so one login's stars and ratings are invisible to the others, the assistant included (it works as the
// login it is talking to). The kiosk has none: the routes refuse it. A recipe with neither a star nor a rating has no row.
// Setting marks on a recipe you cannot see is a 404, like the recipe itself.

import { NutritionError } from "./errors.ts";
import { bodyObject } from "./input.ts";
import { cleanRating } from "../recipeModel.ts";
import { requireRecipe } from "./recipes.ts";
import { all, get, run, type Db } from "./sql.ts";

export interface RecipeMark {
  favorite: boolean;
  /** 1 to 5, or null when not rated. */
  rating: number | null;
}

interface MarkRow {
  recipe_id: string;
  favorite: number;
  rating: number | null;
}

/** Every mark this login has made, by recipe id. Recipes with no mark are simply absent. */
export function listMarks(db: Db, userId: string): Record<string, RecipeMark> {
  const out: Record<string, RecipeMark> = {};
  for (const r of all<MarkRow>(db, "SELECT recipe_id, favorite, rating FROM nutrition_recipe_marks WHERE user_id = ?", userId)) {
    out[r.recipe_id] = { favorite: r.favorite === 1, rating: r.rating };
  }
  return out;
}

export function getMark(db: Db, userId: string, recipeId: string): RecipeMark | undefined {
  const r = get<MarkRow>(db, "SELECT recipe_id, favorite, rating FROM nutrition_recipe_marks WHERE user_id = ? AND recipe_id = ?", userId, recipeId);
  return r ? { favorite: r.favorite === 1, rating: r.rating } : undefined;
}

/**
 * Change this login's marks on a recipe: { favorite?: boolean, rating?: 1-5 | null }. What the body doesn't mention is
 * left as it was; `rating: null` clears it. Returns the marks now (an unmarked recipe is `{ favorite: false, rating: null }`).
 */
export function setMark(db: Db, userId: string, recipeId: string, input: unknown): RecipeMark {
  const rec = requireRecipe(db, userId, recipeId);
  const b = bodyObject(input);
  const current = getMark(db, userId, rec.doc.id) ?? { favorite: false, rating: null };
  let { favorite, rating } = current;
  if (b.favorite !== undefined) {
    if (typeof b.favorite !== "boolean") throw new NutritionError(400, "favorite must be true or false.");
    favorite = b.favorite;
  }
  if (b.rating !== undefined) {
    if (b.rating === null || b.rating === 0) rating = null;
    else {
      const r = cleanRating(b.rating);
      if (r === undefined) throw new NutritionError(400, "rating must be a whole number from 1 to 5, or null.");
      rating = r;
    }
  }
  if (!favorite && rating === null) {
    run(db, "DELETE FROM nutrition_recipe_marks WHERE user_id = ? AND recipe_id = ?", userId, rec.doc.id);
  } else {
    run(db,
      `INSERT INTO nutrition_recipe_marks (recipe_id, user_id, favorite, rating, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(recipe_id, user_id) DO UPDATE SET favorite = excluded.favorite, rating = excluded.rating, updated_at = excluded.updated_at`,
      rec.doc.id, userId, favorite ? 1 : 0, rating, new Date().toISOString());
  }
  return { favorite, rating };
}
