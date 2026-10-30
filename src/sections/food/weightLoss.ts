// "Lost so far": the headline above the weight chart, from the day the person said they started. Pure numbers and
// words, so it is tested without a browser (tests/foodWeightLoss.test.ts).
//
//   * It measures the TREND weight (the smoothed value the tab already shows as "Trend weight") on the start day against
//     the trend now, so one heavy day does not swing it. The server works out the trend on the start day
//     (GET /weights/trend `weightStart`): the trend at the latest weigh-in on or before it, or, when nothing was
//     weighed by then, at the first weigh-in after it -- and the sentence says so.
//   * It is independent of the range buttons: it always measures from the start day.
//   * Units follow the person's unit system; the difference is rounded once, from kilograms.
//   * No start day set = no number at all (the screen shows a link to set it).
//   * The goal: "18.6 lb to go to 175 lb", or "Goal reached". A goal weight below the start is a loss goal (reached at or
//     below it); one above the start is a gain goal (reached at or above it). "At" is judged to one decimal, as shown.

import { isValidLocalDate, longDate } from "./dates.ts";
import type { Built } from "./forms.ts";
import type { UnitSystem, WeightStart } from "./types.ts";
import { formatWeight, kgToLb, round1, weightUnit } from "./units.ts";

export type LossSummary =
  | { kind: "unset" }
  | { kind: "no-weigh-ins"; text: string }
  | {
      kind: "ok";
      direction: "down" | "up" | "same";
      /** "Lost 12.4 lb since Jan 3, 2026" / "Up 2.1 lb since Jan 3, 2026" / "No change since Jan 3, 2026". */
      headline: string;
      /** Said when the start day had no weigh-in on or before it, so the first one after it was used. */
      note: string | null;
      /** "18.6 lb to go to 175 lb" / "Goal reached" / null without a goal weight. */
      goalLine: string | null;
      goalReached: boolean;
    };

const inUnits = (kg: number, system: UnitSystem): number => round1(system === "imperial" ? kgToLb(kg) : kg);

/** The headline and the goal line for the person's own Weight & progress tab. `currentTrendKg` is the trend now. */
export function lossSummary(start: WeightStart | null, currentTrendKg: number | null, goalKg: number | null, system: UnitSystem): LossSummary {
  if (start === null) return { kind: "unset" };
  if (start.trendKg === null || currentTrendKg === null) {
    return { kind: "no-weigh-ins", text: `No weigh-ins yet to measure from ${longDate(start.date)}.` };
  }
  const unit = weightUnit(system);
  const lostKg = start.trendKg - currentTrendKg; // > 0: lighter now
  const amount = inUnits(Math.abs(lostKg), system);
  const since = longDate(start.date);
  const direction = amount === 0 ? "same" : lostKg > 0 ? "down" : "up";
  const headline = direction === "same" ? `No change since ${since}` : `${direction === "down" ? "Lost" : "Up"} ${amount} ${unit} since ${since}`;
  const note = start.later && start.weighedOn ? `You had no weigh-in by then, so this is measured from your first one, on ${longDate(start.weighedOn)}.` : null;

  let goalLine: string | null = null;
  let goalReached = false;
  if (goalKg !== null) {
    const losing = start.trendKg >= goalKg;
    const toGoKg = losing ? currentTrendKg - goalKg : goalKg - currentTrendKg;
    const toGo = inUnits(toGoKg, system);
    goalReached = toGo <= 0;
    goalLine = goalReached ? "Goal reached" : `${toGo} ${unit} to go to ${formatWeight(goalKg, system)}`;
  }
  return { kind: "ok", direction, headline, note, goalLine, goalReached };
}

/**
 * The start-day box as a request body for PUT /me/weight-start. Empty clears it (null). Otherwise a real date from
 * `earliest` to `today` (the server checks the same).
 */
export function weightStartBody(text: string, today: string, earliest: string): Built<{ weightStartDate: string | null }> {
  const v = text.trim();
  if (v === "") return { ok: true, body: { weightStartDate: null } };
  if (!isValidLocalDate(v)) return { ok: false, error: "Pick a date." };
  if (v > today) return { ok: false, error: "Pick a day that has already happened." };
  if (v < earliest) return { ok: false, error: `Pick a date after ${longDate(earliest)}.` };
  return { ok: true, body: { weightStartDate: v } };
}
