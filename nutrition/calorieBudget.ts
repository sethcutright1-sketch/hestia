// Daily CALORIE budget: Mifflin-St Jeor BMR x activity, minus a weekly-loss deficit.
//
// "Budget" in this folder always means calories eaten per day -- never money. The
// household's grocery/spending Budget section (routes/budget.ts, budgetMath.ts) is a
// different thing, which is why every exported name here says "calorie".
//
// Lose It! doesn't publish its exact formula; this reproduces its visible knobs
// (activity level, lb/week plan, Safe/Low/None minimum) with standard published
// numbers. Nothing here is fitted to Lose It!'s output, so expect small differences.

import { dayOfWeek } from "./dates.ts";
import { round2 } from "./nutrients.ts";

export type Sex = "male" | "female";
export type ActivityLevel = "sedentary" | "light" | "moderate" | "very";
export type MinCalorieBudgetMode = "safe" | "low" | "none";

// Lose It! doesn't publish its multipliers; these are the conventional PAL values
// (Harris-Benedict factors). Users who disagree set goal_profile.pal_override.
export const ACTIVITY_MULTIPLIER: Record<ActivityLevel, number> = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  very: 1.725,
};

// Pounds per week. Positive = lose, negative = gain (the mirror of each loss plan).
export const PLAN_LB_PER_WEEK = [-2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2] as const;

// The 3,500 kcal/lb rule. It is known to overestimate real loss over time (the body
// adapts and lean mass is lost too), but it is what Lose It! and every other tracker
// uses, so the plan labels ("1 lb/week") mean what users expect.
export const KCAL_PER_LB = 3500;

// Minimum-calorie-budget warning thresholds. "safe" (1,200 women / 1,500 men) is the widely
// cited floor; "low" and "none" mirror Lose It!'s three settings, but the "low"
// numbers (1,000 / 1,200) are OUR assumption -- Lose It! doesn't document them.
// We only warn, never clamp: the budget the user sees is the budget they computed.
export const CALORIE_BUDGET_FLOOR: Record<MinCalorieBudgetMode, Record<Sex, number> | null> = {
  safe: { female: 1200, male: 1500 },
  low: { female: 1000, male: 1200 },
  none: null,
};

export function isValidPlan(lbPerWeek: number): boolean {
  return (PLAN_LB_PER_WEEK as readonly number[]).includes(lbPerWeek);
}

/** Age in whole years on `onDate` (both "YYYY-MM-DD", local). */
export function ageOn(birthDate: string, onDate: string): number {
  const [by, bm, bd] = birthDate.split("-").map(Number);
  const [y, m, d] = onDate.split("-").map(Number);
  let age = y - by;
  if (m < bm || (m === bm && d < bd)) age -= 1;
  return age;
}

export function mifflinStJeor(p: { sex: Sex; weightKg: number; heightCm: number; ageYears: number }): number {
  const base = 10 * p.weightKg + 6.25 * p.heightCm - 5 * p.ageYears;
  return round2(base + (p.sex === "male" ? 5 : -161));
}

/** Daily kcal removed from maintenance for a plan: 250 per half-pound/week. */
export function dailyDeficit(planLbPerWeek: number): number {
  if (!isValidPlan(planLbPerWeek)) throw new RangeError(`Unsupported plan: ${planLbPerWeek} lb/week`);
  return 250 * (planLbPerWeek / 0.5);
}

// ---- calorie schedule ---------------------------------------------------------------------
//
// Lose It! Premium's "calorie schedule": some weekdays get more calories and the others
// pay for it, so the week still averages the plan. Lose It! doesn't publish its method;
// this one keeps the seven-day TOTAL exactly equal to 7 x the base budget:
//
//   high day = base + extra
//   low day  = base - extra x nHigh / (7 - nHigh)
//
// Everything is done in whole cents, with the rounding remainder of the low days handed out
// one cent at a time starting from the earliest weekday (Sunday = 0), so the week sums to
// 7 x base to the cent rather than "to within a cent".

export interface CalorieSchedule {
  /** 0 = Sunday ... 6 = Saturday, unique, ascending. */
  highDays: number[];
  extraKcal: number;
}

export const MAX_SCHEDULE_EXTRA_KCAL = 1500;
export const MAX_HIGH_DAYS = 6;

/** Validate a schedule from a request or the database. null/undefined = no schedule. Throws RangeError. */
export function parseCalorieSchedule(raw: unknown): CalorieSchedule | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new RangeError("calorieSchedule must be an object like { highDays: [0, 6], extraKcal: 300 }.");
  const { highDays, extraKcal } = raw as { highDays?: unknown; extraKcal?: unknown };
  if (!Array.isArray(highDays) || !highDays.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) {
    throw new RangeError("highDays must be a list of weekdays, 0 (Sunday) to 6 (Saturday).");
  }
  const days = [...new Set(highDays as number[])].sort((a, b) => a - b);
  if (days.length > MAX_HIGH_DAYS) throw new RangeError(`A calorie schedule can have at most ${MAX_HIGH_DAYS} high days.`);
  if (typeof extraKcal !== "number" || !Number.isFinite(extraKcal) || extraKcal < 0 || extraKcal > MAX_SCHEDULE_EXTRA_KCAL) {
    throw new RangeError(`extraKcal must be between 0 and ${MAX_SCHEDULE_EXTRA_KCAL}.`);
  }
  return { highDays: days, extraKcal: round2(extraKcal) };
}

/** True when the schedule changes anything: 0 or 7 high days, or no extra, leave every day at the base. */
export const isActiveSchedule = (s: CalorieSchedule | null | undefined): s is CalorieSchedule =>
  !!s && s.extraKcal > 0 && s.highDays.length > 0 && s.highDays.length < 7;

/** The seven weekday budgets (index 0 = Sunday) for a base budget. Sums to exactly 7 x base (in cents). */
export function scheduledWeek(baseKcal: number, schedule: CalorieSchedule | null | undefined): number[] {
  const baseC = Math.round(baseKcal * 100);
  if (!isActiveSchedule(schedule)) return Array.from({ length: 7 }, () => baseC / 100);
  const high = new Set(schedule.highDays);
  const highC = baseC + Math.round(schedule.extraKcal * 100);
  const lowCount = 7 - high.size;
  const lowTotalC = 7 * baseC - high.size * highC;
  const lowEach = Math.floor(lowTotalC / lowCount);
  let remainder = lowTotalC - lowEach * lowCount; // 0 .. lowCount - 1 spare cents
  return Array.from({ length: 7 }, (_, weekday) => {
    if (high.has(weekday)) return highC / 100;
    const cents = lowEach + (remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder--;
    return cents / 100;
  });
}

/** One date's budget under a schedule (the base itself when there is no schedule). */
export const scheduledCalorieBudget = (baseKcal: number, schedule: CalorieSchedule | null | undefined, date: string): number =>
  scheduledWeek(baseKcal, schedule)[dayOfWeek(date)];

export interface CalorieBudgetProfile {
  sex: Sex;
  birthDate: string;
  heightCm: number;
  activityLevel: ActivityLevel;
  palOverride: number | null;
  planLbPerWeek: number;
  minCalorieBudgetMode: MinCalorieBudgetMode;
  calorieBudgetOverrideKcal: number | null;
  /** Optional so every caller from before the schedule existed keeps working unchanged. */
  calorieSchedule?: CalorieSchedule | null;
}

export interface DailyCalorieBudget {
  bmr: number;
  maintenance: number;
  calorieBudget: number;
  belowFloor: boolean;
}

export function dailyCalorieBudget(profile: CalorieBudgetProfile, weightKg: number, onDate: string): DailyCalorieBudget {
  const bmr = mifflinStJeor({
    sex: profile.sex,
    weightKg,
    heightCm: profile.heightCm,
    ageYears: ageOn(profile.birthDate, onDate),
  });
  const pal = profile.palOverride ?? ACTIVITY_MULTIPLIER[profile.activityLevel];
  const maintenance = bmr * pal;
  // An explicit override wins over the computed number (and over the plan); the calorie
  // schedule then moves this weekday up or down from that base.
  const base = profile.calorieBudgetOverrideKcal ?? maintenance - dailyDeficit(profile.planLbPerWeek);
  const calorieBudget = scheduledCalorieBudget(base, profile.calorieSchedule, onDate);
  // The floor is judged per day, on the number the person sees: a low day can dip under it.
  const floors = CALORIE_BUDGET_FLOOR[profile.minCalorieBudgetMode];
  return {
    bmr,
    maintenance: round2(maintenance),
    calorieBudget,
    belowFloor: floors !== null && calorieBudget < floors[profile.sex],
  };
}

export type MacroSpec =
  | { mode: "percent"; protein: number; carbs: number; fat: number }
  | { mode: "grams"; protein: number; carbs: number; fat: number };

/** Gram targets for a calorie budget. Atwater factors: protein 4, carbs 4, fat 9 kcal/g. */
export function macroGrams(calorieBudgetKcal: number, spec: MacroSpec): { protein: number; carbs: number; fat: number } {
  if (spec.mode === "grams") {
    return { protein: round2(spec.protein), carbs: round2(spec.carbs), fat: round2(spec.fat) };
  }
  return {
    protein: round2((calorieBudgetKcal * spec.protein) / 100 / 4),
    carbs: round2((calorieBudgetKcal * spec.carbs) / 100 / 4),
    fat: round2((calorieBudgetKcal * spec.fat) / 100 / 9),
  };
}
