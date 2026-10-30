// Recipes with calories: the pure half. No database, no network, no clock.
//
// A recipe is still the JSON document household-app has always kept in its `recipes` table (the
// meal plan, shopping list, pantry matching and the assistant all read it), with new OPTIONAL
// fields on top, so every recipe saved before this existed keeps working untouched:
//
//   lines[]      the ingredient lines as written ("2 1/2 cups all-purpose flour"), each with the
//                pantry name used for matching ("flour") and, once someone links it, a food and an
//                amount so calories can be added up
//   yieldServings, servingLabel, totalCookedG, sourceUrl
//   instructions the method, as ordered plain-text steps (cleanInstructions caps them)
//   nutrition    per-serving nutrients and where they came from (see RecipeNutrition)
//   foodId       the read-only food this recipe is materialized as (nutrition/data/recipes.ts)
//
// `ingredients: string[]` stays and is what pantry/grocery matching reads; when a recipe has
// lines it is DERIVED from their pantryNames (ingredientsOfLines), so nothing downstream changes.
//
// This file holds: the line parser (quantity, unit, ingredient) that runs before and without any
// language model, unit conversion, the "which food is this line?" scoring and the conservative
// rule for auto-linking, the calorie arithmetic, and the readers for what a recipe web page says
// about its own calories and servings.

import { stripQuantity } from "../recipeText.ts";
import { emptyNutrients, fromServing, round2, sumNutrients, type Nutrients } from "./nutrients.ts";

// ---- the document -----------------------------------------------------------------------

export type RecipeScope = "joint" | "personal";

/** One ingredient line. Everything after pantryName is optional and only set once calories are in play. */
export interface Line {
  /** As written: "2 1/2 cups all-purpose flour". */
  text: string;
  /** What the pantry and shopping list match on: "flour". Derived exactly as the importer always has. */
  pantryName: string;
  /** The food that supplies the calories (nutrition_foods.id). */
  foodId?: string;
  /** The amount, in the same terms the diary uses: `quantity` of a serving row, or a gram weight. */
  quantity?: number;
  servingId?: string;
  grams?: number;
  /** True when no food is linked and `estimatedKcal` is the local model's guess for this line (whole dish). */
  estimated?: boolean;
  estimatedKcal?: number;
}

/**
 * Where a recipe's calories came from.
 *   site        the page's own figure (schema.org nutrition.calories); nothing was added up
 *   calculated  added up from linked foods; `complete` says whether every line was accounted for
 *   mixed       calculated, but at least one line is the model's estimate instead of a food
 * `complete` is false while any line is estimated or has no food, so the UI can say "calories
 * partly estimated". A site figure covers the whole dish as the site states it, so it is complete.
 */
export interface RecipeNutrition {
  perServing: Nutrients;
  siteKcalPerServing?: number;
  origin: "site" | "calculated" | "mixed";
  complete: boolean;
}

export interface RecipeDoc {
  id: string;
  name: string;
  ingredients: string[];
  scope: RecipeScope;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  lines?: Line[];
  yieldServings?: number;
  /** True when nobody said how many servings it makes and DEFAULT_YIELD was used. */
  yieldAssumed?: boolean;
  servingLabel?: string;
  totalCookedG?: number;
  sourceUrl?: string;
  /** How to make it: ordered steps, plain text. Absent on every recipe saved before this existed. */
  instructions?: string[];
  /** Free-text labels ("quick", "crockpot"): lower case, see cleanTags. Absent on older recipes. */
  tags?: string[];
  prepMinutes?: number;
  cookMinutes?: number;
  /** Free-text notes about the recipe (substitutions, who liked it), see cleanNotes. */
  notes?: string;
  /** When the recipe's photo was last set (the photo itself lives in nutrition_recipe_photos, never in this document). */
  photoAt?: string;
  nutrition?: RecipeNutrition;
  foodId?: string;
}

export const DEFAULT_YIELD = 4;
export const MAX_TAGS = 12;
export const MAX_TAG_CHARS = 30;
export const MAX_NOTES_CHARS = 2000;
export const MAX_MINUTES = 1440;
export const DEFAULT_SERVING_LABEL = "serving";
export const MAX_LINES = 100;
export const MAX_STEPS = 60;
export const MAX_STEP_CHARS = 2000;

// ---- instructions ("how to make it") -------------------------------------------------------

// "1." "1)" "Step 1" "Step 1:" "Step 1 -" at the start of a line: the number is the list's, not the step's.
const STEP_NUMBERING = /^(?:step\s*\d+\s*[:.)\-–]?|\d+\s*[.)])\s+/i;

/** One step as stored: leading bullet or numbering off, whitespace folded, at most MAX_STEP_CHARS. */
export function cleanStep(raw: unknown): string {
  const t = String(raw ?? "").replace(/\s+/g, " ").trim().replace(/^[-*•▢□◦]+\s*/, "").replace(STEP_NUMBERING, "").trim();
  // A line that is only "Step 2" (the text is on the next line) is a label, not a step.
  if (/^step\s*\d+\s*[:.)\-–]?$/i.test(t)) return "";
  return t.slice(0, MAX_STEP_CHARS).trim();
}

/** A list of steps as stored: each cleaned, empties dropped, at most MAX_STEPS. */
export function cleanInstructions(value: unknown): string[] {
  const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(/\r?\n/) : [];
  const out: string[] = [];
  for (const raw of list) {
    const step = cleanStep(raw);
    if (step) out.push(step);
    if (out.length >= MAX_STEPS) break;
  }
  return out;
}

// ---- tags, times, notes, rating ------------------------------------------------------------

/** Tags as stored: a list or comma/line separated text; lower case, no leading "#", folded spaces, deduped, capped. */
export function cleanTags(value: unknown): string[] {
  const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,\n]/) : [];
  const out: string[] = [];
  for (const raw of list) {
    const tag = String(raw ?? "").replace(/\s+/g, " ").trim().replace(/^#+\s*/, "").toLowerCase().slice(0, MAX_TAG_CHARS).trim();
    if (tag && !out.includes(tag)) out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/** Whole minutes, 1 to a day; anything else (blank, zero, negative, text) is "not set". */
export function cleanMinutes(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const n = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(n)) return undefined;
  const whole = Math.round(n);
  return whole >= 1 && whole <= MAX_MINUTES ? whole : undefined;
}

/** Notes as stored: trimmed, at most MAX_NOTES_CHARS; blank is "not set". */
export function cleanNotes(value: unknown): string | undefined {
  const t = String(value ?? "").replace(/\r\n/g, "\n").trim().slice(0, MAX_NOTES_CHARS).trim();
  return t || undefined;
}

/** A 1-5 star rating; anything else (0, blank, out of range, text) is "not rated". */
export function cleanRating(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const n = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : undefined;
}

// ---- scaling an ingredient line -------------------------------------------------------------

const UNICODE_FRACTIONS: Record<string, number> = { "¼": 1 / 4, "½": 1 / 2, "¾": 3 / 4, "⅓": 1 / 3, "⅔": 2 / 3, "⅛": 1 / 8, "⅜": 3 / 8, "⅝": 5 / 8, "⅞": 7 / 8 };
// What a scaled amount is rounded to when it lands near one of these (a cook measures in these, not in 0.37).
const FRACTION_STEPS: [number, string][] = [
  [1 / 8, "⅛"], [1 / 4, "¼"], [1 / 3, "⅓"], [3 / 8, "⅜"], [1 / 2, "½"], [5 / 8, "⅝"], [2 / 3, "⅔"], [3 / 4, "¾"], [7 / 8, "⅞"],
];

/** The leading amount of a line ("2 1/2", "1/2", "2½", "1.5", "3") and what follows; null when there is none to read. */
function readLeadingAmount(text: string): { value: number; rest: string } | null {
  let m = /^(\d+)\s+(\d+)\/(\d+)/.exec(text);
  if (m && Number(m[3]) > 0) return { value: Number(m[1]) + Number(m[2]) / Number(m[3]), rest: text.slice(m[0].length) };
  m = /^(\d+)\/(\d+)/.exec(text);
  if (m && Number(m[2]) > 0) return { value: Number(m[1]) / Number(m[2]), rest: text.slice(m[0].length) };
  m = /^(\d+)?\s*([¼½¾⅓⅔⅛⅜⅝⅞])/.exec(text);
  if (m) return { value: Number(m[1] ?? 0) + UNICODE_FRACTIONS[m[2]], rest: text.slice(m[0].length) };
  m = /^(\d+(?:\.\d+)?)/.exec(text);
  if (m) return { value: Number(m[1]), rest: text.slice(m[0].length) };
  return null;
}

/** A scaled amount written the way a cook reads it: "2 ½", "¾", "1 ⅓", "12", "0.4". */
export function formatAmount(value: number): string {
  if (!(value > 0)) return "0";
  const whole = Math.floor(value + 1e-9);
  const frac = value - whole;
  if (frac < 0.04) return String(whole);
  if (frac > 0.96) return String(whole + 1);
  const near = FRACTION_STEPS.reduce((best, s) => (Math.abs(s[0] - frac) < Math.abs(best[0] - frac) ? s : best));
  if (Math.abs(near[0] - frac) <= 0.04) return whole > 0 ? `${whole} ${near[1]}` : near[1];
  return String(Math.round(value * 100) / 100);
}

/**
 * The line with its leading amount multiplied by `factor` ("2 1/2 cups flour" at 2 gives "5 cups flour"). Only the first
 * amount is touched. A line with no amount, a range ("1-2 cloves", "1 to 2"), or a number that is part of a name ("7up")
 * comes back unchanged, as does any factor that is not positive.
 */
export function scaleLineText(text: string, factor: number): string {
  const s = String(text ?? "");
  if (!(factor > 0) || factor === 1) return s;
  const lead = /^[-*•▢□◦\s]*/.exec(s)![0];
  const body = s.slice(lead.length);
  const amount = readLeadingAmount(body);
  if (!amount || amount.value <= 0) return s;
  // A number glued to a letter ("7up", "2x") or a range is not an amount to scale.
  if (/^[a-zA-Z]/.test(amount.rest) && !/^\s/.test(amount.rest)) return s;
  if (/^\s*(?:-|–|to\b)\s*\d/i.test(amount.rest)) return s;
  return `${lead}${formatAmount(amount.value * factor)}${amount.rest}`;
}

// ---- does an edited line still mean the same thing? ------------------------------------------

/** Edit distance between two short strings (insert, delete, substitute each cost 1). */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/**
 * True when an edited ingredient line still means the same thing as the one it replaces, so a calorie link made for the
 * old one is still right: the same amount and unit, and the same food name apart from a typo (a spelling fix of up to a
 * fifth of the name, at least one letter). A changed amount or a different food is not the same thing.
 */
export function sameLineMeaning(oldText: string, newText: string): boolean {
  const a = parseIngredientLine(oldText);
  const b = parseIngredientLine(newText);
  if ((a.quantity ?? null) !== (b.quantity ?? null) || (a.unit ?? null) !== (b.unit ?? null)) return false;
  const an = a.name.toLowerCase().replace(/\s+/g, " ").trim();
  const bn = b.name.toLowerCase().replace(/\s+/g, " ").trim();
  if (an === bn) return true;
  const allowed = Math.max(1, Math.floor(Math.max(an.length, bn.length) * 0.2));
  return editDistance(an, bn) <= allowed;
}

// ---- lines <-> ingredients ---------------------------------------------------------------

// "7up" is a name, "7 oz cheese" is a quantity: the number has to stand alone (or be a fraction).
const LEADING_QUANTITY = /^[-*•▢□◦\s]*(?:\d+[\d.,/]*|[¼½¾⅓⅔⅛⅜⅝⅞])(?:\s|$)/;

/** The name pantry matching uses for a line written by hand or by the assistant: quantities come off only when there is one. */
export function pantryNameOf(text: string): string {
  const t = String(text ?? "").trim();
  if (!LEADING_QUANTITY.test(t)) return t;
  return stripQuantity(t) || t;
}

export function linesFromNames(names: string[]): Line[] {
  return names.map((n) => String(n ?? "").trim()).filter(Boolean).map((text) => ({ text, pantryName: pantryNameOf(text) }));
}

/** The recipe's `ingredients`: the lines' pantry names, once each (case-insensitive), in order. */
export function ingredientsOfLines(lines: Line[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of lines) {
    const name = l.pantryName.trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

// ---- units ---------------------------------------------------------------------------------

export type UnitKind = "weight" | "volume" | "count";

export interface UnitInfo {
  key: string;
  kind: UnitKind;
  /** Grams per unit for weight, millilitres per unit for volume, 1 for count. */
  factor: number;
}

const unit = (key: string, kind: UnitKind, factor: number, ...aliases: string[]): [string, UnitInfo][] =>
  [key, ...aliases].map((a) => [a, { key, kind, factor }]);

/** Every spelling we recognise, lower case, mapped to its canonical unit. */
export const UNIT_TABLE: Record<string, UnitInfo> = Object.fromEntries([
  ...unit("g", "weight", 1, "gram", "grams", "gm", "gms"),
  ...unit("kg", "weight", 1000, "kilogram", "kilograms", "kilo", "kilos"),
  ...unit("oz", "weight", 28.3495, "ounce", "ounces"),
  ...unit("lb", "weight", 453.592, "lbs", "pound", "pounds"),
  ...unit("ml", "volume", 1, "milliliter", "milliliters", "millilitre", "millilitres"),
  ...unit("l", "volume", 1000, "liter", "liters", "litre", "litres"),
  ...unit("tsp", "volume", 4.92892, "teaspoon", "teaspoons", "tsps"),
  ...unit("tbsp", "volume", 14.7868, "tbs", "tablespoon", "tablespoons", "tbsps"),
  ...unit("cup", "volume", 236.588, "cups", "c"),
  ...unit("fl oz", "volume", 29.5735, "floz", "fl. oz", "fluid ounce", "fluid ounces"),
  ...unit("pint", "volume", 473.176, "pints", "pt"),
  ...unit("quart", "volume", 946.353, "quarts", "qt"),
  ...unit("gallon", "volume", 3785.41, "gallons", "gal"),
  ...unit("clove", "count", 1, "cloves"),
  ...unit("can", "count", 1, "cans", "tin", "tins"),
  ...unit("jar", "count", 1, "jars"),
  ...unit("package", "count", 1, "packages", "pkg", "packet", "packets", "pack", "packs"),
  ...unit("bottle", "count", 1, "bottles"),
  ...unit("slice", "count", 1, "slices"),
  ...unit("stick", "count", 1, "sticks"),
  ...unit("bunch", "count", 1, "bunches"),
  ...unit("head", "count", 1, "heads"),
  ...unit("sprig", "count", 1, "sprigs"),
  ...unit("stalk", "count", 1, "stalks"),
  ...unit("piece", "count", 1, "pieces"),
  ...unit("handful", "count", 1, "handfuls"),
  ...unit("pinch", "count", 1, "pinches"),
  ...unit("dash", "count", 1, "dashes"),
]);

/** Units that mean "a negligible amount": no calories worth counting. */
const TINY_UNITS = new Set(["pinch", "dash"]);

/** Foods whose calories are nil at any amount a recipe uses, so a line for one never blocks "complete". */
const NEGLIGIBLE_NAMES = new Set([
  "water", "ice", "ice water", "salt", "pepper", "black pepper", "salt and pepper", "salt & pepper",
  "cooking spray", "boiling water", "hot water", "cold water", "warm water",
]);

// grams per millilitre for the few volume measures people write constantly; anything else is 1.0.
// A guess, which is why a volume converted this way is flagged `approx` and never auto-linked.
const DENSITY: Array<[RegExp, number]> = [
  [/\bflour\b/, 0.53], [/\bbrown sugar\b/, 0.93], [/\bsugar\b/, 0.85], [/\boats?\b/, 0.34],
  [/\brice\b/, 0.85], [/\bbutter\b/, 0.96], [/\boil\b/, 0.92], [/\bmilk\b|\bcream\b/, 1.03],
  [/\bhoney\b|\bsyrup\b/, 1.42], [/\bpeanut butter\b/, 1.1], [/\bcocoa\b/, 0.5], [/\bparmesan\b/, 0.4],
  [/\bcheese\b/, 0.45], [/\bbreadcrumbs?\b/, 0.45],
];

export function densityFor(name: string): number {
  const n = name.toLowerCase();
  return DENSITY.find(([re]) => re.test(n))?.[1] ?? 1;
}

// ---- parsing a line ------------------------------------------------------------------------

export interface ParsedLine {
  text: string;
  quantity: number | null;
  /** Canonical unit key (cup, tbsp, g...) or null. */
  unit: string | null;
  unitKind: UnitKind | null;
  /** The ingredient with the amount, unit and preparation notes taken off: "all-purpose flour". */
  name: string;
  /** "1 (14 oz) can tomatoes": the 14 oz in grams, per unit. */
  sizeG: number | null;
  /** Salt, water, "a pinch": counts as accounted for without any calories. */
  negligible: boolean;
  via: "regex" | "model";
}

const FRACTIONS: Record<string, number> = { "¼": 0.25, "½": 0.5, "¾": 0.75, "⅓": 1 / 3, "⅔": 2 / 3, "⅛": 0.125, "⅜": 0.375, "⅝": 0.625, "⅞": 0.875 };
const FRACTION_CLASS = "[¼½¾⅓⅔⅛⅜⅝⅞]";

/** A number at the very start ("2", "1.5", "1/2", "2 1/2", "2½", "½"), and the text after it. */
function readNumber(s: string): { value: number; rest: string } | null {
  let m = new RegExp(`^(\\d+)\\s*(${FRACTION_CLASS})`).exec(s);
  if (m) return { value: Number(m[1]) + FRACTIONS[m[2]], rest: s.slice(m[0].length) };
  m = /^(\d+)\s+(\d+)\/(\d+)(?!\d)/.exec(s);
  if (m && Number(m[3]) > 0) return { value: Number(m[1]) + Number(m[2]) / Number(m[3]), rest: s.slice(m[0].length) };
  m = /^(\d+)\/(\d+)(?!\d)/.exec(s);
  if (m && Number(m[2]) > 0) return { value: Number(m[1]) / Number(m[2]), rest: s.slice(m[0].length) };
  m = new RegExp(`^(${FRACTION_CLASS})`).exec(s);
  if (m) return { value: FRACTIONS[m[1]], rest: s.slice(m[0].length) };
  m = /^(\d+(?:\.\d+)?)/.exec(s);
  if (m) return { value: Number(m[1]), rest: s.slice(m[0].length) };
  return null;
}

/** "2-3", "2 to 3": the middle. */
function readQuantity(s: string): { value: number; rest: string } | null {
  const first = readNumber(s);
  if (!first) return null;
  const range = /^\s*(?:-|–|to)\s*(?=[\d¼½¾⅓⅔⅛⅜⅝⅞])/.exec(first.rest);
  if (range) {
    const second = readNumber(first.rest.slice(range[0].length));
    if (second) return { value: (first.value + second.value) / 2, rest: second.rest };
  }
  return first;
}

/** The unit word at the front of `s` (two-word "fl oz" first), with what follows it. */
function readUnit(s: string): { info: UnitInfo; rest: string } | null {
  const t = s.trimStart();
  const two = /^(fl\.?\s*oz\.?|fluid\s+ounces?)(?![a-z])/i.exec(t);
  if (two) return { info: UNIT_TABLE["fl oz"], rest: t.slice(two[0].length) };
  const m = /^([a-zA-Z]+)\.?(?![a-zA-Z])/.exec(t);
  if (!m) return null;
  const info = UNIT_TABLE[m[1].toLowerCase()];
  // A lone "c" or "l" followed by more letters is part of a word, not a unit ("c" only counts as
  // a cup in "2 c flour"); the regex above already needs a non-letter after the word.
  return info ? { info, rest: t.slice(m[0].length) } : null;
}

/** The weight in a parenthetical like "(14 oz)" or "(400 g)", in grams. */
function weightInParens(s: string): number | null {
  const q = readQuantity(s.trim());
  if (!q) return null;
  const u = readUnit(q.rest);
  return u && u.info.kind === "weight" ? q.value * u.info.factor : null;
}

const WORD_AMOUNT = /^\s*(?:an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|dozen|half|couple|few)\b/i;

/** True when the text opens with an amount in words that the regex cannot read ("two cups", "a dozen"). */
export function hasWordAmount(text: string): boolean {
  return WORD_AMOUNT.test(text.replace(/^[-*•▢□◦\s]+/, ""));
}

export function parseIngredientLine(text: string): ParsedLine {
  const original = String(text ?? "").trim();
  let t = original.replace(/^[-*•▢□◦\s]+/, "").replace(/^\d+[.)]\s+/, "");
  const lead = readQuantity(t);
  let quantity: number | null = null;
  let info: UnitInfo | null = null;
  let sizeG: number | null = null;

  if (lead && lead.value > 0) {
    quantity = lead.value;
    let rest = lead.rest.trimStart();
    // "1 (14 oz) can": the size sits between the number and the unit.
    const paren = /^\(([^)]*)\)\s*/.exec(rest);
    if (paren) {
      sizeG = weightInParens(paren[1]);
      rest = rest.slice(paren[0].length);
    }
    const u = readUnit(rest);
    if (u) {
      info = u.info;
      const after = /^\s*\(([^)]*)\)/.exec(u.rest);
      if (after && sizeG === null) sizeG = weightInParens(after[1]);
    }
  }

  const name = stripQuantity(original) || original;
  const lower = name.toLowerCase().trim();
  const negligible =
    (info !== null && TINY_UNITS.has(info.key)) ||
    /^\s*(?:an?\s+|one\s+)?(?:pinch|pinches|dash|dashes)\b/i.test(original) ||
    /\b(?:to taste|as needed)\b/i.test(original) ||
    NEGLIGIBLE_NAMES.has(lower);

  return {
    text: original,
    quantity,
    unit: info?.key ?? null,
    unitKind: info?.kind ?? null,
    name,
    sizeG: info && info.kind === "count" ? sizeG : null,
    negligible,
    via: "regex",
  };
}

/** A line is negligible when the parser says so; lines the model estimated are never "negligible", they have a figure. */
export const isNegligible = (line: Line): boolean => parseIngredientLine(line.text).negligible;

// ---- turning a parsed line into an amount of a food -----------------------------------------

export interface ServingLike {
  id: string;
  label: string;
  grams: number | null;
  isDefault: boolean;
}

export interface FoodLike {
  basis: "per100g" | "per_serving";
  servings: ServingLike[];
}

/** The fields a Line (and a diary add) takes for an amount. `approx`: a density guess was involved. */
export interface ResolvedAmount {
  quantity?: number;
  servingId?: string;
  grams?: number;
  approx: boolean;
}

const labelNumber = (label: string): number => {
  const r = readNumber(label.trim());
  return r && r.value > 0 ? r.value : 1;
};

/** Does a serving label ("1 cup (80 g)", "2 tbsp", "1 slice") measure in this unit? */
function labelUsesUnit(label: string, unitKey: string): boolean {
  const l = label.toLowerCase();
  const aliases = Object.entries(UNIT_TABLE).filter(([, u]) => u.key === unitKey).map(([a]) => a);
  return aliases.some((a) => a.length > 1 && new RegExp(`(^|[^a-z])${a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`).test(l));
}

/** A label that is only a weight or volume ("100 g", "1 oz"): no use for counting items. */
const isMeasureLabel = (label: string): boolean => /^\s*[\d./\s¼½¾⅓⅔]*\s*(g|gram|grams|kg|oz|ounces?|lbs?|ml|l)\b/i.test(label);

/**
 * How much of `food` a parsed line is, or null when it can't be said. In order of trust:
 *   weight unit            exact grams (per-serving foods: grams / the serving's weight)
 *   "(14 oz) can" sizes    exact grams
 *   a serving that is named in the same unit, or counts the item ("1 cup", "1 large egg")
 *   a volume with no matching serving: grams from a density guess, flagged approx
 */
export function resolveAmount(parsed: ParsedLine, food: FoodLike): ResolvedAmount | null {
  const q = parsed.quantity;
  if (q === null || q <= 0) return null;
  const servings = food.servings;
  const only = servings[0];

  const fromGrams = (grams: number, approx: boolean): ResolvedAmount | null => {
    if (food.basis === "per100g") return { grams: Math.round(grams * 100) / 100, approx };
    // A per-serving food has one serving; its weight is how a gram amount becomes a fraction of it.
    if (!only || !only.grams) return null;
    return { quantity: Math.round((grams / only.grams) * 10_000) / 10_000, approx };
  };

  if (parsed.unitKind === "weight") return fromGrams(q * UNIT_TABLE[parsed.unit!].factor, false);
  if (parsed.unitKind === "count" && parsed.sizeG) return fromGrams(q * parsed.sizeG, false);

  // A serving that speaks the line's language.
  const matching = parsed.unit
    ? servings.find((s) => labelUsesUnit(s.label, parsed.unit!))
    : servings.find((s) => s.isDefault && !isMeasureLabel(s.label)) ?? servings.find((s) => !isMeasureLabel(s.label));
  if (matching) {
    const count = q / labelNumber(matching.label);
    if (food.basis === "per_serving") return { quantity: Math.round(count * 10_000) / 10_000, approx: false };
    if (matching.grams) return { quantity: Math.round(count * 10_000) / 10_000, servingId: matching.id, approx: false };
  }

  if (parsed.unitKind === "volume") return fromGrams(q * UNIT_TABLE[parsed.unit!].factor * densityFor(parsed.name), true);
  return null;
}

// ---- which food is this line? ----------------------------------------------------------------

// Words that describe how an ingredient is prepared or sized, not which ingredient it is.
const DESCRIPTORS = new Set([
  "fresh", "chopped", "diced", "minced", "sliced", "grated", "shredded", "peeled", "crushed", "softened",
  "melted", "boneless", "skinless", "large", "small", "medium", "finely", "roughly", "thinly", "optional",
  "organic", "packed", "divided", "cubed", "trimmed", "halved", "drained", "rinsed", "frozen", "thawed",
]);
const FILLER = new Set(["the", "and", "of", "with", "in", "for", "a", "an", "or", "to"]);

function singular(w: string): string {
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && w.endsWith("oes")) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

/** Comparable words of a food or ingredient name: lower case, plurals folded, filler and prep words dropped. */
export function nameTokens(s: string): string[] {
  const words = s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(words.map(singular).filter((w) => !FILLER.has(w) && !DESCRIPTORS.has(w)))];
}

export interface CandidateLike {
  id: string;
  name: string;
  /** 'usda_generic' foods have long descriptive names; everything else was named by a person. */
  source: string;
}

export type MatchConfidence = "exact" | "possible" | "weak";

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((t) => b.includes(t));

/**
 * "exact": the words of the ingredient are the words of the food's name (up to its first comma, which
 * is where the USDA's own qualifiers start). "possible": every word of the ingredient is somewhere in
 * the name. Anything else is "weak": worth showing as a suggestion, never worth trusting.
 */
export function matchConfidence(ingredient: string, foodName: string): MatchConfidence {
  const want = nameTokens(ingredient);
  if (want.length === 0) return "weak";
  if (sameSet(want, nameTokens(foodName.split(",")[0]))) return "exact";
  const all = nameTokens(foodName);
  return want.every((t) => all.includes(t)) ? "possible" : "weak";
}

/**
 * The auto-link rule, deliberately conservative: a wrong link makes a calorie figure look sure when
 * it isn't, whereas an unlinked line is merely estimated (and says so). A candidate is taken only when
 *   - its name is an "exact" match for the ingredient, and
 *   - nothing else in the list is an exact match of the same kind: a food a person made or imported
 *     beats the USDA catalogue (they chose it), but two of their own foods that both fit, or two
 *     catalogue rows that both fit ("Rice, white, raw" / "Rice, white, cooked"), are ambiguous.
 * Returns the chosen id, or null.
 */
export function pickConfident(ingredient: string, candidates: CandidateLike[]): string | null {
  const exact = candidates.filter((c) => matchConfidence(ingredient, c.name) === "exact");
  const own = exact.filter((c) => c.source !== "usda_generic");
  if (own.length === 1) return own[0].id;
  if (own.length > 1) return null;
  const generic = exact.filter((c) => c.source === "usda_generic");
  return generic.length === 1 ? generic[0].id : null;
}

// ---- the arithmetic -------------------------------------------------------------------------

export interface CalcResult {
  total: Nutrients;
  perServing: Nutrients;
  origin: "calculated" | "mixed";
  complete: boolean;
  /** Indexes of lines by how they were counted. */
  linked: number[];
  estimated: number[];
  /** Counted as nothing and not negligible: no food, no estimate. */
  missing: number[];
}

/**
 * Add up a recipe from its lines. `amountOf` turns a linked line into nutrients (null when the
 * food is gone or the amount doesn't fit it, which counts the line as missing). A line with no food
 * but an estimate contributes its estimate (kcal only). Returns null when nothing contributed at all,
 * so a caller can keep the site's figure, or none.
 *
 *   per serving = (sum of every counted line) / yieldServings
 */
export function calculateNutrition(
  lines: Line[],
  yieldServings: number,
  amountOf: (line: Line, index: number) => Nutrients | null,
): CalcResult | null {
  if (!(yieldServings > 0)) return null;
  const parts: Nutrients[] = [];
  const linked: number[] = [];
  const estimated: number[] = [];
  const missing: number[] = [];

  lines.forEach((line, i) => {
    const n = line.foodId ? amountOf(line, i) : null;
    if (n) {
      parts.push(n);
      linked.push(i);
    } else if (line.estimated && typeof line.estimatedKcal === "number" && line.estimatedKcal >= 0) {
      parts.push({ ...emptyNutrients(), kcal: line.estimatedKcal });
      estimated.push(i);
    } else if (!isNegligible(line)) {
      missing.push(i);
    }
  });

  if (linked.length === 0 && estimated.length === 0) return null;
  const total = sumNutrients(parts);
  return {
    total,
    perServing: fromServing(total, 1 / yieldServings),
    origin: estimated.length > 0 ? "mixed" : "calculated",
    complete: estimated.length === 0 && missing.length === 0,
    linked,
    estimated,
    missing,
  };
}

export interface SiteFigures {
  kcal: number;
  /** Whatever else the page stated per serving (protein, fat, ...); kcal-only when it said nothing else. */
  nutrients: Nutrients;
}

/** The recipe's `nutrition` from a calculation, falling back to what the site said, or nothing. */
export function buildNutrition(calc: CalcResult | null, site?: SiteFigures): RecipeNutrition | undefined {
  if (calc) {
    return {
      perServing: calc.perServing,
      ...(site ? { siteKcalPerServing: site.kcal } : {}),
      origin: calc.origin,
      complete: calc.complete,
    };
  }
  if (site) return { perServing: site.nutrients, siteKcalPerServing: site.kcal, origin: "site", complete: true };
  return undefined;
}

/** The site figures a stored recipe still carries (kcal; macros only while the figure is still the site's own). */
export function siteFiguresOf(n: RecipeNutrition | undefined): SiteFigures | undefined {
  if (!n || n.siteKcalPerServing === undefined) return undefined;
  const nutrients = n.origin === "site" ? n.perServing : { ...emptyNutrients(), kcal: n.siteKcalPerServing };
  return { kcal: n.siteKcalPerServing, nutrients };
}

export const kcalPerServing = (r: Pick<RecipeDoc, "nutrition">): number | null =>
  r.nutrition ? round2(r.nutrition.perServing.kcal) : null;

// ---- what a recipe web page says about itself ------------------------------------------------

const MAX_SITE_KCAL = 5000;

/** schema.org nutrition.calories: a number, or "250 kcal", "250 calories", "250 Cal", "1,200 calories", "1046 kJ". Per serving. */
export function parseSiteKcal(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 && value <= MAX_SITE_KCAL ? round2(value) : undefined;
  if (typeof value !== "string") return undefined;
  const m = /(\d[\d,]*(?:\.\d+)?)\s*(kj|kilojoules?|k?cal(?:ories)?)?/i.exec(value.replace(/ /g, " "));
  if (!m) return undefined;
  let n = Number(m[1].replace(/,/g, ""));
  if (/^kj|^kilojoule/i.test(m[2] ?? "")) n /= 4.184;
  return Number.isFinite(n) && n > 0 && n <= MAX_SITE_KCAL ? round2(n) : undefined;
}

/** "4", "4 servings", "Serves 4", "Makes 12 cookies", "6-8 servings", ["4", "4 servings"]. Whole number 1-1000. */
export function parseYield(value: unknown): number | undefined {
  const list = Array.isArray(value) ? value : [value];
  const texts = list.filter((v) => typeof v === "string" || typeof v === "number").map(String);
  // Prefer an entry that says "serving(s)": "12" might be cookies, "4 servings" is a portion count.
  const pick = texts.find((t) => /serv/i.test(t)) ?? texts[0];
  if (!pick) return undefined;
  const m = /(\d+(?:\.\d+)?)/.exec(pick);
  if (!m) return undefined;
  const n = Math.round(Number(m[1]));
  return n >= 1 && n <= 1000 ? n : undefined;
}

const grams = (v: unknown): number | undefined => {
  if (typeof v === "number") return v >= 0 ? v : undefined;
  if (typeof v !== "string") return undefined;
  const m = /(\d+(?:\.\d+)?)\s*(mg|g|gram|grams|kg)?/i.exec(v);
  if (!m) return undefined;
  const n = Number(m[1]);
  return /^mg/i.test(m[2] ?? "") ? n / 1000 : n;
};
const mg = (v: unknown): number | undefined => {
  if (typeof v === "string" && /\bmg\b|milligram/i.test(v)) return Number((/(\d+(?:\.\d+)?)/.exec(v) ?? [])[1]);
  const g = grams(v);
  return g === undefined ? undefined : typeof v === "number" ? g : g * 1000;
};

/** The schema.org `nutrition` node (NutritionInformation): calories plus whatever else it states, all per serving. */
export function parseSiteNutrition(node: unknown): SiteFigures | undefined {
  if (!node || typeof node !== "object") return undefined;
  const n = node as Record<string, unknown>;
  const kcal = parseSiteKcal(n.calories);
  if (kcal === undefined) return undefined;
  const nutrients: Nutrients = {
    kcal,
    protein: grams(n.proteinContent) ?? 0,
    carbs: grams(n.carbohydrateContent) ?? 0,
    fat: grams(n.fatContent) ?? 0,
    satFat: grams(n.saturatedFatContent) ?? 0,
    sugars: grams(n.sugarContent) ?? 0,
    fiber: grams(n.fiberContent) ?? 0,
    cholesterolMg: mg(n.cholesterolContent) ?? 0,
    sodiumMg: mg(n.sodiumContent) ?? 0,
  };
  for (const k of Object.keys(nutrients) as (keyof Nutrients)[]) nutrients[k] = round2(Number.isFinite(nutrients[k]) ? nutrients[k] : 0);
  return { kcal, nutrients };
}
