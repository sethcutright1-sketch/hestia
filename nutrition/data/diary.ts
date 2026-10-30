// Diary entries: log, plan, edit, delete, undo a group, and the day view.
//
// The one place an entry gets built and written -- the single add, the bulk add, and anything
// that turns foods into entries later (saved meals, a recipe's ingredient math, the meal plan)
// all go through computeFromFood + insertEntry, so an entry made any way is indistinguishable
// from one logged by hand.
//
// Entries are part reference, part snapshot: food_id says what it was, but the name, unit and
// nutrient totals are computed here at log time and stored, so editing a food later never
// rewrites history.
//
// Every write is for a Tracker (an admin or parent login, never the kiosk) and every read and
// write is scoped to that person's own rows. `today` is always the person's own local date
// (tracker.ts todayFor), passed in so tests can pin the clock.

import crypto from "node:crypto";
import { fromServing, round2, scaleNutrients, type Nutrients } from "../nutrients.ts";
import { assertCanTrack, type Tracker } from "./access.ts";
import {
  daySummary, entryJson, liveEntries, resolveDayCalorieBudget, type EntryRow,
} from "./days.ts";
import { NutritionError } from "./errors.ts";
import { requireVisibleFood, servingsOf, canSee, getFood, parseNutrients, type FoodRow } from "./foods.ts";
import {
  CLIENT_ID_HINT, bodyObject, camelKeys, isClientId, localDateField, oneOf, optClientId, optNumber, optString,
  parseJson, reqNumber, type Body,
} from "./input.ts";
import { allSlotsFor, slotTargetKcal, slotsFor } from "./slots.ts";
import { all, get, run, tx, type Db } from "./sql.ts";

export const ENTRY_SOURCES = ["manual", "scan", "copy", "plan", "llm", "quick"] as const;
export type EntrySource = (typeof ENTRY_SOURCES)[number];

export const MAX_BULK_ITEMS = 100;

export interface Computed {
  foodId: string | null;
  isQuickAdd: boolean;
  name: string;
  quantity: number;
  unit: string;
  grams: number | null;
  nutrients: Nutrients;
  /** The serving row the amount was measured in; null when logged by gram weight (and for quick adds). */
  servingId: string | null;
}

/** What an entry for `food` would hold. `b` carries quantity / servingId / grams as in a diary add. */
export function computeFromFood(db: Db, food: FoodRow, b: Body): Computed {
  const servings = servingsOf(db, food.id);
  const nutrients = parseJson<Nutrients>(food.nutrients);
  const name = food.brand ? `${food.name} (${food.brand})` : food.name;
  const quantity = optNumber(b, "quantity", 0.0001, 100_000) ?? 1;
  const grams = optNumber(b, "grams", 0.01, 1_000_000);
  const servingId = optString(b, "servingId", 80);

  if (food.basis === "per_serving") {
    if (grams !== null) throw new NutritionError(400, "grams isn't valid for a per-serving food; use quantity.");
    const s = servings.find((x) => x.id === servingId) ?? servings.find((x) => x.is_default === 1) ?? servings[0];
    if (servingId && s?.id !== servingId) throw new NutritionError(400, "serving_id doesn't belong to this food.");
    return {
      foodId: food.id, isQuickAdd: false, name, quantity, unit: s?.label ?? "serving",
      grams: s?.grams ? round2(s.grams * quantity) : null, nutrients: fromServing(nutrients, quantity), servingId: s?.id ?? null,
    };
  }

  // per100g: either an explicit gram weight, or quantity x a named serving.
  if (grams !== null && !servingId) {
    return { foodId: food.id, isQuickAdd: false, name, quantity: grams, unit: "g", grams, nutrients: scaleNutrients(nutrients, grams), servingId: null };
  }
  const s = servingId ? servings.find((x) => x.id === servingId) : servings.find((x) => x.is_default === 1);
  if (!s || s.grams === null) throw new NutritionError(400, servingId ? "serving_id doesn't belong to this food." : "Food has no default serving; pass grams.");
  const totalGrams = round2(s.grams * quantity); // 2 dp: no 2.0999999999999996 g from float noise
  return {
    foodId: food.id, isQuickAdd: false, name, quantity, unit: s.label, grams: totalGrams,
    nutrients: scaleNutrients(nutrients, totalGrams), servingId: s.id,
  };
}

export function computeQuickAdd(b: Body): Computed {
  const nutrients = parseNutrients({
    kcal: reqNumber(b, "kcal", 0, 100_000),
    protein: optNumber(b, "protein", 0, 100_000) ?? 0,
    carbs: optNumber(b, "carbs", 0, 100_000) ?? 0,
    fat: optNumber(b, "fat", 0, 100_000) ?? 0,
  });
  return { foodId: null, isQuickAdd: true, name: optString(b, "name", 200) ?? "Quick Add", quantity: 1, unit: "serving", grams: null, nutrients, servingId: null };
}

/** Logging a food counts as using it, which lifts it in search ranking. Planning one does not. */
export function bumpUsage(db: Db, foodId: string | null): void {
  if (foodId) run(db, "UPDATE nutrition_foods SET usage_count = usage_count + 1, last_used_at = ? WHERE id = ?", new Date().toISOString(), foodId);
}

/** A slot the person can still add food to (switched on); 400 otherwise. */
export function requireSlot(db: Db, user: Tracker, raw: unknown): string {
  const key = typeof raw === "string" ? raw : "";
  const slots = slotsFor(db, user.id);
  if (!slots.some((s) => s.key === key)) throw new NutritionError(400, `slot must be one of: ${slots.map((s) => s.key).join(", ")}.`);
  return key;
}

/** Lose It! behaviour: anything added to a future day is a plan, not a log. */
export const defaultStatus = (date: string, today: string): "logged" | "planned" => (date > today ? "planned" : "logged");

export interface NewEntry {
  id: string;
  date: string;
  slotKey: string;
  status: "logged" | "planned";
  source: EntrySource;
  groupId: string | null;
  c: Computed;
  /** Set by the household meal plan (nutrition/data/mealPlanSync.ts): the PlannedMeal this entry came from. */
  mealPlanId?: string | null;
  /** The slot the plan named, when it differs from slotKey. */
  planSlotKey?: string | null;
}

/**
 * INSERT one entry (caller owns the transaction and calls resolveDayCalorieBudget once the day
 * is done). Logging a food counts as using it for search ranking; planning one does not.
 */
export function insertEntry(db: Db, user: Tracker, e: NewEntry): EntryRow {
  assertCanTrack(user);
  const now = new Date().toISOString();
  run(db,
    `INSERT INTO nutrition_diary_entries (id, user_id, local_date, slot_key, status, food_id, is_quick_add, name_snapshot, quantity,
       unit_snapshot, grams, nutrients_total, source, group_id, meal_plan_id, plan_slot_key, logged_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    e.id, user.id, e.date, e.slotKey, e.status, e.c.foodId, e.c.isQuickAdd ? 1 : 0, e.c.name, e.c.quantity, e.c.unit, e.c.grams,
    JSON.stringify(e.c.nutrients), e.source, e.groupId, e.mealPlanId ?? null, e.planSlotKey ?? null, now, now);
  if (e.status === "logged") bumpUsage(db, e.c.foodId);
  return get<EntryRow>(db, "SELECT * FROM nutrition_diary_entries WHERE id = ?", e.id)!;
}

// ---- turning existing entries back into amounts ---------------------------------------

/** The amount fields of a diary add / bulk item that would log the same thing again. */
export interface Amount {
  foodId: string;
  quantity?: number;
  servingId?: string;
  grams?: number;
}

/**
 * The amount that re-logs an entry, or null when it can't be (a quick add has no food; the food
 * was deleted or is someone else's personal one). Entries do not store which serving row they
 * used, only its label, so a per-100 g entry is matched back by label and otherwise falls back to
 * its gram weight: same calories, only the unit text may differ.
 */
export function amountOfEntry(db: Db, user: Tracker, e: EntryRow): Amount | null {
  if (e.is_quick_add === 1 || !e.food_id) return null;
  const food = getFood(db, e.food_id);
  if (!food || !canSee(food, user.id)) return null;
  if (food.basis === "per_serving") return { foodId: food.id, quantity: e.quantity };
  if (e.unit_snapshot === "g") return { foodId: food.id, grams: e.grams ?? e.quantity };
  const s = servingsOf(db, food.id).find((x) => x.label === e.unit_snapshot && x.grams !== null);
  if (s) return { foodId: food.id, quantity: e.quantity, servingId: s.id };
  return e.grams ? { foodId: food.id, grams: e.grams } : null;
}

// ---- writes ----------------------------------------------------------------------------

function ownEntry(db: Db, user: Tracker, id: string): EntryRow {
  const row = get<EntryRow>(db, "SELECT * FROM nutrition_diary_entries WHERE id = ? AND user_id = ?", id, user.id);
  if (!row) throw new NutritionError(404, "Entry not found.");
  return row;
}

/**
 * Log or plan one entry on `date`. Body: slot, then either foodId (+ quantity / servingId / grams)
 * or a quick add (kcal, name?, protein?, carbs?, fat?); status? source? id?.
 *
 * `id` makes it idempotent: the offline outbox may resend a write whose answer it never saw, and
 * the second one finds the entry already there (`created: false`) without touching it or the
 * food's popularity. Someone else's id is a 409.
 */
export function addEntry(db: Db, user: Tracker, date: string, today: string, input: unknown): { row: EntryRow; created: boolean } {
  assertCanTrack(user);
  const day = localDateField(date, "date");
  const b = bodyObject(input);
  const clientId = optClientId(b);

  return tx(db, () => {
    if (clientId) {
      const prior = get<EntryRow>(db, "SELECT * FROM nutrition_diary_entries WHERE id = ?", clientId);
      if (prior) {
        if (prior.user_id !== user.id) throw new NutritionError(409, "That entry id belongs to someone else.");
        return { row: prior, created: false };
      }
    }

    const slotKey = requireSlot(db, user, b.slot);
    const status = b.status === undefined ? defaultStatus(day, today) : oneOf(b.status, "status", ["logged", "planned"] as const);
    const source = b.source === undefined ? (b.foodId === undefined ? "quick" : "manual") : oneOf(b.source, "source", ENTRY_SOURCES);

    const c = b.foodId !== undefined ? computeFromFood(db, requireVisibleFood(db, user.id, b.foodId), b) : computeQuickAdd(b);

    const row = insertEntry(db, user, { id: clientId ?? crypto.randomUUID(), date: day, slotKey, status, source, groupId: null, c });
    // Freeze (or refresh, for today/future) this day's calorie budget the moment it gets an entry.
    resolveDayCalorieBudget(db, user, day, today);
    return { row, created: true };
  });
}

/**
 * Many entries into one slot of one day, in one transaction: a saved meal, a previous meal,
 * "copy to...". Body: { slot, status?, source?, groupId?, items: [{ id, foodId, quantity?, servingId?, grams?, source? }] }.
 *
 * Every item carries a client id. A replay finds the ids already there and creates nothing new,
 * answering with the existing entries; an id that belongs to another person refuses the WHOLE
 * request (409, nothing written). `groupId` is stored so the entries can be shown and undone as
 * one (deleteGroup). Source per item, else the request's, else 'copy'.
 */
export function addEntries(db: Db, user: Tracker, date: string, today: string, input: unknown): { entries: EntryRow[]; created: number } {
  assertCanTrack(user);
  const day = localDateField(date, "date");
  const b = bodyObject(input);

  if (!Array.isArray(b.items) || b.items.length === 0) throw new NutritionError(400, "items must be a non-empty array.");
  if (b.items.length > MAX_BULK_ITEMS) throw new NutritionError(400, `items can hold at most ${MAX_BULK_ITEMS} entries.`);
  const groupId = b.groupId === undefined || b.groupId === null ? null : String(b.groupId);
  if (groupId !== null && !isClientId(groupId)) throw new NutritionError(400, `groupId must be ${CLIENT_ID_HINT}`);
  const requestSource = b.source === undefined ? "copy" : oneOf(b.source, "source", ENTRY_SOURCES);

  // Shape first, so a malformed item is a 400 before anything is written.
  const seen = new Set<string>();
  const items = b.items.map((raw, i) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new NutritionError(400, `items[${i}] must be an object.`);
    const item = camelKeys(raw);
    if (!isClientId(item.id)) throw new NutritionError(400, `items[${i}].id is required: ${CLIENT_ID_HINT}`);
    if (seen.has(item.id)) throw new NutritionError(400, `items[${i}].id repeats an earlier item.`);
    seen.add(item.id);
    if (item.foodId === undefined) throw new NutritionError(400, `items[${i}].foodId is required.`);
    return { item, id: item.id, source: item.source === undefined ? requestSource : oneOf(item.source, `items[${i}].source`, ENTRY_SOURCES) };
  });

  return tx(db, () => {
    const slotKey = requireSlot(db, user, b.slot);
    const status = b.status === undefined ? defaultStatus(day, today) : oneOf(b.status, "status", ["logged", "planned"] as const);
    const entries: EntryRow[] = [];
    let created = 0;
    for (const { item, id, source } of items) {
      const prior = get<EntryRow>(db, "SELECT * FROM nutrition_diary_entries WHERE id = ?", id);
      if (prior) {
        // Someone else's id refuses everything: the throw rolls back the entries written above it.
        if (prior.user_id !== user.id) throw new NutritionError(409, "One of those entry ids belongs to someone else.");
        entries.push(prior);
        continue;
      }
      const c = computeFromFood(db, requireVisibleFood(db, user.id, item.foodId), item);
      entries.push(insertEntry(db, user, { id, date: day, slotKey, status, source, groupId, c }));
      created++;
    }
    // One budget freeze/refresh for the day, however many entries landed.
    resolveDayCalorieBudget(db, user, day, today);
    return { entries, created };
  });
}

/**
 * Change an entry's meal, its status (planned -> logged is "I ate it"), or its amount.
 *
 * A new `quantity` alone scales the stored snapshot rather than re-reading the food, so the entry
 * keeps the label values it was logged with even if the food has since been edited.
 *
 * Changing the SERVING (`servingId`, or `grams` for a per-100 g food) is different: the entry is
 * measured again against the food as it is now, exactly as a new add would be (`quantity` is the
 * count of that serving, default 1), because "1 cup" cannot be scaled into "150 g" without the
 * food's serving weights. That needs the food: a quick add, or a food that has since been deleted
 * or made someone else's, can only have its quantity changed.
 */
export function updateEntry(db: Db, user: Tracker, today: string, id: string, input: unknown): EntryRow {
  assertCanTrack(user);
  const b = bodyObject(input);
  return tx(db, () => {
    const cur = ownEntry(db, user, id);
    if (cur.deleted_at) throw new NutritionError(404, "Entry not found.");

    let slot = cur.slot_key;
    if (b.slot !== undefined) {
      slot = String(b.slot);
      if (!slotsFor(db, user.id).some((s) => s.key === slot)) throw new NutritionError(400, "Unknown slot.");
    }
    const status = b.status === undefined ? cur.status : oneOf(b.status, "status", ["logged", "planned"] as const);
    // User decision 2026-10-15: a planned entry can be logged only on or after its own day, everywhere (this single
    // Log, "Log all" in mealPlanSync.ts, and the kiosk, which logs through here). Other edits to a future entry still work.
    if (cur.status === "planned" && status === "logged" && cur.local_date > today) {
      throw new NutritionError(400, "That day hasn't happened yet. Log it on the day.");
    }

    let quantity = cur.quantity, grams = cur.grams, totals = cur.nutrients_total, unit = cur.unit_snapshot;
    if (b.servingId !== undefined || b.grams !== undefined) {
      if (cur.is_quick_add === 1 || !cur.food_id) throw new NutritionError(400, "A quick add has no food behind it, so only its quantity can be changed.");
      const food = getFood(db, cur.food_id);
      if (!food || !canSee(food, user.id)) throw new NutritionError(400, "The food behind this entry is gone, so only its quantity can be changed.");
      const c = computeFromFood(db, food, b);
      quantity = c.quantity;
      grams = c.grams;
      unit = c.unit;
      totals = JSON.stringify(c.nutrients);
    } else if (b.quantity !== undefined) {
      quantity = reqNumber(b, "quantity", 0.0001, 100_000);
      const ratio = quantity / cur.quantity;
      totals = JSON.stringify(fromServing(parseJson<Nutrients>(cur.nutrients_total), ratio));
      grams = cur.grams === null ? null : Math.round(cur.grams * ratio * 100) / 100;
    }

    run(db, "UPDATE nutrition_diary_entries SET slot_key = ?, status = ?, quantity = ?, unit_snapshot = ?, grams = ?, nutrients_total = ?, updated_at = ? WHERE id = ?",
      slot, status, quantity, unit, grams, totals, new Date().toISOString(), cur.id);
    // Activating a plan is the moment it becomes "something you ate" for ranking purposes.
    if (cur.status === "planned" && status === "logged") bumpUsage(db, cur.food_id);
    resolveDayCalorieBudget(db, user, cur.local_date, today);
    return get<EntryRow>(db, "SELECT * FROM nutrition_diary_entries WHERE id = ?", cur.id)!;
  });
}

/** Soft delete (and idempotent): sync clients and the importer's import_hash stay consistent. Returns the entry. */
export function deleteEntry(db: Db, user: Tracker, id: string): EntryRow {
  const cur = ownEntry(db, user, id);
  if (!cur.deleted_at) {
    const now = new Date().toISOString();
    run(db, "UPDATE nutrition_diary_entries SET deleted_at = ?, updated_at = ? WHERE id = ?", now, now, cur.id);
  }
  return cur;
}

/**
 * Undo for a bulk write: soft-deletes every entry of this person's that carries the group id.
 * Idempotent (nothing left to delete is still fine), so the offline outbox can replay it, and it
 * only ever touches the caller's own rows. Returns the dates it touched, since a caller could in
 * principle mix dates, and how many entries went.
 */
export function deleteGroup(db: Db, user: Tracker, groupId: string): { dates: string[]; deleted: number } {
  if (!isClientId(groupId)) throw new NutritionError(400, `groupId must be ${CLIENT_ID_HINT}`);
  return tx(db, () => {
    const dates = all<{ local_date: string }>(db,
      "SELECT DISTINCT local_date FROM nutrition_diary_entries WHERE user_id = ? AND group_id = ? AND deleted_at IS NULL", user.id, groupId)
      .map((r) => r.local_date);
    const now = new Date().toISOString();
    const r = run(db, "UPDATE nutrition_diary_entries SET deleted_at = ?, updated_at = ? WHERE user_id = ? AND group_id = ? AND deleted_at IS NULL",
      now, now, user.id, groupId);
    return { dates, deleted: Number(r.changes) };
  });
}

// ---- reads -------------------------------------------------------------------------------

/**
 * The diary page for one day: the person's meals with their entries, each meal's calorie target
 * for THIS day, and the summary. `relog` on each entry is the amount that would log the same
 * thing again (null for a quick add or a food that is gone) -- what lets "Copy to..." work from
 * a cached copy of this response.
 */
export function getDay(db: Db, user: Tracker, date: string, today: string) {
  const day = localDateField(date, "date");
  const entries = liveEntries(db, user.id, day).map((e) => ({ ...entryJson(e), relog: amountOfEntry(db, user, e) }));
  // An entry in a disabled slot (an old custom meal brought in by the Lose It! import) must
  // still show up, under that slot's real name and in its place in the order. `enabled: false`
  // tells the client not to offer adding food to it.
  const used = new Set(entries.map((e) => e.slotKey));
  const slots = allSlotsFor(db, user.id)
    .filter((s) => s.enabled === 1 || used.has(s.key))
    .map((s) => ({ key: s.key, label: s.label, enabled: s.enabled === 1, target_kcal: s.target_kcal, target_pct: s.target_pct }));
  // A key with no slot row at all (a hand-edited database) falls back to the raw key.
  for (const key of used) if (!slots.some((s) => s.key === key)) slots.push({ key, label: key, enabled: false, target_kcal: null, target_pct: null });
  const summary = daySummary(db, user, day, today);
  return {
    date: day,
    slots: slots.map(({ target_kcal, target_pct, ...s }) => {
      const list = entries.filter((e) => e.slotKey === s.key);
      return {
        ...s,
        entries: list,
        kcal: Math.round(list.filter((e) => e.status === "logged").reduce((a, e) => a + e.nutrients.kcal, 0) * 100) / 100,
        // This meal's target for THIS day: a percentage is taken of the day's calorie budget (not
        // counting exercise), so it moves with the budget; null when there is no target or no budget.
        targetKcal: slotTargetKcal({ target_kcal, target_pct }, summary.calorieBudget),
        targetPct: target_pct,
      };
    }),
    summary,
  };
}
