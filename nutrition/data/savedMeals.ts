// Saved meals: named templates of food amounts ("my usual breakfast"). Logging one is a bulk
// diary write built on the client from the list's own items (diary.ts addEntries), so this file
// only stores, shares and serves them.
//
// Joint (owner_user_id NULL) or personal (a user id), like everything else. A joint meal is
// logged by the other person item by item, so it can only hold foods they can log: a personal
// food in a joint meal is refused.

import crypto from "node:crypto";
import { assertCanTrack, type Tracker } from "./access.ts";
import { computeFromFood } from "./diary.ts";
import { NutritionError } from "./errors.ts";
import { getFood, parseScope, requireVisibleFood, type Scope } from "./foods.ts";
import { bodyObject, camelKeys, localDateField, optString, reqString, type Body } from "./input.ts";
import {
  amountsFromEntries, mealItem, mealKcal, slotEntries, storedAmount,
  type MealItemJson, type Skipped, type StoredAmount,
} from "./mealItems.ts";
import { allSlotsFor } from "./slots.ts";
import { all, get, run, tx, type Db } from "./sql.ts";

export interface SavedMealRow {
  id: string;
  owner_user_id: string | null;
  created_by_user_id: string;
  name: string;
  default_slot_key: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface SavedMealItemRow extends StoredAmount {
  id: string;
  saved_meal_id: string;
  position: number;
  food_id: string;
}

export const MAX_MEAL_ITEMS = 100;

export const getSavedMeal = (db: Db, id: string): SavedMealRow | undefined =>
  get<SavedMealRow>(db, "SELECT * FROM nutrition_saved_meals WHERE id = ?", id);

export const savedMealItems = (db: Db, id: string): SavedMealItemRow[] =>
  all<SavedMealItemRow>(db, "SELECT * FROM nutrition_saved_meal_items WHERE saved_meal_id = ? ORDER BY position, rowid", id);

const scopeOf = (m: Pick<SavedMealRow, "owner_user_id">): Scope => (m.owner_user_id === null ? "joint" : "personal");

export function canSeeSavedMeal(m: SavedMealRow, userId: string): boolean {
  if (m.deleted_at) return false;
  return m.owner_user_id === null || m.owner_user_id === userId;
}

export function requireSavedMeal(db: Db, user: Tracker, id: string): SavedMealRow {
  const m = getSavedMeal(db, id);
  if (!m || !canSeeSavedMeal(m, user.id)) throw new NutritionError(404, "Saved meal not found.");
  return m;
}

/** Every saved meal the person can see (joint ones and their own), by name. */
export function listSavedMeals(db: Db, user: Tracker): SavedMealRow[] {
  return all<SavedMealRow>(db,
    `SELECT * FROM nutrition_saved_meals WHERE deleted_at IS NULL AND (owner_user_id IS NULL OR owner_user_id = ?)
      ORDER BY name COLLATE NOCASE, created_at`,
    user.id);
}

export function savedMealJson(db: Db, user: Tracker, m: SavedMealRow, skipped?: Skipped[]) {
  const items: MealItemJson[] = savedMealItems(db, m.id).map((i) => mealItem(db, user, i.food_id, i));
  return {
    id: m.id,
    name: m.name,
    scope: scopeOf(m),
    ownerUserId: m.owner_user_id,
    createdByUserId: m.created_by_user_id,
    mine: m.created_by_user_id === user.id,
    defaultSlotKey: m.default_slot_key,
    // Only what can be logged counts: the number the list shows is the number logging adds.
    kcal: mealKcal(items),
    items,
    ...(skipped ? { skipped } : {}),
    createdAt: m.created_at,
    updatedAt: m.updated_at,
  };
}

interface NewItem extends StoredAmount {
  food_id: string;
}

/** Validate request items like diary amounts: visible foods, servings that belong to them. */
function parseItems(db: Db, user: Tracker, raw: unknown, scope: Scope): NewItem[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new NutritionError(400, "items must be a non-empty array.");
  if (raw.length > MAX_MEAL_ITEMS) throw new NutritionError(400, `A saved meal can hold at most ${MAX_MEAL_ITEMS} items.`);
  return raw.map((entry, i) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new NutritionError(400, `items[${i}] must be an object.`);
    const b = camelKeys(entry);
    if (b.foodId === undefined) throw new NutritionError(400, `items[${i}].foodId is required.`);
    const food = requireVisibleFood(db, user.id, b.foodId);
    if (scope === "joint") assertShareable(food);
    return { food_id: food.id, ...storedAmount(computeFromFood(db, food, b)) };
  });
}

/** A joint thing (saved meal, recipe) is read by both logins, so it may only name foods both can see. */
export function assertShareable(food: { name: string; owner_user_id: string | null }, keep = "this meal"): void {
  if (food.owner_user_id !== null) {
    throw new NutritionError(400, `"${food.name}" is a personal food. Make the food shared (joint), or keep ${keep} personal.`);
  }
}

function parseDefaultSlot(db: Db, user: Tracker, b: Body, fallback: string | null): string | null {
  if (b.defaultSlotKey === undefined) return fallback;
  const key = optString(b, "defaultSlotKey", 40);
  if (key !== null && !allSlotsFor(db, user.id).some((s) => s.key === key)) throw new NutritionError(400, "defaultSlotKey isn't one of your meals.");
  return key;
}

function writeItems(db: Db, mealId: string, items: NewItem[]): void {
  run(db, "DELETE FROM nutrition_saved_meal_items WHERE saved_meal_id = ?", mealId);
  items.forEach((it, position) => {
    run(db, "INSERT INTO nutrition_saved_meal_items (id, saved_meal_id, position, food_id, quantity, serving_id, grams) VALUES (?, ?, ?, ?, ?, ?, ?)",
      crypto.randomUUID(), mealId, position, it.food_id, it.quantity, it.serving_id, it.grams);
  });
}

/**
 * Create from explicit `items`, or from a logged slot via { fromDate, fromSlot }. Body: name, scope?
 * (default joint), defaultSlotKey?, items | fromDate + fromSlot. Returns what was skipped when
 * copying a slot (quick adds, foods that are gone).
 */
export function createSavedMeal(db: Db, user: Tracker, input: unknown): { meal: SavedMealRow; skipped: Skipped[] } {
  assertCanTrack(user);
  const b = bodyObject(input);
  const name = reqString(b, "name", 120);
  const scope = parseScope(b.scope);
  const fromSlot = b.fromSlot !== undefined || b.fromDate !== undefined;
  if (fromSlot && b.items !== undefined) throw new NutritionError(400, "Send either items or fromDate/fromSlot, not both.");

  return tx(db, () => {
    let items: NewItem[];
    let skipped: Skipped[] = [];
    let slotDefault: string | null = null;
    if (fromSlot) {
      const date = localDateField(b.fromDate, "fromDate");
      const slot = reqString(b, "fromSlot", 40);
      const entries = slotEntries(db, user.id, date, slot);
      if (entries.length === 0) throw new NutritionError(404, "There is nothing in that meal to save.");
      const got = amountsFromEntries(db, user, entries);
      skipped = got.skipped;
      if (got.amounts.length === 0) throw new NutritionError(400, "None of the foods in that meal can be saved (quick adds have no food).", { skipped });
      items = parseItems(db, user, got.amounts, scope);
      slotDefault = slot;
    } else {
      items = parseItems(db, user, b.items, scope);
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    run(db,
      "INSERT INTO nutrition_saved_meals (id, owner_user_id, created_by_user_id, name, default_slot_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      id, scope === "personal" ? user.id : null, user.id, name, parseDefaultSlot(db, user, b, slotDefault), now, now);
    writeItems(db, id, items);
    return { meal: getSavedMeal(db, id)!, skipped };
  });
}

/**
 * Partial update: missing fields keep their value; `items`, when present, replaces the list.
 * Anyone who can see a joint meal can edit it. Sharing a personal meal needs every food in it to
 * be joint; making a joint meal personal makes it the CREATOR's.
 */
export function updateSavedMeal(db: Db, user: Tracker, id: string, input: unknown): SavedMealRow {
  assertCanTrack(user);
  const b = bodyObject(input);
  return tx(db, () => {
    const cur = requireSavedMeal(db, user, id);
    const name = b.name === undefined ? cur.name : reqString(b, "name", 120);
    const scope = b.scope === undefined ? scopeOf(cur) : parseScope(b.scope);
    if (scope !== scopeOf(cur) && cur.created_by_user_id !== user.id) {
      throw new NutritionError(403, "Only the person who saved a meal can change who it's shared with.");
    }
    const items = b.items !== undefined ? parseItems(db, user, b.items, scope) : null;
    // Sharing a meal that wasn't shared: its existing foods have to be shareable too.
    if (!items && scope === "joint" && scopeOf(cur) !== "joint") {
      for (const i of savedMealItems(db, cur.id)) {
        const food = getFood(db, i.food_id);
        if (food) assertShareable(food);
      }
    }
    run(db, "UPDATE nutrition_saved_meals SET name = ?, owner_user_id = ?, default_slot_key = ?, updated_at = ? WHERE id = ?",
      name, scope === "personal" ? cur.created_by_user_id : null, parseDefaultSlot(db, user, b, cur.default_slot_key), new Date().toISOString(), cur.id);
    if (items) writeItems(db, cur.id, items);
    return getSavedMeal(db, cur.id)!;
  });
}

/** Soft delete. */
export function deleteSavedMeal(db: Db, user: Tracker, id: string): void {
  const meal = requireSavedMeal(db, user, id);
  const now = new Date().toISOString();
  run(db, "UPDATE nutrition_saved_meals SET deleted_at = ?, updated_at = ? WHERE id = ?", now, now, meal.id);
}
