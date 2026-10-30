// Barcodes on foods: finding the food a scan resolves to, attaching a scanned code to a food
// you already have (how history from the Lose It! import, which has no barcodes, becomes
// scannable one product at a time), detaching it, and the list the phone keeps for offline scans.
//
// The upstream lookup (Open Food Facts -> USDA -> UPCitemdb) is nutrition/lookup.ts, and the scan-to-new-food
// step is routes/nutrition/barcodes.ts. Everything here is the part that only touches the database.

import { canonicalGtin, isRandomWeight } from "../barcode.ts";
import type { Nutrients } from "../nutrients.ts";
import type { Tracker } from "./access.ts";
import { NutritionError } from "./errors.ts";
import {
  assertFoodEditable, canEdit, canSee, foodJson, getFood, searchFoods, type FoodRow, type ServingRow,
} from "./foods.ts";
import { bodyObject, optString, parseJson, reqString } from "./input.ts";
import { all, get, run, tx, type Db } from "./sql.ts";

// Foods the scan flow itself made from a database lookup. Only these may be swept aside
// when the user says the scanned product was really one of their own foods.
const isFromLookup = (f: FoodRow): boolean => f.source === "off" || f.source === "fdc";

/**
 * The food a scan of this code should land on, among the ones the person can see: their OWN
 * personal food first, then a joint one, never anyone else's personal food. (Migration 6: a code
 * is unique per scope, so a personal and a joint food may both hold it.) Saves an upstream lookup.
 */
export function findFoodByBarcode(db: Db, userId: string, gtin14: string): FoodRow | undefined {
  return get<FoodRow>(db,
    `SELECT * FROM nutrition_foods
      WHERE gtin14 = ? AND deleted_at IS NULL AND (owner_user_id IS NULL OR owner_user_id = ?)
      ORDER BY (owner_user_id IS NULL), rowid LIMIT 1`,
    gtin14, userId);
}

// A barcode is unique within a scope: all joint foods share one, each person's personal foods
// are another. Two foods are in the same scope when their owner is the same (NULL = joint).
const sameScope = (a: Pick<FoodRow, "owner_user_id">, b: Pick<FoodRow, "owner_user_id">): boolean => a.owner_user_id === b.owner_user_id;

function parseCode(b: Record<string, unknown>) {
  const code = reqString(b, "code", 40);
  const format = optString(b, "format", 20) ?? undefined;
  const canon = canonicalGtin(code, format);
  if (!canon) throw new NutritionError(400, "Not a valid UPC/EAN barcode (length or check digit is wrong).");
  if (isRandomWeight(canon.gtin14)) {
    throw new NutritionError(400, "That looks like an in-store price/weight label, not a product barcode, so it can't be saved to a food.");
  }
  return canon;
}

/**
 * Attach a scanned code to a food the person can edit. Body: code, format? ("upc_e" for
 * UPC-E), replaceFoodId?. A code belongs to one food PER SCOPE (all joint foods, or one person's
 * personal foods): if another food in the same scope holds it the answer is 409, naming that food
 * (the caller can always see it). Another person's personal food is never a conflict, and is not
 * mentioned. The one exception to a conflict is the scan flow's own copy of this very product
 * (made a moment ago from a database lookup) which the caller names in replaceFoodId: it is
 * deleted if nobody has logged it, or merely stops claiming the code.
 */
export function attachBarcode(db: Db, user: Tracker, foodId: string, input: unknown) {
  const food = assertFoodEditable(getFood(db, foodId), user.id);
  const b = bodyObject(input);
  const canon = parseCode(b);
  const replaceFoodId = optString(b, "replaceFoodId", 80);

  const out = tx(db, () => {
    // Everything holding this code, in any scope. Only the SAME-scope holder can block the
    // attach (nobody's personal food ever blocks a joint one or another person's), and that holder
    // is always one the caller can see, so naming it in the 409 leaks nothing.
    const holders = all<FoodRow>(db, "SELECT * FROM nutrition_foods WHERE gtin14 = ? AND deleted_at IS NULL", canon.gtin14)
      .filter((h) => h.id !== food.id);
    const blocker = holders.find((h) => sameScope(h, food));
    let replaced: { id: string; name: string; action: "deleted" | "unlinked" } | null = null;

    // The scan flow's own copy of this very product (made a moment ago from a database lookup) may
    // give up the code when the caller names it in replaceFoodId. It is usually joint, so it may
    // sit in a different scope from a personal food being linked: it is swept either way, as long
    // as the caller could see and edit it.
    const replacee = replaceFoodId ? holders.find((h) => h.id === replaceFoodId) : undefined;
    if (blocker && blocker.id !== replacee?.id) {
      // Anything else (a food you built by hand, say) is the answer "that barcode is already taken".
      throw new NutritionError(409, `That barcode already belongs to "${blocker.name}". Unlink it there first.`,
        { conflict: { id: blocker.id, name: blocker.name } });
    }
    if (replacee) {
      if (!isFromLookup(replacee) || !canEdit(replacee, user.id)) {
        throw new NutritionError(409, `That barcode already belongs to "${replacee.name}". Unlink it there first.`,
          canSee(replacee, user.id) ? { conflict: { id: replacee.id, name: replacee.name } } : {});
      }
      const used = get<{ n: number }>(db, "SELECT COUNT(*) AS n FROM nutrition_diary_entries WHERE food_id = ? AND deleted_at IS NULL", replacee.id)!.n;
      if (used === 0) {
        // Soft delete, like every food delete: it frees the code (the unique indexes ignore deleted rows).
        run(db, "UPDATE nutrition_foods SET deleted_at = ? WHERE id = ?", new Date().toISOString(), replacee.id);
        replaced = { id: replacee.id, name: replacee.name, action: "deleted" };
      } else {
        // Someone already logged it, so it stays as a food; it just stops claiming the code.
        run(db, "UPDATE nutrition_foods SET gtin14 = NULL WHERE id = ?", replacee.id);
        replaced = { id: replacee.id, name: replacee.name, action: "unlinked" };
      }
    }

    try {
      run(db, "UPDATE nutrition_foods SET gtin14 = ? WHERE id = ?", canon.gtin14, food.id);
    } catch (err) {
      // A race with another request: the message never names the other food.
      if (/UNIQUE constraint failed/i.test(String((err as Error)?.message))) throw new NutritionError(409, "Another food already has that barcode.");
      throw err;
    }
    return { replaced, previousGtin14: food.gtin14 && food.gtin14 !== canon.gtin14 ? food.gtin14 : null };
  });
  return { food: foodJson(db, getFood(db, food.id)!), ...out };
}

/** Hand the code back: the next scan goes upstream again. Fine on a food with no barcode. */
export function detachBarcode(db: Db, user: Tracker, foodId: string) {
  const food = assertFoodEditable(getFood(db, foodId), user.id);
  run(db, "UPDATE nutrition_foods SET gtin14 = NULL WHERE id = ?", food.id);
  return { food: foodJson(db, getFood(db, food.id)!) };
}

// kcal in one default serving: what the offline scan result shows before the amount step.
const defaultServingOf = (servings: ServingRow[]): ServingRow | null => servings.find((s) => s.is_default === 1) ?? servings[0] ?? null;

function kcalPerDefaultServing(f: FoodRow, nutrients: Nutrients, s: ServingRow | null): number {
  if (f.basis === "per_serving" || !s?.grams) return nutrients.kcal;
  return Math.round(((nutrients.kcal * s.grams) / 100) * 100) / 100;
}

/**
 * Every barcoded food the person can see, with what the amount step needs (nutrients, servings),
 * not just a name: the phone keeps this so a barcode resolves with no connection, and the diary
 * write that follows goes through the outbox.
 */
export function listBarcodedFoods(db: Db, user: Tracker) {
  const visible = all<FoodRow>(db,
    `SELECT * FROM nutrition_foods
      WHERE gtin14 IS NOT NULL AND deleted_at IS NULL AND (owner_user_id IS NULL OR owner_user_id = ?)
      ORDER BY usage_count DESC, name`,
    user.id);
  // One food per code: when the person's own personal food and a joint food share a code, the
  // personal one is what a scan resolves to (findFoodByBarcode), so it is the one the phone keeps.
  const chosen = new Map<string, FoodRow>();
  for (const f of visible) {
    const cur = chosen.get(f.gtin14!);
    if (!cur || (cur.owner_user_id === null && f.owner_user_id !== null)) chosen.set(f.gtin14!, f);
  }
  const foods = visible.filter((f) => chosen.get(f.gtin14!)!.id === f.id);
  // One query for every serving rather than one per food.
  const byFood = new Map<string, ServingRow[]>();
  for (const s of all<ServingRow>(db,
    `SELECT s.* FROM nutrition_food_servings s JOIN nutrition_foods f ON f.id = s.food_id
      WHERE f.gtin14 IS NOT NULL AND f.deleted_at IS NULL AND (f.owner_user_id IS NULL OR f.owner_user_id = ?)
      ORDER BY s.is_default DESC, s.rowid`, user.id)) {
    const list = byFood.get(s.food_id);
    if (list) list.push(s);
    else byFood.set(s.food_id, [s]);
  }
  return foods.map((f) => {
    const servings = byFood.get(f.id) ?? [];
    const nutrients = parseJson<Nutrients>(f.nutrients);
    const def = defaultServingOf(servings);
    return {
      id: f.id,
      gtin14: f.gtin14,
      name: f.name,
      brand: f.brand,
      basis: f.basis,
      nutrients,
      servings: servings.map((s) => ({ id: s.id, label: s.label, grams: s.grams, isDefault: s.is_default === 1 })),
      defaultServing: def && { id: def.id, label: def.label, grams: def.grams },
      kcal: kcalPerDefaultServing(f, nutrients, def),
    };
  });
}

/**
 * Candidates for "is this one of your foods?": joint foods and the person's own (never the USDA
 * catalogue) that have no barcode yet, ranked like normal search. Foods that already carry a
 * code are left out on purpose: a food holds one barcode, so offering them would mean silently
 * dropping the old one.
 */
export function linkCandidates(db: Db, user: Tracker, q: string, limit = 5): FoodRow[] {
  const max = Math.min(10, Math.max(1, Math.trunc(Number(limit)) || 5));
  return searchFoods(db, user.id, q, max, Date.now(), { skipGeneric: true, withoutBarcode: true, anyWord: true });
}
