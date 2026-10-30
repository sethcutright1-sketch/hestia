// Typed readers for the files in a Lose It! export.
//
// The layouts below were checked against a real full-account export (food-logs, exercise-logs, weights,
// daily-calorie-summary, daily-values, steps, progress-photos, custom-foods, profile). Every column is still
// found through an alias list, anything that doesn't fit is reported (never guessed), and the file
// inventory says exactly which files were understood, which were skipped on purpose (and why), and which the
// importer should have read but couldn't.
//
// Facts about the real export that the readers rely on (and that tests with synthetic files pin down):
//   - dates are M/D/YYYY; the progress photo FILE names use ISO dates;
//   - the `Deleted` flag is 1/0 in food-logs.csv and exercise-logs.csv but true/false in weights.csv;
//   - exercise-logs.csv stores calories BURNED as a NEGATIVE number (-172.53); zero-calorie rows are real;
//     its Quantity/Units columns hold the minutes ("30", "minutes");
//   - profile.csv is Name|Value with bare numbers and no weight unit;
//   - daily-values.csv is Date|Name|Value; Name = Complete is "Done logging" (Value 1 = done, 0 = not done);
//   - nutrients in food-logs.csv and custom-foods.csv are TOTALS for the stated quantity, not per unit.

import { isValidLocalDate } from "../dates.ts";
import { NutritionError } from "../data/errors.ts";
import type { Nutrients } from "../nutrients.ts";
import { cell, parseCsv, resolveColumns, type CsvTable } from "./csv.ts";
import type { ExportFiles } from "./zip.ts";

// ---- value parsers ----------------------------------------------------------------

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/**
 * Normalize a date cell to YYYY-MM-DD, or null if it isn't a real calendar date.
 * Lose It! writes US-style M/D/YYYY; also accepted: MM/DD/YYYY, M/D/YY (-> 20YY), and
 * ISO. A trailing time ("1/5/2026 12:00 AM") is ignored. Day-first dates are not guessed:
 * 13/05/2026 is rejected rather than silently read as May 13.
 */
export function parseDate(raw: string): string | null {
  const s = raw.trim();
  let y: number, m: number, d: number;
  let match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T].*)?$/.exec(s);
  if (match) {
    [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else if ((match = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})(?:[ T].*)?$/.exec(s))) {
    m = Number(match[1]);
    d = Number(match[2]);
    y = match[3].length === 2 ? 2000 + Number(match[3]) : Number(match[3]);
  } else {
    return null;
  }
  const iso = `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
  return isValidLocalDate(iso) ? iso : null;
}

const MAX_ABS = 1e9;
const BLANK = /^(|n\/?a|na|null|none|nan|-+|\?)$/i;
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;

/**
 * A numeric cell: thousands separators are stripped ("1,250" -> 1250); blank and
 * "n/a"-style cells are a legitimate null; anything else that isn't a number is null
 * AND flagged `invalid` so the caller can say so.
 */
export function numberCell(raw: string | undefined): { value: number | null; invalid: boolean } {
  const s = (raw ?? "").trim();
  if (BLANK.test(s)) return { value: null, invalid: false };
  const stripped = s.replace(/,/g, "");
  if (!NUMBER.test(stripped)) return { value: null, invalid: true };
  const value = Number(stripped);
  // Nothing in a food diary is anywhere near a billion: a number that big is a corrupt cell, and would overflow the sums.
  return Number.isFinite(value) && Math.abs(value) <= MAX_ABS ? { value, invalid: false } : { value: null, invalid: true };
}

export const parseNumber = (raw: string | undefined): number | null => numberCell(raw).value;

/**
 * A yes/no flag: true / 1 / yes (any case). Anything else, including a missing column, is "no". This one
 * reader covers every spelling the real export uses: `1`/`0` (food-logs.csv, exercise-logs.csv, daily-values.csv)
 * and `true`/`false` (weights.csv).
 */
export const parseFlag = (raw: string | undefined): boolean => /^(true|1|yes|y|t)$/i.test((raw ?? "").trim());

/** Collects parse problems: keeps a count of all of them but only the first few messages. */
export class IssueLog {
  count = 0;
  messages: string[] = [];
  constructor(private cap = 200) {}
  add(message: string): void {
    this.count++;
    if (this.messages.length < this.cap) this.messages.push(message);
  }
}

// ---- row types ----------------------------------------------------------------------

export type SmallNutrients = Omit<Nutrients, "kcal">;

export interface FoodLogRow {
  /** Record number in the file (header = 1), for messages. */
  row: number;
  date: string;
  name: string;
  /** The meal name exactly as written ("Breakfast", or a renamed one). */
  type: string;
  quantity: number | null;
  units: string;
  /** null = blank or "n/a". */
  calories: number | null;
  deleted: boolean;
  /** TOTALS for the logged quantity, not per unit. Missing values are 0. */
  nutrients: SmallNutrients;
}

export interface SummaryRow {
  date: string;
  foodCals: number | null;
  exerciseCals: number | null;
  budgetCals: number | null;
}

export interface WeightRow {
  date: string;
  /** In whatever unit the account displays; see the importer's unit resolution. */
  value: number;
  deleted: boolean;
}

export interface ExerciseRow {
  row: number;
  date: string;
  name: string;
  /** Calories BURNED, as a positive number (the file stores them negative; see parseExercise). null = blank. */
  calories: number | null;
  /** The duration, when the row's Units say minutes. */
  minutes: number | null;
  deleted: boolean;
}

export interface ProfileEntry {
  key: string;
  value: string;
}

export interface DailyValueRow {
  row: number;
  date: string;
  name: string;
  value: string;
}

export interface StepsRow {
  row: number;
  date: string;
  /** As written (9999.9): the importer rounds to whole steps. */
  steps: number;
}

export interface ProgressPhotoRow {
  row: number;
  date: string;
  /** The 32-character token the picture's file name carries. */
  token: string;
  deleted: boolean;
  visibility: string;
}

export interface CustomFoodRow {
  row: number;
  name: string;
  brand: string;
  /** The measure the nutrition is stated for ("Serving", "Grams", "Fluid ounces"...), with `quantity` of it. */
  measure: string;
  quantity: number | null;
  calories: number | null;
  /** TOTALS for `quantity` x `measure`, like a food-log row. */
  nutrients: SmallNutrients;
}

export interface Parsed<T> {
  recognized: boolean;
  rows: T[];
  /** Required columns that couldn't be found. */
  missing: string[];
}

// ---- food log -------------------------------------------------------------------------

const NUTRIENT_COLUMNS = {
  fat: ["fat (g)", "fat", "total fat"],
  protein: ["protein (g)", "protein"],
  carbs: ["carbohydrates (g)", "carbohydrates", "carbs", "carbohydrate", "total carbohydrate", "total carbs"],
  satFat: ["saturated fat (g)", "saturated fat", "sat fat", "saturated"],
  sugars: ["sugars (g)", "sugars", "sugar", "total sugars"],
  fiber: ["fiber (g)", "fiber", "fibre", "dietary fiber"],
  cholesterolMg: ["cholesterol (mg)", "cholesterol"],
  sodiumMg: ["sodium (mg)", "sodium"],
} as const;

const FOOD_COLUMNS = {
  date: ["date", "day", "date logged"],
  name: ["name", "food name", "food", "item", "description"],
  type: ["meal", "type", "meal type", "mealtype", "meal name"],
  quantity: ["quantity", "qty", "amount"],
  units: ["units", "unit", "serving unit", "measure"],
  calories: ["calories", "calories (kcal)", "kcal", "energy", "cals"],
  deleted: ["deleted", "is deleted"],
  ...NUTRIENT_COLUMNS,
} as const;

const NUTRIENT_FIELDS = ["fat", "protein", "carbs", "satFat", "sugars", "fiber", "cholesterolMg", "sodiumMg"] as const;
const NUTRIENT_LABEL: Record<(typeof NUTRIENT_FIELDS)[number], string> = {
  fat: "Fat", protein: "Protein", carbs: "Carbohydrates", satFat: "Saturated Fat", sugars: "Sugars", fiber: "Fiber",
  cholesterolMg: "Cholesterol", sodiumMg: "Sodium",
};

export function parseFoodLog(table: CsvTable, file: string, issues: IssueLog): Parsed<FoodLogRow> {
  const col = resolveColumns(table.keys, FOOD_COLUMNS);
  const missing = (["date", "name", "calories"] as const).filter((k) => !col[k]);
  if (missing.length) return { recognized: false, rows: [], missing };
  if (!col.type) issues.add(`${file}: no meal column (Meal), so every entry is filed under Snacks`);
  if (!col.quantity || !col.units) issues.add(`${file}: no ${!col.quantity ? "Quantity" : "Units"} column; entries are logged as 1 serving`);
  if (table.raggedRows) issues.add(`${file}: ${table.raggedRows} row(s) have more cells than the header; check for an unquoted comma in a food name`);

  const rows: FoodLogRow[] = [];
  table.rows.forEach((rec, i) => {
    const row = table.rowNumbers[i];
    const where = `${file} row ${row}`;
    const num = (key: string | undefined, label: string): number | null => {
      const { value, invalid } = numberCell(cell(rec, key));
      if (invalid) issues.add(`${where}: unreadable ${label} "${cell(rec, key)}"`);
      return value;
    };

    const date = parseDate(cell(rec, col.date));
    if (!date) {
      issues.add(`${where}: unreadable date "${cell(rec, col.date)}", row skipped`);
      return;
    }
    let name = cell(rec, col.name);
    if (!name) {
      issues.add(`${where}: no food name on ${date}, imported as "Unnamed food"`);
      name = "Unnamed food";
    }
    const nutrients = {} as SmallNutrients;
    for (const f of NUTRIENT_FIELDS) nutrients[f] = num(col[f], NUTRIENT_LABEL[f]) ?? 0;
    rows.push({
      row, date, name,
      type: cell(rec, col.type),
      quantity: col.quantity ? num(col.quantity, "Quantity") : 1,
      units: cell(rec, col.units),
      calories: num(col.calories, "Calories"),
      deleted: parseFlag(cell(rec, col.deleted)),
      nutrients,
    });
  });
  return { recognized: true, rows, missing: [] };
}

// ---- daily calorie summary --------------------------------------------------------------

const SUMMARY_COLUMNS = {
  date: ["date", "day"],
  foodCals: ["food cals", "food calories", "food", "calories eaten", "calories consumed", "calories in"],
  exerciseCals: ["exercise cals", "exercise calories", "exercise", "calories burned", "calories out"],
  budgetCals: ["budget cals", "budget calories", "budget", "calorie budget", "calories budget", "daily budget"],
} as const;

export function parseSummary(table: CsvTable, file: string, issues: IssueLog): Parsed<SummaryRow> {
  const col = resolveColumns(table.keys, SUMMARY_COLUMNS);
  if (!col.date) return { recognized: false, rows: [], missing: ["date"] };
  if (!col.foodCals && !col.exerciseCals && !col.budgetCals) return { recognized: false, rows: [], missing: ["food cals / exercise cals / budget cals"] };

  const byDate = new Map<string, SummaryRow>();
  table.rows.forEach((rec, i) => {
    const date = parseDate(cell(rec, col.date));
    if (!date) {
      issues.add(`${file} row ${table.rowNumbers[i]}: unreadable date "${cell(rec, col.date)}", row skipped`);
      return;
    }
    const n = (key: string | undefined) => numberCell(cell(rec, key)).value;
    if (byDate.has(date)) issues.add(`${file}: more than one row for ${date}; the last one is used`);
    byDate.set(date, { date, foodCals: n(col.foodCals), exerciseCals: n(col.exerciseCals), budgetCals: n(col.budgetCals) });
  });
  return { recognized: true, rows: [...byDate.values()], missing: [] };
}

// ---- weights ------------------------------------------------------------------------------

const WEIGHT_COLUMNS = {
  date: ["date"],
  weight: ["weight", "body weight", "weight (lb)", "weight (lbs)", "weight (kg)", "value"],
  deleted: ["deleted", "is deleted"],
} as const;

/** "Weight (kg)" -> kg. Only trusted when the header itself names a unit. */
function unitFromText(text: string): "lb" | "kg" | null {
  if (/\bkg\b|kilogram|\bmetric\b/i.test(text)) return "kg";
  if (/\blbs?\b|pound|\bimperial\b/i.test(text)) return "lb";
  return null;
}

export interface WeightParse extends Parsed<WeightRow> {
  unitHint: "lb" | "kg" | null;
}

export function parseWeights(table: CsvTable, file: string, issues: IssueLog): WeightParse {
  const col = resolveColumns(table.keys, WEIGHT_COLUMNS);
  const missing = (["date", "weight"] as const).filter((k) => !col[k]);
  if (missing.length) return { recognized: false, rows: [], missing, unitHint: null };
  const header = table.headers[table.keys.indexOf(col.weight!)] ?? "";

  const rows: WeightRow[] = [];
  table.rows.forEach((rec, i) => {
    const where = `${file} row ${table.rowNumbers[i]}`;
    const date = parseDate(cell(rec, col.date));
    if (!date) {
      issues.add(`${where}: unreadable date "${cell(rec, col.date)}", row skipped`);
      return;
    }
    const { value, invalid } = numberCell(cell(rec, col.weight));
    if (value === null) {
      issues.add(`${where}: ${invalid ? `unreadable weight "${cell(rec, col.weight)}"` : "no weight"} on ${date}, row skipped`);
      return;
    }
    rows.push({ date, value, deleted: parseFlag(cell(rec, col.deleted)) });
  });
  return { recognized: true, rows, missing: [], unitHint: unitFromText(header) };
}

// ---- exercise ------------------------------------------------------------------------------

const EXERCISE_COLUMNS = {
  date: ["date", "day"],
  name: ["name", "activity", "exercise", "exercise name", "activity name", "description", "title"],
  calories: ["calories", "calories burned", "cals", "kcal", "burned", "exercise cals"],
  quantity: ["quantity", "minutes", "duration"],
  units: ["units", "unit"],
  deleted: ["deleted", "is deleted"],
} as const;

/**
 * Exercise rows. The real export stores the calories BURNED as a NEGATIVE number (-172.53 for 30 minutes), so
 * the amount is made positive here -- skipping negatives (as the first importer did) loses every real workout.
 * A zero is a real zero-calorie row and stays 0; a positive number (not seen in the real file) is read as the
 * amount burned as it stands. The minutes come from Quantity when Units says minutes.
 */
export function parseExercise(table: CsvTable, file: string, issues: IssueLog): Parsed<ExerciseRow> {
  const col = resolveColumns(table.keys, EXERCISE_COLUMNS);
  const missing = (["date", "name", "calories"] as const).filter((k) => !col[k]);
  if (missing.length) return { recognized: false, rows: [], missing };

  const rows: ExerciseRow[] = [];
  table.rows.forEach((rec, i) => {
    const row = table.rowNumbers[i];
    const date = parseDate(cell(rec, col.date));
    if (!date) {
      issues.add(`${file} row ${row}: unreadable date "${cell(rec, col.date)}", row skipped`);
      return;
    }
    const kcal = numberCell(cell(rec, col.calories));
    if (kcal.invalid) issues.add(`${file} row ${row}: unreadable calories "${cell(rec, col.calories)}"`);
    const units = cell(rec, col.units);
    const quantity = numberCell(cell(rec, col.quantity)).value;
    // The real file says Quantity=30, Units=minutes; a column that is itself called Minutes/Duration is minutes too.
    // Most rows in the real file carry Quantity = -1, which is not a duration (nothing was recorded): minutes stay empty then.
    const quantityIsMinutes = /^min/i.test(units.trim()) || col.quantity === "minutes" || col.quantity === "duration";
    rows.push({
      row, date,
      name: cell(rec, col.name) || "Exercise",
      calories: kcal.value === null ? null : Math.abs(kcal.value),
      minutes: quantityIsMinutes && quantity !== null && quantity >= 0 ? quantity : null,
      deleted: parseFlag(cell(rec, col.deleted)),
    });
  });
  return { recognized: true, rows, missing: [] };
}

// ---- profile (key/value rows) -----------------------------------------------------------------

const PROFILE_COLUMNS = {
  key: ["name", "key", "field", "setting", "property"],
  value: ["value", "setting value"],
} as const;

export function parseProfile(table: CsvTable): Parsed<ProfileEntry> {
  const col = resolveColumns(table.keys, PROFILE_COLUMNS);
  const pair = col.key && col.value ? [col.key, col.value] : table.keys.length === 2 ? [table.keys[0], table.keys[1]] : null;
  if (pair) {
    const rows = table.rows.map((r) => ({ key: cell(r, pair[0]), value: cell(r, pair[1]) })).filter((e) => e.key);
    return { recognized: true, rows, missing: [] };
  }
  // A single wide row (one column per setting) is the other plausible layout.
  if (table.rows.length === 1 && table.keys.length > 2) {
    const rows = table.keys.map((k, i) => ({ key: table.headers[i], value: cell(table.rows[0], k) })).filter((e) => e.key);
    return { recognized: true, rows, missing: [] };
  }
  return { recognized: false, rows: [], missing: ["name / value"] };
}

/**
 * The weight unit a profile says its account uses: any setting whose NAME mentions
 * "unit" and whose VALUE says kg/kilogram/metric or lb/pound/imperial. Settings that
 * mention weight are preferred over other unit settings (distance, energy...). The real profile.csv has
 * no unit setting at all (bare numbers), so this normally finds nothing and the login's own unit setting decides.
 */
export function profileWeightUnit(entries: ProfileEntry[]): { unit: "lb" | "kg"; key: string } | null {
  const units = entries.filter((e) => /unit/i.test(e.key));
  for (const e of [...units.filter((u) => /weight/i.test(u.key)), ...units.filter((u) => !/weight/i.test(u.key))]) {
    const unit = unitFromText(e.value);
    if (unit) return { unit, key: e.key };
  }
  return null;
}

// ---- daily values ("Done logging"), steps, progress photos, custom foods ----------------------

const DAILY_VALUE_COLUMNS = {
  date: ["date", "day"],
  name: ["name", "key", "type"],
  value: ["value"],
} as const;

export function parseDailyValues(table: CsvTable, file: string, issues: IssueLog): Parsed<DailyValueRow> {
  const col = resolveColumns(table.keys, DAILY_VALUE_COLUMNS);
  const missing = (["date", "name"] as const).filter((k) => !col[k]);
  if (missing.length) return { recognized: false, rows: [], missing };
  const rows: DailyValueRow[] = [];
  table.rows.forEach((rec, i) => {
    const row = table.rowNumbers[i];
    const name = cell(rec, col.name);
    const raw = cell(rec, col.date);
    // A RecordedWeightsResetDate row is only noted (its Value is a bare number in the real file), so only a Complete row needs a real date here.
    const date = parseDate(raw);
    if (!date && name.toLowerCase() === "complete") {
      issues.add(`${file} row ${row}: unreadable date "${raw}", row skipped`);
      return;
    }
    rows.push({ row, date: date ?? "", name, value: cell(rec, col.value) });
  });
  return { recognized: true, rows, missing: [] };
}

const STEPS_COLUMNS = {
  date: ["date", "day"],
  steps: ["value", "steps"],
} as const;

export function parseSteps(table: CsvTable, file: string, issues: IssueLog): Parsed<StepsRow> {
  const col = resolveColumns(table.keys, STEPS_COLUMNS);
  const missing = (["date", "steps"] as const).filter((k) => !col[k]);
  if (missing.length) return { recognized: false, rows: [], missing };
  const rows: StepsRow[] = [];
  table.rows.forEach((rec, i) => {
    const where = `${file} row ${table.rowNumbers[i]}`;
    const date = parseDate(cell(rec, col.date));
    if (!date) {
      issues.add(`${where}: unreadable date "${cell(rec, col.date)}", row skipped`);
      return;
    }
    const { value, invalid } = numberCell(cell(rec, col.steps));
    if (value === null) {
      if (invalid) issues.add(`${where}: unreadable steps "${cell(rec, col.steps)}" on ${date}, row skipped`);
      return;
    }
    rows.push({ row: table.rowNumbers[i], date, steps: value });
  });
  return { recognized: true, rows, missing: [] };
}

const PHOTO_COLUMNS = {
  date: ["date", "day"],
  token: ["token", "photo token", "id"],
  deleted: ["deleted", "is deleted"],
  visibility: ["visibility"],
} as const;

export function parseProgressPhotos(table: CsvTable, file: string, issues: IssueLog): Parsed<ProgressPhotoRow> {
  const col = resolveColumns(table.keys, PHOTO_COLUMNS);
  const missing = (["date", "token"] as const).filter((k) => !col[k]);
  if (missing.length) return { recognized: false, rows: [], missing };
  const rows: ProgressPhotoRow[] = [];
  table.rows.forEach((rec, i) => {
    const row = table.rowNumbers[i];
    const date = parseDate(cell(rec, col.date));
    const token = cell(rec, col.token);
    if (!date || !token) {
      issues.add(`${file} row ${row}: ${!date ? `unreadable date "${cell(rec, col.date)}"` : "no token"}, row skipped`);
      return;
    }
    rows.push({ row, date, token, deleted: parseFlag(cell(rec, col.deleted)), visibility: cell(rec, col.visibility) });
  });
  return { recognized: true, rows, missing: [] };
}

const CUSTOM_FOOD_COLUMNS = {
  name: ["name", "food name"],
  brand: ["brand"],
  quantity: ["quantity", "qty"],
  measure: ["measure", "units", "unit"],
  calories: ["calories", "calories (kcal)", "kcal"],
  ...NUTRIENT_COLUMNS,
} as const;

export function parseCustomFoods(table: CsvTable, file: string, issues: IssueLog): Parsed<CustomFoodRow> {
  const col = resolveColumns(table.keys, CUSTOM_FOOD_COLUMNS);
  const missing = (["name", "calories"] as const).filter((k) => !col[k]);
  if (missing.length) return { recognized: false, rows: [], missing };
  const rows: CustomFoodRow[] = [];
  table.rows.forEach((rec, i) => {
    const row = table.rowNumbers[i];
    const where = `${file} row ${row}`;
    const num = (key: string | undefined, label: string): number | null => {
      const { value, invalid } = numberCell(cell(rec, key));
      if (invalid) issues.add(`${where}: unreadable ${label} "${cell(rec, key)}"`);
      return value;
    };
    const name = cell(rec, col.name);
    if (!name) {
      issues.add(`${where}: no food name, row skipped`);
      return;
    }
    const nutrients = {} as SmallNutrients;
    for (const f of NUTRIENT_FIELDS) nutrients[f] = num(col[f], NUTRIENT_LABEL[f]) ?? 0;
    rows.push({
      row, name,
      brand: cell(rec, col.brand),
      measure: cell(rec, col.measure),
      quantity: col.quantity ? num(col.quantity, "Quantity") : 1,
      calories: num(col.calories, "Calories"),
      nutrients,
    });
  });
  return { recognized: true, rows, missing: [] };
}

// ---- the whole export ---------------------------------------------------------------------------------

export type FileKind =
  | "food-log" | "daily-summary" | "weights" | "exercise" | "profile"
  | "daily-values" | "steps" | "progress-photos" | "custom-foods" | "recipes" | "other";

export interface InventoryItem {
  /** Basename as it appears in the archive (lowercase). */
  name: string;
  kind: FileKind;
  /** Data rows (CSV) or lines (other text). */
  rows: number;
  headers: string[];
  /** The importer reads this file and its columns fit. */
  recognized: boolean;
  /**
   * understood = read; skipped = a file the importer deliberately does not use (note says why);
   * not understood = a file it should read but whose columns don't fit (also a warning).
   */
  status: "understood" | "skipped" | "not understood";
  /** What the importer does with it, or why it doesn't. */
  note: string;
  /** profile.csv only: the setting names (values are not listed, they can be personal). */
  settings?: string[];
  /** `--inspect --samples` only: the first data row. */
  sample?: Record<string, string>;
}

export interface ParsedExport {
  foodLogFile: string | null;
  foodLog: FoodLogRow[];
  summary: SummaryRow[] | null;
  weights: WeightParse | null;
  exercise: ExerciseRow[] | null;
  profile: { unit: "lb" | "kg"; key: string } | null;
  dailyValues: DailyValueRow[] | null;
  steps: StepsRow[] | null;
  progressPhotos: ProgressPhotoRow[] | null;
  customFoods: CustomFoodRow[] | null;
  inventory: InventoryItem[];
  issues: IssueLog;
}

const KIND_NAMES: Array<[Exclude<FileKind, "other">, string[]]> = [
  ["food-log", ["food-logs", "food-log", "foodlogs", "foodlog"]],
  ["daily-summary", ["daily-calorie-summary", "daily-calorie-summaries", "daily-summary", "calorie-summary"]],
  ["weights", ["weights", "weight", "weight-logs", "weight-log"]],
  ["exercise", ["exercise-logs", "exercise-log", "exercises", "exercise"]],
  ["profile", ["profile"]],
  ["daily-values", ["daily-values", "daily-value"]],
  ["steps", ["steps"]],
  ["progress-photos", ["progress-photos", "progress-photo"]],
  ["custom-foods", ["custom-foods", "custom-food"]],
  ["recipes", ["recipes", "recipe"]],
];

/** "Food Logs.csv" / "food_logs.csv" -> "food-logs". Archive paths with a folder never match. */
const stemOf = (name: string): string | null =>
  name.includes("/") ? null : name.toLowerCase().replace(/\.[a-z]+$/, "").replace(/[\s_]+/g, "-");

/** Files the importer knowingly leaves alone, with the reason shown to the person. First match wins. */
const SKIPPED: Array<[RegExp, string]> = [
  [/^(sodium|cholesterol)\.csv$/, "skipped on purpose: these are per-day sums of the food log, so importing them would count everything twice"],
  [/fasting/, "skipped on purpose: fasting isn't tracked in this app"],
  [/achievement/, "skipped on purpose: Lose It! badges aren't kept"],
  [/water/, "skipped on purpose: water isn't tracked in this app"],
  [/food-photos/, "skipped on purpose: photos of meals aren't imported"],
  [/focus|course|lab-report|medication/, "skipped on purpose: not tracked in this app"],
  [/note/, "skipped on purpose: notes aren't imported"],
  [/custom-exercises/, "skipped on purpose: custom exercise definitions aren't needed; logged exercise comes from exercise-logs.csv"],
  [/active-food-servings/, "skipped on purpose: extra serving sizes aren't imported; each food keeps the unit it was logged in"],
  [/\((g|mg|kcal)\)|goal/, "skipped on purpose: nutrient goals aren't imported; set yours in Food settings"],
];

export function parseExport(files: ExportFiles, opts: { requireFoodLog?: boolean } = {}): ParsedExport {
  const requireFoodLog = opts.requireFoodLog ?? true;
  const issues = new IssueLog();
  const names = [...files.keys()].sort();
  const tables = new Map<string, CsvTable | null>(names.map((n) => [n, n.endsWith(".csv") ? parseCsv(files.get(n)!) : null]));

  // Which file plays which role: the file with the most canonical name wins its role
  // (food-logs.csv before food-log.csv), and a CSV is the only kind of file that can.
  const roles = new Map<string, FileKind>();
  const taken = new Set<FileKind>();
  for (const [kind, stems] of KIND_NAMES) {
    for (const stem of stems) {
      const name = names.find((n) => stemOf(n) === stem && tables.get(n));
      if (name && !roles.has(name)) { roles.set(name, kind); taken.add(kind); break; }
    }
  }
  // No food-logs.csv by name (the older weekly export may be called anything): accept the
  // one CSV whose headers read like a food log.
  if (!taken.has("food-log")) {
    const looksLike = names.filter((n) => {
      const t = tables.get(n);
      if (!t || roles.has(n)) return false;
      const c = resolveColumns(t.keys, FOOD_COLUMNS);
      return !!(c.date && c.name && c.calories && (c.type || c.units));
    });
    if (looksLike.length === 1) { roles.set(looksLike[0], "food-log"); taken.add("food-log"); }
  }

  let foodLogFile: string | null = null;
  let foodLog: FoodLogRow[] = [];
  let summary: SummaryRow[] | null = null;
  let weights: WeightParse | null = null;
  let exercise: ExerciseRow[] | null = null;
  let profile: ParsedExport["profile"] = null;
  let dailyValues: DailyValueRow[] | null = null;
  let steps: StepsRow[] | null = null;
  let progressPhotos: ProgressPhotoRow[] | null = null;
  let customFoods: CustomFoodRow[] | null = null;
  const inventory: InventoryItem[] = [];

  for (const name of names) {
    const table = tables.get(name) ?? null;
    const kind = roles.get(name) ?? "other";
    const item: InventoryItem = {
      name, kind, headers: table?.headers ?? [], rows: table ? table.rows.length : files.get(name)!.split(/\r\n|\r|\n/).filter(Boolean).length,
      recognized: false, status: "not understood", note: "",
    };
    const understood = (recognized: boolean, ok: string, bad: string) => {
      item.recognized = recognized;
      item.status = recognized ? "understood" : "not understood";
      item.note = recognized ? ok : bad;
    };

    if (!table) {
      item.status = "skipped";
      item.note = "skipped: not a CSV";
    } else if (kind === "other") {
      item.status = "skipped";
      item.note = SKIPPED.find(([re]) => re.test(name))?.[1] ?? "skipped: an unrecognised file";
    } else if (kind === "recipes") {
      item.status = "skipped";
      item.note = "skipped by choice: recipes aren't imported (they have totals only, no ingredients)";
    } else if (kind === "food-log") {
      const p = parseFoodLog(table, name, issues);
      understood(p.recognized, "diary entries and the food library", `missing column(s): ${p.missing.join(", ")}`);
      if (p.recognized) { foodLogFile = name; foodLog = p.rows; }
      else if (requireFoodLog) {
        throw new NutritionError(400, `${name} doesn't have the columns this importer needs (Date, Name, Calories). Found: ${table.headers.join(", ") || "(no header row)"}.`);
      }
    } else if (kind === "daily-summary") {
      const p = parseSummary(table, name, issues);
      understood(p.recognized, "daily calorie budgets (and exercise when there is no exercise log)", `missing column(s): ${p.missing.join(", ")}`);
      if (p.recognized) summary = p.rows;
    } else if (kind === "weights") {
      const p = parseWeights(table, name, issues);
      understood(p.recognized, "weigh-ins", `missing column(s): ${p.missing.join(", ")}`);
      if (p.recognized) weights = p;
    } else if (kind === "exercise") {
      const p = parseExercise(table, name, issues);
      understood(p.recognized, "exercise entries",
        "columns not recognized (need a date, an activity name and calories); exercise comes from the daily summary instead");
      if (p.recognized) exercise = p.rows;
    } else if (kind === "profile") {
      const p = parseProfile(table);
      understood(p.recognized, "read for a weight unit only (your profile in this app is not changed)", "layout not recognized");
      if (p.recognized) {
        profile = profileWeightUnit(p.rows);
        item.settings = p.rows.map((e) => e.key);
      }
    } else if (kind === "daily-values") {
      const p = parseDailyValues(table, name, issues);
      understood(p.recognized, "\"Done logging\" days (Complete) and the weight reset date", `missing column(s): ${p.missing.join(", ")}`);
      if (p.recognized) dailyValues = p.rows;
    } else if (kind === "steps") {
      const p = parseSteps(table, name, issues);
      understood(p.recognized, "step history (days you typed yourself are never overwritten)", `missing column(s): ${p.missing.join(", ")}`);
      if (p.recognized) steps = p.rows;
    } else if (kind === "progress-photos") {
      const p = parseProgressPhotos(table, name, issues);
      understood(p.recognized, "progress photos (private to you, kept exactly as they are)", `missing column(s): ${p.missing.join(", ")}`);
      if (p.recognized) progressPhotos = p.rows;
    } else if (kind === "custom-foods") {
      const p = parseCustomFoods(table, name, issues);
      understood(p.recognized, "your custom foods", `missing column(s): ${p.missing.join(", ")}`);
      if (p.recognized) customFoods = p.rows;
    }
    inventory.push(item);
  }

  if (requireFoodLog && !foodLogFile) {
    throw new NutritionError(400, `No food-logs.csv found in the export. Files seen: ${names.join(", ") || "(none)"}.`);
  }
  return { foodLogFile, foodLog, summary, weights, exercise, profile, dailyValues, steps, progressPhotos, customFoods, inventory, issues };
}

/** The file inventory alone (CLI `--inspect`): works on any file set, needs no food log and no database. */
export function inventoryOf(files: ExportFiles, opts: { samples?: boolean } = {}): InventoryItem[] {
  const { inventory } = parseExport(files, { requireFoodLog: false });
  if (opts.samples) {
    for (const item of inventory) {
      const t = item.name.endsWith(".csv") ? parseCsv(files.get(item.name)!) : null;
      const first = t?.rows[0];
      if (t && first) item.sample = Object.fromEntries(t.headers.map((h, i) => [h, first[t.keys[i]] ?? ""]));
    }
  }
  return inventory;
}
