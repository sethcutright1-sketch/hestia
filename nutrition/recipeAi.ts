// The local language model's two jobs in the recipe flow, behind an interface so everything that
// uses them can be tested with a fake and so the flow works with the model switched off:
//
//   parseLines    "two cups of flour" -> { quantity: 2, unit: "cup", ingredient: "flour" }, for the
//                 lines the regex parser (recipeModel.ts parseIngredientLine) cannot read
//   estimateKcal  a kcal figure for lines nobody could link to a food, for the whole dish
//
// Local only (merge plan decision 9): this talks to Ollama through household-app's existing client
// (ollama.ts) and to nothing else. Recipes aren't health data, but the figures feed a calorie
// diary, so a cloud provider is never asked.
//
// The model is advisory. Whatever it says is validated here (a unit we don't know becomes null, a
// kcal figure outside a sane range is dropped) and an estimate is always stored as an estimate.
//
// Tests: setRecipeModel(fake) swaps it, and HOUSEHOLD_LOCAL_MODEL=off (set by tests/helpers/testdb.ts)
// makes the default "no model", so no test can reach a real Ollama by accident.

import { generateJson } from "../ollama.ts";
import { UNIT_TABLE } from "./recipeModel.ts";

export interface ModelParse {
  quantity: number | null;
  /** Canonical unit key (see UNIT_TABLE) or null. */
  unit: string | null;
  ingredient: string;
}

export interface EstimateInput {
  recipeName: string;
  servings: number;
  ingredients: Array<{ index: number; text: string }>;
}

export interface RecipeModel {
  /** One entry per input text, null where the model had nothing usable. */
  parseLines(texts: string[]): Promise<Array<ModelParse | null>>;
  /** kcal for the WHOLE dish contributed by each ingredient, keyed by the input `index`. Missing = no figure. */
  estimateKcal(input: EstimateInput): Promise<Record<number, number>>;
}

export const MODEL_TIMEOUT_MS = 60_000;
export const MAX_ESTIMATE_KCAL = 8000;

let override: RecipeModel | null | undefined;

/** Swap the model (tests), or pass null to switch it off, or undefined to go back to the default. */
export function setRecipeModel(m: RecipeModel | null | undefined): void {
  override = m;
}

/** The model in use, or null when there is none (switched off). */
export function getRecipeModel(): RecipeModel | null {
  if (override !== undefined) return override;
  if (process.env.HOUSEHOLD_LOCAL_MODEL === "off") return null;
  return ollamaRecipeModel;
}

async function askJson(prompt: string): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);
  try {
    const { text } = await generateJson(prompt, controller.signal);
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

const UNIT_KEYS = [...new Set(Object.values(UNIT_TABLE).map((u) => u.key))];

/** Reads the model's `lines` array defensively: anything malformed is just "no answer" for that line. */
export function readParsedLines(json: any, count: number): Array<ModelParse | null> {
  const out: Array<ModelParse | null> = Array(count).fill(null);
  const rows = Array.isArray(json?.lines) ? json.lines : [];
  for (const row of rows) {
    const at = Number(row?.n) - 1;
    if (!Number.isInteger(at) || at < 0 || at >= count) continue;
    const ingredient = typeof row.ingredient === "string" ? row.ingredient.trim().slice(0, 200) : "";
    if (!ingredient) continue;
    const q = typeof row.quantity === "number" ? row.quantity : Number(row.quantity);
    const unit = typeof row.unit === "string" ? UNIT_TABLE[row.unit.trim().toLowerCase()]?.key ?? null : null;
    out[at] = { quantity: Number.isFinite(q) && q > 0 && q <= 10_000 ? q : null, unit, ingredient };
  }
  return out;
}

/** Reads the model's `estimates` array: only whole-dish figures in a believable range survive. */
export function readEstimates(json: any, valid: Set<number>): Record<number, number> {
  const out: Record<number, number> = {};
  const rows = Array.isArray(json?.estimates) ? json.estimates : [];
  for (const row of rows) {
    const index = Number(row?.n);
    const kcal = typeof row?.kcal === "number" ? row.kcal : Number(row?.kcal);
    if (!valid.has(index) || !Number.isFinite(kcal) || kcal < 0 || kcal > MAX_ESTIMATE_KCAL) continue;
    out[index] = Math.round(kcal);
  }
  return out;
}

export const ollamaRecipeModel: RecipeModel = {
  async parseLines(texts) {
    if (texts.length === 0) return [];
    const prompt =
      "You read recipe ingredient lines. For each numbered line give the amount, the unit and the ingredient.\n" +
      "- quantity is a number: convert words and fractions (\"a dozen\" is 12, \"half a cup\" is 0.5 cup); null if there is no amount.\n" +
      `- unit is exactly one of: ${UNIT_KEYS.join(", ")} -- or null if the line has none.\n` +
      "- ingredient is the food only, with no amount and no preparation words (\"flour\", not \"sifted flour\").\n" +
      'Reply with JSON only, like {"lines":[{"n":1,"quantity":2,"unit":"cup","ingredient":"flour"}]}.\n\n' +
      texts.map((t, i) => `${i + 1}. ${t}`).join("\n");
    return readParsedLines(await askJson(prompt), texts.length);
  },

  async estimateKcal({ recipeName, servings, ingredients }) {
    if (ingredients.length === 0) return {};
    const prompt =
      `You estimate calories for a home recipe. The dish is "${recipeName}" and it makes ${servings} servings.\n` +
      "For each numbered ingredient give the total kilocalories (kcal) that ingredient adds to the WHOLE dish, all servings together. " +
      "Where no amount is written, assume a typical home-cooking amount for a dish like this.\n" +
      'Reply with JSON only, like {"estimates":[{"n":1,"kcal":350}]}.\n\n' +
      ingredients.map((x, i) => `${i + 1}. ${x.text}`).join("\n");
    const json = await askJson(prompt);
    // The model numbers its answers 1..n; map them back to the caller's indexes.
    const byPosition = readEstimates(json, new Set(ingredients.map((_, i) => i + 1)));
    const out: Record<number, number> = {};
    ingredients.forEach((x, i) => {
      if (byPosition[i + 1] !== undefined) out[x.index] = byPosition[i + 1];
    });
    return out;
  },
};
