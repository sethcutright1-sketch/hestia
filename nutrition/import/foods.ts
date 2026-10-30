// The food library built from history and from custom-foods.csv: one food per distinct (name, units), so
// search and Recent are personal the moment the import finishes.
//
// Lose It! exports nutrient TOTALS for the logged quantity, so a food's per-unit values come from dividing the
// newest usable row by its quantity. Grams and ounces become per-100 g foods (so any gram amount can be logged
// later); every other unit stays a per-serving food whose one serving is named after the unit. No weights are
// invented for units like "Cup". A custom food is read the same way (its Quantity and Measure play the part of a
// row's quantity and units), so a custom food and the log rows that mention it become ONE food.
//
// Who can see an imported food: the import's "Only me" option decides. By default a new food is JOINT (shared
// with the household); with "Only me" it is personal. This is about the food itself only -- who ate it stays in
// each person's own diary.

import { fromServing, type Nutrients } from "../nutrients.ts";
import type { Tracker } from "../data/access.ts";
import { insertFood, type Basis, type FoodRow, type Scope, type ServingInput } from "../data/foods.ts";
import { get, run, type Db } from "../data/sql.ts";
import type { FoodLogRow, SmallNutrients } from "./loseitParse.ts";

export const GRAMS_PER_OUNCE = 28.3495;

/** Case, spacing and Unicode-form insensitive: the identity of a name or unit. */
export const normText = (s: string): string => s.normalize("NFC").trim().toLowerCase().replace(/\s+/g, " ");

const GRAM_UNITS = new Set(["g", "gram", "grams"]);
const OUNCE_UNITS = new Set(["oz", "ounce", "ounces"]); // weight ounces; "fluid ounce" is deliberately not here

/** Grams in one of this unit, when it is a plain weight. */
export function gramsPerUnit(units: string): number | null {
  const u = normText(units);
  if (GRAM_UNITS.has(u)) return 1;
  if (OUNCE_UNITS.has(u)) return GRAMS_PER_OUNCE;
  return null;
}

/** Lose It!'s own "Quick Add" entries carry no real food; they stay quick adds instead of becoming one averaged "food". */
export const isQuickAdd = (name: string): boolean => /^quick add\b/i.test(name.trim());

export const groupKeyOf = (name: string, units: string): string => `${normText(name)}\u0000${normText(units)}`;

interface FoodDef {
  basis: Basis;
  nutrients: Nutrients;
  servings: ServingInput[];
}

export interface FoodGroup {
  key: string;
  /** Display name and units, from the newest row. */
  name: string;
  units: string;
  brand: string | null;
  /** `loseit:<name>|<units>`, lowercased: stable across re-imports and between household members. */
  sourceRef: string;
  /** null when no row had both a quantity above 0 and a calorie count. */
  def: FoodDef | null;
}

/** What a food definition needs from a food-log row or a custom-food row. */
export interface Measured {
  quantity: number | null;
  units: string;
  calories: number | null;
  nutrients: SmallNutrients;
}

const isNewer = (a: FoodLogRow, b: FoodLogRow): boolean => a.date > b.date || (a.date === b.date && a.row > b.row);
const usable = (r: Measured): boolean => r.quantity !== null && r.quantity > 0 && r.calories !== null;

export function define(r: Measured): FoodDef {
  const totals: Nutrients = { kcal: r.calories!, ...r.nutrients };
  const gramsEach = gramsPerUnit(r.units);
  if (gramsEach !== null) {
    const grams = r.quantity! * gramsEach;
    return {
      basis: "per100g",
      nutrients: fromServing(totals, 100 / grams),
      servings: [gramsEach === 1 ? { label: "100 g", grams: 100, isDefault: true } : { label: "1 oz", grams: 28.35, isDefault: true }],
    };
  }
  return {
    basis: "per_serving",
    nutrients: fromServing(totals, 1 / r.quantity!),
    servings: [{ label: r.units.trim().slice(0, 80) || "serving", grams: null, isDefault: true }],
  };
}

export const sourceRefOf = (name: string, units: string): string => `loseit:${normText(name)}|${normText(units)}`;

/** Group the live food-log rows (any dates) by food. */
export function groupFoods(rows: Iterable<FoodLogRow>): Map<string, FoodGroup> {
  const newest = new Map<string, FoodLogRow>();
  const newestUsable = new Map<string, FoodLogRow>();
  for (const r of rows) {
    if (r.deleted || isQuickAdd(r.name)) continue;
    const key = groupKeyOf(r.name, r.units);
    const n = newest.get(key);
    if (!n || isNewer(r, n)) newest.set(key, r);
    if (usable(r)) {
      const u = newestUsable.get(key);
      if (!u || isNewer(r, u)) newestUsable.set(key, r);
    }
  }
  const groups = new Map<string, FoodGroup>();
  for (const [key, row] of newest) {
    const u = newestUsable.get(key);
    groups.set(key, {
      key,
      name: row.name.trim(),
      units: row.units.trim(),
      brand: null,
      sourceRef: sourceRefOf(row.name, row.units),
      def: u ? define(u) : null,
    });
  }
  return groups;
}

export class FoodLibrary {
  created = 0;
  reused = 0;
  withoutNutrition = 0;
  private resolved = new Map<string, string | null>();
  private usage = new Map<string, { n: number; last: string }>();

  constructor(
    private db: Db,
    private user: Tracker,
    private scope: Scope,
    private warn: (message: string) => void,
  ) {}

  /**
   * The food a group's entries point at: a food this person can already see with the same source_ref (their
   * own earlier import, or a joint one -- their partner's, or a custom food from this same export), else a new
   * one. Their own personal food is preferred over a joint one. Null if there is nothing to build one from.
   */
  idFor(g: FoodGroup): string | null {
    if (this.resolved.has(g.key)) return this.resolved.get(g.key)!;
    let id: string | null = null;
    const existing = get<FoodRow>(this.db,
      `SELECT * FROM nutrition_foods
        WHERE source = 'import_loseit' AND source_ref = ? AND deleted_at IS NULL
          AND (owner_user_id IS NULL OR owner_user_id = ?)
        ORDER BY (owner_user_id = ?) DESC, created_at, rowid LIMIT 1`,
      g.sourceRef, this.user.id, this.user.id);
    if (existing) {
      id = existing.id;
      this.reused++;
    } else if (g.def) {
      id = insertFood(this.db, this.user.id, {
        name: g.name.slice(0, 200), brand: g.brand ? g.brand.slice(0, 100) : null, gtin14: null,
        basis: g.def.basis, nutrients: g.def.nutrients, servings: g.def.servings,
        scope: this.scope, source: "import_loseit", sourceRef: g.sourceRef,
      }).id;
      this.created++;
    } else {
      this.withoutNutrition++;
      this.warn(`"${g.name}" (${g.units || "no units"}) has no row with a quantity and calories, so its entries aren't linked to a food`);
    }
    this.resolved.set(g.key, id);
    return id;
  }

  /** One logged entry for this food on this date. Written out by flush(). */
  noteLogged(foodId: string, date: string): void {
    const u = this.usage.get(foodId) ?? { n: 0, last: "" };
    u.n++;
    if (date > u.last) u.last = date;
    this.usage.set(foodId, u);
  }

  /**
   * usage_count / last_used_at feed search ranking and Recent. Only entries created by this run count, so
   * re-importing the same export doesn't inflate them.
   */
  flush(): void {
    for (const [id, u] of this.usage) {
      const at = `${u.last}T12:00:00.000Z`; // a date only; noon keeps it on the right day in any US time zone
      run(this.db,
        `UPDATE nutrition_foods SET usage_count = usage_count + ?,
           last_used_at = CASE WHEN last_used_at IS NULL OR last_used_at < ? THEN ? ELSE last_used_at END
         WHERE id = ?`,
        u.n, at, at, id);
    }
  }
}
