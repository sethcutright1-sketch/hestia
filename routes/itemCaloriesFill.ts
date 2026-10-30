// The shared body of "Fill calories" for the Pantry and for a shopping list (itemCalories.ts has
// the rules). Each screen's route loads its items, calls this, and saves what changed.

import type express from "express";
import { db } from "../db.ts";
import { currentUserId } from "../auth.ts";
import { providerById, ProviderUnavailableError } from "../assistant/providers/index.ts";
import { lookupBarcode } from "../nutrition/lookup.ts";
import { searchFoods, servingsOf } from "../nutrition/data/foods.ts";
import { estimateWithProvider, fillMissingCalories, type CalorieItem, type FillDeps, type FillSummary, type NamedFigure } from "../itemCalories.ts";

export interface FillOutcome {
  summary: FillSummary;
  /** Set when the chosen model could not be used (not running, no key): the rest was still filled. */
  warning: string | null;
  /** The model that was asked, or null when none was chosen. */
  model: string | null;
}

/** Test seam: replaces the barcode and catalogue sources so tests reach no network or database tables. */
let depsOverride: Pick<FillDeps, "lookup" | "foodByName"> | null = null;
export function setFillSourcesForTests(d: Pick<FillDeps, "lookup" | "foodByName"> | null): void {
  depsOverride = d;
}

/** "Whole milk" and "milk, whole" are different foods; only "Milk, whole" is called "milk". So an item
 *  name counts as a catalogue food only when it is the food's name up to the first comma (plural or not). */
export function sameFoodName(foodName: string, itemName: string): boolean {
  const head = foodName.split(",")[0].trim().toLowerCase();
  const item = itemName.trim().toLowerCase();
  if (!head || !item) return false;
  return head === item || head === `${item}s` || `${head}s` === item;
}

function catalogueFigure(userId: string, name: string): NamedFigure | null {
  for (const food of searchFoods(db, userId, name, 8)) {
    if (!sameFoodName(food.name, name)) continue;
    let nutrients: { kcal?: number };
    try {
      nutrients = JSON.parse(food.nutrients);
    } catch {
      continue;
    }
    if (typeof nutrients.kcal !== "number") continue;
    const serving = servingsOf(db, food.id).find((s) => s.is_default === 1) ?? servingsOf(db, food.id)[0];
    if (food.basis === "per_serving") return { kcal: Math.round(nutrients.kcal), serving: serving?.label ?? null };
    if (serving?.grams) return { kcal: Math.round((nutrients.kcal * serving.grams) / 100), serving: `${serving.label} (${serving.grams} g)` };
  }
  return null;
}

/** Runs the fill over `items` (changed in place). Sends 400 itself and returns null for a bad `provider`. */
export async function runFill(req: express.Request, res: express.Response, items: CalorieItem[]): Promise<FillOutcome | null> {
  const requested = req.body?.provider;
  const provider = requested === undefined || requested === null || requested === "" ? null : providerById(requested);
  if (requested !== undefined && requested !== null && requested !== "" && !provider) {
    res.status(400).json({ error: "Unknown model." });
    return null;
  }
  const userId = currentUserId(req);
  let warning: string | null = null;
  const sources = depsOverride ?? {
    lookup: (upc: string) => lookupBarcode(db, upc),
    foodByName: (name: string) => catalogueFigure(userId, name),
  };
  const summary = await fillMissingCalories(items, {
    ...sources,
    modelLabel: provider?.label.replace(/,\s*local\)/, ")"),
    estimate: provider
      ? async (names) => {
          try {
            return await estimateWithProvider(provider, names);
          } catch (err) {
            warning = err instanceof ProviderUnavailableError ? err.hint : "The model didn't answer. Try again.";
            throw err;
          }
        }
      : undefined,
  });
  return { summary, warning, model: provider ? provider.label : null };
}
