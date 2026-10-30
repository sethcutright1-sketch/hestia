// Which days count toward a person's logging streak, and the streak itself. (The pure date
// walk is nutrition/streaks.ts; this file is only "which days count".)
//
// A day counts when
//   - "Done logging" was tapped for it (nutrition_day_logs.done_logging_at), or
//   - it holds live entries imported from Lose It!.
//
// The second rule is an ASSUMPTION: Lose It!'s export has no "done" flag, so a day that was
// logged there can't be told apart from one that was merely opened. Counting every imported day
// keeps the history you built there from reading as a streak of zero the moment you switch; the
// price is that a day with one forgotten snack imported counts too. Days logged in this app count
// only when finished, so the streak stays honest from now on.

import { computeStreak, type Streak } from "../streaks.ts";
import { listTrackers, todayFor } from "./tracker.ts";
import { all, type Db } from "./sql.ts";

export function countedDates(db: Db, userId: string): string[] {
  return all<{ local_date: string }>(db,
    `SELECT local_date FROM nutrition_day_logs WHERE user_id = ? AND done_logging_at IS NOT NULL
     UNION
     SELECT local_date FROM nutrition_diary_entries WHERE user_id = ? AND source = 'import_loseit' AND deleted_at IS NULL`,
    userId, userId).map((r) => r.local_date);
}

/** `today` is the person's own local date (their timezone, not the caller's). */
export const streakFor = (db: Db, userId: string, today: string): Streak => computeStreak(countedDates(db, userId), today);

/**
 * The household's streak numbers: NUMBERS ONLY -- nothing about what anyone ate or when. Each person's
 * "today" is their own timezone's, since a streak resets at their own midnight.
 *
 * The viewer's own streak is always included. Anyone else is included only when asked for, because a
 * streak is shared by the owner's choice (visibility.ts: "totals" or "everything"):
 *   - `shared`   the ids of the other logins whose level lets this viewer see it (the route works them out);
 *   - `everyone` all of them, for server-side callers that are not answering one person.
 * With neither, only the viewer's own streak comes back, so a caller that forgets the rule shows less, not more.
 */
export function householdStreaks(
  db: Db, viewerId: string, now: Date = new Date(), opts: { shared?: ReadonlySet<string>; everyone?: boolean } = {},
) {
  return listTrackers(db)
    .filter((m) => m.id === viewerId || opts.everyone === true || opts.shared?.has(m.id) === true)
    .map((m) => ({
      userId: m.id,
      name: m.displayName,
      mine: m.id === viewerId,
      ...streakFor(db, m.id, todayFor(m, now)),
    }));
}
