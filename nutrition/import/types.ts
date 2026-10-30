// Option and report shapes for the Lose It! importer. The report is plain JSON: the CLI prints it, the API
// returns it and the Food settings card summarizes it, so it carries numbers and short strings only (never
// photo bytes, and food names only inside the first few warnings).

import type { Scope } from "../data/foods.ts";
import type { InventoryItem } from "./loseitParse.ts";

export type ConflictMode = "skip" | "merge" | "replace";
export type WeightUnit = "lb" | "kg";

export interface ImportOptions {
  /** Do everything for real inside the transaction, then roll back: the counts are exactly what a real run would produce. */
  dryRun: boolean;
  /** The person's own local date today. Days before it get their Lose It! calorie budget frozen; today and later are recomputed as usual. */
  today: string;
  /** What to do with a day that already has food logged in this app. Default skip. */
  conflict?: ConflictMode;
  /** Only import this inclusive date window (YYYY-MM-DD). */
  from?: string;
  to?: string;
  /** Unit of weights.csv. Default: a unit the file itself names, else the login's own unit system. */
  weightUnit?: WeightUnit;
  /** Who can see the foods this import creates: "joint" (the household, the default) or "personal" ("Only me"). */
  foodScope?: Scope;
  /**
   * CLI only (`--apply-calibration`): also add a goal row carrying the activity multiplier implied by the Lose It!
   * calorie budgets. The web routes never set it: there it is a separate, explicit action (applyCalibration()).
   */
  applyCalibration?: boolean;
}

export interface ConflictDate {
  date: string;
  /** Live entries LOGGED in this app (anything but an earlier import; planned entries are not counted). */
  nativeEntries: number;
  /** Food rows the export has for that date. */
  importRows: number;
  action: "skipped" | "merged" | "replaced";
}

export interface ReconcileMismatch {
  date: string;
  /** Lose It!'s own `Food cals` for the day. */
  summaryKcal: number;
  /** What the food-log rows add up to. */
  fileKcal: number;
  /** What the diary holds from earlier or this import (null on days that weren't imported). */
  diaryKcal: number | null;
}

export interface CalibrationReport {
  status: "computed" | "skipped";
  /** Why it was skipped, or why a requested apply didn't happen. */
  reason?: string;
  /** True when the only thing missing is the profile (sex, birth date, height): the screen then says to fill it in first. */
  needsProfile: boolean;
  daysUsed: number;
  /** Median implied activity multiplier, 3 dp. */
  median?: number;
  min?: number;
  max?: number;
  /** Average Lose It! calorie budget over the days used, whole kcal. */
  loseItAvgKcal?: number;
  /** What this app's calorie budget gives on those same days with the profile and goal as they are now. */
  appAvgKcal?: number;
  /** ...and what it would give with the median multiplier. */
  matchedAvgKcal?: number;
  /** The goal in effect today has a calorie budget of its own, which no multiplier can change. */
  goalHasOwnBudget: boolean;
  /** The "Match my Lose It! calorie budget" action would work. */
  canApply: boolean;
  applyRequested: boolean;
  applied: boolean;
}


export interface ImportReport {
  dryRun: boolean;
  options: {
    today: string;
    conflict: ConflictMode;
    from: string | null;
    to: string | null;
    foodScope: Scope;
    applyCalibration: boolean;
  };
  /** Every file in the export: rows, headers, whether it was understood or skipped (and why). */
  files: InventoryItem[];
  /** Pictures in the archive that are not progress photos (meal photos): skipped, never read. */
  ignoredImages: number;
  /** Span of the food-log rows inside the date window. */
  dateRange: { from: string; to: string; daysWithEntries: number } | null;
  /** Diary entries (one per non-deleted food-log row). */
  counts: {
    created: number;
    alreadyImported: number;
    /** Imported earlier, flagged Deleted in this export, so now soft-deleted here. */
    deletedSince: number;
    /** Live rows on days left alone because you'd already logged them here. */
    skippedByConflict: number;
    /** Live rows dated outside --from/--to. */
    outsideRange: number;
    /** Rows the export marks Deleted (inside the window). */
    deletedInExport: number;
    /** Created as plans because their date is after today. */
    plannedInFuture: number;
    /** All warnings, including ones past the cap on `warnings` below. */
    warnings: number;
  };
  /** Foods made from the food log history (one per distinct name + unit). */
  foods: { created: number; reused: number; withoutNutrition: number };
  /** Foods made from custom-foods.csv. */
  customFoods: { rows: number; created: number; reused: number; withoutNutrition: number };
  /** Meal names that aren't Breakfast / Lunch / Dinner / Snacks. */
  customSlots: Array<{ name: string; key: string; entries: number; enabled: boolean; created: boolean }>;
  weights: null | {
    unit: WeightUnit;
    unitSource: "option" | "weights.csv header" | "profile.csv" | "account setting";
    created: number;
    alreadyImported: number;
    /** An existing import whose value changed (e.g. a re-import with the unit corrected). */
    updated: number;
    deletedSince: number;
    rejected: number;
    outsideRange: number;
    first: { date: string; kg: number } | null;
    last: { date: string; kg: number } | null;
  };
  exercise: {
    mode: "logs" | "summary" | "none";
    created: number;
    alreadyImported: number;
    updated: number;
    deletedSince: number;
    skippedByConflict: number;
    /** Days where the exercise log and the summary's Exercise cals disagree (logs mode only). */
    mismatches: number;
  };
  /** "Done logging" days from daily-values.csv (Name = Complete). */
  doneDays: {
    /** Complete rows in the file with a true value. */
    inFile: number;
    marked: number;
    alreadyDone: number;
    /** Complete rows whose value says the day was NOT completed (0). */
    notComplete: number;
    outsideRange: number;
    skippedByConflict: number;
    /** Dated after today. */
    future: number;
    /** Dates of RecordedWeightsResetDate rows: noted, nothing is done with them. */
    weightsResetDates: string[];
  };
  steps: {
    inFile: number;
    created: number;
    /** An earlier import whose number changed. */
    updated: number;
    alreadyImported: number;
    /** Days where you typed steps yourself: the import never overwrites those. */
    keptManual: number;
    outsideRange: number;
    future: number;
    rejected: number;
  };
  photos: {
    inFile: number;
    created: number;
    alreadyImported: number;
    /** Rows the export marks Deleted. */
    skippedDeleted: number;
    /** Imported earlier but deleted in Lose It! since: kept here (a photo can't be brought back once deleted). */
    deletedSinceKept: number;
    /** Over the photo size limit: skipped, never shrunk. */
    tooBig: number;
    /** No file for the row, or the file isn't a JPEG/PNG/WebP picture. */
    unusable: number;
    outsideRange: number;
    future: number;
    /** The size limit in bytes, for the message. */
    limitBytes: number;
  };
  budgetSnapshots: { written: number; unchanged: number };
  conflicts: { mode: ConflictMode; count: number; replacedEntries: number; dates: ConflictDate[] };
  reconciliation: { compared: number; mismatches: number; first: ReconcileMismatch[] };
  calibration: CalibrationReport;
  /** The first few warnings; counts.warnings has the total. */
  warnings: string[];
}
