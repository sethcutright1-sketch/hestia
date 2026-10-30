// The kiosk (fridge) board and "we ate it" logging, as plain data-layer functions so that the
// kiosk's HTTP routes (routes/nutrition/kiosk.ts) and the assistant's kiosk tools
// (assistant/tools/calories.ts) share ONE implementation of the rules instead of two copies.
//
// What the kiosk may touch, and nothing more:
//   - read: the day's APPROVED household-plan meals, and for each person who keeps a diary their own
//     PLANNED entries that came from the household meal plan (source = 'plan'): name, calories, meal.
//     No weights, goals, calorie budget, totals or logged food, and nothing a person planned privately
//     in their own diary (an assistant-made or "Copy to..." planned entry has another source).
//   - write: mark such an entry as eaten, on any day up to that person's today. All or nothing.
//
// Who may use these (the admin's kiosk setting, "hidden" / "plan only" / "plan + quick logging") is decided
// by the caller, not here.

import type { Tracker } from "./access.ts";
import type { EntryRow } from "./days.ts";
import { updateEntry } from "./diary.ts";
import { NutritionError } from "./errors.ts";
import { parseJson } from "./input.ts";
import { approvedMealsOn } from "./planDocs.ts";
import { allSlotsFor } from "./slots.ts";
import { all, get, tx, type Db } from "./sql.ts";
import { defaultTimezone, listTrackers, todayFor } from "./tracker.ts";
import { localDate } from "../dates.ts";
import type { Nutrients } from "../nutrients.ts";

export const MAX_KIOSK_LOG_IDS = 50;

/** One person's PLANNED meal-plan entries on `date` (their own today when none is given). */
export function plannedPlanEntries(db: Db, person: Tracker, now: Date, date?: string) {
  const day = date ?? todayFor(person, now);
  const labels = new Map(allSlotsFor(db, person.id).map((s) => [s.key, s.label]));
  const rows = all<EntryRow>(db,
    `SELECT * FROM nutrition_diary_entries
      WHERE user_id = ? AND local_date = ? AND status = 'planned' AND source = 'plan' AND deleted_at IS NULL ORDER BY logged_at, rowid`,
    person.id, day);
  return {
    userId: person.id,
    name: person.displayName,
    date: day,
    // Names and calories only: the least that lets someone tap "we ate this".
    planned: rows.map((e) => ({
      id: e.id,
      name: e.name_snapshot,
      kcal: parseJson<Nutrients>(e.nutrients_total).kcal,
      // The plan meal this entry came from (the same id as `meals[].id`), so a screen can put "Log for: <name>"
      // on the right meal without guessing from names. It is the plan's own id, not diary data.
      mealId: e.meal_plan_id,
      slotKey: e.slot_key,
      slotLabel: labels.get(e.slot_key) ?? e.slot_key,
    })),
  };
}

/**
 * The board for a date: the plan's approved meals and each diary login's planned plan entries. "Today" for the
 * plan is the date in the first diary login's timezone (the household's); for each person's entries it is their own.
 */
export function kioskBoardData(db: Db, now: Date, date?: string) {
  const people = listTrackers(db);
  const planDate = date ?? (people[0] ? todayFor(people[0], now) : localDate(defaultTimezone(), now));
  return {
    date: planDate,
    meals: approvedMealsOn(db, planDate),
    people: people.map((p) => plannedPlanEntries(db, p, now, date)),
  };
}

/**
 * Mark planned meal-plan entries of `person` as eaten. Every id must be one of the person's own live, still-planned
 * entries that came from the household plan (source = 'plan'); one that isn't (logged, deleted, someone else's,
 * a privately planned one) refuses the WHOLE request with a 409 naming it, and nothing is written. A day that
 * hasn't happened yet is refused by updateEntry (400, also all-or-nothing, because this runs in one transaction).
 * It goes through the phone's own path (updateEntry), so totals, the day's frozen calorie budget and food
 * popularity follow. Returns the unique ids logged.
 */
export function logPlanEntries(db: Db, person: Tracker, entryIds: readonly string[], now: Date): string[] {
  if (entryIds.length === 0 || entryIds.length > MAX_KIOSK_LOG_IDS || entryIds.some((id) => typeof id !== "string")) {
    throw new NutritionError(400, `entryIds must be a list of 1 to ${MAX_KIOSK_LOG_IDS} entry ids.`);
  }
  const unique = [...new Set(entryIds)];
  tx(db, () => {
    // Check every id first so a bad one writes nothing at all.
    const bad = unique.filter((id) => !get(db,
      `SELECT 1 FROM nutrition_diary_entries
        WHERE id = ? AND user_id = ? AND status = 'planned' AND source = 'plan' AND deleted_at IS NULL`,
      id, person.id));
    if (bad.length > 0) {
      throw new NutritionError(409, "Some of those can't be logged from here: they're not planned meal-plan entries, or not that person's.", { rejected: bad });
    }
    // `today` is the person's own (it decides whether a past/future day's budget is frozen); each entry keeps its own date.
    const today = todayFor(person, now);
    for (const id of unique) updateEntry(db, person, today, id, { status: "logged" });
  });
  return unique;
}
