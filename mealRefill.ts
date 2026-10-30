// Picking a replacement for a denied meal (the project notes, the owner's list: "fill the meal plan with the meals
// that were denied"). Pure: no database, so the rules are easy to test. routes/mealplan.ts gathers the inputs.
//
// A recipe is a candidate unless
//   - it is the denied meal's own recipe, or the recipe of any other meal the week has refused;
//   - it is already on the plan (a meal that is not denied -- leftovers included -- uses it);
//   - it calls for something a person the meal is for won't eat (same check as the plan's dislike warnings).
// Candidates are ranked by
//   1. not going over the calorie room left that day (a recipe with no calories saved is never "over");
//   2. fewer ingredients the pantry doesn't cover;
//   3. calories closest to the room left, when there is one;
//   4. name, so the answer is stable.

import { computeMissing, findDislikeConflicts, normalizeName, type MemberLike } from "./ingredients.ts";

export interface RefillRecipe {
  id: string;
  name: string;
  ingredients: string[];
  /** kcal for one serving; null when the recipe has no calories yet. */
  kcalPerServing: number | null;
}

export interface RefillMeal {
  id: string;
  name: string;
  recipeId?: string;
  status: string;
  ingredients?: string[];
  audience?: "family" | "individual";
  memberId?: string;
}

export interface RefillInput {
  denied: RefillMeal;
  /** Every meal in the week's plan, the denied one included. */
  planMeals: RefillMeal[];
  recipes: RefillRecipe[];
  members: MemberLike[];
  pantry: string[];
  /** Calories still free that day for the people the meal is for (the tightest of them); null when not known. */
  roomKcal: number | null;
}

export function pickReplacement(input: RefillInput): RefillRecipe | null {
  const { denied, planMeals, recipes, members, pantry, roomKcal } = input;

  const refusedIds = new Set<string>([denied.recipeId ?? ""]);
  const refusedNames = new Set<string>([normalizeName(denied.name)]);
  const usedIds = new Set<string>();
  const usedNames = new Set<string>();
  for (const m of planMeals) {
    if (m.status === "denied") {
      if (m.recipeId) refusedIds.add(m.recipeId);
      refusedNames.add(normalizeName(m.name));
    } else {
      if (m.recipeId) usedIds.add(m.recipeId);
      usedNames.add(normalizeName(m.name.replace(/^leftover\s+/i, "")));
    }
  }

  const rows: { recipe: RefillRecipe; over: number; missing: number; gap: number }[] = [];
  for (const recipe of recipes) {
    const name = normalizeName(recipe.name);
    if (refusedIds.has(recipe.id) || refusedNames.has(name)) continue;
    if (usedIds.has(recipe.id) || usedNames.has(name)) continue;
    const asMeal = { id: "candidate", ingredients: recipe.ingredients, status: "proposed", audience: denied.audience, memberId: denied.memberId };
    if (findDislikeConflicts([asMeal], members).length > 0) continue;

    const kcal = recipe.kcalPerServing;
    const known = roomKcal !== null && kcal !== null;
    rows.push({
      recipe,
      over: known && kcal > roomKcal ? 1 : 0,
      missing: computeMissing([{ ingredients: recipe.ingredients }], pantry).length,
      gap: known ? Math.abs(roomKcal - kcal) : 0,
    });
  }

  rows.sort((a, b) =>
    a.over - b.over || a.missing - b.missing || a.gap - b.gap || a.recipe.name.localeCompare(b.recipe.name));
  return rows[0]?.recipe ?? null;
}
