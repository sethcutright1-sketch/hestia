// The smoothed trend weight and, with a goal weight and a weekly plan, when the plan reaches it.
// (The maths is nutrition/weightTrend.ts; this is the person's own data fed into it.)
//
// The phone computes the same thing from its own (queued-writes-included) list; this is the
// reference those are tested against and what other readers (the assistant) use. `from`
// defaults to a year back: the trend forgets anything older almost completely (0.9^30 is 4%),
// so a longer window only costs time.
//
// Two ways in:
//   weightTrendFor(db, user, today, from?)     the original: the trend is worked out from the weigh-ins since `from`
//                                              (the first one in the window is the starting trend). The assistant uses it.
//   weightTrendForRange(db, user, today, range) the chart's range buttons (1m 3m 6m 1y all): the trend is worked out from the
//                                              WHOLE history and only the points inside the range are returned, so the
//                                              trend weight, the goal date and a point's trend value are the same
//                                              whichever button is pressed (a 1-month window must not restart the smoothing).
//
// `weightStart` (own view only, and only in the range form) carries the trend at the person's "I started on" day, for
// "lost so far". sharedView.ts calls weightTrendOver and keeps only the points and the trend, so the goal, the plan and
// the start date never reach another person.

import { addDays } from "../dates.ts";
import { round2 } from "../nutrients.ts";
import { goalProjection, trendAtDate, trendSeries, type TrendPoint } from "../weightTrend.ts";
import { isWeightRange, rangeStart, WEIGHT_RANGES, type WeightRange } from "../weightRange.ts";
import type { Tracker } from "./access.ts";
import { NutritionError } from "./errors.ts";
import { goalOn } from "./goals.ts";
import { localDateField } from "./input.ts";
import type { Db } from "./sql.ts";
import { weightStartDate } from "./weightStart.ts";
import { weightsSince } from "./weights.ts";

const EVERYTHING = "0000-01-01"; // sorts before any real date

const seriesFrom = (db: Db, userId: string, since: string): TrendPoint[] =>
  trendSeries(weightsSince(db, userId, since).map((r) => ({ date: r.measured_on, kg: r.weight_kg })));

/** The points to return, the current trend (always the newest one in `full`), the goal and the projection. */
function shape(db: Db, user: Tracker, today: string, shown: TrendPoint[], full: TrendPoint[]) {
  const goal = goalOn(db, user.id, today);
  const latest = full.length ? full[full.length - 1].trendKg : null; // unrounded: the projection uses it as is
  const goalKg = goal?.goal_weight_kg ?? null;
  const planLbPerWeek = goal?.plan_lb_per_week ?? null;
  return {
    points: shown.map((p) => ({ date: p.date, weightKg: round2(p.kg), trendKg: round2(p.trendKg) })),
    trendKg: latest === null ? null : round2(latest),
    goalKg,
    planLbPerWeek,
    projection: latest !== null && goalKg !== null && planLbPerWeek !== null
      ? goalProjection({ trendKg: latest, goalKg, planLbPerWeek, today })
      : null,
  };
}

export function weightTrendFor(db: Db, user: Tracker, today: string, from?: unknown) {
  const since = from === undefined ? addDays(today, -365) : localDateField(from, "from");
  const series = seriesFrom(db, user.id, since);
  return shape(db, user, today, series, series);
}

/** `range` must be one of 1m, 3m, 6m, 1y, all (400 otherwise). */
export function parseWeightRange(range: unknown): WeightRange {
  if (!isWeightRange(range)) throw new NutritionError(400, `range must be one of ${WEIGHT_RANGES.join(", ")}.`);
  return range;
}

/** The trend worked out from the whole history, with only the points on or after `start` returned (null = all of them). */
export function weightTrendOver(db: Db, user: Tracker, today: string, start: string | null) {
  const full = seriesFrom(db, user.id, EVERYTHING);
  return { out: shape(db, user, today, start === null ? full : full.filter((p) => p.date >= start), full), full };
}

export function weightTrendForRange(db: Db, user: Tracker, today: string, range: unknown) {
  const r = parseWeightRange(range);
  const from = rangeStart(r, today);
  const { out, full } = weightTrendOver(db, user, today, from);
  const startDate = weightStartDate(db, user.id);
  const at = startDate === null ? null : trendAtDate(full, startDate);
  return {
    ...out,
    range: r,
    /** The first day the points cover; null for All. */
    from,
    /** The person's "I started on" day, with the trend there (null when no day is set). `trendKg` is null with no weigh-ins at all. */
    weightStart: startDate === null
      ? null
      : { date: startDate, trendKg: at ? round2(at.trendKg) : null, weighedOn: at?.date ?? null, later: at?.later ?? false },
  };
}
