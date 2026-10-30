// One person's day: its frozen CALORIE budget, the summary the diary header shows, and
// "Done logging". Also home of the diary entry row type, since the summary is made of entries.
// (Not household-app's money Budget: every "budget" in this folder is calories.)

import { addDays } from "../dates.ts";
import { CALORIE_BUDGET_FLOOR, dailyCalorieBudget, macroGrams } from "../calorieBudget.ts";
import { emptyNutrients, round2, sumNutrients, type Nutrients } from "../nutrients.ts";
import { assertCanTrack, type Tracker } from "./access.ts";
import { goalOn, calorieBudgetProfile, type GoalRow } from "./goals.ts";
import { NutritionError } from "./errors.ts";
import { parseJson } from "./input.ts";
import { streakFor } from "./loggingStreaks.ts";
import { planningTargetKcal, snackAllowancePct } from "./snackAllowance.ts";
import { all, get, run, tx, type Db } from "./sql.ts";
import { weightKgOn } from "./weights.ts";

export interface EntryRow {
  id: string;
  user_id: string;
  local_date: string;
  slot_key: string;
  status: "logged" | "planned";
  food_id: string | null;
  is_quick_add: number;
  name_snapshot: string;
  quantity: number;
  unit_snapshot: string;
  grams: number | null;
  nutrients_total: string;
  source: string;
  import_hash: string | null;
  /** Client-supplied id shared by entries written together (a saved meal, a copy); null for single adds. */
  group_id: string | null;
  /** The household meal plan's PlannedMeal id when the plan made this entry (migration 8); null otherwise. */
  meal_plan_id: string | null;
  /** The slot the plan named, when this person's entry sits in a different one (a custom meal they lack). */
  plan_slot_key: string | null;
  /** Set once "Use from pantry?" was confirmed for this entry. */
  pantry_used_at: string | null;
  logged_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export function entryJson(r: EntryRow) {
  return {
    id: r.id,
    localDate: r.local_date,
    slotKey: r.slot_key,
    status: r.status,
    foodId: r.food_id,
    isQuickAdd: r.is_quick_add === 1,
    name: r.name_snapshot,
    quantity: r.quantity,
    unit: r.unit_snapshot,
    grams: r.grams,
    nutrients: parseJson<Nutrients>(r.nutrients_total),
    source: r.source,
    groupId: r.group_id,
    mealPlanId: r.meal_plan_id,
    planSlotKey: r.plan_slot_key,
    pantryUsed: r.pantry_used_at !== null,
    loggedAt: r.logged_at,
    updatedAt: r.updated_at,
  };
}

export function liveEntries(db: Db, userId: string, date: string): EntryRow[] {
  return all<EntryRow>(db,
    "SELECT * FROM nutrition_diary_entries WHERE user_id = ? AND local_date = ? AND deleted_at IS NULL ORDER BY logged_at, rowid",
    userId, date);
}

export interface DayCalorieBudget {
  /** kcal for the day; null when it can't be worked out (see `missing`). */
  calorieBudget: number | null;
  maintenance: number | null;
  belowFloor: boolean;
  /** What is needed before there can be a calorie budget: a profile, a goal, a weigh-in. */
  missing: Array<"profile" | "goal" | "weight">;
  goal: GoalRow | undefined;
}

// History must not change when a profile is edited later. So:
//   - a past day uses the calorie budget frozen in nutrition_day_logs (with the maintenance figure
//     it came from), computing and freezing both the first time the day is summarized or logged into;
//   - today and future days are always recomputed (and the stored copy refreshed), since
//     a goal edit this morning should apply to this evening's diary.
// A budget snapshot alone is enough to freeze a past day: days imported from Lose It!
// carry its budget but no maintenance figure (maintenance comes back null), and
// recomputing them would overwrite the very numbers the import exists to preserve.
// `persist: false` is for read-only views (the meal plan's week) that should not freeze a day
// just by looking at it: the figure is computed the same way, but nothing is written.
export function resolveDayCalorieBudget(
  db: Db, user: Tracker, date: string, today: string, opts: { persist?: boolean } = {},
): DayCalorieBudget {
  const goal = goalOn(db, user.id, date);
  const snap = get<{ calorie_budget_kcal_snapshot: number | null; maintenance_kcal_snapshot: number | null }>(db,
    "SELECT calorie_budget_kcal_snapshot, maintenance_kcal_snapshot FROM nutrition_day_logs WHERE user_id = ? AND local_date = ?",
    user.id, date);
  const floorFor = (calorieBudget: number): boolean => {
    const floors = goal ? CALORIE_BUDGET_FLOOR[goal.min_calorie_budget_mode] : null;
    return floors !== null && !!user.profile && calorieBudget < floors[user.profile.sex];
  };

  if (date < today && snap?.calorie_budget_kcal_snapshot != null) {
    return {
      calorieBudget: snap.calorie_budget_kcal_snapshot, maintenance: snap.maintenance_kcal_snapshot,
      belowFloor: floorFor(snap.calorie_budget_kcal_snapshot), missing: [], goal,
    };
  }

  const weight = weightKgOn(db, user.id, date);
  const missing: DayCalorieBudget["missing"] = [];
  if (!user.profile) missing.push("profile");
  if (!goal) missing.push("goal");
  if (weight === null) missing.push("weight");
  if (!user.profile || !goal || weight === null) return { calorieBudget: null, maintenance: null, belowFloor: false, missing, goal };

  const b = dailyCalorieBudget(calorieBudgetProfile(user.profile, goal), weight, date);
  if (opts.persist === false) return { calorieBudget: b.calorieBudget, maintenance: b.maintenance, belowFloor: b.belowFloor, missing: [], goal };
  run(db,
    `INSERT INTO nutrition_day_logs (user_id, local_date, calorie_budget_kcal_snapshot, maintenance_kcal_snapshot) VALUES (?, ?, ?, ?)
     ON CONFLICT (user_id, local_date) DO UPDATE SET
       calorie_budget_kcal_snapshot = excluded.calorie_budget_kcal_snapshot,
       maintenance_kcal_snapshot = excluded.maintenance_kcal_snapshot`,
    user.id, date, b.calorieBudget, b.maintenance);
  return { calorieBudget: b.calorieBudget, maintenance: b.maintenance, belowFloor: b.belowFloor, missing: [], goal };
}

/** `persist: false` is for looking at SOMEONE ELSE's day (sharedView.ts): the figure is the same, but nothing is written to their rows. */
export function daySummary(db: Db, user: Tracker, date: string, today: string, opts: { persist?: boolean } = {}) {
  const b = resolveDayCalorieBudget(db, user, date, today, opts);
  const entries = liveEntries(db, user.id, date);
  const logged = entries.filter((e) => e.status === "logged");
  const planned = entries.filter((e) => e.status === "planned");
  const nutrientsOf = (list: EntryRow[]) => sumNutrients(list.map((e) => parseJson<Nutrients>(e.nutrients_total)));
  const eatenN = logged.length ? nutrientsOf(logged) : emptyNutrients();

  const perSlot: Record<string, number> = {};
  for (const e of logged) perSlot[e.slot_key] = round2((perSlot[e.slot_key] ?? 0) + parseJson<Nutrients>(e.nutrients_total).kcal);

  // Exercise adds to the day's allowance unless flagged "exclude from budget".
  const ex = get<{ counted: number; excluded: number }>(db,
    `SELECT COALESCE(SUM(CASE WHEN exclude_from_budget = 0 THEN kcal END), 0) AS counted,
            COALESCE(SUM(CASE WHEN exclude_from_budget = 1 THEN kcal END), 0) AS excluded
       FROM nutrition_exercise WHERE user_id = ? AND local_date = ? AND deleted_at IS NULL`,
    user.id, date)!;

  const goalGrams = b.calorieBudget !== null && b.goal
    ? macroGrams(b.calorieBudget, { mode: b.goal.macro_mode, protein: b.goal.macro_protein, carbs: b.goal.macro_carbs, fat: b.goal.macro_fat })
    : null;
  const day = get<{ done_logging_at: string | null }>(db, "SELECT done_logging_at FROM nutrition_day_logs WHERE user_id = ? AND local_date = ?", user.id, date);
  const snackPct = snackAllowancePct(db, user.id);

  return {
    date,
    calorieBudget: b.calorieBudget,
    maintenance: b.maintenance,
    belowFloor: b.belowFloor,
    missing: b.missing,
    eaten: eatenN.kcal,
    exercise: round2(ex.counted),
    exerciseExcluded: round2(ex.excluded),
    remaining: b.calorieBudget === null ? null : round2(b.calorieBudget - eatenN.kcal + ex.counted),
    macros: {
      protein: { eaten: eatenN.protein, goal: goalGrams?.protein ?? null },
      carbs: { eaten: eatenN.carbs, goal: goalGrams?.carbs ?? null },
      fat: { eaten: eatenN.fat, goal: goalGrams?.fat ?? null },
    },
    nutrients: eatenN,
    perSlot,
    plannedKcal: planned.length ? nutrientsOf(planned).kcal : 0,
    plannedCount: planned.length,
    // Calorie-aware planning: the share of this day's calorie budget kept free for snacks, and what is left
    // for planned meals (the calorie budget, with the calorie schedule already applied, x (1 - pct / 100)).
    snackAllowancePct: snackPct,
    planningTargetKcal: planningTargetKcal(b.calorieBudget, snackPct),
    doneLoggingAt: day?.done_logging_at ?? null,
  };
}

/** How far back a day can still be marked done: Lose It! lets you finish yesterday, and a few days of slack is kinder. */
export const DONE_WINDOW_DAYS = 7;

/**
 * "Done logging". Lose It! won't let a day be marked done while planned foods remain: each one
 * has to be activated (it was eaten) or removed (it wasn't). A day can be finished late, up to a
 * week back, but never ahead of time. Returns the day's summary and the streak it leaves, so the
 * phone can say "13-day streak". Marking an already-done day again just refreshes the timestamp.
 */
export function markDayDone(db: Db, user: Tracker, date: string, today: string) {
  assertCanTrack(user);
  if (date > today) throw new NutritionError(400, "A day that hasn't happened yet can't be marked done.");
  if (date < addDays(today, -DONE_WINDOW_DAYS)) throw new NutritionError(400, `Only the last ${DONE_WINDOW_DAYS} days can still be marked done.`);
  tx(db, () => {
    const planned = get<{ n: number }>(db,
      "SELECT COUNT(*) AS n FROM nutrition_diary_entries WHERE user_id = ? AND local_date = ? AND status = 'planned' AND deleted_at IS NULL",
      user.id, date)!.n;
    if (planned > 0) {
      throw new NutritionError(409, `${planned} planned ${planned === 1 ? "entry is" : "entries are"} still on this day. Log or remove them first.`, { plannedCount: planned });
    }
    resolveDayCalorieBudget(db, user, date, today); // makes sure the day log row (and snapshot) exists
    run(db,
      `INSERT INTO nutrition_day_logs (user_id, local_date, done_logging_at) VALUES (?, ?, ?)
       ON CONFLICT (user_id, local_date) DO UPDATE SET done_logging_at = excluded.done_logging_at`,
      user.id, date, new Date().toISOString());
  });
  return { ...daySummary(db, user, date, today), streak: streakFor(db, user.id, today) };
}
