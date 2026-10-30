// Lose It! meal names -> this person's meal slots.
//
// The food log's `Meal` column is the meal name. Free accounts always have Breakfast, Lunch, Dinner and Snacks;
// Premium users can rename them or add others, so any other name becomes a custom slot for the importing
// person (key = slug of the name, label = the name as written). Slots are each person's own
// (nutrition_meal_slots), so an import never touches the other login's meals.

import { DEFAULT_SLOTS, slug } from "../data/slots.ts";
import { get, run, type Db } from "../data/sql.ts";

export interface Meal {
  key: string;
  label: string;
  custom: boolean;
}

const builtIn = (key: string): Meal => ({ key, label: DEFAULT_SLOTS.find((s) => s.key === key)!.label, custom: false });
const BUILT_IN = new Map<string, Meal>([
  ["breakfast", builtIn("breakfast")],
  ["lunch", builtIn("lunch")],
  ["dinner", builtIn("dinner")],
  ["snack", builtIn("snacks")],
  ["snacks", builtIn("snacks")],
]);

export function mealFor(type: string): Meal {
  const name = type.trim().replace(/\s+/g, " ");
  if (!name) return BUILT_IN.get("snacks")!; // no meal named: the catch-all
  const known = BUILT_IN.get(name.toLowerCase());
  if (known) return known;
  const key = slug(name);
  // "Dinner!" slugs to a default key: it is that default meal, not a lookalike beside it.
  const collides = [...BUILT_IN.values()].find((m) => m.key === key);
  return collides ?? { key, label: name.slice(0, 40), custom: true };
}

/** Whether the person's slot exists and is enabled (null = no such slot yet). */
export function slotState(db: Db, userId: string, key: string): { enabled: boolean } | null {
  const row = get<{ enabled: number }>(db, "SELECT enabled FROM nutrition_meal_slots WHERE user_id = ? AND key = ?", userId, key);
  return row ? { enabled: row.enabled === 1 } : null;
}

/** Create the person's slot if missing. An existing slot is never touched: its enabled state is their choice. */
export function ensureSlot(db: Db, userId: string, meal: Meal, enabled: boolean): boolean {
  if (slotState(db, userId, meal.key)) return false;
  const defaultIdx = DEFAULT_SLOTS.findIndex((s) => s.key === meal.key);
  const sort = defaultIdx >= 0
    ? defaultIdx
    : get<{ n: number }>(db, "SELECT COALESCE(MAX(sort), -1) + 1 AS n FROM nutrition_meal_slots WHERE user_id = ?", userId)!.n;
  run(db, "INSERT INTO nutrition_meal_slots (user_id, key, label, sort, enabled) VALUES (?, ?, ?, ?, ?)",
    userId, meal.key, meal.label, sort, enabled ? 1 : 0);
  return true;
}
