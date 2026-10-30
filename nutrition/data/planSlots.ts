// The meal plan's slots (merge plan decision 11): the household's meals, not just breakfast / lunch /
// dinner. A planned meal names a slot KEY. The four standard keys (breakfast, lunch, dinner, snacks)
// always exist as plan slots; any custom meal a tracker has switched on ("brunch", "pre-workout") can be
// used too. Each person has their own meals, though, so a plan slot one of them lacks falls back to the
// closest standard slot THEY have, and the diary entry records the plan's own key (plan_slot_key).

import { slotKindOf, type SlotKind } from "../planCells.ts";
import { DEFAULT_SLOTS, allSlotsFor, slotsFor } from "./slots.ts";
import { all, type Db } from "./sql.ts";

export const STANDARD_SLOT_KEYS: readonly string[] = DEFAULT_SLOTS.map((s) => s.key);

export interface PlanSlotOption {
  key: string;
  label: string;
  standard: boolean;
}

/**
 * Every slot a plan meal may use: the standard four first, then each custom meal any tracker has
 * switched on (the first label seen for a key wins; keys are slugs, so two people's "Brunch" are one slot).
 */
export function planSlotOptions(db: Db): PlanSlotOption[] {
  const out: PlanSlotOption[] = DEFAULT_SLOTS.map((s) => ({ key: s.key, label: s.label, standard: true }));
  const rows = all<{ key: string; label: string }>(db,
    `SELECT s.key AS key, s.label AS label FROM nutrition_meal_slots s
       JOIN users u ON u.id = s.user_id
      WHERE s.enabled = 1 AND u.role IN ('admin', 'parent') ORDER BY s.sort, s.id`);
  for (const r of rows) if (!out.some((o) => o.key === r.key)) out.push({ key: r.key, label: r.label, standard: false });
  return out;
}

export const isPlanSlotKey = (db: Db, key: unknown): key is string =>
  typeof key === "string" && planSlotOptions(db).some((o) => o.key === key);

/** The rank used to order slots inside a day: breakfast, lunch, dinner, snacks; a custom meal by what it sounds like. */
export type { SlotKind };

/** Which standard slot a key is nearest to: itself if standard, else by what its name sounds like, else snacks. */
export const slotKind = slotKindOf;

/** If the person lacks the kind itself, the standard slots to try next, nearest first. */
const LADDER: Record<SlotKind, SlotKind[]> = {
  breakfast: ["snacks", "lunch", "dinner"],
  lunch: ["snacks", "dinner", "breakfast"],
  dinner: ["lunch", "snacks", "breakfast"],
  snacks: ["dinner", "lunch", "breakfast"],
};

export interface MappedSlot {
  /** The key to put the entry in: one of the person's own switched-on meals. */
  key: string;
  /** The plan's key, when it had to be changed for this person. */
  fellBackFrom?: string;
}

/**
 * The slot a plan meal lands in for one person. Their own meal with that key if it is switched on;
 * otherwise the nearest standard slot they have (a custom plan slot is first read as the standard
 * kind it sounds like); otherwise their first switched-on meal (they always keep at least one).
 */
export function mapPlanSlot(db: Db, userId: string, planKey: string): MappedSlot {
  const mine = slotsFor(db, userId);
  const has = (key: string) => mine.some((s) => s.key === key);
  if (has(planKey)) return { key: planKey };
  const kind = slotKind(planKey);
  for (const k of [kind, ...LADDER[kind]]) if (has(k)) return { key: k, fellBackFrom: planKey };
  const first = mine[0] ?? allSlotsFor(db, userId)[0];
  return { key: first?.key ?? "dinner", fellBackFrom: planKey };
}
