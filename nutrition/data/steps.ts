// Steps, typed by hand: one row per login per local date. Typing a date again replaces it. Steps are
// for the person's own interest (a chart and a number); they NEVER change the calorie budget.
//
// `source` is 'manual' for what a person types and 'import_loseit' for rows the phase 7 importer will
// bring in from Lose It!'s steps.csv (Date|Value|...). The importer upserts by (login, date); this file
// is only the typed side. Everything is scoped to the signed-in person's own rows.

import { assertCanTrack, type Tracker } from "./access.ts";
import { NutritionError } from "./errors.ts";
import { bodyObject, localDateField, reqNumber } from "./input.ts";
import { all, run, type Db } from "./sql.ts";

/** More than a person can walk in a day (an ultramarathon is under 100,000); a typo guard, not a goal. */
export const MAX_STEPS = 200_000;

export interface StepsRow {
  local_date: string;
  steps: number;
  source: string;
}

export const stepsJson = (r: StepsRow) => ({ date: r.local_date, steps: r.steps, source: r.source });

/** Rows in a date range (both ends optional and inclusive), oldest first. */
export function listSteps(db: Db, userId: string, range: { from?: unknown; to?: unknown } = {}): StepsRow[] {
  const from = range.from === undefined ? "0000-01-01" : localDateField(range.from, "from");
  const to = range.to === undefined ? "9999-12-31" : localDateField(range.to, "to");
  return all<StepsRow>(db,
    "SELECT local_date, steps, source FROM nutrition_steps WHERE user_id = ? AND local_date BETWEEN ? AND ? ORDER BY local_date",
    userId, from, to);
}

/**
 * Set a day's steps (a whole number from 0 to 200,000), replacing what was there -- including a row
 * imported from Lose It!, which becomes a typed one. A day that hasn't happened yet is refused.
 * `today` is the person's own local date.
 */
export function putSteps(db: Db, user: Tracker, today: string, date: unknown, input: unknown) {
  assertCanTrack(user);
  const day = localDateField(date, "date");
  if (day > today) throw new NutritionError(400, "That day hasn't happened yet.");
  const steps = reqNumber(bodyObject(input), "steps", 0, MAX_STEPS);
  if (!Number.isInteger(steps)) throw new NutritionError(400, "steps must be a whole number.");
  run(db,
    `INSERT INTO nutrition_steps (user_id, local_date, steps, source, updated_at) VALUES (?, ?, ?, 'manual', ?)
     ON CONFLICT (user_id, local_date) DO UPDATE SET steps = excluded.steps, source = 'manual', updated_at = excluded.updated_at`,
    user.id, day, steps, new Date().toISOString());
  return { date: day, steps, source: "manual" };
}

/** Remove a day of the person's own steps. 404 when there is none. */
export function deleteSteps(db: Db, user: Tracker, date: unknown): void {
  const day = localDateField(date, "date");
  const r = run(db, "DELETE FROM nutrition_steps WHERE user_id = ? AND local_date = ?", user.id, day);
  if (!r.changes) throw new NutritionError(404, "No steps recorded for that day.");
}
