// Steps as numbers for the screen: the last N days with a gap where nothing was entered, the bars of a
// small chart, and the one-line summaries. Steps are typed by hand, so a missing day is "not entered", never
// zero. Plain SVG geometry like weightChart.ts; tested in tests/foodStepsChart.test.ts.

import { addDays, shortDate } from "./dates.ts";
import type { StepsDay } from "./types.ts";

/** How many days the chart shows. */
export const CHART_DAYS = 30;

/** "8,123": fixed US form so a number reads the same everywhere. */
export const stepsText = (n: number): string => Math.round(n).toLocaleString("en-US");

export interface DaySteps {
  date: string;
  /** null = nothing entered for that day. */
  steps: number | null;
  source: string | null;
}

/** The `days` days ending at `today` (oldest first), each with its steps or null. Rows outside the window are ignored. */
export function lastDays(rows: Array<Pick<StepsDay, "date" | "steps"> & { source?: string }>, today: string, days: number = CHART_DAYS): DaySteps[] {
  const byDate = new Map(rows.map((r) => [r.date, r]));
  return Array.from({ length: days }, (_, i) => {
    const date = addDays(today, i - (days - 1));
    const row = byDate.get(date);
    return { date, steps: row ? row.steps : null, source: row?.source ?? null };
  });
}

export interface StepsBar {
  date: string;
  /** null = no bar: nothing entered. */
  steps: number | null;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface StepsChartSize {
  width: number;
  height: number;
  padTop: number;
  padBottom: number;
  /** Space between bars as a fraction of a bar slot. */
  gap: number;
}

export const DEFAULT_STEPS_SIZE: StepsChartSize = { width: 320, height: 120, padTop: 10, padBottom: 18, gap: 0.25 };

export interface StepsChart {
  width: number;
  height: number;
  bars: StepsBar[];
  /** The value the tallest bar stands for. */
  max: number;
  baselineY: number;
  startLabel: string;
  endLabel: string;
}

/** Bars for the days given, scaled so the biggest entered day fills the height. Days with nothing entered get no height. */
export function buildStepsChart(days: DaySteps[], size: StepsChartSize = DEFAULT_STEPS_SIZE): StepsChart {
  const max = Math.max(1, ...days.map((d) => d.steps ?? 0));
  const slot = size.width / Math.max(1, days.length);
  const barW = slot * (1 - size.gap);
  const plotH = size.height - size.padTop - size.padBottom;
  const baselineY = size.padTop + plotH;
  return {
    width: size.width,
    height: size.height,
    max,
    baselineY,
    bars: days.map((d, i) => {
      const h = d.steps === null ? 0 : Math.max(d.steps > 0 ? 1 : 0, (d.steps / max) * plotH);
      return { date: d.date, steps: d.steps, x: i * slot + (slot - barW) / 2, y: baselineY - h, width: barW, height: h };
    }),
    startLabel: days.length ? shortDate(days[0].date) : "",
    endLabel: days.length ? shortDate(days[days.length - 1].date) : "",
  };
}

/** The mean over the days that have steps entered; null when none do (never an average with the blanks counted as zero). */
export function averageSteps(days: DaySteps[]): number | null {
  const entered = days.filter((d): d is DaySteps & { steps: number } => d.steps !== null);
  return entered.length ? entered.reduce((a, d) => a + d.steps, 0) / entered.length : null;
}

/** "Average 7,420 a day over 12 days with steps entered", or null with none. */
export function averageText(days: DaySteps[]): string | null {
  const avg = averageSteps(days);
  if (avg === null) return null;
  const n = days.filter((d) => d.steps !== null).length;
  return `Average ${stepsText(avg)} a day over ${n} ${n === 1 ? "day" : "days"} with steps entered.`;
}
