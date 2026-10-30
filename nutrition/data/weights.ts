// Weigh-ins. Stored in kilograms; the client converts for display. The latest weight on or
// before a date drives that day's BMR, and so that day's calorie budget (days.ts).

import crypto from "node:crypto";
import { round2 } from "../nutrients.ts";
import { KG_PER_LB } from "../weightTrend.ts";
import { assertCanTrack, type Tracker } from "./access.ts";
import { NutritionError } from "./errors.ts";
import { bodyObject, localDateField, optClientId, reqNumber } from "./input.ts";
import { all, get, run, tx, type Db } from "./sql.ts";
import { todayFor } from "./tracker.ts";

export interface WeightRow {
  id: string;
  measured_on: string;
  weight_kg: number;
  source: string;
}

export const weightJson = (r: WeightRow) => ({ id: r.id, measuredOn: r.measured_on, weightKg: r.weight_kg, source: r.source });

/**
 * Latest weight on or before the date; if the person only weighed in later, their earliest
 * weigh-in instead, rather than refusing to compute a calorie budget for old days.
 */
export function weightKgOn(db: Db, userId: string, date: string): number | null {
  const before = get<{ weight_kg: number }>(db,
    "SELECT weight_kg FROM nutrition_weights WHERE user_id = ? AND deleted_at IS NULL AND measured_on <= ? ORDER BY measured_on DESC, rowid DESC LIMIT 1",
    userId, date);
  if (before) return before.weight_kg;
  const after = get<{ weight_kg: number }>(db,
    "SELECT weight_kg FROM nutrition_weights WHERE user_id = ? AND deleted_at IS NULL ORDER BY measured_on ASC, rowid ASC LIMIT 1",
    userId);
  return after?.weight_kg ?? null;
}

/** Weigh-ins in a date range (both ends optional and inclusive), oldest first. */
export function listWeights(db: Db, user: Tracker, range: { from?: unknown; to?: unknown } = {}): WeightRow[] {
  const from = range.from === undefined ? "0000-01-01" : localDateField(range.from, "from");
  const to = range.to === undefined ? "9999-12-31" : localDateField(range.to, "to");
  return all<WeightRow>(db,
    `SELECT id, measured_on, weight_kg, source FROM nutrition_weights
      WHERE user_id = ? AND deleted_at IS NULL AND measured_on BETWEEN ? AND ? ORDER BY measured_on, rowid`,
    user.id, from, to);
}

/** Weigh-ins since `from` (a date), for the trend. Not part of the public list because it has no upper bound to validate. */
export function weightsSince(db: Db, userId: string, from: string): WeightRow[] {
  return all<WeightRow>(db,
    "SELECT id, measured_on, weight_kg, source FROM nutrition_weights WHERE user_id = ? AND deleted_at IS NULL AND measured_on >= ? ORDER BY measured_on, rowid",
    userId, from);
}

/**
 * Record a weigh-in: `weightKg` (20-500) or `weightLb` (44-1100), on `measuredOn` (default: the
 * person's today). A client-supplied `id` makes it idempotent -- resending the same one is a
 * no-op that says `created: false`; another person's id is a 409 and nothing is written.
 */
export function addWeight(db: Db, user: Tracker, now: Date, input: unknown): { created: boolean; id: string; measuredOn: string; weightKg: number } {
  assertCanTrack(user);
  const b = bodyObject(input);
  const kg = b.weightKg !== undefined ? reqNumber(b, "weightKg", 20, 500) : reqNumber(b, "weightLb", 44, 1100) * KG_PER_LB;
  const measuredOn = b.measuredOn === undefined ? todayFor(user, now) : localDateField(b.measuredOn, "measuredOn");
  const id = optClientId(b) ?? crypto.randomUUID();
  return tx(db, () => {
    const prior = get<{ user_id: string; measured_on: string; weight_kg: number }>(db,
      "SELECT user_id, measured_on, weight_kg FROM nutrition_weights WHERE id = ?", id);
    if (prior) {
      if (prior.user_id !== user.id) throw new NutritionError(409, "That id belongs to someone else.");
      return { created: false, id, measuredOn: prior.measured_on, weightKg: prior.weight_kg };
    }
    run(db, "INSERT INTO nutrition_weights (id, user_id, measured_on, weight_kg, source) VALUES (?, ?, ?, ?, 'manual')",
      id, user.id, measuredOn, round2(kg));
    return { created: true, id, measuredOn, weightKg: round2(kg) };
  });
}

/** Soft delete. A second delete is a 404, which a replaying outbox reads as "already gone". */
export function deleteWeight(db: Db, user: Tracker, id: string): void {
  const r = run(db, "UPDATE nutrition_weights SET deleted_at = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
    new Date().toISOString(), id, user.id);
  if (!r.changes) throw new NutritionError(404, "Weight entry not found.");
}
