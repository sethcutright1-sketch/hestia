// A calorie number tied to every pantry item and shopping-list item.
//
// Each item may carry `calories: ItemCalories` (stored with the item; these are JSON documents, so
// no migration). fillMissingCalories() gives one to every item that lacks it, trying the sources in
// order of trust and recording WHICH one answered, because the screen must tell a measured figure
// from a guess:
//
//   barcode   the item's barcode in the Nutrition barcode service (Open Food Facts / USDA label data)
//   food_db   a generic food in the Nutrition catalogue whose name IS the item's name
//   estimate  a model's guess from the item's name alone -- always labelled as an estimate, with the
//             model's name, and never mistaken for data
//
// Only item NAMES ever go to a model, so the model may be a cloud one the person picked (this is
// not the food diary). Items are changed in place and the caller saves them. Everything here takes
// its sources as parameters, so tests run it with fakes and never reach a network or a model.

import type { Provider } from "./assistant/providers/types.ts";
import type { CalorieLookup } from "./krogerNutrition.ts";
import { caloriesOf } from "./krogerNutrition.ts";

export type CalorieSource = "barcode" | "food_db" | "estimate";

export interface ItemCalories {
  kcal: number;
  /** The amount the figure is for, e.g. "1 cup (240 ml)". */
  serving: string | null;
  source: CalorieSource;
  /** For an estimate: the model that guessed it (e.g. "Claude (claude-sonnet-5-5)"). Null otherwise. */
  model: string | null;
  /** ISO time the figure was set. */
  at: string;
}

export interface CalorieItem {
  name: string;
  barcode?: string;
  calories?: ItemCalories;
}

export interface NamedFigure {
  kcal: number;
  serving: string | null;
}

export interface FillDeps {
  /** Barcode -> label data. Absent: barcodes are not consulted. */
  lookup?: CalorieLookup;
  /** An item name -> a generic food of exactly that name, or null. */
  foodByName?: (name: string) => NamedFigure | null;
  /** Names -> a guess each (keyed by the name as sent). Absent: nothing is estimated. */
  estimate?: (names: string[]) => Promise<Record<string, NamedFigure>>;
  /** Stored on estimates. */
  modelLabel?: string;
  now?: () => Date;
}

export interface FillSummary {
  /** Items that already had calories. */
  alreadyHad: number;
  barcode: number;
  foodDb: number;
  estimated: number;
  /** Items still without calories (no source knew, or the model failed). */
  stillMissing: number;
}

const ESTIMATE_BATCH = 25;

export async function fillMissingCalories(items: CalorieItem[], deps: FillDeps): Promise<FillSummary> {
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const summary: FillSummary = { alreadyHad: 0, barcode: 0, foodDb: 0, estimated: 0, stillMissing: 0 };
  const needEstimate: CalorieItem[] = [];

  for (const item of items) {
    if (item.calories) {
      summary.alreadyHad++;
      continue;
    }
    const fromBarcode = item.barcode && deps.lookup ? await figureFromBarcode(item.barcode, deps.lookup) : null;
    if (fromBarcode) {
      item.calories = { ...fromBarcode, source: "barcode", model: null, at: now };
      summary.barcode++;
      continue;
    }
    const fromFood = deps.foodByName?.(item.name) ?? null;
    if (fromFood) {
      item.calories = { ...fromFood, source: "food_db", model: null, at: now };
      summary.foodDb++;
      continue;
    }
    needEstimate.push(item);
  }

  if (needEstimate.length > 0 && deps.estimate) {
    const names = [...new Set(needEstimate.map((i) => i.name))];
    const guesses: Record<string, NamedFigure> = {};
    for (let i = 0; i < names.length; i += ESTIMATE_BATCH) {
      try {
        Object.assign(guesses, await deps.estimate(names.slice(i, i + ESTIMATE_BATCH)));
      } catch {
        // This batch's items stay without calories; the person can run it again.
      }
    }
    for (const item of needEstimate) {
      const g = guesses[item.name];
      if (!g) continue;
      item.calories = { kcal: g.kcal, serving: g.serving, source: "estimate", model: deps.modelLabel ?? null, at: now };
      summary.estimated++;
    }
  }

  summary.stillMissing = items.filter((i) => !i.calories).length;
  return summary;
}

async function figureFromBarcode(barcode: string, lookup: CalorieLookup): Promise<NamedFigure | null> {
  try {
    return caloriesOf(await lookup(barcode));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// The model's part.

const MAX_KCAL = 2500;
const ESTIMATE_TIMEOUT_MS = 90_000;

/**
 * Asks `provider` for a typical calorie figure per item name. It is advisory: the reply is parsed
 * strictly, a figure outside 0..2500 or a name nobody asked about is dropped, and whatever survives
 * is stored as an estimate. Throws if the provider is unavailable (the caller shows its hint).
 */
export async function estimateWithProvider(provider: Provider, names: string[]): Promise<Record<string, NamedFigure>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ESTIMATE_TIMEOUT_MS);
  try {
    const result = await provider.chat(
      [
        {
          role: "system",
          content:
            "You estimate typical food energy. Reply with ONLY a JSON array, no prose and no code fence. " +
            'Each element: {"name": <the item exactly as given>, "kcal": <whole number of kilocalories in ONE typical serving>, ' +
            '"serving": <short description of that serving, e.g. "1 cup (240 ml)">}. ' +
            "Use a typical store-bought version of the item. Omit an item you cannot judge (not food, or too vague).",
        },
        { role: "user", content: JSON.stringify(names) },
      ],
      [],
      { signal: controller.signal, maxRounds: 1 }
    );
    return parseEstimates(result.reply, names);
  } finally {
    clearTimeout(timer);
  }
}

/** The model's reply -> figures for the names that were asked about. Tolerates a code fence or chatter around the array. */
export function parseEstimates(reply: string, asked: string[]): Record<string, NamedFigure> {
  const start = reply.indexOf("[");
  const end = reply.lastIndexOf("]");
  if (start < 0 || end <= start) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply.slice(start, end + 1));
  } catch {
    return {};
  }
  if (!Array.isArray(parsed)) return {};
  const wanted = new Set(asked);
  const out: Record<string, NamedFigure> = {};
  for (const row of parsed) {
    if (!row || typeof row !== "object") continue;
    const { name, kcal, serving } = row as Record<string, unknown>;
    if (typeof name !== "string" || !wanted.has(name)) continue;
    if (typeof kcal !== "number" || !Number.isFinite(kcal) || kcal < 0 || kcal > MAX_KCAL) continue;
    out[name] = { kcal: Math.round(kcal), serving: typeof serving === "string" && serving.trim() ? serving.trim().slice(0, 60) : null };
  }
  return out;
}
