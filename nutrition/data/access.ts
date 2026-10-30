// Who may keep a food diary. Split out from tracker.ts so slots.ts, tracker.ts and every
// other module can use the check without importing each other in a circle.
//
// There is no separate nutrition user table: a "tracker" is a household-app login (the
// `users` table, TEXT ids) whose role is `admin` or `parent`, plus an optional row in
// nutrition_profiles for the facts a calorie budget needs. The kiosk login is a shared
// device, not a person (db.ts), so it never has a diary -- assertCanTrack is where that is
// enforced in code, and the triggers in schema.ts are the backstop for raw SQL.

import { NutritionError } from "./errors.ts";

export type TrackerRole = "admin" | "parent";
export const TRACKER_ROLES: readonly TrackerRole[] = ["admin", "parent"];

export const canTrack = (role: string): role is TrackerRole => (TRACKER_ROLES as readonly string[]).includes(role);

/**
 * Throws 403 unless `user` may have a diary. Takes anything with a `role`, so a UserRecord from
 * db.ts, a session user or a Tracker all work. The message names the rule, not just the role,
 * because it is what a kiosk's request would be told.
 */
export function assertCanTrack(user: { role: string }): asserts user is { role: TrackerRole } {
  if (!canTrack(user.role)) {
    throw new NutritionError(403, "Food diaries are for admin and parent logins; the kiosk login doesn't keep one.");
  }
}

export interface ProfileRow {
  user_id: string;
  sex: "male" | "female";
  birth_date: string;
  height_cm: number;
  timezone: string;
  unit_system: "imperial" | "metric";
  created_at: string;
  updated_at: string;
}

/** A login that may keep a diary. Everything in nutrition/data that is "for a person" takes one. */
export interface Tracker {
  id: string;
  displayName: string;
  role: TrackerRole;
  /** null until they fill in sex, birth date and height: no calorie budget without it. */
  profile: ProfileRow | null;
}
