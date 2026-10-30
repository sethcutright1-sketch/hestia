// Trend weight and goal-date projection.
//
// A scale reading swings by a kilo or two with water and meals, so anything that reasons about
// the direction of travel (the goal date, a budget recalculation) should use a SMOOTHED weight.
//
// Exponential smoothing, time-aware: each weigh-in pulls the trend toward it by a fraction that
// depends on how many days passed since the previous one,
//
//     weight of the new reading = 1 - (1 - 0.1) ^ days
//
// i.e. ~0.1 per day, compounded. Weighing in daily gives the classic EMA with alpha 0.1; one
// reading a week trusts the new value 52% (1 - 0.9^7) because a week of drift has happened in
// between; irregular weigh-ins just work. Several readings on one day are averaged first.
// Units don't matter: the smoothing is linear, so it works in kg or lb alike.

import { addDays, isValidLocalDate } from "./dates.ts";

/** Fraction of a gap the trend closes per elapsed day. */
export const TREND_ALPHA_PER_DAY = 0.1;
/** Goal-date projections further out than this are hidden: at that pace they're noise. */
export const MAX_PROJECTION_DAYS = 5 * 365;
export const KG_PER_LB = 0.45359237;
const LB_PER_KG = 1 / KG_PER_LB;
/** Within this of the goal counts as there (about 0.2 lb). */
const REACHED_KG = 0.1;

export interface WeighIn {
  /** Local date of the weigh-in. */
  date: string;
  kg: number;
}

export interface TrendPoint {
  date: string;
  kg: number;
  trendKg: number;
}

const daysBetween = (a: string, b: string): number => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** One point per weigh-in day (readings of the same day averaged), oldest first, with the trend at that day. */
export function trendSeries(weighIns: WeighIn[]): TrendPoint[] {
  const byDay = new Map<string, number[]>();
  for (const w of weighIns) {
    if (!isValidLocalDate(w.date) || !Number.isFinite(w.kg) || w.kg <= 0) continue;
    const list = byDay.get(w.date);
    if (list) list.push(w.kg);
    else byDay.set(w.date, [w.kg]);
  }
  const out: TrendPoint[] = [];
  for (const date of [...byDay.keys()].sort()) {
    const readings = byDay.get(date)!;
    const kg = readings.reduce((a, b) => a + b, 0) / readings.length;
    const prev = out[out.length - 1];
    if (!prev) {
      out.push({ date, kg, trendKg: kg }); // the first reading is the starting trend
      continue;
    }
    const weight = 1 - Math.pow(1 - TREND_ALPHA_PER_DAY, daysBetween(prev.date, date));
    out.push({ date, kg, trendKg: prev.trendKg + weight * (kg - prev.trendKg) });
  }
  return out;
}

/** The trend after the latest weigh-in, or null with none. */
export function currentTrend(weighIns: WeighIn[]): number | null {
  const s = trendSeries(weighIns);
  return s.length ? s[s.length - 1].trendKg : null;
}

export type ProjectionReason = "ok" | "no-plan" | "reached" | "wrong-direction" | "too-far";

export interface GoalProjection {
  date: string | null;
  reason: ProjectionReason;
}

/**
 * When the trend weight reaches the goal if the plan is followed exactly. `planLbPerWeek` is the
 * app's plan: positive = lose, negative = gain. No date (and the reason why) when there is no
 * plan, the goal is already reached, the plan moves away from the goal, or it's over 5 years out.
 */
export function goalProjection(a: { trendKg: number; goalKg: number; planLbPerWeek: number; today: string }): GoalProjection {
  const { trendKg, goalKg, planLbPerWeek, today } = a;
  if (!(planLbPerWeek !== 0)) return { date: null, reason: "no-plan" };
  const toGoalKg = trendKg - goalKg; // > 0: weight above the goal, i.e. still to lose
  if (Math.abs(toGoalKg) <= REACHED_KG) return { date: null, reason: "reached" };
  if ((toGoalKg > 0) !== (planLbPerWeek > 0)) return { date: null, reason: "wrong-direction" };
  const weeks = (Math.abs(toGoalKg) * LB_PER_KG) / Math.abs(planLbPerWeek);
  // The tiny subtraction keeps 5.000000000000001 weeks (a unit-conversion round trip) from becoming a 36th day.
  const days = Math.ceil(weeks * 7 - 1e-9);
  if (days > MAX_PROJECTION_DAYS) return { date: null, reason: "too-far" };
  return { date: addDays(today, days), reason: "ok" };
}

export const projectGoalDate = (a: { trendKg: number; goalKg: number; planLbPerWeek: number; today: string }): string | null =>
  goalProjection(a).date;

export interface TrendAt {
  /** The weigh-in day the trend value belongs to. */
  date: string;
  trendKg: number;
  /** True when no weigh-in was on or before the day asked for, so this is the first one AFTER it. */
  later: boolean;
}

/**
 * The trend weight as of a day (for "lost so far" from the day a person started): the trend at the latest weigh-in on
 * or before it -- the trend only moves when there is a weigh-in, so that is its value that day. When nothing was
 * weighed on or before the day, the first weigh-in after it (`later: true`). Null with no weigh-ins at all.
 * `series` is trendSeries output: oldest first, one point per day.
 */
export function trendAtDate(series: TrendPoint[], date: string): TrendAt | null {
  if (series.length === 0) return null;
  let before: TrendPoint | null = null;
  for (const p of series) {
    if (p.date > date) break;
    before = p;
  }
  if (before) return { date: before.date, trendKg: before.trendKg, later: false };
  return { date: series[0].date, trendKg: series[0].trendKg, later: true };
}
