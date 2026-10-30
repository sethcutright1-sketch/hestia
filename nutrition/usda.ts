// Mapping USDA FoodData Central nutrient rows to our Nutrients shape.
//
// FDC reports the same nutrient under two numbering schemes: the modern nutrient
// id (1008 = energy kcal) and the legacy SR "nutrient number" (208). The full
// food detail uses ids; the abridged items returned by /foods/list use `number`.
// We accept both so the importer doesn't depend on which one a given endpoint sends.

import { NUTRIENT_KEYS, round2, type Nutrients } from "./nutrients.ts";

const BY_ID: Record<number, keyof Nutrients> = {
  1008: "kcal",
  1003: "protein",
  1005: "carbs",
  1004: "fat",
  1258: "satFat",
  2000: "sugars",
  1079: "fiber",
  1253: "cholesterolMg",
  1093: "sodiumMg",
};
const BY_NUMBER: Record<string, keyof Nutrients> = {
  "208": "kcal", "203": "protein", "205": "carbs", "204": "fat", "606": "satFat",
  "269": "sugars", "291": "fiber", "601": "cholesterolMg", "307": "sodiumMg",
};
// Foundation foods often have no 1008 row; energy is given as Atwater general (2047)
// or specific (2048) factors instead (legacy numbers 957 / 958). General first.
const ATWATER_IDS = [2047, 2048];
const ATWATER_NUMBERS = ["957", "958"];

interface FdcNutrient {
  nutrientId?: number;
  id?: number;
  number?: string | number;
  amount?: number;
  value?: number;
  nutrient?: { id?: number; number?: string };
}

/** Per-100 g nutrients, or null when the food has no usable energy value. */
export function mapFdcNutrients(rows: FdcNutrient[] | undefined): Nutrients | null {
  const out: Partial<Record<keyof Nutrients, number>> = {};
  const atwater: Record<string, number> = {};
  for (const r of rows ?? []) {
    const id = r.nutrientId ?? r.nutrient?.id ?? r.id;
    const num = r.number !== undefined ? String(r.number) : r.nutrient?.number;
    const amount = r.amount ?? r.value;
    if (typeof amount !== "number" || !Number.isFinite(amount)) continue;
    const key = (id !== undefined ? BY_ID[id] : undefined) ?? (num !== undefined ? BY_NUMBER[num] : undefined);
    if (key) out[key] = amount;
    if (id !== undefined && ATWATER_IDS.includes(id)) atwater[String(id)] = amount;
    if (num !== undefined && ATWATER_NUMBERS.includes(num)) atwater[ATWATER_IDS[ATWATER_NUMBERS.indexOf(num)]] = amount;
  }
  if (out.kcal === undefined) {
    const fallback = atwater["2047"] ?? atwater["2048"];
    if (fallback === undefined) return null;
    out.kcal = fallback;
  }
  const n = {} as Nutrients;
  for (const k of NUTRIENT_KEYS) n[k] = round2(Math.max(0, out[k] ?? 0));
  return n;
}
