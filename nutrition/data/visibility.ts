// Who sees what: each diary login decides what the OTHER diary logins can see of THEIR food data
// (the user's phase 5 decision, 2026-10-15). A per-login setting, enforced here and in the routes --
// never only in the screen.
//
//   nothing     the default. Nobody else sees anything.
//   totals      the day's calories eaten against the calorie budget (the summary numbers, no foods),
//               and the logging streak.
//   everything  also the diary entries, exercise, weigh-ins and steps, read-only.
//
// Progress photos are NEVER shared, at any level: nothing in this file or in routes/nutrition/share.ts
// can reach nutrition_photos, and the photo routes answer only the owner.
//
// Stored in nutrition_user_settings.visibility (migration 10), beside the snack allowance: the same
// per-login row, the same diary-logins-only trigger, the same daily database copy. (The food-diary PIN
// option lives in app_config instead -- see routes/nutrition/pin.ts -- because it is a lock on the
// login, not a nutrition fact.) A login with no row has 'nothing'.
//
// This file only decides levels. The PIN rule (an owner who locks their diary behind the household PIN
// also locks it for the viewer) needs app_config and the session, so it sits in routes/nutrition/share.ts.

import { assertCanTrack, type Tracker } from "./access.ts";
import { NutritionError } from "./errors.ts";
import { bodyObject } from "./input.ts";
import { get, run, type Db } from "./sql.ts";
import { listTrackers } from "./tracker.ts";

export const VISIBILITY_LEVELS = ["nothing", "totals", "everything"] as const;
export type Visibility = (typeof VISIBILITY_LEVELS)[number];
export const DEFAULT_VISIBILITY: Visibility = "nothing";

export const isVisibility = (v: unknown): v is Visibility => (VISIBILITY_LEVELS as readonly unknown[]).includes(v);

/** What a viewer asks for: 'totals' is satisfied by 'totals' or 'everything'; 'everything' only by 'everything'. */
export type VisibilityNeed = "totals" | "everything";

export const levelAllows = (level: Visibility, need: VisibilityNeed): boolean =>
  need === "totals" ? level === "totals" || level === "everything" : level === "everything";

/** What this login shares with the other diary logins (the default when they never chose). */
export function visibilityOf(db: Db, userId: string): Visibility {
  const v = get<{ visibility: string }>(db, "SELECT visibility FROM nutrition_user_settings WHERE user_id = ?", userId)?.visibility;
  return isVisibility(v) ? v : DEFAULT_VISIBILITY;
}

export const visibilityJson = (level: Visibility) => ({
  visibility: level,
  defaultVisibility: DEFAULT_VISIBILITY,
  levels: VISIBILITY_LEVELS,
});

/** Set the signed-in login's own level. Anything but one of the three words is a 400. */
export function setVisibility(db: Db, user: Tracker, input: unknown): Visibility {
  assertCanTrack(user);
  const v = bodyObject(input).visibility;
  if (!isVisibility(v)) throw new NutritionError(400, `visibility must be one of ${VISIBILITY_LEVELS.join(", ")}.`);
  run(db,
    `INSERT INTO nutrition_user_settings (user_id, visibility, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET visibility = excluded.visibility, updated_at = excluded.updated_at`,
    user.id, v, new Date().toISOString());
  return v;
}

export interface Sharer {
  tracker: Tracker;
  level: Visibility;
}

/**
 * The OTHER diary logins who share at least `need` with `viewerId`, oldest account first. The viewer is
 * never in the list: their own data is theirs whatever they share.
 */
export function sharersFor(db: Db, viewerId: string, need: VisibilityNeed = "totals"): Sharer[] {
  return listTrackers(db)
    .filter((t) => t.id !== viewerId)
    .map((tracker) => ({ tracker, level: visibilityOf(db, tracker.id) }))
    .filter((s) => levelAllows(s.level, need));
}
