// The food log -> diary entries, plus the foods and meal slots those entries need.
//
// Idempotency lives in import_hash. Each row's hash covers person, date, meal, name, quantity, units, calories
// and an `occurrence` number: how many rows with the identical content came earlier on that date, deleted ones
// included. Counting deleted rows keeps twin entries (two identical rows, e.g. two eggs logged separately)
// stable: if one is deleted in Lose It! later, the row that still exists keeps its old hash, and the deleted
// row's hash points at the entry that should go.

import crypto from "node:crypto";
import { addDays } from "../dates.ts";
import { round2, type Nutrients } from "../nutrients.ts";
import { all, run } from "../data/sql.ts";
import { normNum, sha256, type Ctx } from "./context.ts";
import { FoodLibrary, gramsPerUnit, groupFoods, groupKeyOf, isQuickAdd, normText } from "./foods.ts";
import type { FoodLogRow } from "./loseitParse.ts";
import { ensureSlot, mealFor, slotState, type Meal } from "./meals.ts";
import type { ConflictDate, ImportReport } from "./types.ts";

const RECENT_DAYS = 60;
const MAX_CONFLICT_DATES = 60;

interface Prepared extends FoodLogRow {
  meal: Meal;
  /** foods.ts group key. */
  group: string;
  hash: string;
  /** Position among that date's rows, in file order. */
  ordinal: number;
}

/** Hash every row (live and deleted) in file order. */
function prepare(rows: FoodLogRow[], userId: string): Prepared[] {
  const earlier = new Map<string, number>();
  const perDate = new Map<string, number>();
  return rows.map((r) => {
    const meal = mealFor(r.type);
    // The meal's slot key, not the raw text: "Snack" and "Snacks" are the same meal.
    const tuple = [userId, r.date, meal.key, normText(r.name), normNum(r.quantity, 4), normText(r.units), normNum(r.calories, 2)].join("|");
    const occurrence = earlier.get(tuple) ?? 0;
    earlier.set(tuple, occurrence + 1);
    const ordinal = perDate.get(r.date) ?? 0;
    perDate.set(r.date, ordinal + 1);
    return { ...r, meal, group: groupKeyOf(r.name, r.units), hash: sha256(`${tuple}|${occurrence}`), ordinal };
  });
}

// Lose It! exports a date and a meal but no time of day. logged_at only orders entries within a day (meals
// roughly chronologically, file order within a meal) and ranks Recent by date, so it is synthesized: a fixed
// time per meal plus the row's position as milliseconds. It is local wall-clock time written as if UTC, and it
// is never displayed.
const MEAL_TIME: Record<string, [number, number]> = { breakfast: [8, 0], lunch: [12, 30], snacks: [15, 0], dinner: [18, 30] };

function syntheticTime(date: string, meal: Meal, ordinal: number): string {
  const [h, m] = meal.custom ? [21, 0] : MEAL_TIME[meal.key];
  const [y, mo, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, d, h, m, 0, ordinal)).toISOString();
}

export interface DiaryResult {
  counts: Omit<ImportReport["counts"], "warnings">;
  foods: ImportReport["foods"];
  customSlots: ImportReport["customSlots"];
  conflicts: ImportReport["conflicts"];
  dateRange: ImportReport["dateRange"];
}

/**
 * Days where the export has food AND this person already LOGGED food of their own in this app. Skip records them
 * in ctx.skipped (every phase that belongs to a diary day leaves those days alone); replace soft-deletes the
 * person's own logged entries there first; merge lets the import land alongside them.
 *
 * Planned entries (the household meal plan puts some in the diary) are not "food you logged": they neither make
 * a conflict nor get replaced, so a plan never blocks an import and an import never deletes a plan.
 */
function handleConflicts(ctx: Ctx, liveScoped: Prepared[]): ImportReport["conflicts"] {
  const { db, user, o } = ctx;
  const result: ImportReport["conflicts"] = { mode: o.conflict, count: 0, replacedEntries: 0, dates: [] };
  const rowsByDate = new Map<string, number>();
  for (const r of liveScoped) rowsByDate.set(r.date, (rowsByDate.get(r.date) ?? 0) + 1);
  if (rowsByDate.size === 0) return result;

  const dates = [...rowsByDate.keys()].sort();
  const natives = all<{ local_date: string; n: number }>(db,
    `SELECT local_date, COUNT(*) AS n FROM nutrition_diary_entries
      WHERE user_id = ? AND deleted_at IS NULL AND status = 'logged' AND source <> 'import_loseit' AND local_date BETWEEN ? AND ?
      GROUP BY local_date ORDER BY local_date`,
    user.id, dates[0], dates[dates.length - 1]);
  const stamp = new Date().toISOString();
  const action: ConflictDate["action"] = o.conflict === "skip" ? "skipped" : o.conflict === "merge" ? "merged" : "replaced";

  for (const n of natives) {
    const importRows = rowsByDate.get(n.local_date);
    if (!importRows) continue;
    result.count++;
    if (result.dates.length < MAX_CONFLICT_DATES) result.dates.push({ date: n.local_date, nativeEntries: n.n, importRows, action });
    if (o.conflict === "skip") ctx.skipped.add(n.local_date);
    if (o.conflict === "replace") {
      run(db,
        `UPDATE nutrition_diary_entries SET deleted_at = ?, updated_at = ?
          WHERE user_id = ? AND local_date = ? AND deleted_at IS NULL AND status = 'logged' AND source <> 'import_loseit'`,
        stamp, stamp, user.id, n.local_date);
      result.replacedEntries += n.n;
    }
  }
  return result;
}

/** The foods are built first (custom foods) by the caller, so the library is passed in. */
export function importDiary(ctx: Ctx, library: FoodLibrary): DiaryResult {
  const { db, user, o } = ctx;
  const rows = prepare(ctx.parsed.foodLog, user.id);
  const live = rows.filter((r) => !r.deleted);
  const scoped = rows.filter((r) => ctx.inWindow(r.date));
  const liveScoped = scoped.filter((r) => !r.deleted);

  const counts = {
    created: 0, alreadyImported: 0, deletedSince: 0, skippedByConflict: 0,
    outsideRange: live.length - liveScoped.length,
    deletedInExport: scoped.length - liveScoped.length,
    plannedInFuture: 0,
  };
  const conflicts = handleConflicts(ctx, liveScoped);

  // Custom meals: enabled only if the export still uses them in its last 60 days (counted back from the export's
  // newest entry, not from today, so an old export behaves the same whenever it is imported). Otherwise the slot
  // is created disabled: its entries keep their real meal name in the diary, but it isn't offered for new food.
  const newest = live.reduce((m, r) => (r.date > m ? r.date : m), "");
  const cutoff = newest ? addDays(newest, -(RECENT_DAYS - 1)) : "";
  const customs = new Map<string, { meal: Meal; entries: number; recent: boolean }>();
  for (const r of live) {
    if (!r.meal.custom) continue;
    const c = customs.get(r.meal.key) ?? { meal: r.meal, entries: 0, recent: false };
    if (r.date >= cutoff) c.recent = true;
    if (ctx.inWindow(r.date)) c.entries++;
    customs.set(r.meal.key, c);
  }
  const ensured = new Set<string>();
  const createdSlots = new Set<string>();
  const slotKeyFor = (meal: Meal): string => {
    if (!ensured.has(meal.key)) {
      ensured.add(meal.key);
      if (ensureSlot(db, user.id, meal, customs.get(meal.key)?.recent ?? true)) createdSlots.add(meal.key);
    }
    return meal.key;
  };

  // Food definitions come from every live row, whatever the date window: the newest label wins even when only
  // an older stretch of history is being imported.
  const groups = groupFoods(live);

  const findByHash = db.prepare("SELECT id, deleted_at FROM nutrition_diary_entries WHERE import_hash = ?");
  const softDelete = db.prepare("UPDATE nutrition_diary_entries SET deleted_at = ?, updated_at = ? WHERE id = ?");
  const insert = db.prepare(
    `INSERT INTO nutrition_diary_entries (id, user_id, local_date, slot_key, status, food_id, is_quick_add, name_snapshot, quantity,
       unit_snapshot, grams, nutrients_total, source, import_hash, logged_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'import_loseit', ?, ?, ?)`);
  const now = new Date().toISOString();
  const handled = new Set<string>();

  for (const r of scoped) {
    if (ctx.skipped.has(r.date)) {
      if (!r.deleted) counts.skippedByConflict++;
      continue;
    }
    const prior = findByHash.get(r.hash) as unknown as { id: string; deleted_at: string | null } | undefined;

    if (r.deleted) {
      // Deleted in Lose It! after an earlier import: remove our copy. (Never seen it? Nothing to do.)
      if (prior && !prior.deleted_at) {
        softDelete.run(now, now, prior.id);
        counts.deletedSince++;
      }
      continue;
    }
    // Already here, live or removed by the person in this app (a removal is respected, not undone).
    if (prior || handled.has(r.hash)) {
      counts.alreadyImported++;
      continue;
    }
    handled.add(r.hash);

    const where = `${r.date} "${r.name}"`;
    const quantityOk = r.quantity !== null && r.quantity > 0;
    if (!quantityOk) ctx.warnings.add(`${where}: quantity ${r.quantity === null ? "missing" : r.quantity}, logged as 1`);
    const quantity = quantityOk ? r.quantity! : 1;
    if (r.calories === null) ctx.warnings.add(`${where}: calories n/a, counted as 0`);

    const nutrients: Nutrients = { kcal: r.calories ?? 0, ...r.nutrients };
    for (const k of Object.keys(nutrients) as Array<keyof Nutrients>) nutrients[k] = round2(nutrients[k]);
    const gramsEach = gramsPerUnit(r.units);
    const grams = quantityOk && gramsEach !== null ? round2(quantity * gramsEach) : null;

    const quick = isQuickAdd(r.name);
    const group = quick ? undefined : groups.get(r.group);
    const foodId = group ? library.idFor(group) : null;
    const status = r.date > o.today ? "planned" : "logged";
    if (status === "planned") counts.plannedInFuture++;
    else if (foodId) library.noteLogged(foodId, r.date);

    insert.run(
      crypto.randomUUID(), user.id, r.date, slotKeyFor(r.meal), status, foodId, quick ? 1 : 0, r.name.slice(0, 200), quantity,
      r.units.slice(0, 80) || "serving", grams, JSON.stringify(nutrients), r.hash, syntheticTime(r.date, r.meal, r.ordinal), now);
    counts.created++;
  }
  library.flush();

  const dates = [...new Set(liveScoped.map((r) => r.date))].sort();
  return {
    counts,
    foods: { created: library.created, reused: library.reused, withoutNutrition: library.withoutNutrition },
    customSlots: [...customs.values()]
      .sort((a, b) => b.entries - a.entries || a.meal.label.localeCompare(b.meal.label))
      .map((c) => ({
        name: c.meal.label,
        key: c.meal.key,
        entries: c.entries,
        enabled: slotState(db, user.id, c.meal.key)?.enabled ?? c.recent,
        created: createdSlots.has(c.meal.key),
      })),
    conflicts,
    dateRange: dates.length ? { from: dates[0], to: dates[dates.length - 1], daysWithEntries: dates.length } : null,
  };
}
