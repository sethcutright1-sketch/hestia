// The sentences under the weight chart: the trend weight, and when the weekly plan reaches the goal weight (or why
// there is no date). The calorie app's wording, in the person's units, with "Settings > Goals" pointing at this
// app's Food settings (the gear). The date itself comes from the server (`GET /weights/trend` `projection`, the
// maths in nutrition/weightTrend.ts), so the screen and the assistant always agree.

import { longDate } from "./dates.ts";
import type { ProjectionReason, UnitSystem } from "./types.ts";
import { KG_PER_LB, displayWeight, formatWeight, round2, weightUnit } from "./units.ts";

/** "Trend weight: 183.3 lb". */
export const trendLine = (trendKg: number, system: UnitSystem): string => `Trend weight: ${formatWeight(trendKg, system)}`;

export interface ProjectionInput {
  trendKg: number | null;
  goalKg: number | null;
  /** The plan in lb/week as the server stores it: positive = lose, negative = gain, 0 = maintain. */
  planLbPerWeek: number | null;
  projection: { date: string | null; reason: ProjectionReason } | null;
  system: UnitSystem;
}

/** "" with no weigh-in; otherwise one sentence. */
export function projectionText({ trendKg, goalKg, planLbPerWeek, projection, system }: ProjectionInput): string {
  if (trendKg === null) return "";
  if (goalKg === null) return "Set a goal weight in Food settings (the gear) to see when you could reach it.";
  if (projection === null || projection.reason === "no-plan") {
    return "Choose a weekly goal other than 'Maintain weight' in Food settings (the gear) to see a goal date.";
  }
  switch (projection.reason) {
    case "reached":
      return "Your trend weight is at your goal weight.";
    case "wrong-direction":
      return "Your weekly goal moves away from your goal weight. Change one of them in Food settings (the gear).";
    case "too-far":
      return "At this pace your goal weight is more than 5 years away, so no date is shown.";
    case "ok": {
      const plan = Math.abs(planLbPerWeek ?? 0);
      const rate = system === "imperial" ? `${plan} lb/week` : `${round2(plan * KG_PER_LB)} kg/week`;
      return `At ${rate} you'd reach ${displayWeight(goalKg, system)} ${weightUnit(system)} around ${longDate(projection.date!)}.`;
    }
  }
}
