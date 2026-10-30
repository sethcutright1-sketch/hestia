// A person's calorie goals. Goals are append-only: a change is a new row effective from a date,
// so earlier days keep the goal they were lived under (days.ts also freezes each past day's
// calorie budget, because the goal row alone isn't enough once a goal is edited back-dated).
//
// "Budget" everywhere in this file is the daily CALORIE budget (nutrition/calorieBudget.ts),
// not household-app's money Budget section.

import { addDays, mondayOf } from "../dates.ts";
import {
  dailyCalorieBudget, isValidPlan, parseCalorieSchedule,
  type CalorieBudgetProfile, type CalorieSchedule,
} from "../calorieBudget.ts";
import { assertCanTrack, type ProfileRow, type Tracker } from "./access.ts";
import { NutritionError } from "./errors.ts";
import { bodyObject, localDateField, oneOf, optNumber, reqNumber, type Body } from "./input.ts";
import { all, get, run, tx, type Db } from "./sql.ts";
import { weightKgOn } from "./weights.ts";

export type ActivityLevel = "sedentary" | "light" | "moderate" | "very";
export type MinCalorieBudgetMode = "safe" | "low" | "none";
const ACTIVITY_LEVELS = ["sedentary", "light", "moderate", "very"] as const;
const MIN_MODES = ["safe", "low", "none"] as const;

export interface GoalRow {
  id: number;
  user_id: string;
  effective_from: string;
  plan_lb_per_week: number;
  activity_level: ActivityLevel;
  pal_override: number | null;
  min_calorie_budget_mode: MinCalorieBudgetMode;
  calorie_budget_override_kcal: number | null;
  macro_mode: "percent" | "grams";
  macro_protein: number;
  macro_carbs: number;
  macro_fat: number;
  goal_weight_kg: number | null;
  /** JSON { highDays, extraKcal } or null. Read it through goalSchedule(). */
  calorie_schedule: string | null;
}

/** The goal in effect on a date: latest effective_from <= date. Same-day edits: newest row wins. */
export function goalOn(db: Db, userId: string, date: string): GoalRow | undefined {
  return get<GoalRow>(db,
    "SELECT * FROM nutrition_goals WHERE user_id = ? AND effective_from <= ? ORDER BY effective_from DESC, id DESC LIMIT 1",
    userId, date);
}

/** The goal's calorie schedule; a stored value that no longer validates (a hand-edited database) is no schedule. */
export function goalSchedule(goal: Pick<GoalRow, "calorie_schedule">): CalorieSchedule | null {
  if (!goal.calorie_schedule) return null;
  try {
    return parseCalorieSchedule(JSON.parse(goal.calorie_schedule));
  } catch {
    return null;
  }
}

export function calorieBudgetProfile(profile: ProfileRow, goal: GoalRow): CalorieBudgetProfile {
  return {
    sex: profile.sex,
    birthDate: profile.birth_date,
    heightCm: profile.height_cm,
    activityLevel: goal.activity_level,
    palOverride: goal.pal_override,
    planLbPerWeek: goal.plan_lb_per_week,
    minCalorieBudgetMode: goal.min_calorie_budget_mode,
    calorieBudgetOverrideKcal: goal.calorie_budget_override_kcal,
    calorieSchedule: goalSchedule(goal),
  };
}

export const goalJson = (g: GoalRow) => ({
  id: g.id,
  effectiveFrom: g.effective_from,
  planLbPerWeek: g.plan_lb_per_week,
  activityLevel: g.activity_level,
  palOverride: g.pal_override,
  minCalorieBudgetMode: g.min_calorie_budget_mode,
  calorieBudgetOverrideKcal: g.calorie_budget_override_kcal,
  macroMode: g.macro_mode,
  macroProtein: g.macro_protein,
  macroCarbs: g.macro_carbs,
  macroFat: g.macro_fat,
  goalWeightKg: g.goal_weight_kg,
  calorieSchedule: goalSchedule(g),
});

/** The goal in effect today and the whole history, newest first. */
export function listGoals(db: Db, user: Tracker, today: string) {
  const rows = all<GoalRow>(db, "SELECT * FROM nutrition_goals WHERE user_id = ? ORDER BY effective_from DESC, id DESC", user.id);
  const current = goalOn(db, user.id, today);
  return { current: current ? goalJson(current) : null, history: rows.map(goalJson) };
}

const PLAN_MESSAGE = "planLbPerWeek must be one of -2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2.";

/**
 * The calorie schedule in a request: absent = keep `fallback` (the goal in effect), null = none,
 * otherwise validated ({ highDays, extraKcal }). A schedule with no high days is stored as none.
 */
function scheduleField(b: Body, fallback: CalorieSchedule | null): CalorieSchedule | null {
  if (b.calorieSchedule === undefined) return fallback;
  try {
    const s = parseCalorieSchedule(b.calorieSchedule);
    return s && s.highDays.length > 0 ? s : null;
  } catch (e) {
    throw new NutritionError(400, e instanceof RangeError ? e.message : "calorieSchedule is not valid.");
  }
}

/** A calorie budget under this on any day of the week is a typo or a mistake, not a plan (calorieBudgetOverrideKcal has the same floor). */
export const MIN_DAY_CALORIE_BUDGET = 500;

/** The week (Monday first) of calorie budgets a profile would give, for the schedule preview and its sanity check. */
export function weekOfCalorieBudgets(profile: CalorieBudgetProfile, weightKg: number, containing: string) {
  const monday = mondayOf(containing);
  const schedule = profile.calorieSchedule;
  return Array.from({ length: 7 }, (_, i) => {
    const date = addDays(monday, i);
    const d = dailyCalorieBudget(profile, weightKg, date);
    const weekday = (i + 1) % 7; // Monday = 1 ... Sunday = 0
    return { date, weekday, kcal: d.calorieBudget, belowFloor: d.belowFloor, high: !!schedule?.highDays.includes(weekday) };
  });
}

/**
 * Add a goal effective from a date (default: today). Body fields (camelCase):
 *   planLbPerWeek (required), activityLevel (required), macroProtein / macroCarbs / macroFat (required),
 *   macroMode, palOverride, minCalorieBudgetMode, calorieBudgetOverrideKcal, goalWeightKg, calorieSchedule, effectiveFrom.
 * minCalorieBudgetMode and calorieSchedule carry over from the goal in effect when not sent.
 */
export function addGoal(db: Db, user: Tracker, today: string, input: unknown): GoalRow {
  assertCanTrack(user);
  const b = bodyObject(input);
  const effectiveFrom = b.effectiveFrom === undefined ? today : localDateField(b.effectiveFrom, "effectiveFrom");
  const plan = reqNumber(b, "planLbPerWeek");
  if (!isValidPlan(plan)) throw new NutritionError(400, PLAN_MESSAGE);
  const macroMode = oneOf(b.macroMode ?? "percent", "macroMode", ["percent", "grams"] as const);
  const protein = reqNumber(b, "macroProtein", 0), carbs = reqNumber(b, "macroCarbs", 0), fat = reqNumber(b, "macroFat", 0);
  if (macroMode === "percent" && Math.abs(protein + carbs + fat - 100) > 1) {
    throw new NutritionError(400, "Macro percentages must add up to 100.");
  }
  return tx(db, () => {
    const prev = goalOn(db, user.id, effectiveFrom);
    const calorieSchedule = scheduleField(b, prev ? goalSchedule(prev) : null);
    const row = {
      activity_level: oneOf(b.activityLevel, "activityLevel", ACTIVITY_LEVELS),
      pal_override: optNumber(b, "palOverride", 1, 3),
      min_mode: oneOf(b.minCalorieBudgetMode ?? prev?.min_calorie_budget_mode ?? "safe", "minCalorieBudgetMode", MIN_MODES),
      override_kcal: optNumber(b, "calorieBudgetOverrideKcal", 500, 10000),
      goal_weight_kg: optNumber(b, "goalWeightKg", 20, 500),
    };
    // With a weight and a profile on file, refuse a schedule that would starve some day outright.
    // (The per-day minimum-calorie WARNING is separate and never blocks.)
    const weight = weightKgOn(db, user.id, effectiveFrom);
    if (calorieSchedule && weight !== null && user.profile) {
      const profile: CalorieBudgetProfile = {
        sex: user.profile.sex, birthDate: user.profile.birth_date, heightCm: user.profile.height_cm,
        activityLevel: row.activity_level, palOverride: row.pal_override, planLbPerWeek: plan,
        minCalorieBudgetMode: row.min_mode, calorieBudgetOverrideKcal: row.override_kcal, calorieSchedule,
      };
      const lowest = Math.min(...weekOfCalorieBudgets(profile, weight, effectiveFrom).map((d) => d.kcal));
      if (lowest < MIN_DAY_CALORIE_BUDGET) {
        throw new NutritionError(400, `That calorie schedule would leave some days at ${Math.round(lowest)} calories. Lower the extra calories or use fewer high days.`);
      }
    }
    run(db,
      `INSERT INTO nutrition_goals (user_id, effective_from, plan_lb_per_week, activity_level, pal_override, min_calorie_budget_mode,
         calorie_budget_override_kcal, macro_mode, macro_protein, macro_carbs, macro_fat, goal_weight_kg, calorie_schedule)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      user.id, effectiveFrom, plan, row.activity_level, row.pal_override, row.min_mode,
      row.override_kcal, macroMode, protein, carbs, fat, row.goal_weight_kg, calorieSchedule ? JSON.stringify(calorieSchedule) : null);
    return goalOn(db, user.id, effectiveFrom)!;
  });
}

/**
 * What a set of calorie-budget goal fields would give each weekday, WITHOUT saving anything:
 * the Settings screen's calorie-schedule preview. Unsent fields default to the goal in effect
 * today, so the preview follows what is typed in the form, and the numbers come from the same
 * code as the diary.
 */
export function previewCalorieBudgets(db: Db, user: Tracker, today: string, input: unknown) {
  const b = bodyObject(input);
  const cur = goalOn(db, user.id, today);
  const plan = b.planLbPerWeek === undefined ? cur?.plan_lb_per_week ?? 0 : reqNumber(b, "planLbPerWeek");
  if (!isValidPlan(plan)) throw new NutritionError(400, PLAN_MESSAGE);
  const activityLevel = b.activityLevel === undefined ? cur?.activity_level ?? "light" : oneOf(b.activityLevel, "activityLevel", ACTIVITY_LEVELS);
  const palOverride = b.palOverride === undefined ? cur?.pal_override ?? null : optNumber(b, "palOverride", 1, 3);
  const minMode = b.minCalorieBudgetMode === undefined ? cur?.min_calorie_budget_mode ?? "safe" : oneOf(b.minCalorieBudgetMode, "minCalorieBudgetMode", MIN_MODES);
  const overrideKcal = b.calorieBudgetOverrideKcal === undefined ? cur?.calorie_budget_override_kcal ?? null : optNumber(b, "calorieBudgetOverrideKcal", 500, 10000);
  const calorieSchedule = scheduleField(b, cur ? goalSchedule(cur) : null);

  const weight = weightKgOn(db, user.id, today);
  const missing: Array<"profile" | "weight"> = [];
  if (!user.profile) missing.push("profile");
  if (weight === null) missing.push("weight");
  if (missing.length > 0 || !user.profile || weight === null) return { days: null, baseKcal: null, missing };

  const profile: CalorieBudgetProfile = {
    sex: user.profile.sex, birthDate: user.profile.birth_date, heightCm: user.profile.height_cm,
    activityLevel, palOverride, planLbPerWeek: plan, minCalorieBudgetMode: minMode, calorieBudgetOverrideKcal: overrideKcal, calorieSchedule,
  };
  const base = dailyCalorieBudget({ ...profile, calorieSchedule: null }, weight, today).calorieBudget;
  return { baseKcal: base, days: weekOfCalorieBudgets(profile, weight, today), missing: [] as Array<"profile" | "weight"> };
}
