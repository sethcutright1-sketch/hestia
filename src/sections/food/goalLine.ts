// The goal weight on the weight chart, as rules about numbers (the drawing is weightChart.ts):
//
//   Goal line   a dashed horizontal line at the goal weight, drawn only when the goal weight is set and it is NEAR the
//               weights on the chart. Near = no further outside the lowest/highest weight drawn than the chart's own
//               weight span (but never less than 4 lb / 2 kg). The chart's weight scale then grows to take the goal in, so
//               the weigh-ins keep at least half of the height. A goal further away is not drawn (a 1-month chart that
//               moved 3 lb cannot also show a goal 40 lb away) and the screen says so in words instead.
//   Projection  a dotted line from the current trend to the goal weight on the day the weekly plan reaches it (the
//               server's goalProjection, nutrition/weightTrend.ts). Drawn only while that day is inside the chart's
//               FUTURE PADDING, a quarter of the chart's width in days (at least 14), because a line that runs off the
//               edge says nothing. A plan that moves away from the goal, a reached goal, no plan, or a date over 5 years
//               out give no projection at all (the server's reasons), and so no line.

import { daysBetween } from "./dates.ts";
import type { ProjectionReason, UnitSystem } from "./types.ts";

/** How far outside the weights drawn a goal still counts as near, at the very least (in the person's units). */
export const MIN_NEAR_SPAN: Record<UnitSystem, number> = { imperial: 4, metric: 2 };

/** The fraction of the chart's span in days that may be added on the right for the projection. */
export const FUTURE_PAD_FRACTION = 0.25;
export const MIN_FUTURE_PAD_DAYS = 14;

export interface WeightScale {
  lo: number;
  hi: number;
  /** Is the goal weight inside (or near enough to join) this scale? */
  goalShown: boolean;
}

/**
 * The weight scale for weights from `lo` to `hi` and a goal weight, all in the person's units. The goal is taken in when
 * it is inside the weights or within one span (at least MIN_NEAR_SPAN) of them; otherwise the scale stays on the weights.
 */
export function scaleWithGoal(lo: number, hi: number, goal: number | null, system: UnitSystem): WeightScale {
  if (goal === null || !Number.isFinite(goal)) return { lo, hi, goalShown: false };
  const distance = goal < lo ? lo - goal : goal > hi ? goal - hi : 0;
  if (distance > Math.max(hi - lo, MIN_NEAR_SPAN[system])) return { lo, hi, goalShown: false };
  return { lo: Math.min(lo, goal), hi: Math.max(hi, goal), goalShown: true };
}

/** How many days after the chart's last day the projection may run: a quarter of the chart's width, 14 days at the least. */
export const futureDays = (spanDays: number): number => Math.max(MIN_FUTURE_PAD_DAYS, Math.floor(Math.max(0, spanDays) * FUTURE_PAD_FRACTION));

export interface ProjectionInput {
  date: string | null;
  reason: ProjectionReason;
}

/**
 * The day the projection line ends (it ends on the goal weight), or null when no line is drawn: the goal is not on the
 * chart, there is no usable projection, or it falls beyond the future padding. `chartStart` and `today` bound the chart's span.
 */
export function projectionEnd(a: { projection: ProjectionInput | null; goalShown: boolean; chartStart: string; today: string }): string | null {
  const { projection, goalShown, chartStart, today } = a;
  if (!goalShown || !projection || projection.reason !== "ok" || !projection.date) return null;
  const ahead = daysBetween(today, projection.date);
  if (ahead < 0 || ahead > futureDays(daysBetween(chartStart, today))) return null;
  return projection.date;
}

/** Says why a goal weight that is set is not on the chart ("" when it is, or none is set). */
export function goalOffScaleText(goalLabel: string, goal: number, lo: number, hi: number): string {
  if (goal < lo) return `Your goal weight, ${goalLabel}, is below this chart.`;
  if (goal > hi) return `Your goal weight, ${goalLabel}, is above this chart.`;
  return "";
}
