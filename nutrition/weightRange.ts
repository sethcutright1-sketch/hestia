// The weight chart's range buttons as the server understands them: 1M, 3M, 6M, 1Y and All. A range is a word, not a
// date, so the start is worked out from the PERSON's today (their time zone), the same one the diary uses, and a phone
// with a wrong clock cannot draw the wrong window. Pure and shared: the Food section's buttons (src/sections/food/
// weightRange.ts) use the same table, and both the person's own /weights/trend and the read-only
// /people/:id/progress routes accept `range=`.
//
// The ranges are counted in days, not calendar months, so a range is always the same length whatever the month:
// 1M = 30 days, 3M = 91, 6M = 182, 1Y = 365 (what the chart showed before there were buttons). All has no start.

import { addDays } from "./dates.ts";

export const WEIGHT_RANGES = ["1m", "3m", "6m", "1y", "all"] as const;
export type WeightRange = (typeof WEIGHT_RANGES)[number];

/** What the chart shows when nobody chose: a year, as it always did. */
export const DEFAULT_WEIGHT_RANGE: WeightRange = "1y";

export const RANGE_DAYS: Record<Exclude<WeightRange, "all">, number> = { "1m": 30, "3m": 91, "6m": 182, "1y": 365 };

export const isWeightRange = (v: unknown): v is WeightRange => (WEIGHT_RANGES as readonly unknown[]).includes(v);

/** The first day a range covers, or null for All (no lower bound: the whole history, back to the Lose It! import). */
export function rangeStart(range: WeightRange, today: string): string | null {
  return range === "all" ? null : addDays(today, -RANGE_DAYS[range]);
}
