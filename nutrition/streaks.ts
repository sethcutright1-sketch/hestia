// Logging streaks: how many days in a row were "counted".
//
// A streak is computed by walking over a set of counted local dates, never stored as a
// counter, so a day that is un-marked, back-filled or imported moves it correctly. What
// makes a day count is the caller's business (the calorie app: "Done logging" was tapped,
// or the day came from a Lose It! import); this module only does the date arithmetic.
//
// Dates are "YYYY-MM-DD" local dates and every step goes through addDays, which works on
// date-only values in UTC, so a DST change can't skip or repeat a day.

import { addDays, isValidLocalDate } from "./dates.ts";

export interface Streak {
  /** Consecutive counted days ending today, or ending yesterday if today isn't counted yet. */
  current: number;
  /** The longest run of consecutive counted days ever. */
  best: number;
  countedToday: boolean;
}

/**
 * An unfinished today doesn't break a streak: until the day is counted, the run that ended
 * yesterday is still "current". It only drops to 0 once a whole day has passed uncounted.
 * Dates after `today` (a clock change, a bad row) are ignored.
 */
export function computeStreak(counted: Iterable<string>, today: string): Streak {
  const days = new Set<string>();
  for (const d of counted) if (isValidLocalDate(d) && d <= today) days.add(d);

  const countedToday = days.has(today);
  let current = 0;
  for (let d = countedToday ? today : addDays(today, -1); days.has(d); d = addDays(d, -1)) current++;

  let best = 0;
  let run = 0;
  let prev: string | null = null;
  for (const d of [...days].sort()) {
    run = prev !== null && addDays(prev, 1) === d ? run + 1 : 1;
    if (run > best) best = run;
    prev = d;
  }
  return { current, best, countedToday };
}
