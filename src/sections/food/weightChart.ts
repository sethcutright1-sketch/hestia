// The weight chart as plain numbers: where each weigh-in dot and the trend line sit inside an SVG of a given
// size. No chart library (household-app has none; the Budget section draws its own too): the component
// just prints these into an <svg>, so the scaling is tested without a browser (tests/foodWeightChart.test.ts).
//
// x is time (the days between weigh-ins are to scale, so a gap in weighing is a gap on the chart), y is the
// weight in the person's units, from the lowest to the highest value drawn (weigh-ins AND trend).
//
// With `extras` (the person's own chart) it also knows the range's first day, today, the goal weight and the
// projection: the x-axis then runs from the range's start (or the first weigh-in when the history is shorter) to today,
// a dashed goal line and a dotted projection line are placed, and the weight scale grows to take the goal in
// (goalLine.ts has the rules). Without extras it is exactly the first-to-last-weigh-in chart it always was.

import { daysBetween, shortDate } from "./dates.ts";
import { goalOffScaleText, projectionEnd, scaleWithGoal, type ProjectionInput } from "./goalLine.ts";
import type { TrendPoint, UnitSystem } from "./types.ts";
import { displayWeight, round1, weightUnit } from "./units.ts";

export interface ChartSize {
  width: number;
  height: number;
  padLeft: number;
  padRight: number;
  padTop: number;
  padBottom: number;
}

export const DEFAULT_CHART_SIZE: ChartSize = { width: 320, height: 160, padLeft: 8, padRight: 8, padTop: 16, padBottom: 24 };

/** More dots than this and the dots are left out (the line alone reads better). */
export const MAX_DOTS = 40;

export interface ChartDot {
  x: number;
  y: number;
  date: string;
  /** In the person's units. */
  value: number;
}

/** What the chart knows beyond the points. All optional: none of it is passed for someone else's weigh-ins. */
export interface ChartExtras {
  /** The first day of the chosen range; null or left out = no lower bound (All). */
  rangeStart?: string | null;
  /** The person's today. The x-axis runs to it (and past it, for a projection). */
  today?: string;
  /** The goal weight and the server's projection. Own chart only. */
  goal?: { goalKg: number | null; projection: ProjectionInput | null } | null;
}

/** How much of a range may be empty on the left before the axis starts at the first weigh-in instead: the larger of 7 days and 15% of the range. */
export const LEFT_SLACK_FRACTION = 0.15;
export const MIN_LEFT_SLACK_DAYS = 7;

export interface WeightChart {
  width: number;
  height: number;
  /** SVG `points` for the thin line through the weigh-ins. */
  rawLine: string;
  /** SVG `points` for the bold smoothed line. */
  trendLine: string;
  dots: ChartDot[];
  /** The trend's last point (where the bold line ends). */
  end: ChartDot;
  /** The highest and lowest value drawn, with where their labels sit. */
  top: { y: number; label: string };
  bottom: { y: number; label: string };
  startLabel: string;
  endLabel: string;
  /** The dashed goal line (own chart, goal near the weights), with the goal in the person's units. */
  goalLine: { y: number; x1: number; x2: number; value: number; label: string } | null;
  /** Why a goal weight that is set is not drawn ("" when it is, or none is set). */
  goalNote: string;
  /** The dotted line from the trend's end to the goal weight on the projected day. */
  projection: { x1: number; y1: number; x2: number; y2: number; date: string } | null;
  /** A "Today" tick on the axis, only when the projection pushes today away from the right edge and there is room for it. */
  todayMark: { x: number; label: string } | null;
  /** For screen readers. */
  description: string;
}

const fix = (n: number): string => n.toFixed(1);

/** The room each side of a "Today" tick (in chart units) before it is drawn; the start and end dates sit at the corners. */
const TODAY_MARK_ROOM = 44;

/** Null for fewer than two weigh-in days: one dot is not a chart. */
export function buildWeightChart(points: TrendPoint[], system: UnitSystem, size: ChartSize = DEFAULT_CHART_SIZE, extras: ChartExtras = {}): WeightChart | null {
  if (points.length < 2) return null;
  const unit = weightUnit(system);
  const first = points[0];
  const last = points[points.length - 1];
  const today = extras.today && extras.today > last.date ? extras.today : last.date;
  // The axis starts at the range's first day when the weigh-ins fill the range; with a history shorter than the range it
  // starts at the first weigh-in, so a person with two weeks of weigh-ins does not get a chart that is 96% empty on the 1Y button.
  let startDate = first.date;
  const rs = extras.rangeStart;
  if (rs && rs < first.date) {
    const slack = Math.max(MIN_LEFT_SLACK_DAYS, Math.round(LEFT_SLACK_FRACTION * daysBetween(rs, today)));
    if (daysBetween(rs, first.date) <= slack) startDate = rs;
  }
  const raw = points.map((p) => ({ date: p.date, value: displayWeight(p.weightKg, system) }));
  const trend = points.map((p) => ({ date: p.date, value: displayWeight(p.trendKg, system) }));
  const values = [...raw, ...trend].map((p) => p.value);
  const dataLo = Math.min(...values);
  const dataHi = Math.max(...values);
  const goalValue = extras.goal?.goalKg != null ? displayWeight(extras.goal.goalKg, system) : null;
  const scale = scaleWithGoal(dataLo, dataHi, goalValue, system);
  const { lo, hi } = scale;
  const range = hi - lo || 1;
  const endDay = extras.today
    ? projectionEnd({ projection: extras.goal?.projection ?? null, goalShown: scale.goalShown, chartStart: startDate, today: extras.today })
    : null;
  const endDate = endDay && endDay > today ? endDay : today;
  const span = Math.max(1, daysBetween(startDate, endDate));

  const plotW = size.width - size.padLeft - size.padRight;
  const plotH = size.height - size.padTop - size.padBottom;
  const x = (date: string): number => size.padLeft + (daysBetween(startDate, date) / span) * plotW;
  const y = (value: number): number => size.padTop + (1 - (value - lo) / range) * plotH;
  const at = (p: { date: string; value: number }): ChartDot => ({ x: x(p.date), y: y(p.value), date: p.date, value: p.value });
  const line = (list: Array<{ date: string; value: number }>): string => list.map((p) => `${fix(x(p.date))},${fix(y(p.value))}`).join(" ");

  const change = round1(raw[raw.length - 1].value - raw[0].value);
  const endPoint = at(trend[trend.length - 1]);
  const goalLine = scale.goalShown && goalValue !== null
    ? { y: y(goalValue), x1: size.padLeft, x2: size.width - size.padRight, value: goalValue, label: `${goalValue} ${unit}` }
    : null;
  const projection = endDay && goalLine
    ? { x1: endPoint.x, y1: endPoint.y, x2: x(endDay), y2: goalLine.y, date: endDay }
    : null;
  const todayX = x(today);
  const todayMark = projection && today !== endDate && todayX - size.padLeft >= TODAY_MARK_ROOM && size.width - size.padRight - todayX >= TODAY_MARK_ROOM
    ? { x: todayX, label: "Today" }
    : null;
  const goalNote = goalValue !== null && !scale.goalShown ? goalOffScaleText(`${goalValue} ${unit}`, goalValue, dataLo, dataHi) : "";
  return {
    width: size.width,
    height: size.height,
    rawLine: line(raw),
    trendLine: line(trend),
    dots: points.length <= MAX_DOTS ? raw.map(at) : [],
    end: endPoint,
    top: { y: size.padTop - 4, label: `${round1(hi)} ${unit}` },
    // Just above the plot's bottom edge, not below it: below, it sat 7 px over the start-date label and the two
    // overlapped (seen once the label could carry a year, "Jun 1, 2024").
    bottom: { y: size.height - size.padBottom - 3, label: `${round1(lo)} ${unit}` },
    startLabel: dateLabel(startDate, endDate),
    endLabel: shortDate(endDate),
    goalLine,
    goalNote,
    projection,
    todayMark,
    description: `Weight from ${raw[0].value} to ${raw[raw.length - 1].value} ${unit} between ${shortDate(first.date)} and ${shortDate(last.date)}; ${change === 0 ? "no change" : `${change > 0 ? "up" : "down"} ${Math.abs(change)} ${unit}`}; the trend is ${trend[trend.length - 1].value} ${unit}.${goalLine ? ` The goal weight is ${goalLine.label}.` : ""}${projection ? ` At the weekly plan the trend reaches it around ${shortDate(projection.date)}.` : ""}`,
  };
}

/**
 * A date for a label that may sit beside one from another year: "Oct 3" within one year, "Jun 1, 2024" when `other`
 * is in a different year. On the All range a bare "Jun 1" read as this year's, next to the "lost so far" headline's
 * own "since Jun 1, 2025" (found in review).
 */
export function dateLabel(date: string, other: string): string {
  return date.slice(0, 4) === other.slice(0, 4) ? shortDate(date) : `${shortDate(date)}, ${date.slice(0, 4)}`;
}

/** "+2 lb since Oct 3" / "-1.4 lb since Oct 3": the change from the first weigh-in drawn to the last (the year is added across years). */
export function changeText(points: TrendPoint[], system: UnitSystem): string | null {
  if (points.length < 2) return null;
  const first = points[0];
  const last = points[points.length - 1];
  const delta = round1(displayWeight(last.weightKg, system) - displayWeight(first.weightKg, system));
  const sign = delta > 0 ? "+" : delta < 0 ? "-" : "";
  return `${sign}${Math.abs(delta)} ${weightUnit(system)} since ${dateLabel(first.date, last.date)}`;
}
