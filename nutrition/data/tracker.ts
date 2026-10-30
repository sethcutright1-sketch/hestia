// How a household-app login becomes a Tracker, and the per-person profile the calorie budget
// is computed from. Who is allowed to be one (admin and parent, never kiosk) is access.ts.

import { localDate } from "../dates.ts";
import { assertCanTrack, type ProfileRow, type Tracker } from "./access.ts";
import { NutritionError } from "./errors.ts";
import { bodyObject, isValidTimezone, localDateField, oneOf, reqNumber, type Body } from "./input.ts";
import { ensureDefaultSlots } from "./slots.ts";
import { all, get, run, tx, type Db } from "./sql.ts";

const FALLBACK_TIMEZONE = "America/New_York";

/**
 * The timezone used for someone with no profile yet: this server's own, which for a home
 * server is the household's. Falls back to New York, the calorie app's old default.
 */
export function defaultTimezone(): string {
  try {
    const tz = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    return isValidTimezone(tz) ? tz : FALLBACK_TIMEZONE;
  } catch {
    return FALLBACK_TIMEZONE;
  }
}

export const timezoneOf = (user: Pick<Tracker, "profile">): string => user.profile?.timezone ?? defaultTimezone();

/** The person's own local date -- never UTC. `now` is injectable so tests can pin an instant. */
export const todayFor = (user: Pick<Tracker, "profile">, now: Date = new Date()): string => localDate(timezoneOf(user), now);

const getProfile = (db: Db, userId: string): ProfileRow | null =>
  get<ProfileRow>(db, "SELECT * FROM nutrition_profiles WHERE user_id = ?", userId) ?? null;

function toTracker(db: Db, u: { id: string; display_name: string; role: string }): Tracker {
  assertCanTrack(u);
  return { id: u.id, displayName: u.display_name, role: u.role, profile: getProfile(db, u.id) };
}

/**
 * The tracker for a login id. 404 for an unknown id, 403 for the kiosk. The first time a login
 * is seen as a tracker it also gets the default meals (breakfast ... snacks); after that this
 * finds them and writes nothing, so it is safe to call on every request.
 */
export function getTracker(db: Db, userId: string): Tracker {
  const u = get<{ id: string; display_name: string; role: string }>(db, "SELECT id, display_name, role FROM users WHERE id = ?", userId);
  if (!u) throw new NutritionError(404, "User not found.");
  const tracker = toTracker(db, u);
  ensureDefaultSlots(db, tracker.id);
  return tracker;
}

/**
 * The tracker for a login id WITHOUT writing anything: no default meals are created for a login that has none yet.
 * For reading another person's shared data (sharedView.ts), which must never change their rows. 404 for an unknown
 * id, 403 for the kiosk.
 */
export function peekTracker(db: Db, userId: string): Tracker {
  const u = get<{ id: string; display_name: string; role: string }>(db, "SELECT id, display_name, role FROM users WHERE id = ?", userId);
  if (!u) throw new NutritionError(404, "User not found.");
  return toTracker(db, u);
}

/** Every login that keeps a diary, oldest account first (the household streaks view). */
export function listTrackers(db: Db): Tracker[] {
  return all<{ id: string; display_name: string; role: string }>(db,
    "SELECT id, display_name, role FROM users WHERE role IN ('admin', 'parent') ORDER BY created_at, rowid")
    .map((u) => toTracker(db, u));
}

export const profileJson = (user: Tracker) => ({
  id: user.id,
  name: user.displayName,
  role: user.role,
  hasProfile: user.profile !== null,
  sex: user.profile?.sex ?? null,
  birthDate: user.profile?.birth_date ?? null,
  heightCm: user.profile?.height_cm ?? null,
  timezone: timezoneOf(user),
  unitSystem: user.profile?.unit_system ?? "imperial",
});

/**
 * Create or update the person's profile. The first save needs sex, birthDate and heightCm;
 * after that it is a partial update (only fields present change). Creating one also gives the
 * person a "maintain weight" starting goal, so a calorie budget exists as soon as they log a
 * weight -- the same placeholder the calorie app's first-run setup made.
 */
export function saveProfile(db: Db, user: Tracker, input: unknown): ProfileRow {
  assertCanTrack(user);
  const b: Body = bodyObject(input);
  const cur = getProfile(db, user.id);

  let timezone = cur?.timezone ?? defaultTimezone();
  if (b.timezone !== undefined) {
    if (!isValidTimezone(b.timezone)) throw new NutritionError(400, "timezone must be an IANA zone like America/New_York.");
    timezone = b.timezone;
  }
  const next = {
    sex: b.sex === undefined && cur ? cur.sex : oneOf(b.sex, "sex", ["male", "female"] as const),
    birth_date: b.birthDate === undefined && cur ? cur.birth_date : localDateField(b.birthDate, "birthDate"),
    height_cm: b.heightCm === undefined && cur ? cur.height_cm : reqNumber(b, "heightCm", 50, 260),
    unit_system: b.unitSystem === undefined ? cur?.unit_system ?? "imperial" : oneOf(b.unitSystem, "unitSystem", ["imperial", "metric"] as const),
  };

  const now = new Date().toISOString();
  tx(db, () => {
    if (cur) {
      run(db, "UPDATE nutrition_profiles SET sex = ?, birth_date = ?, height_cm = ?, timezone = ?, unit_system = ?, updated_at = ? WHERE user_id = ?",
        next.sex, next.birth_date, next.height_cm, timezone, next.unit_system, now, user.id);
      return;
    }
    run(db,
      "INSERT INTO nutrition_profiles (user_id, sex, birth_date, height_cm, timezone, unit_system, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      user.id, next.sex, next.birth_date, next.height_cm, timezone, next.unit_system, now, now);
    if (!get(db, "SELECT id FROM nutrition_goals WHERE user_id = ? LIMIT 1", user.id)) {
      run(db,
        `INSERT INTO nutrition_goals (user_id, effective_from, plan_lb_per_week, activity_level, min_calorie_budget_mode, macro_mode, macro_protein, macro_carbs, macro_fat)
         VALUES (?, '2000-01-01', 0, 'light', 'safe', 'percent', 20, 50, 30)`, user.id);
    }
  });
  return getProfile(db, user.id)!;
}
