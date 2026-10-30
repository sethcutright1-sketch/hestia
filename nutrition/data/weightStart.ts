// "I started my weight loss on <date>": the day the Weight & progress tab measures "lost so far" from. A per-login
// setting on nutrition_user_settings.weight_start_date (migration 13); NULL = not set, and it can be cleared.
//
// Private to the login: it is a setting like the goal weight and the plan, so the sharing routes (share.ts,
// sharedView.ts) never read it and another person's view never shows a "lost so far".
//
//   GET /me/weight-start   { weightStartDate, today, earliest }
//   PUT /me/weight-start   { weightStartDate: "2026-01-03" | null }   null (or "") clears it

import { assertCanTrack, type Tracker } from "./access.ts";
import { NutritionError } from "./errors.ts";
import { bodyObject, localDateField } from "./input.ts";
import { get, run, type Db } from "./sql.ts";

/** Nobody's weight loss started before this; it also catches a typo like 0026. */
export const EARLIEST_WEIGHT_START = "2000-01-01";

/** The login's start date, or null when they never set one. */
export function weightStartDate(db: Db, userId: string): string | null {
  return get<{ d: string | null }>(db, "SELECT weight_start_date AS d FROM nutrition_user_settings WHERE user_id = ?", userId)?.d ?? null;
}

/** `today` is the person's own today, so the screen can stop its date box there. */
export const weightStartJson = (date: string | null, today: string) => ({ weightStartDate: date, today, earliest: EARLIEST_WEIGHT_START });

/**
 * Set or clear the start date. A real calendar date from 2000-01-01 up to the person's today (a start in the future
 * is a 400: there is nothing to measure from yet). `null` or an empty string clears it; leaving the field out is a 400.
 */
export function setWeightStartDate(db: Db, user: Tracker, today: string, input: unknown): string | null {
  assertCanTrack(user);
  const b = bodyObject(input);
  if (!("weightStartDate" in b)) throw new NutritionError(400, "weightStartDate must be a local date like 2026-01-03, or null to clear it.");
  const raw = b.weightStartDate;
  let date: string | null = null;
  if (raw !== null && raw !== "") {
    date = localDateField(raw, "weightStartDate");
    if (date < EARLIEST_WEIGHT_START) throw new NutritionError(400, `weightStartDate can't be before ${EARLIEST_WEIGHT_START}.`);
    if (date > today) throw new NutritionError(400, "weightStartDate can't be in the future.");
  }
  run(db,
    `INSERT INTO nutrition_user_settings (user_id, weight_start_date, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET weight_start_date = excluded.weight_start_date, updated_at = excluded.updated_at`,
    user.id, date, new Date().toISOString());
  return date;
}
