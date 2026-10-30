// "Use from pantry?" (merge plan decision 7). After a person logs an entry that came from a recipe, the app
// asks, every time, whether the recipe's ingredients should come out of the pantry:
//
//   suggestions   the recipe's lines matched to pantry items, with an amount pre-filled from the line
//   confirm       takes those amounts out of the pantry's stock -- never below zero, all or nothing
//
// The pantry is household-app's `pantry_items` table (JSON documents, always joint). The nutrition data
// layer can't import db.ts, so like recipes.ts it reads and writes them with plain SQL on the handle it is given.
//
// WHAT CAN BE COUNTED. Pantry only does arithmetic on `stockCount`, which a barcode scan sets (routes/pantry.ts);
// its `quantity` is a free-text display box that mirrors it. So an item is "countable" when it has a stockCount,
// or its quantity is a plain number ("3"); an item whose quantity is words ("a bag") is matched and shown but
// can't be decremented, and the confirm refuses it by name. Recipe amounts are grams and cups, pantry stock is
// packages and cans, so the suggested amount is deliberately simple: a line with a bare count ("2 peppers")
// suggests that count, anything else suggests 1 unit, and it never suggests more than is in stock. The person
// edits the number before confirming. Matching is the pantry's own: ingredients.ts matchesAny (head noun).
//
// ONE CONFIRM PER ENTRY. The entry remembers (pantry_used_at) so a double tap or a retried request can't take
// the same items out twice; a second confirm answers 409.

import { matchesAny } from "../../ingredients.ts";
import { parseIngredientLine } from "../recipeModel.ts";
import { assertCanTrack, type Tracker } from "./access.ts";
import type { EntryRow } from "./days.ts";
import { NutritionError } from "./errors.ts";
import { bodyObject } from "./input.ts";
import { getRecipeRecord, canSeeRecipe, linesOf } from "./recipes.ts";
import { getFood } from "./foods.ts";
import { all, get, run, tx, type Db } from "./sql.ts";

export const MAX_PANTRY_USE_AMOUNT = 1000;

interface PantryDoc {
  id: string;
  name: string;
  quantity?: string;
  stockCount?: number;
  updatedAt?: string;
  updatedBy?: string;
  [key: string]: unknown;
}

/** The pantry items `userId` can see (the pantry is joint, but the rule is db.ts's: joint or your own). */
function visiblePantry(db: Db, userId: string): PantryDoc[] {
  return all<{ data: string }>(db, "SELECT data FROM pantry_items WHERE owner_user_id IS NULL OR owner_user_id = ?", userId)
    .map((r) => JSON.parse(r.data) as PantryDoc);
}

/** The count Pantry holds for an item, or null when it only has words ("a bag"). */
export function pantryStock(item: Pick<PantryDoc, "stockCount" | "quantity">): number | null {
  if (typeof item.stockCount === "number" && Number.isFinite(item.stockCount)) return item.stockCount;
  const q = String(item.quantity ?? "").trim();
  return /^\d+(\.\d+)?$/.test(q) ? Number(q) : null;
}

function ownRecipeEntry(db: Db, user: Tracker, entryId: string): { entry: EntryRow; recipeId: string } {
  const entry = get<EntryRow>(db, "SELECT * FROM nutrition_diary_entries WHERE id = ? AND user_id = ? AND deleted_at IS NULL", entryId, user.id);
  if (!entry) throw new NutritionError(404, "Entry not found.");
  const recipeId = entry.food_id ? getFood(db, entry.food_id)?.recipe_id ?? null : null;
  if (!recipeId) throw new NutritionError(404, "That entry isn't from a recipe, so there is nothing to take out of the pantry.");
  return { entry, recipeId };
}

export interface PantrySuggestion {
  pantryItemId: string;
  name: string;
  /** Items in stock, or null when the pantry only has words for it. */
  stock: number | null;
  countable: boolean;
  /** The amount pre-filled: what the recipe line says for a bare count, else 1; never more than the stock. */
  suggested: number;
  /** The recipe lines that matched this item, as written. */
  lines: string[];
}

/** The recipe behind an entry, matched to the pantry. Writes nothing. */
export function pantryUseSuggestions(db: Db, user: Tracker, entryId: string) {
  assertCanTrack(user);
  const { entry, recipeId } = ownRecipeEntry(db, user, entryId);
  const rec = getRecipeRecord(db, recipeId);
  if (!rec || !canSeeRecipe(rec, user.id)) throw new NutritionError(404, "That recipe is gone, so there is nothing to match.");
  const pantry = visiblePantry(db, user.id);

  const byItem = new Map<string, PantrySuggestion>();
  let unmatched = 0;
  for (const line of linesOf(rec.doc)) {
    const matches = pantry.filter((p) => matchesAny(line.pantryName, [p.name]));
    if (matches.length === 0) {
      unmatched++;
      continue;
    }
    const parsed = parseIngredientLine(line.text);
    const countLine = parsed.unit === null && parsed.quantity !== null && parsed.quantity > 0 ? Math.ceil(parsed.quantity) : 1;
    for (const item of matches) {
      const stock = pantryStock(item);
      const seen = byItem.get(item.id);
      if (seen) {
        seen.lines.push(line.text);
        continue;
      }
      byItem.set(item.id, {
        pantryItemId: item.id, name: item.name, stock, countable: stock !== null,
        suggested: stock === null ? countLine : Math.min(countLine, Math.max(0, Math.floor(stock))), lines: [line.text],
      });
    }
  }
  return {
    entryId: entry.id,
    recipeName: rec.doc.name,
    status: entry.status,
    alreadyUsed: entry.pantry_used_at !== null,
    items: [...byItem.values()].sort((a, b) => a.name.localeCompare(b.name)),
    unmatchedLines: unmatched,
  };
}

export interface PantryUseResult {
  updated: Array<{ pantryItemId: string; name: string; before: number; after: number; clamped: boolean }>;
}

/**
 * Take the confirmed amounts out of the pantry. Body: { items: [{ pantryItemId, amount }] }. Everything is
 * checked first (the entry is yours, logged, and not already used; each item is one you can see and can be
 * counted; each amount is a positive number), then every item is written or none is. Stock never goes below zero.
 */
export function usePantry(db: Db, user: Tracker, entryId: string, input: unknown): PantryUseResult {
  assertCanTrack(user);
  const b = bodyObject(input);
  if (!Array.isArray(b.items) || b.items.length === 0 || b.items.length > 100) {
    throw new NutritionError(400, "items must be a list of { pantryItemId, amount } (1 to 100).");
  }
  const items = b.items;
  return tx(db, () => {
    const { entry, recipeId } = ownRecipeEntry(db, user, entryId);
    if (entry.status !== "logged") throw new NutritionError(409, "Log it first: the pantry is only used once the meal was eaten.");
    if (entry.pantry_used_at) throw new NutritionError(409, "The pantry was already updated for this entry.");
    const rec = getRecipeRecord(db, recipeId);
    if (!rec || !canSeeRecipe(rec, user.id)) throw new NutritionError(404, "That recipe is gone.");

    const pantry = new Map(visiblePantry(db, user.id).map((p) => [p.id, p]));
    const seen = new Set<string>();
    const plan = items.map((raw, i) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new NutritionError(400, `items[${i}] must be an object.`);
      const { pantryItemId, amount } = raw as { pantryItemId?: unknown; amount?: unknown };
      const item = typeof pantryItemId === "string" ? pantry.get(pantryItemId) : undefined;
      if (!item) throw new NutritionError(404, `items[${i}]: that pantry item wasn't found.`);
      if (seen.has(item.id)) throw new NutritionError(400, `items[${i}]: ${item.name} is listed twice.`);
      seen.add(item.id);
      if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0 || amount > MAX_PANTRY_USE_AMOUNT) {
        throw new NutritionError(400, `items[${i}]: amount must be a number above 0 (and at most ${MAX_PANTRY_USE_AMOUNT}).`);
      }
      const stock = pantryStock(item);
      if (stock === null) throw new NutritionError(400, `${item.name} isn't counted in the pantry (its quantity is words, not a number), so it can't be reduced here.`);
      return { item, amount, stock };
    });

    const now = new Date().toISOString();
    const updated: PantryUseResult["updated"] = [];
    for (const { item, amount, stock } of plan) {
      const after = Math.max(0, Math.round((stock - amount) * 1000) / 1000);
      const doc: PantryDoc = { ...item, quantity: String(after), updatedAt: now, updatedBy: user.id };
      // stockCount is only written where the item already has one: a hand-typed quantity stays a quantity.
      if (typeof item.stockCount === "number") doc.stockCount = after;
      run(db, "UPDATE pantry_items SET data = ? WHERE item_id = ? AND (owner_user_id IS NULL OR owner_user_id = ?)", JSON.stringify(doc), item.id, user.id);
      updated.push({ pantryItemId: item.id, name: item.name, before: stock, after, clamped: stock - amount < 0 });
    }
    run(db, "UPDATE nutrition_diary_entries SET pantry_used_at = ?, updated_at = ? WHERE id = ?", now, now, entry.id);
    return { updated };
  });
}
