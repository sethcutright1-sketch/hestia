// The snack allowance: how much of a person's CALORIE budget calorie-aware planning keeps free for
// snacks. A percentage of the day's calorie budget (merge plan phase 4, the user's answer), per login,
// default 10%, adjustable from 0 to 50%. Planned meals aim at
//
//   planning target = that day's calorie budget (calorie schedule already applied) x (1 - pct / 100)
//
// so a day the schedule makes bigger leaves a bigger snack allowance in kcal too. Stored in
// nutrition_user_settings (migration 8); a login with no row has the default. "Budget" is always the
// calorie budget here, never household-app's money Budget.

import { round2 } from "../nutrients.ts";
import { assertCanTrack, type Tracker } from "./access.ts";
import { NutritionError } from "./errors.ts";
import { bodyObject } from "./input.ts";
import { get, run, type Db } from "./sql.ts";

export const DEFAULT_SNACK_ALLOWANCE_PCT = 10;
export const MIN_SNACK_ALLOWANCE_PCT = 0;
export const MAX_SNACK_ALLOWANCE_PCT = 50;

/** The login's snack allowance in percent (the default when they never chose one). */
export function snackAllowancePct(db: Db, userId: string): number {
  return get<{ pct: number }>(db, "SELECT snack_allowance_pct AS pct FROM nutrition_user_settings WHERE user_id = ?", userId)?.pct
    ?? DEFAULT_SNACK_ALLOWANCE_PCT;
}

/** Calorie budget x (1 - pct / 100), or null when there is no calorie budget for the day. */
export function planningTargetKcal(calorieBudget: number | null, pct: number): number | null {
  return calorieBudget === null ? null : round2(calorieBudget * (1 - pct / 100));
}

/** The kcal a day's snack allowance is worth (null without a calorie budget). */
export function snackAllowanceKcal(calorieBudget: number | null, pct: number): number | null {
  return calorieBudget === null ? null : round2(calorieBudget * (pct / 100));
}

export const snackAllowanceJson = (pct: number) => ({
  snackAllowancePct: pct,
  defaultPct: DEFAULT_SNACK_ALLOWANCE_PCT,
  min: MIN_SNACK_ALLOWANCE_PCT,
  max: MAX_SNACK_ALLOWANCE_PCT,
});

/** Set the allowance: a number from 0 to 50 (one decimal place is kept). Anything else is a 400. */
export function setSnackAllowancePct(db: Db, user: Tracker, input: unknown): number {
  assertCanTrack(user);
  const b = bodyObject(input);
  const v = b.snackAllowancePct;
  if (typeof v !== "number" || !Number.isFinite(v) || v < MIN_SNACK_ALLOWANCE_PCT || v > MAX_SNACK_ALLOWANCE_PCT) {
    throw new NutritionError(400, `snackAllowancePct must be a number from ${MIN_SNACK_ALLOWANCE_PCT} to ${MAX_SNACK_ALLOWANCE_PCT} (a percentage of your calorie budget).`);
  }
  const pct = Math.round(v * 10) / 10;
  run(db,
    `INSERT INTO nutrition_user_settings (user_id, snack_allowance_pct, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET snack_allowance_pct = excluded.snack_allowance_pct, updated_at = excluded.updated_at`,
    user.id, pct, new Date().toISOString());
  return pct;
}
