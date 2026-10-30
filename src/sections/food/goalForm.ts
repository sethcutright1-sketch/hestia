// Food settings > Calorie goals: the form as typed -> the body for POST /me/goals (append-only: a save adds a goal
// effective from today) and for POST /me/goals/preview (the live per-weekday calorie budgets of the calorie
// schedule). "Calorie budget" is the only budget here. Ported from the calorie app's Settings screen; tested in
// tests/foodSettingsForms.test.ts.

import type { Built } from "./forms.ts";
import type { ActivityLevel, CalorieSchedule, Goal, MinCalorieBudgetMode, UnitSystem } from "./types.ts";
import { displayWeight, goalWeightKg, weightUnit } from "./units.ts";

/** Pounds per week as the server counts them: positive = lose, negative = gain. Shown biggest loss first. */
export const PLANS = [2, 1.5, 1, 0.5, 0, -0.5, -1, -1.5, -2] as const;

export const planLabel = (p: number): string => (p === 0 ? "Maintain weight" : `${p > 0 ? "Lose" : "Gain"} ${Math.abs(p)} lb per week`);

export const ACTIVITY_OPTIONS: Array<[ActivityLevel, string]> = [
  ["sedentary", "Sedentary (desk job, little exercise)"],
  ["light", "Lightly active"],
  ["moderate", "Moderately active"],
  ["very", "Very active"],
];

export const MIN_MODE_OPTIONS: Array<[MinCalorieBudgetMode, string]> = [
  ["safe", "Warn below the safe minimum"],
  ["low", "Warn below a lower minimum"],
  ["none", "Don't warn me"],
];

/** Monday first, the household plan's week; the numbers are the server's (0 = Sunday ... 6 = Saturday). */
export const WEEK: Array<[number, string]> = [[1, "Mon"], [2, "Tue"], [3, "Wed"], [4, "Thu"], [5, "Fri"], [6, "Sat"], [0, "Sun"]];
export const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export const DEFAULT_EXTRA_KCAL = 300;
export const MAX_EXTRA_KCAL = 1500;
export const MAX_HIGH_DAYS = 6;

export interface GoalForm {
  plan: number;
  activity: ActivityLevel;
  minMode: MinCalorieBudgetMode;
  protein: string;
  carbs: string;
  fat: string;
  /** "" = automatic. */
  override: string;
  /** In the person's units; "" = no goal weight. */
  goalWeight: string;
  highDays: number[];
  extra: string;
}

export function goalFormFrom(goal: Goal | null, system: UnitSystem): GoalForm {
  return {
    plan: goal?.planLbPerWeek ?? 0,
    activity: goal?.activityLevel ?? "light",
    minMode: goal?.minCalorieBudgetMode ?? "safe",
    protein: String(goal?.macroProtein ?? 20),
    carbs: String(goal?.macroCarbs ?? 50),
    fat: String(goal?.macroFat ?? 30),
    override: goal?.calorieBudgetOverrideKcal != null ? String(goal.calorieBudgetOverrideKcal) : "",
    goalWeight: goal?.goalWeightKg != null ? String(displayWeight(goal.goalWeightKg, system)) : "",
    highDays: goal?.calorieSchedule?.highDays ?? [],
    extra: String(goal?.calorieSchedule?.extraKcal ?? DEFAULT_EXTRA_KCAL),
  };
}

export const macroTotal = (f: Pick<GoalForm, "protein" | "carbs" | "fat">): number =>
  Math.round(Number(f.protein) + Number(f.carbs) + Number(f.fat));

export const toggleDay = (days: number[], day: number): number[] =>
  (days.includes(day) ? days.filter((d) => d !== day) : [...days, day]).sort((a, b) => a - b);

/** What stops the calorie schedule from being saved, or "". No high days = no schedule, which is fine. */
export function scheduleProblem(f: Pick<GoalForm, "highDays" | "extra">): string {
  if (f.highDays.length === 0) return "";
  if (f.highDays.length > MAX_HIGH_DAYS) return `Pick at most ${MAX_HIGH_DAYS} higher-calorie days.`;
  const e = f.extra.trim() === "" ? NaN : Number(f.extra);
  return Number.isFinite(e) && e >= 0 && e <= MAX_EXTRA_KCAL ? "" : `Extra calories must be between 0 and ${MAX_EXTRA_KCAL.toLocaleString("en-US")}.`;
}

/** The schedule to send: null clears it (the server stores "no high days" as none). */
export function scheduleValue(f: Pick<GoalForm, "highDays" | "extra">): CalorieSchedule | null {
  if (f.highDays.length === 0 || scheduleProblem(f) !== "") return null;
  return { highDays: [...f.highDays].sort((a, b) => a - b), extraKcal: Number(f.extra) };
}

const overrideKcal = (text: string): Built<number | null> => {
  if (text.trim() === "") return { ok: true, body: null };
  const n = Number(text);
  return Number.isFinite(n) && n >= 500 && n <= 10_000 ? { ok: true, body: n } : { ok: false, error: "A daily calorie budget of your own must be between 500 and 10,000, or empty for automatic." };
};

/** The fields POST /me/goals/preview needs: what the form says now, saved or not. */
export function previewBody(f: GoalForm): Record<string, unknown> {
  const override = overrideKcal(f.override);
  return {
    planLbPerWeek: f.plan,
    activityLevel: f.activity,
    minCalorieBudgetMode: f.minMode,
    calorieBudgetOverrideKcal: override.ok ? override.body : null,
    calorieSchedule: scheduleValue(f),
  };
}

export interface GoalBody {
  planLbPerWeek: number;
  activityLevel: ActivityLevel;
  minCalorieBudgetMode: MinCalorieBudgetMode;
  macroMode: "percent";
  macroProtein: number;
  macroCarbs: number;
  macroFat: number;
  calorieBudgetOverrideKcal: number | null;
  goalWeightKg: number | null;
  palOverride: number | null;
  calorieSchedule: CalorieSchedule | null;
}

/** `palOverride` is carried over from the goal in effect (the screen has no box for it). */
export function buildGoal(f: GoalForm, system: UnitSystem, palOverride: number | null): Built<GoalBody> {
  const macros = [f.protein, f.carbs, f.fat].map((t) => (t.trim() === "" ? NaN : Number(t)));
  if (macros.some((m) => !Number.isFinite(m) || m < 0 || m > 100)) return { ok: false, error: "Protein, carbs and fat are percentages from 0 to 100." };
  if (macroTotal(f) !== 100) return { ok: false, error: "Protein, carbs and fat percentages must add up to 100." };
  const bad = scheduleProblem(f);
  if (bad) return { ok: false, error: bad };
  const override = overrideKcal(f.override);
  if (!override.ok) return override;
  const weight = goalWeightKg(f.goalWeight, system);
  if (!weight.ok) return weight;
  return {
    ok: true,
    body: {
      planLbPerWeek: f.plan,
      activityLevel: f.activity,
      minCalorieBudgetMode: f.minMode,
      macroMode: "percent",
      macroProtein: macros[0],
      macroCarbs: macros[1],
      macroFat: macros[2],
      calorieBudgetOverrideKcal: override.body,
      goalWeightKg: weight.body,
      palOverride,
      calorieSchedule: scheduleValue(f),
    },
  };
}

/** The line that says what the goal in effect is: "Lose 1 lb per week · Lightly active · goal weight 165 lb · since 2026-10-03". */
export function goalSummary(goal: Goal | null, system: UnitSystem): string {
  if (!goal) return "No goal saved yet.";
  const parts = [planLabel(goal.planLbPerWeek), ACTIVITY_OPTIONS.find(([v]) => v === goal.activityLevel)?.[1]?.replace(/ \(.*\)$/, "") ?? goal.activityLevel];
  if (goal.goalWeightKg != null) parts.push(`goal weight ${displayWeight(goal.goalWeightKg, system)} ${weightUnit(system)}`);
  if (goal.calorieBudgetOverrideKcal != null) parts.push(`${goal.calorieBudgetOverrideKcal.toLocaleString("en-US")} calories a day`);
  const s = goal.calorieSchedule;
  if (s && s.highDays.length > 0 && s.extraKcal > 0) parts.push(`calorie schedule: ${WEEK.filter(([n]) => s.highDays.includes(n)).map(([, l]) => l).join(", ")} +${s.extraKcal}`);
  return parts.join(" · ");
}

/** A saved goal is effective from today (the server's rule), and earlier days keep the budget they had. */
export const SAVED_MESSAGE = "Saved. Today's calorie budget now uses these goals; earlier days keep theirs.";
