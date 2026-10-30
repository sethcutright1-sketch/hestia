// The food catalogue: what a food's calories ARE. See ./README.md for the contract every domain module follows.
//
// sensitivity "household", deliberately. The catalogue is the shared list of foods (the household's own and
// joint foods first, then the USDA catalogue) -- the same list every login's "Add food" screen searches. It says
// nothing about anyone's diary: not what they ate, not their calorie budget. A person's own PERSONAL foods are
// visible to that person only (searchFoods scopes by user), exactly as in the app.
//
// Recipe calories ("the lasagna is 520 kcal a serving") are household data too and live in the meal-plan tools
// (list_recipes, save_recipe). The calorie DIARY tools -- anything about what a person ate, their calorie budget,
// weight, steps or goals -- are the `health` tools in ./calories.ts.

import type { DomainTool, ToolModule } from "../registry.ts";
import { db as appDb } from "../../db.ts";
import { searchFoods, servingsOf, type FoodRow } from "../../nutrition/data/foods.ts";
import { parseJson } from "../../nutrition/data/input.ts";
import { round2, type Nutrients } from "../../nutrition/nutrients.ts";

export const MAX_FOOD_RESULTS = 10;

/** Where a food came from, in words a person would say. */
function foodOrigin(f: FoodRow, userId: string): string {
  if (f.source === "usda_generic") return "USDA catalogue";
  if (f.source === "recipe") return "household recipe";
  if (f.source === "off" || f.source === "fdc") return "scanned product database";
  return f.owner_user_id === userId ? "your own food" : "household food";
}

/** One search hit with its calories worked out per serving, so the model never has to do the arithmetic. */
export function foodHit(f: FoodRow, userId: string) {
  const n = parseJson<Nutrients>(f.nutrients);
  const servings = servingsOf(appDb, f.id);
  const common = {
    foodId: f.id,
    name: f.name,
    brand: f.brand ?? undefined,
    from: foodOrigin(f, userId),
  };
  if (f.basis === "per_serving") {
    return {
      ...common,
      measuredPer: "serving",
      servings: servings.map((s) => ({
        serving: s.label,
        grams: s.grams ?? undefined,
        calories: round2(n.kcal),
        isDefault: s.is_default === 1 || undefined,
      })),
      calories: round2(n.kcal),
      proteinGrams: round2(n.protein),
      carbGrams: round2(n.carbs),
      fatGrams: round2(n.fat),
    };
  }
  return {
    ...common,
    measuredPer: "100 g",
    caloriesPer100g: round2(n.kcal),
    servings: servings
      .filter((s) => s.grams !== null)
      .map((s) => ({
        serving: s.label,
        grams: s.grams ?? undefined,
        calories: round2((n.kcal * (s.grams as number)) / 100),
        isDefault: s.is_default === 1 || undefined,
      })),
    proteinPer100g: round2(n.protein),
    carbsPer100g: round2(n.carbs),
    fatPer100g: round2(n.fat),
  };
}

function foodTools(userId: string): DomainTool[] {
  return [
    {
      name: "search_food_calories",
      description:
        "Look up how many calories a food has. Searches the household's own foods first, then the USDA " +
        "catalogue, and returns each match with its calories per serving (and per 100 g). This is the FOOD " +
        "CATALOGUE only: it says nothing about what anyone has eaten or their calorie budget. It also gives each " +
        "food's id and servings, for putting the food in a diary. Report only what it returns; if nothing " +
        "matches, say so.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: 'The food, e.g. "egg", "whole wheat bread", "Greek yogurt".' },
          limit: { type: "number", description: `How many matches, 1 to ${MAX_FOOD_RESULTS}. Default 5.` },
        },
        required: ["query"],
      },
      run: async ({ query, limit }) => {
        const q = typeof query === "string" ? query.trim() : "";
        if (!q) return { error: "Say which food to look up." };
        const n = typeof limit === "number" && Number.isFinite(limit) ? Math.min(MAX_FOOD_RESULTS, Math.max(1, Math.round(limit))) : 5;
        const found = searchFoods(appDb, userId, q, n);
        if (found.length === 0) return { error: `No food matching "${q}" in the household's foods or the USDA catalogue.` };
        return found.map((f) => foodHit(f, userId));
      },
    },
  ];
}

export const foodCatalogueModule: ToolModule = {
  domain: "foods",
  sensitivity: "household",
  label: "the food catalogue (calories in foods)",
  build: foodTools,
};
