// Calibration: how active does Lose It! think you are, and what would matching it do?
//
// Lose It!'s budget formula is unpublished but each day's Budget cals is in the export. This app's calorie budget
// is  BMR x PAL - deficit,  so the multiplier Lose It! effectively used is
//
//     PAL = (Budget cals + deficit) / BMR
//
// with BMR from the same Mifflin-St Jeor this app uses (the person's profile here, their weight on that day) and
// the deficit from the weekly plan in effect that day. The median over the last 30 usable days shrugs off a few
// odd days.
//
// This is a COMPARISON, never a change: calibrate() only reads. It says "Lose It! gave you about X a day; the app
// gives you Y (and would give Z with the matched multiplier)". Changing anything is the separate, explicit
// applyCalibration(), which adds a NEW goal row effective today (goals are append-only, so earlier days keep the
// goal they were lived under). It quietly assumes your plan in this app matches the plan you had in Lose It!,
// which is why it is a button and not automatic.

import { ageOn, dailyCalorieBudget, dailyDeficit, mifflinStJeor, ACTIVITY_MULTIPLIER } from "../calorieBudget.ts";
import { assertCanTrack, type Tracker } from "../data/access.ts";
import { NutritionError } from "../data/errors.ts";
import { addGoal, calorieBudgetProfile, goalOn, type GoalRow } from "../data/goals.ts";
import type { Db } from "../data/sql.ts";
import { weightKgOn } from "../data/weights.ts";
import type { SummaryRow } from "./loseitParse.ts";
import type { CalibrationReport } from "./types.ts";

const DAYS_USED = 30;
// pal_override is validated to 1-3 by the goals route; stay inside it.
export const PAL_MIN = 1;
export const PAL_MAX = 3;

const round3 = (n: number) => Math.round(n * 1000) / 1000;

export function calibrate(
  db: Db,
  user: Tracker,
  summary: SummaryRow[] | null,
  o: { today: string; inWindow(date: string): boolean; applyRequested?: boolean },
): CalibrationReport {
  const base = { needsProfile: false, daysUsed: 0, goalHasOwnBudget: false, canApply: false, applyRequested: o.applyRequested ?? false, applied: false };
  const skipped = (reason: string, extra: Partial<CalibrationReport> = {}): CalibrationReport => ({ ...base, ...extra, status: "skipped", reason });
  if (!summary) return skipped("the export has no usable daily-calorie-summary.csv");
  if (!user.profile) {
    return skipped("The comparison needs your profile first (sex, birth date and height): fill it in under Profile in Food settings, then compare again.", { needsProfile: true });
  }
  const profile = user.profile;
  const todayGoal = goalOn(db, user.id, o.today);
  if (!todayGoal) return skipped("no calorie goal is set in this app yet (Calorie goals in Food settings)");

  const recent = summary
    .filter((s) => o.inWindow(s.date) && s.date <= o.today && s.budgetCals !== null && s.budgetCals > 0)
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  const pals: number[] = [];
  const loseIt: number[] = [];
  const appNow: number[] = [];
  const dayInfo: Array<{ date: string; weightKg: number; goal: GoalRow }> = [];
  for (const s of recent) {
    if (pals.length >= DAYS_USED) break;
    const weightKg = weightKgOn(db, user.id, s.date);
    const goal = goalOn(db, user.id, s.date);
    if (weightKg === null || !goal) continue;
    let deficit: number;
    try { deficit = dailyDeficit(goal.plan_lb_per_week); } catch { continue; }
    const bmr = mifflinStJeor({ sex: profile.sex, weightKg, heightCm: profile.height_cm, ageYears: ageOn(profile.birth_date, s.date) });
    if (!(bmr > 0)) continue;
    pals.push((s.budgetCals! + deficit) / bmr);
    loseIt.push(s.budgetCals!);
    appNow.push(dailyCalorieBudget(calorieBudgetProfile(profile, goal), weightKg, s.date).calorieBudget);
    dayInfo.push({ date: s.date, weightKg, goal });
  }
  if (pals.length === 0) return skipped("no day has both a Lose It! calorie budget and a weight");

  const sorted = [...pals].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median = round3(sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2);
  const avg = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
  // What the same days would have been with the matched multiplier: the goal as it was, only the multiplier changed.
  const matched = dayInfo.map((d) => dailyCalorieBudget({ ...calorieBudgetProfile(profile, d.goal), palOverride: median }, d.weightKg, d.date).calorieBudget);

  const goalHasOwnBudget = todayGoal.calorie_budget_override_kcal !== null;
  const outside = median < PAL_MIN || median > PAL_MAX;
  const report: CalibrationReport = {
    ...base, status: "computed", daysUsed: pals.length, median, min: round3(sorted[0]), max: round3(sorted[sorted.length - 1]),
    loseItAvgKcal: avg(loseIt), appAvgKcal: avg(appNow), matchedAvgKcal: avg(matched), goalHasOwnBudget,
    canApply: !outside && !goalHasOwnBudget,
  };
  if (outside) {
    report.reason = `The matching multiplier would be ${median}, outside ${PAL_MIN}-${PAL_MAX}, so something else is off (weight unit? birth date? height?). It can't be applied.`;
  } else if (goalHasOwnBudget) {
    report.reason = "Your current goal uses a calorie budget of your own, which no activity multiplier can change. Clear it in Calorie goals first.";
  }
  return report;
}

/** The activity multiplier the goal in effect uses today (its override, else its activity level). */
export const palOf = (goal: Pick<GoalRow, "pal_override" | "activity_level">): number => goal.pal_override ?? ACTIVITY_MULTIPLIER[goal.activity_level];

/**
 * Adds a NEW goal row effective today that copies the goal in effect and sets its activity multiplier (palOverride).
 * Goals are append-only: yesterday keeps the goal it was lived under. Refused (with the reason) when there is no
 * profile or goal, the number is outside 1-3, or the current goal has a calorie budget of its own.
 */
export function applyCalibration(db: Db, user: Tracker, today: string, pal: unknown): GoalRow {
  assertCanTrack(user);
  if (typeof pal !== "number" || !Number.isFinite(pal)) throw new NutritionError(400, "palOverride must be a number.");
  const value = round3(pal);
  if (value < PAL_MIN || value > PAL_MAX) throw new NutritionError(400, `palOverride must be between ${PAL_MIN} and ${PAL_MAX}.`);
  if (!user.profile) throw new NutritionError(409, "Fill in your profile (sex, birth date and height) first.");
  const goal = goalOn(db, user.id, today);
  if (!goal) throw new NutritionError(409, "No calorie goal is in effect today.");
  if (goal.calorie_budget_override_kcal !== null) {
    throw new NutritionError(409, "Your current goal uses a calorie budget of your own, which no activity multiplier can change. Clear it in Calorie goals first.");
  }
  return addGoal(db, user, today, {
    effectiveFrom: today,
    planLbPerWeek: goal.plan_lb_per_week,
    activityLevel: goal.activity_level,
    palOverride: value,
    minCalorieBudgetMode: goal.min_calorie_budget_mode,
    calorieBudgetOverrideKcal: goal.calorie_budget_override_kcal,
    macroMode: goal.macro_mode,
    macroProtein: goal.macro_protein,
    macroCarbs: goal.macro_carbs,
    macroFat: goal.macro_fat,
    goalWeightKg: goal.goal_weight_kg,
  });
}
