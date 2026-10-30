// Shapes of the /api/nutrition/* answers the Food section reads. They mirror the server's
// *Json functions (nutrition/data/foods.ts, diary.ts, days.ts, mealItems.ts, savedMeals.ts,
// exercise.ts, pantryUse.ts); "calorie budget" is the only budget in any of them.

import type { Nutrients } from "../../api.ts";
import type { WeightRange } from "./weightRange.ts";

export type { Nutrients };

export type Basis = "per100g" | "per_serving";
/** "generic" = the shared, read-only USDA catalogue. */
export type FoodScope = "joint" | "personal" | "generic";

export interface FoodServing {
  id: string;
  label: string;
  grams: number | null;
  isDefault: boolean;
}

export interface Food {
  id: string;
  name: string;
  brand: string | null;
  gtin14: string | null;
  basis: Basis;
  nutrients: Nutrients;
  source: string;
  sourceRef: string | null;
  /** Set on a recipe's read-only food. */
  recipeId: string | null;
  scope: FoodScope;
  ownerUserId: string | null;
  createdByUserId: string | null;
  usageCount: number;
  lastUsedAt: string | null;
  servings: FoodServing[];
}

/** The fields of a diary add / bulk item that log the same thing again. */
export interface Amount {
  foodId?: string;
  quantity?: number;
  servingId?: string;
  grams?: number;
}

export interface DiaryEntry {
  id: string;
  localDate: string;
  slotKey: string;
  status: "logged" | "planned";
  foodId: string | null;
  isQuickAdd: boolean;
  name: string;
  quantity: number;
  unit: string;
  grams: number | null;
  nutrients: Nutrients;
  /** "plan" = made by the household meal plan. */
  source: string;
  groupId: string | null;
  mealPlanId: string | null;
  planSlotKey: string | null;
  pantryUsed: boolean;
  loggedAt: string;
  updatedAt: string;
  /** The amount that logs it again; null for a quick add or a food that is gone. */
  relog: (Amount & { foodId: string }) | null;
}

export interface DaySlot {
  key: string;
  label: string;
  /** false = switched off, kept only because it still holds entries. */
  enabled: boolean;
  entries: DiaryEntry[];
  /** kcal LOGGED in this meal. */
  kcal: number;
  targetKcal: number | null;
  targetPct: number | null;
}

export interface MacroProgress {
  eaten: number;
  goal: number | null;
}

export interface DaySummary {
  date: string;
  calorieBudget: number | null;
  maintenance: number | null;
  belowFloor: boolean;
  missing: Array<"profile" | "goal" | "weight">;
  eaten: number;
  exercise: number;
  exerciseExcluded: number;
  remaining: number | null;
  macros: { protein: MacroProgress; carbs: MacroProgress; fat: MacroProgress };
  nutrients: Nutrients;
  perSlot: Record<string, number>;
  plannedKcal: number;
  plannedCount: number;
  doneLoggingAt: string | null;
}

export interface DayResponse {
  date: string;
  slots: DaySlot[];
  summary: DaySummary;
}

export interface Streak {
  current: number;
  best: number;
  countedToday: boolean;
}

export interface StreakResponse extends Streak {
  /** The person's own local date, from the server (their timezone, not the browser's). */
  today: string;
}

/** A meal as a list of food amounts: a saved meal's items, or a previous meal's. */
export interface MealItem {
  foodId: string | null;
  name: string;
  quantity: number;
  servingId: string | null;
  grams: number | null;
  unit: string;
  totalGrams: number | null;
  nutrients: Nutrients;
  kcal: number;
  isQuickAdd: boolean;
  /** false: the food is gone or someone else's personal food; shown but not loggable. */
  available: boolean;
}

export interface SavedMeal {
  id: string;
  name: string;
  scope: "joint" | "personal";
  mine: boolean;
  defaultSlotKey: string | null;
  kcal: number;
  items: MealItem[];
}

export interface PreviousMeal {
  key: string;
  date: string;
  slotKey: string;
  slotLabel: string;
  kcal: number;
  items: MealItem[];
  quickAddCount: number;
  unavailableCount: number;
}

export interface RecipeListItem {
  id: string;
  name: string;
  scope: "joint" | "personal";
  mine: boolean;
  yieldServings: number | null;
  kcalPerServing: number | null;
  foodId: string | null;
  lineCount: number;
}

/** POST /recipes (Save as recipe): the new recipe in the detail shape, trimmed to what the diary reads. */
export interface RecipeCreated {
  id: string;
  name: string;
  scope: "joint" | "personal";
  yieldServings: number | null;
  kcalPerServing: number | null;
  lines: Array<{ text: string; foodName: string | null }>;
}

export interface Exercise {
  id: string;
  localDate: string;
  name: string;
  kcal: number;
  minutes: number | null;
  excludeFromBudget: boolean;
}

export interface PantrySuggestion {
  pantryItemId: string;
  name: string;
  stock: number | null;
  countable: boolean;
  suggested: number;
  lines: string[];
}

export interface PantrySuggestions {
  entryId: string;
  recipeName: string;
  status: "logged" | "planned";
  alreadyUsed: boolean;
  items: PantrySuggestion[];
  unmatchedLines: number;
}

/** What the lookup cascade learned about a code nobody had nutrition for (maybe just a name). */
export interface BarcodeLookupInfo {
  name: string | null;
  brand: string | null;
  source: string | null;
}

// ---- profile, goals, meals and settings (Food settings) ---------------------------------------

export type UnitSystem = "imperial" | "metric";
export type Sex = "male" | "female";
export type ActivityLevel = "sedentary" | "light" | "moderate" | "very";
export type MinCalorieBudgetMode = "safe" | "low" | "none";

/** GET /me/profile. `sex`, `birthDate` and `heightCm` are null until the first save. */
export interface Profile {
  id: string;
  name: string;
  role: string;
  hasProfile: boolean;
  sex: Sex | null;
  birthDate: string | null;
  heightCm: number | null;
  timezone: string;
  unitSystem: UnitSystem;
}

export interface CalorieSchedule {
  /** 0 = Sunday ... 6 = Saturday, as the server counts them. */
  highDays: number[];
  extraKcal: number;
}

export interface Goal {
  id: number;
  effectiveFrom: string;
  planLbPerWeek: number;
  activityLevel: ActivityLevel;
  palOverride: number | null;
  minCalorieBudgetMode: MinCalorieBudgetMode;
  calorieBudgetOverrideKcal: number | null;
  macroMode: "percent" | "grams";
  macroProtein: number;
  macroCarbs: number;
  macroFat: number;
  goalWeightKg: number | null;
  calorieSchedule: CalorieSchedule | null;
}

export interface GoalsResponse {
  current: Goal | null;
  history: Goal[];
}

export interface SchedulePreviewDay {
  date: string;
  /** 0 = Sunday ... 6 = Saturday. */
  weekday: number;
  kcal: number;
  belowFloor: boolean;
  high: boolean;
}

/** POST /me/goals/preview: `days` is null (with `missing`) while there is no profile or weigh-in to work from. */
export interface SchedulePreview {
  baseKcal: number | null;
  days: SchedulePreviewDay[] | null;
  missing: Array<"profile" | "weight">;
}

/** GET /me/slots: a meal as settings show it (switched-off ones too). */
export interface SettingsSlot {
  key: string;
  label: string;
  sort: number;
  enabled: boolean;
  targetKcal: number | null;
  targetPct: number | null;
  custom: boolean;
}

export interface SnackAllowance {
  snackAllowancePct: number;
  defaultPct: number;
  min: number;
  max: number;
}

// ---- weight, steps, photos --------------------------------------------------------------------

export interface Weight {
  id: string;
  measuredOn: string;
  weightKg: number;
  source: string;
}

export interface TrendPoint {
  date: string;
  weightKg: number;
  trendKg: number;
}

export type ProjectionReason = "ok" | "no-plan" | "reached" | "wrong-direction" | "too-far";

/** The person's "I started on" day with the trend weight there (GET /weights/trend?range=). */
export interface WeightStart {
  date: string;
  /** The trend at the latest weigh-in on or before `date`; null when there are no weigh-ins at all. */
  trendKg: number | null;
  /** The weigh-in day that trend belongs to. */
  weighedOn: string | null;
  /** True when nothing was weighed on or before `date`, so `weighedOn` is the first weigh-in after it. */
  later: boolean;
}

/** GET /weights/trend (with `range=`, the points cover that range and `weightStart` is there; null = no start day set). */
export interface WeightTrend {
  points: TrendPoint[];
  trendKg: number | null;
  goalKg: number | null;
  planLbPerWeek: number | null;
  projection: { date: string | null; reason: ProjectionReason } | null;
  range?: WeightRange;
  /** The first day the points cover; null for All. */
  from?: string | null;
  weightStart?: WeightStart | null;
}

/** GET/PUT /me/weight-start. */
export interface WeightStartSetting {
  weightStartDate: string | null;
  /** The person's today: the date box stops there. */
  today: string;
  earliest: string;
}

export interface StepsDay {
  date: string;
  steps: number;
  source: string;
}

export interface Photo {
  id: string;
  takenOn: string;
  mime: string;
  width: number;
  height: number;
  source: string;
  size: number;
  createdAt: string;
}

// ---- who sees what ----------------------------------------------------------------------------

export type Visibility = "nothing" | "totals" | "everything";
/** What another login can be given: a person only appears in the switcher at one of these. */
export type SharedLevel = "totals" | "everything";

export interface VisibilitySetting {
  visibility: Visibility;
  defaultVisibility: Visibility;
  levels: Visibility[];
}

/** GET /sharing: another diary login that shares something with me. */
export interface Sharer {
  userId: string;
  name: string;
  level: SharedLevel;
}

export interface SharedPerson {
  userId: string;
  name: string;
  level: SharedLevel;
}

export interface SharedTotals {
  date: string;
  calorieBudget: number | null;
  eaten: number;
  exercise: number;
  remaining: number | null;
}

export interface SharedEntry {
  id: string;
  slotKey: string;
  status: "logged" | "planned";
  name: string;
  quantity: number;
  unit: string;
  nutrients: Nutrients;
  fromPlan: boolean;
}

export interface SharedSlot {
  key: string;
  label: string;
  kcal: number;
  entries: SharedEntry[];
}

export interface SharedExercise {
  name: string;
  kcal: number;
  minutes: number | null;
  excludeFromBudget: boolean;
}

/** GET /people/:id/day/:date. `slots`, `exercise` and the macros come only at "everything". */
export interface SharedDay {
  person: SharedPerson;
  date: string;
  /** The OWNER's own local date. */
  today: string;
  streak: Streak;
  summary: SharedTotals & { macros?: { protein: MacroProgress; carbs: MacroProgress; fat: MacroProgress } };
  slots?: SharedSlot[];
  exercise?: SharedExercise[];
}

/** GET /people/:id/progress ("everything" only). */
export interface SharedProgress {
  person: SharedPerson;
  today: string;
  weights: Array<{ date: string; weightKg: number }>;
  trend: { points: TrendPoint[]; trendKg: number | null };
  steps: Array<{ date: string; steps: number }>;
}

// ---- admin ------------------------------------------------------------------------------------

export type KioskFoodAccess = "hidden" | "plan_only" | "plan_and_quick_log";

export interface KioskFoodSetting {
  kioskAccess: KioskFoodAccess;
  options: KioskFoodAccess[];
}

/** GET /barcodes/misses: a scan that ended without nutrition. */
export interface BarcodeMiss {
  gtin14: string;
  code: string;
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
  name: string | null;
  brand: string | null;
  /** A food you can use now carries this code. */
  resolved: boolean;
  foodId: string | null;
  foodName: string | null;
}
