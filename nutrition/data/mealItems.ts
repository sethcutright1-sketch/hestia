// "A meal" as a list of food amounts: what saved meals store and what "previous meals" show.
// One JSON shape (MealItemJson) serves them both so a client has one mapping from a meal to
// bulk diary items (diary.ts addEntries), and can log a meal from its cached copy with no
// round trip. A recipe will be built from the same items when it starts life as a logged meal
// (phase 3).

import type { Nutrients } from "../nutrients.ts";
import type { Tracker } from "./access.ts";
import { amountOfEntry, computeFromFood, type Amount, type Computed } from "./diary.ts";
import type { EntryRow } from "./days.ts";
import { canSee, getFood, servingsOf, type FoodRow } from "./foods.ts";
import { parseJson } from "./input.ts";
import { allSlotsFor } from "./slots.ts";
import { all, type Db } from "./sql.ts";

/** An amount as stored (saved_meal_item): quantity, plus a serving row or a gram weight. */
export interface StoredAmount {
  quantity: number;
  serving_id: string | null;
  grams: number | null;
}

/**
 * The entry `food` would produce for a STORED amount. Unlike computeFromFood on request input
 * this forgives a serving row that has since been replaced (editing a food's servings issues new
 * ids): it falls back to the food's default serving instead of failing, because the reader is a
 * list screen, not someone who can fix the request.
 */
export function computeStored(db: Db, food: FoodRow, a: StoredAmount): Computed {
  const known = a.serving_id !== null && servingsOf(db, food.id).some((s) => s.id === a.serving_id);
  return computeFromFood(db, food, { quantity: a.quantity, servingId: known ? a.serving_id : null, grams: a.grams });
}

/** How to store the amount a request described, given what computeFromFood made of it. */
export function storedAmount(c: Computed): StoredAmount {
  return { quantity: c.quantity, serving_id: c.servingId, grams: c.servingId === null ? c.grams : null };
}

export interface MealItemJson {
  /** Null only for a quick-add entry shown in a previous meal (display text; never re-logged). */
  foodId: string | null;
  name: string;
  // The fields a bulk diary item needs...
  quantity: number;
  servingId: string | null;
  grams: number | null;
  // ...and what the resulting entry will show, so a phone can render it before the server answers.
  unit: string;
  totalGrams: number | null;
  nutrients: Nutrients;
  kcal: number;
  isQuickAdd: boolean;
  /** false: the food is gone or is someone else's personal food; the item is shown but cannot be logged. */
  available: boolean;
}

const ZERO: Nutrients = { kcal: 0, protein: 0, carbs: 0, fat: 0, satFat: 0, sugars: 0, fiber: 0, cholesterolMg: 0, sodiumMg: 0 };

/** An item for a food amount, as `user` can see it. */
export function mealItem(db: Db, user: Tracker, foodId: string, a: StoredAmount): MealItemJson {
  const food = getFood(db, foodId);
  if (!food || !canSee(food, user.id)) {
    // A deleted food's name is still useful ("Oat milk"); someone else's personal food is not ours to name.
    const nameable = food && food.deleted_at !== null && (food.owner_user_id === null || food.owner_user_id === user.id);
    return {
      foodId, name: nameable ? food.name : "Unavailable food", quantity: a.quantity, servingId: a.serving_id, grams: a.grams,
      unit: "", totalGrams: null, nutrients: ZERO, kcal: 0, isQuickAdd: false, available: false,
    };
  }
  const c = computeStored(db, food, a);
  return {
    foodId, name: c.name, quantity: c.quantity, servingId: c.servingId, grams: c.servingId === null ? c.grams : null,
    unit: c.unit, totalGrams: c.grams, nutrients: c.nutrients, kcal: c.nutrients.kcal, isQuickAdd: false, available: true,
  };
}

/** Display-only item for a quick-add entry (previous meals list them but never re-log them). */
export function quickAddItem(e: EntryRow, nutrients: Nutrients): MealItemJson {
  return {
    foodId: null, name: e.name_snapshot, quantity: 1, servingId: null, grams: null, unit: e.unit_snapshot, totalGrams: null,
    nutrients, kcal: nutrients.kcal, isQuickAdd: true, available: false,
  };
}

export function mealKcal(items: Array<Pick<MealItemJson, "kcal" | "available">>): number {
  return Math.round(items.filter((i) => i.available).reduce((a, i) => a + i.kcal, 0) * 100) / 100;
}

/** The person's live entries in one slot of one day, logged and planned alike, in the order they were added. */
export function slotEntries(db: Db, userId: string, date: string, slot: string): EntryRow[] {
  return all<EntryRow>(db,
    "SELECT * FROM nutrition_diary_entries WHERE user_id = ? AND local_date = ? AND slot_key = ? AND deleted_at IS NULL ORDER BY logged_at, rowid",
    userId, date, slot);
}

export interface Skipped {
  name: string;
  reason: string;
}

/**
 * Turn a slot's entries into re-loggable amounts. Quick adds have no food and entries whose food
 * was deleted (or is someone else's personal food) can't be rebuilt from a food, so both are
 * skipped with a note rather than smuggled in through a hidden food built from the snapshot: a
 * snapshot has no serving data to scale, and a silent copy of one-off numbers would be hard to explain.
 */
export function amountsFromEntries(db: Db, user: Tracker, entries: EntryRow[]): { amounts: Amount[]; skipped: Skipped[] } {
  const amounts: Amount[] = [];
  const skipped: Skipped[] = [];
  for (const e of entries) {
    if (e.is_quick_add === 1 || !e.food_id) {
      skipped.push({ name: e.name_snapshot, reason: "Quick adds have no food to copy." });
      continue;
    }
    const a = amountOfEntry(db, user, e);
    if (!a) skipped.push({ name: e.name_snapshot, reason: "That food was deleted or is no longer shared with you." });
    else amounts.push(a);
  }
  return { amounts, skipped };
}

// ---- previous meals -------------------------------------------------------------------

export const PREVIOUS_DAYS = 21;
const DAY_MS = 86_400_000;

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

/** Same foods in the same amounts = the same meal. Quick adds are not part of the identity: they are never re-logged. */
const identity = (entries: EntryRow[]): string =>
  entries.filter((e) => e.food_id && e.is_quick_add === 0)
    .map((e) => `${e.food_id}:${round4(e.quantity)}:${e.unit_snapshot}`).sort().join("|");

function itemsOf(db: Db, user: Tracker, entries: EntryRow[]): MealItemJson[] {
  return entries.map((e) => {
    const nutrients = parseJson<Nutrients>(e.nutrients_total);
    if (e.is_quick_add === 1 || !e.food_id) return quickAddItem(e, nutrients);
    const a = amountOfEntry(db, user, e);
    if (a) return mealItem(db, user, a.foodId, { quantity: a.quantity ?? 1, serving_id: a.servingId ?? null, grams: a.grams ?? null });
    // The food is gone or personal to someone else: keep the line (what it was) but it cannot be logged.
    return {
      foodId: e.food_id, name: e.name_snapshot, quantity: e.quantity, servingId: null, grams: null, unit: e.unit_snapshot,
      totalGrams: e.grams, nutrients, kcal: nutrients.kcal, isQuickAdd: false, available: false,
    };
  });
}

/**
 * "Previous Meals": what the person actually ate lately, ready to log again.
 *
 * A meal here is the set of LOGGED entries in one slot of one day (planned entries are
 * intentions, not meals). The last 21 days (today included) are grouped by (date, slot) and a
 * group needs at least one food-backed entry that can still be logged. Groups with the same
 * food amounts are one meal -- the same breakfast eaten every morning appears once, at its
 * newest date -- and the list is newest first.
 *
 * Items use the saved-meal item shape at the foods' CURRENT values, so "kcal" is what logging
 * the meal now would add. Quick-add entries are listed as display text only (`isQuickAdd`,
 * never `available`): they have no food, so re-logging skips them and the phone says so.
 */
export function previousMeals(db: Db, user: Tracker, today: string, limit = 20) {
  const max = Math.min(50, Math.max(1, Math.trunc(Number(limit)) || 20));
  const since = new Date(Date.parse(`${today}T00:00:00Z`) - PREVIOUS_DAYS * DAY_MS).toISOString().slice(0, 10);
  const labels = new Map(allSlotsFor(db, user.id).map((s) => [s.key, s.label]));

  const rows = all<EntryRow>(db,
    `SELECT * FROM nutrition_diary_entries WHERE user_id = ? AND status = 'logged' AND deleted_at IS NULL AND local_date >= ? AND local_date <= ?
      ORDER BY local_date DESC, logged_at, rowid`,
    user.id, since, today);
  const groups = new Map<string, EntryRow[]>();
  for (const e of rows) {
    const k = `${e.local_date}\u0000${e.slot_key}`;
    const g = groups.get(k);
    if (g) g.push(e);
    else groups.set(k, [e]);
  }
  // Newest first: by day, and within a day the slot whose last entry was logged most recently.
  const cmp = (x: string, y: string) => (x < y ? 1 : x > y ? -1 : 0); // descending
  const ordered = [...groups.values()].sort((a, b) =>
    cmp(a[0].local_date, b[0].local_date) || cmp(a[a.length - 1].logged_at, b[b.length - 1].logged_at));

  const seen = new Set<string>();
  const meals = [];
  for (const g of ordered) {
    const key = identity(g);
    if (!key || seen.has(key)) continue; // no food-backed entry, or the same meal as a newer one
    const items = itemsOf(db, user, g);
    if (!items.some((i) => i.available)) continue;
    seen.add(key);
    meals.push({
      key: `${g[0].local_date}|${g[0].slot_key}`,
      date: g[0].local_date,
      slotKey: g[0].slot_key,
      slotLabel: labels.get(g[0].slot_key) ?? g[0].slot_key,
      kcal: mealKcal(items),
      items,
      quickAddCount: items.filter((i) => i.isQuickAdd).length,
      unavailableCount: items.filter((i) => !i.isQuickAdd && !i.available).length,
    });
    if (meals.length >= max) break;
  }
  return meals;
}
