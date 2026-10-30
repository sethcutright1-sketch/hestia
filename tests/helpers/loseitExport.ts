// A synthetic Lose It! export for the importer tests: a builder that writes CSV with the REAL export's headers
// (food-logs: Date|Name|Icon|Meal|Quantity|Units|Calories|Deleted|nutrients; exercise-logs: Date|Name|Icon|Type|
// Quantity|Units|Calories|Deleted; weights: Date|Weight|Last Updated|Deleted; daily-values: Date|Name|Value; steps:
// Date|Value|Secondary Value|Last Updated; progress-photos: Date|Goal Tag|Visibility|Token|Deleted|Created|Last
// Updated; custom-foods: Name|UniqueId|Brand|Image|Quantity|Measure|Calories|nutrients), quoting and all.
//
// Every row here is MADE UP. Nothing in tests/ may be copied from a real export (it is private health data).

import { strToU8, zipSync } from "fflate";
import type { LoseItExport } from "../../nutrition/import/zip.ts";

export const FOOD_HEADER = "Date,Name,Icon,Meal,Quantity,Units,Calories,Deleted,Fat (g),Protein (g),Carbohydrates (g),Saturated Fat (g),Sugars (g),Fiber (g),Cholesterol (mg),Sodium (mg)";

export interface Food {
  date: string; // M/D/YYYY, as Lose It! writes it
  name: string;
  type?: string;
  qty?: number | string;
  units?: string;
  kcal?: number | string;
  /** The real food-logs.csv writes 1/0; the parser reads every spelling. */
  deleted?: boolean | string | number;
  fat?: number; protein?: number; carbs?: number; sat?: number; sugars?: number; fiber?: number; chol?: number; sodium?: number;
}

const quote = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
export const csv = (header: string, rows: Array<Array<string | number | boolean>>) =>
  [header, ...rows.map((r) => r.map((c) => quote(String(c))).join(","))].join("\r\n") + "\r\n";

const flag01 = (v: boolean | string | number | undefined): string | number => (v === undefined || v === false ? 0 : v === true ? 1 : v);

export const foodCsv = (rows: Food[]) => csv(FOOD_HEADER, rows.map((r) => [
  r.date, r.name, "", r.type ?? "Breakfast", r.qty ?? 1, r.units ?? "Serving", r.kcal ?? 100, flag01(r.deleted),
  r.fat ?? 0, r.protein ?? 0, r.carbs ?? 0, r.sat ?? 0, r.sugars ?? 0, r.fiber ?? 0, r.chol ?? 0, r.sodium ?? 0,
]));

export interface Day { date: string; food?: number | string; exercise?: number | string; budget?: number | string }
export const summaryCsv = (rows: Day[]) => csv("Date,Food cals,Exercise cals,Budget cals,EER", rows.map((r) => [r.date, r.food ?? "", r.exercise ?? "", r.budget ?? "", ""]));

/** [date, weight, deleted?]: weights.csv spells Deleted true/false. */
export type WeightRowIn = [string, number | string, boolean?];
export const weightsCsv = (rows: WeightRowIn[]) => csv("Date,Weight,Last Updated,Deleted", rows.map(([d, w, del]) => [d, w, "1/1/2026", del ?? false]));

/** [date, name, calories (NEGATIVE, as the real file stores burn), minutes, deleted?]: exercise-logs.csv spells Deleted 1/0. */
export type ExerciseRowIn = [string, string, number, number | "", boolean?];
export const exerciseCsv = (rows: ExerciseRowIn[]) => csv("Date,Name,Icon,Type,Quantity,Units,Calories,Deleted", rows.map(([d, n, kcal, min, del]) => [d, n, "", "Exercise", min, "minutes", kcal, del ? 1 : 0]));

/** [date, value]: Name = Complete. */
export const dailyValuesCsv = (rows: Array<[string, number | string] | [string, string, string]>) =>
  csv("Date,Name,Value", rows.map((r) => (r.length === 3 ? [r[0], r[1], r[2]] : [r[0], "Complete", r[1]])));

export const stepsCsv = (rows: Array<[string, number | string]>) => csv("Date,Value,Secondary Value,Last Updated", rows.map(([d, v]) => [d, v, "0.0", "1/1/2026"]));

export const photosCsv = (rows: Array<[string, string, boolean?]>) =>
  csv("Date,Goal Tag,Visibility,Token,Deleted,Created,Last Updated", rows.map(([d, token, del]) => [d, "WEIGHT", "Private", token, del ? "true" : "false", "1/1/2026", "1/1/2026"]));

export interface CustomFood { name: string; brand?: string; qty?: number; measure?: string; kcal?: number; fat?: number; protein?: number; carbs?: number }
export const customFoodsCsv = (rows: CustomFood[]) => csv(
  "Name,UniqueId,Brand,Image,Quantity,Measure,Calories,Fat (g),Protein (g),Carbohydrates (g),Saturated Fat (g),Sugars (g),Fiber (g),Cholesterol (mg),Sodium (mg)",
  rows.map((r, i) => [r.name, `uid-${i}`, r.brand ?? "", "", r.qty ?? 1, r.measure ?? "Serving", r.kcal ?? 100, r.fat ?? 0, r.protein ?? 0, r.carbs ?? 0, 0, 0, 0, 0, 0]));

export interface Parts {
  food: Food[];
  summary?: Day[];
  weights?: WeightRowIn[];
  exercise?: ExerciseRowIn[];
  /** Any other file, by name (text). */
  extra?: Record<string, string>;
  /** Progress photo files by their basename (bytes). */
  photos?: Record<string, Uint8Array>;
}

export function exportOf(p: Parts): LoseItExport {
  const files = new Map<string, string>([["food-logs.csv", foodCsv(p.food)]]);
  if (p.summary) files.set("daily-calorie-summary.csv", summaryCsv(p.summary));
  if (p.weights) files.set("weights.csv", weightsCsv(p.weights));
  if (p.exercise) files.set("exercise-logs.csv", exerciseCsv(p.exercise));
  for (const [name, text] of Object.entries(p.extra ?? {})) files.set(name, text);
  return { files, photos: new Map(Object.entries(p.photos ?? {})), ignoredImages: 0 };
}

/** The same export as the bytes of a ZIP, laid out the way Lose It! does (photos under progress-photos/). */
export function zipOf(p: Parts): Uint8Array {
  const e = exportOf(p);
  const entries: Record<string, Uint8Array> = {};
  for (const [name, text] of e.files) entries[name === "progress-photos.csv" ? "progress-photos/progress-photos.csv" : name] = strToU8(text);
  for (const [name, bytes] of e.photos) entries[`progress-photos/${name}`] = bytes;
  return zipSync(entries);
}

/** The 32-character token a progress photo carries. */
export const token = (n: number): string => n.toString(16).padStart(32, "0");
export const photoName = (isoDate: string, tok: string): string => `${isoDate}-${tok}-photo.jpg`;
