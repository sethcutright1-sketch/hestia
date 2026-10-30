// What one diary login may SEE of another's data: strictly read-only, and strictly what the owner's
// visibility level (visibility.ts) allows. Nothing here writes -- a day's calorie budget is computed with
// `persist: false`, and the owner is looked up with `peekTracker` (no default meals created for them).
//
//   totals      the day's top-card numbers (calorie budget, eaten, exercise, left) and the streak. No foods,
//               no macros, no per-meal numbers, no planned entries, no profile or goal details.
//   everything  also the macros eaten, each meal with its entries (name, amount, calories), the day's
//               exercise, and -- in sharedProgress -- weigh-ins with the trend, and steps.
//
// Never here, at any level: progress photos (nutrition_photos is not touched by this file), goal weight and
// weekly plan, calorie-budget settings, meal targets, the snack allowance, ids of foods or of rows, and the
// owner's profile (sex, birth date, height).
//
// The caller (routes/nutrition/share.ts) has already checked the level, the kiosk and the PIN; the `level`
// passed in is what decides the shape of the answer.

import { addDays } from "../dates.ts";
import type { Tracker } from "./access.ts";
import { daySummary, liveEntries, type EntryRow } from "./days.ts";
import { localDateField, parseJson } from "./input.ts";
import { streakFor } from "./loggingStreaks.ts";
import { allSlotsFor } from "./slots.ts";
import { listSteps } from "./steps.ts";
import { todayFor } from "./tracker.ts";
import type { Nutrients } from "../nutrients.ts";
import { parseWeightRange, weightTrendFor, weightTrendOver } from "./weightProgress.ts";
import { rangeStart } from "../weightRange.ts";
import { NutritionError } from "./errors.ts";
import { listWeights } from "./weights.ts";
import { all, type Db } from "./sql.ts";
import type { VisibilityNeed } from "./visibility.ts";

const personJson = (owner: Tracker, level: VisibilityNeed) => ({ userId: owner.id, name: owner.displayName, level });

const round2 = (n: number) => Math.round(n * 100) / 100;

/** A diary entry as another person may see it: what and how much, not where it came from. */
const sharedEntryJson = (r: EntryRow) => ({
  id: r.id,
  slotKey: r.slot_key,
  status: r.status,
  name: r.name_snapshot,
  quantity: r.quantity,
  unit: r.unit_snapshot,
  nutrients: parseJson<Nutrients>(r.nutrients_total),
  fromPlan: r.source === "plan",
});

interface ExerciseRow {
  name: string;
  kcal: number;
  minutes: number | null;
  exclude_from_budget: number;
}

/**
 * The owner's day, at `level`. `now` is the clock; the owner's own "today" (their timezone) is worked out
 * here, because it decides whether the day is frozen, and is returned so the screen can label the day.
 */
export function sharedDay(db: Db, owner: Tracker, level: VisibilityNeed, date: string, now: Date) {
  const today = todayFor(owner, now);
  const s = daySummary(db, owner, date, today, { persist: false });
  const base = {
    person: personJson(owner, level),
    date,
    today,
    streak: streakFor(db, owner.id, today),
  };
  const totals = { date, calorieBudget: s.calorieBudget, eaten: s.eaten, exercise: s.exercise, remaining: s.remaining };
  if (level === "totals") return { ...base, summary: totals };

  const entries = liveEntries(db, owner.id, date);
  const used = new Set(entries.map((e) => e.slot_key));
  const slots = allSlotsFor(db, owner.id)
    .filter((sl) => sl.enabled === 1 || used.has(sl.key))
    .map((sl) => ({ key: sl.key, label: sl.label }));
  for (const key of used) if (!slots.some((sl) => sl.key === key)) slots.push({ key, label: key });
  const exercise = all<ExerciseRow>(db,
    "SELECT name, kcal, minutes, exclude_from_budget FROM nutrition_exercise WHERE user_id = ? AND local_date = ? AND deleted_at IS NULL ORDER BY rowid",
    owner.id, date);
  return {
    ...base,
    summary: {
      ...totals,
      // Eaten only: the owner's macro goals are part of their calorie-budget settings and stay theirs.
      macros: {
        protein: { eaten: s.macros.protein.eaten, goal: null },
        carbs: { eaten: s.macros.carbs.eaten, goal: null },
        fat: { eaten: s.macros.fat.eaten, goal: null },
      },
    },
    slots: slots.map((sl) => {
      const list = entries.filter((e) => e.slot_key === sl.key);
      return {
        ...sl,
        kcal: round2(list.filter((e) => e.status === "logged").reduce((a, e) => a + parseJson<Nutrients>(e.nutrients_total).kcal, 0)),
        entries: list.map(sharedEntryJson),
      };
    }),
    exercise: exercise.map((e) => ({ name: e.name, kcal: e.kcal, minutes: e.minutes, excludeFromBudget: e.exclude_from_budget === 1 })),
  };
}

/**
 * The owner's weigh-ins (with the trend) and steps since `from` (default: a year back). `everything` only --
 * the route refuses lower levels before calling this. The trend is the smoothed weight only: the owner's
 * goal weight, weekly plan, goal date and "I started on" day are settings, not weigh-ins, and are left out.
 *
 * `range` (1m 3m 6m 1y all, the chart's buttons) instead of `from`: the trend points cover that range (the trend itself is
 * worked out from the whole history, as for the owner), and the weigh-in list is never shorter than the default year, so
 * a short range cannot make a person with older weigh-ins look as if they have none. Steps stay on the default year.
 */
export function sharedProgress(db: Db, owner: Tracker, now: Date, from?: unknown, range?: unknown) {
  const today = todayFor(owner, now);
  if (range !== undefined && from !== undefined) throw new NutritionError(400, "Use either from or range, not both.");
  const defaultSince = addDays(today, -364);
  if (range !== undefined) {
    const start = rangeStart(parseWeightRange(range), today);
    const weighSince = start === null ? null : start < defaultSince ? start : defaultSince;
    const { out } = weightTrendOver(db, owner, today, start);
    return {
      person: personJson(owner, "everything"),
      today,
      weights: listWeights(db, owner, weighSince === null ? {} : { from: weighSince }).map((w) => ({ date: w.measured_on, weightKg: w.weight_kg })),
      trend: { points: out.points, trendKg: out.trendKg },
      steps: listSteps(db, owner.id, { from: defaultSince }).map((r) => ({ date: r.local_date, steps: r.steps })),
    };
  }
  const since = from === undefined ? defaultSince : localDateField(from, "from");
  const trend = weightTrendFor(db, owner, today, since);
  return {
    person: personJson(owner, "everything"),
    today,
    weights: listWeights(db, owner, { from: since }).map((w) => ({ date: w.measured_on, weightKg: w.weight_kg })),
    trend: { points: trend.points, trendKg: trend.trendKg },
    steps: listSteps(db, owner.id, { from: since }).map((r) => ({ date: r.local_date, steps: r.steps })),
  };
}
