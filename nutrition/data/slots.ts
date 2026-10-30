// Meal slots ("Breakfast", "Dinner", a custom "Pre-workout"): each person's own list, in their
// own order, each optionally switched off and optionally carrying a calorie target.
//
// A slot's KEY is what diary entries and saved meals store, so it never changes: a rename only
// changes the label, and a slot that is switched off keeps showing the entries it holds.
//
// The meal plan will use these same slots (phase 4), including snacks and custom meals.

import { round2 } from "../nutrients.ts";
import { assertCanTrack, type Tracker } from "./access.ts";
import { NutritionError } from "./errors.ts";
import { optNumber, reqString, type Body } from "./input.ts";
import { all, get, run, tx, type Db } from "./sql.ts";

export interface SlotRow {
  key: string;
  label: string;
  sort: number;
  enabled: number;
  /** At most one of the two targets is set: a fixed kcal, or a percentage of the day's calorie budget. */
  target_kcal: number | null;
  target_pct: number | null;
}

export const DEFAULT_SLOTS = [
  { key: "breakfast", label: "Breakfast" },
  { key: "lunch", label: "Lunch" },
  { key: "dinner", label: "Dinner" },
  { key: "snacks", label: "Snacks" },
];

const SLOT_COLUMNS = "key, label, sort, enabled, target_kcal, target_pct";

export const slotJson = (s: SlotRow) => ({
  key: s.key,
  label: s.label,
  sort: s.sort,
  enabled: s.enabled === 1,
  targetKcal: s.target_kcal,
  targetPct: s.target_pct,
});

/** A meal's target in kcal for a day: the fixed number, or its share of that day's CALORIE budget. */
export function slotTargetKcal(s: Pick<SlotRow, "target_kcal" | "target_pct">, calorieBudgetKcal: number | null): number | null {
  if (s.target_kcal !== null) return s.target_kcal;
  if (s.target_pct !== null && calorieBudgetKcal !== null) return round2((calorieBudgetKcal * s.target_pct) / 100);
  return null;
}

/** The slots a person can still add food to (switched on), in their order. */
export function slotsFor(db: Db, userId: string): SlotRow[] {
  return all<SlotRow>(db, `SELECT ${SLOT_COLUMNS} FROM nutrition_meal_slots WHERE user_id = ? AND enabled = 1 ORDER BY sort, id`, userId);
}

/** Every slot row in display order, disabled ones included (a disabled slot can still hold old entries). */
export function allSlotsFor(db: Db, userId: string): SlotRow[] {
  return all<SlotRow>(db, `SELECT ${SLOT_COLUMNS} FROM nutrition_meal_slots WHERE user_id = ? ORDER BY sort, id`, userId);
}

/**
 * Give a person the four default meals if they have none at all. Idempotent -- it only acts on
 * an empty list, so someone who switched meals off or renamed them is never "reset". (Slots
 * can't be deleted, only switched off, so an empty list really does mean a brand-new tracker.)
 */
export function ensureDefaultSlots(db: Db, userId: string): void {
  if (get(db, "SELECT 1 FROM nutrition_meal_slots WHERE user_id = ? LIMIT 1", userId)) return;
  DEFAULT_SLOTS.forEach((s, i) =>
    run(db, "INSERT OR IGNORE INTO nutrition_meal_slots (user_id, key, label, sort) VALUES (?, ?, ?, ?)", userId, s.key, s.label, i));
}

/** "Pre-Workout!" -> "pre-workout". Keeps letters and digits of any script so a non-English name still gets a unique key. */
export function slug(name: string): string {
  const s = name.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
  return s.slice(0, 40) || "meal";
}

export const MAX_SLOTS = 20;
export const MAX_TARGET_KCAL = 10_000;
/** Keys a custom meal must not take: the `POST /me/slots/reorder` route would swallow them. */
const RESERVED_KEYS = new Set(["reorder"]);

export const isBuiltInSlot = (key: string): boolean => DEFAULT_SLOTS.some((s) => s.key === key);

/** The key a new meal called `label` gets: its slug, made unique for this person ("brunch", "brunch-2"). */
export function newSlotKey(db: Db, userId: string, label: string): string {
  const taken = new Set(allSlotsFor(db, userId).map((s) => s.key));
  const base = slug(label);
  let key = base;
  for (let n = 2; taken.has(key) || RESERVED_KEYS.has(key); n++) key = `${base.slice(0, 36)}-${n}`;
  return key;
}

export function getSlot(db: Db, userId: string, key: string): SlotRow {
  const row = get<SlotRow>(db, `SELECT ${SLOT_COLUMNS} FROM nutrition_meal_slots WHERE user_id = ? AND key = ?`, userId, key);
  if (!row) throw new NutritionError(404, "Meal not found.");
  return row;
}

/**
 * Targets from a request, on top of the current ones. A meal has a fixed kcal target OR a share of
 * the day's calorie budget, never both: setting one clears the other, and null clears just that one.
 */
function resolveTargets(b: Body, cur: Pick<SlotRow, "target_kcal" | "target_pct">): { kcal: number | null; pct: number | null } {
  const num = (field: string, min: number, max: number): number | null | undefined =>
    b[field] === undefined ? undefined : b[field] === null ? null : round2(optNumber(b, field, min, max)!);
  const kcal = num("targetKcal", 1, MAX_TARGET_KCAL);
  const pct = num("targetPct", 1, 100);
  if (kcal != null && pct != null) throw new NutritionError(400, "A meal can have a calorie target or a percentage target, not both.");
  let k = cur.target_kcal, p = cur.target_pct;
  if (kcal !== undefined) { k = kcal; if (kcal !== null) p = null; }
  if (pct !== undefined) { p = pct; if (pct !== null) k = null; }
  return { kcal: k, pct: p };
}

export function createSlot(db: Db, user: Tracker, b: Body): SlotRow {
  assertCanTrack(user);
  return tx(db, () => createSlotTx(db, user, b));
}

function createSlotTx(db: Db, user: Tracker, b: Body): SlotRow {
  const label = reqString(b, "label", 40);
  if (allSlotsFor(db, user.id).length >= MAX_SLOTS) throw new NutritionError(400, `You can have at most ${MAX_SLOTS} meals.`);
  const t = resolveTargets(b, { target_kcal: null, target_pct: null });
  const key = newSlotKey(db, user.id, label);
  const sort = get<{ n: number }>(db, "SELECT COALESCE(MAX(sort), -1) + 1 AS n FROM nutrition_meal_slots WHERE user_id = ?", user.id)!.n;
  run(db, "INSERT INTO nutrition_meal_slots (user_id, key, label, sort, enabled, target_kcal, target_pct) VALUES (?, ?, ?, ?, 1, ?, ?)",
    user.id, key, label, sort, t.kcal, t.pct);
  return getSlot(db, user.id, key);
}

/** Partial: only the fields present change. The key never does. */
export function updateSlot(db: Db, user: Tracker, key: string, b: Body): SlotRow {
  assertCanTrack(user);
  return tx(db, () => updateSlotTx(db, user, key, b));
}

function updateSlotTx(db: Db, user: Tracker, key: string, b: Body): SlotRow {
  const cur = getSlot(db, user.id, key);
  const label = b.label === undefined ? cur.label : reqString(b, "label", 40);
  let enabled = cur.enabled;
  if (b.enabled !== undefined) {
    if (typeof b.enabled !== "boolean") throw new NutritionError(400, "enabled must be true or false.");
    enabled = b.enabled ? 1 : 0;
  }
  if (enabled === 0 && cur.enabled === 1) {
    const others = get<{ n: number }>(db, "SELECT COUNT(*) AS n FROM nutrition_meal_slots WHERE user_id = ? AND enabled = 1 AND key <> ?", user.id, key)!.n;
    if (others === 0) throw new NutritionError(400, "Keep at least one meal switched on.");
  }
  const t = resolveTargets(b, cur);
  run(db, "UPDATE nutrition_meal_slots SET label = ?, enabled = ?, target_kcal = ?, target_pct = ? WHERE user_id = ? AND key = ?",
    label, enabled, t.kcal, t.pct, user.id, key);
  return getSlot(db, user.id, key);
}

/** `keys` must be exactly the person's meals (switched-off ones too), in the new order. */
export function reorderSlots(db: Db, user: Tracker, keys: unknown): void {
  assertCanTrack(user);
  if (!Array.isArray(keys) || keys.some((k) => typeof k !== "string")) throw new NutritionError(400, "keys must be a list of meal keys.");
  const have = all<{ key: string }>(db, "SELECT key FROM nutrition_meal_slots WHERE user_id = ?", user.id).map((r) => r.key);
  if (new Set(keys).size !== keys.length || keys.length !== have.length || !have.every((k) => keys.includes(k))) {
    throw new NutritionError(400, "keys must list every one of your meals exactly once.");
  }
  tx(db, () => keys.forEach((k, i) => run(db, "UPDATE nutrition_meal_slots SET sort = ? WHERE user_id = ? AND key = ?", i, user.id, k)));
}
