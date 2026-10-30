// Keeping the meal plan in step with a recipe that was edited (recipes overhaul, the owner's call: "this week and future
// weeks").
//
// A planned meal copies its recipe's `name` and `ingredients` when the recipe is attached (routes/mealplan.ts
// attachRecipe); the shopping list, the dislike check and the grocery budget read those copies. So when a joint
// recipe is renamed or its ingredients change, the copies on meals that point at it are rewritten, for weeks that
// have not fully passed. What is NOT touched, on purpose:
//   - weeks that are already over (the plan is history; what was cooked stays as it was written);
//   - a meal's status, its diary entries (they are snapshots of what was planned) and anything already on a shopping list;
//   - the plan's own `updatedAt` (it decides which plan the app calls "current", and an edit to a recipe is not an edit
//     to the plan).
// A leftover meal has no ingredients of its own; only its name ("Leftover <dish>") follows a rename.
//
// Lives in nutrition/data (not routes) because saveRecipe, the one place every recipe write goes through, calls it.
// It reads and writes the `meal_plans` table directly, the same way recipes.ts reads the `recipes` table.

import { addDays, serverToday } from "../dates.ts";
import type { RecipeDoc } from "../recipeModel.ts";
import { all, get, run, type Db } from "./sql.ts";

interface PlanRow {
  item_id: string;
  data: string;
}
interface PlanMeal {
  recipeId?: string;
  leftoverOf?: string;
  name?: string;
  ingredients?: string[];
}
interface PlanDoc {
  weekStart: string;
  meals: PlanMeal[];
}

const hasPlans = (db: Db): boolean =>
  get<{ name: string }>(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meal_plans'") !== undefined;

const plansMentioning = (db: Db, recipeId: string): PlanRow[] =>
  hasPlans(db) ? all<PlanRow>(db, "SELECT item_id, data FROM meal_plans WHERE data LIKE ?", `%"recipeId":${JSON.stringify(recipeId)}%`) : [];

/** A week is over once its Sunday is before today. */
const weekIsOver = (weekStart: string, today: string): boolean => addDays(weekStart, 6) < today;

const sameList = (a: string[] | undefined, b: string[]): boolean => (a ?? []).length === b.length && b.every((x, i) => (a ?? [])[i] === x);

/**
 * After a recipe was saved: make the planned meals that name it carry its new name and ingredients, in weeks not yet
 * over. Only a joint recipe can be on the shared plan, so a personal one does nothing. Returns how many meals changed.
 */
export function syncPlannedMeals(db: Db, next: RecipeDoc, prior: RecipeDoc | undefined, today = serverToday()): number {
  if (next.scope !== "joint" || !prior) return 0;
  if (prior.name === next.name && sameList(prior.ingredients, next.ingredients)) return 0;
  let changed = 0;
  for (const row of plansMentioning(db, next.id)) {
    const plan = JSON.parse(row.data) as PlanDoc;
    if (!plan.weekStart || weekIsOver(plan.weekStart, today)) continue;
    let touched = false;
    for (const meal of plan.meals ?? []) {
      if (meal.recipeId !== next.id) continue;
      if (meal.leftoverOf) {
        const name = `Leftover ${next.name}`;
        if (meal.name !== name) { meal.name = name; touched = true; changed++; }
        continue;
      }
      if (meal.name !== next.name || !sameList(meal.ingredients, next.ingredients)) {
        meal.name = next.name;
        meal.ingredients = [...next.ingredients];
        touched = true;
        changed++;
      }
    }
    if (touched) run(db, "UPDATE meal_plans SET data = ? WHERE item_id = ?", JSON.stringify(plan), row.item_id);
  }
  return changed;
}

export interface RecipeUsage {
  /** Meals (leftovers not counted) on any plan that point at the recipe. */
  plannedMeals: number;
  /** Of those, the ones in a week that is not over. */
  upcoming: number;
}

/** How much of the meal plan uses a recipe: what the delete confirmation says. */
export function recipeUsage(db: Db, recipeId: string, today = serverToday()): RecipeUsage {
  const out: RecipeUsage = { plannedMeals: 0, upcoming: 0 };
  for (const row of plansMentioning(db, recipeId)) {
    const plan = JSON.parse(row.data) as PlanDoc;
    const n = (plan.meals ?? []).filter((m) => m.recipeId === recipeId && !m.leftoverOf).length;
    out.plannedMeals += n;
    if (plan.weekStart && !weekIsOver(plan.weekStart, today)) out.upcoming += n;
  }
  return out;
}
