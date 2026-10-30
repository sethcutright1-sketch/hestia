// The recipe line editor's pure pieces (phase 5c): how a line and the recipe's calories are worded, what the
// requests look like, and the yield form's checks. No network, so it is tested without a browser
// (tests/mealplanRecipeLines.test.ts). The routes are in routes/nutrition/recipes.ts:
//   GET  /recipes/:id         the recipe with each line and what it adds        -> RecipeDetail
//   POST /recipes/:id/match   candidate foods per line, with the amount each would be -> { lines: MatchLine[] }
//   POST /recipes/:id/links   { links: [{ index, foodId, quantity? | servingId? | grams? } | { index, clear: true }] }
//   PUT  /recipes/:id         { yieldServings?, servingLabel?, totalCookedG? (null clears) }
//
// A line keeps its text and its pantry name whatever happens here: linking a food only adds the food and the amount,
// so pantry and grocery matching (which read `ingredients`, derived from the pantry names) are not touched.

import type { RecipeNutrition } from "../../api.ts";
import { startAmount, type AmountInput } from "../food/amount.ts";
import type { Amount, Food } from "../food/types.ts";

export interface RecipeLineDetail {
  index: number;
  /** As written: "2 1/2 cups all-purpose flour". */
  text: string;
  pantryName: string;
  foodId?: string;
  quantity?: number;
  servingId?: string;
  grams?: number;
  estimated?: boolean;
  estimatedKcal?: number;
  foodName: string | null;
  /** What the line adds (the food at its amount, or the model's estimate); null when it adds nothing yet. */
  kcal: number | null;
  /** Salt, water, "a pinch": counts as accounted for without calories. */
  negligible: boolean;
}

export interface RecipeDetail {
  id: string;
  name: string;
  scope: "joint" | "personal";
  ingredients: string[];
  lines: RecipeLineDetail[];
  yieldServings: number | null;
  yieldAssumed?: boolean;
  servingLabel?: string;
  totalCookedG?: number;
  sourceUrl?: string;
  nutrition?: RecipeNutrition;
  kcalPerServing: number | null;
  mine: boolean;
  updatedAt: string;
}

export interface MatchParsed {
  quantity: number | null;
  unit: string | null;
  name: string;
  negligible: boolean;
  via: "regex" | "model";
}

export interface MatchCandidate {
  foodId: string;
  name: string;
  brand: string | null;
  scope: "joint" | "personal" | "generic";
  source: string;
  basis: "per100g" | "per_serving";
  /** kcal in 100 g (per100g) or in one serving (per_serving). */
  kcal: number;
  confidence: "exact" | "possible" | "weak";
  amount: { quantity?: number; servingId?: string; grams?: number; approx: boolean } | null;
}

export interface MatchLine {
  index: number;
  text: string;
  parsed: MatchParsed;
  candidates: MatchCandidate[];
  suggestedFoodId: string | null;
}

// ---- words -------------------------------------------------------------------------------------------------------

const round1 = (n: number): number => Math.round(n * 10) / 10;
const kcalText = (n: number): string => Math.round(n).toLocaleString("en-US");

/** The amount the reader found in the line: "2 cup flour", "no amount found", or that it counts as nothing. */
export function parsedText(p: MatchParsed | undefined): string {
  if (!p) return "";
  if (p.negligible) return "a pinch or a splash: counts as nothing";
  if (p.quantity === null) return p.name ? `no amount found (${p.name})` : "no amount found";
  return `${round1(p.quantity)}${p.unit ? ` ${p.unit}` : ""} ${p.name}`.trim();
}

export type LineStatus = "linked" | "broken" | "estimate" | "negligible" | "none";

/**
 * Where a line stands. "broken" is a link whose food is gone or whose amount no longer fits it (it adds nothing),
 * which is worth saying out loud rather than showing as linked.
 */
export function lineStatus(l: Pick<RecipeLineDetail, "foodId" | "kcal" | "estimated" | "estimatedKcal" | "negligible">): LineStatus {
  if (l.foodId) return l.kcal === null ? "broken" : "linked";
  if (l.estimated && l.estimatedKcal !== undefined) return "estimate";
  if (l.negligible) return "negligible";
  return "none";
}

/** A short amount for a linked line: grams, or a number of the food's servings (the sheet shows the serving's name). */
export function lineAmountText(l: Pick<RecipeLineDetail, "grams" | "quantity">): string {
  if (l.grams !== undefined) return `${round1(l.grams)} g`;
  if (l.quantity !== undefined) return `${round1(l.quantity)} serving${l.quantity === 1 ? "" : "s"}`;
  return "";
}

/** The line's status sentence: the food and amount with its calories, "AI estimate", or "not linked". */
export function statusText(l: RecipeLineDetail): string {
  switch (lineStatus(l)) {
    case "linked": return `${l.foodName ?? "Food"} · ${lineAmountText(l)} · ${kcalText(l.kcal ?? 0)} kcal`;
    case "broken": return `${l.foodName ?? "The linked food"} can't be used any more (removed, or the amount no longer fits). Link a food again.`;
    case "estimate": return `AI estimate · about ${kcalText(l.estimatedKcal ?? 0)} kcal`;
    case "negligible": return "not counted (a pinch or a splash)";
    default: return "not linked";
  }
}

export interface LinesSummary {
  total: number;
  linked: number;
  estimated: number;
  /** Not linked and not an estimate, and not a pinch: these add nothing to the calories. */
  unlinked: number;
  negligible: number;
}

export function summarize(lines: RecipeLineDetail[]): LinesSummary {
  const out: LinesSummary = { total: lines.length, linked: 0, estimated: 0, unlinked: 0, negligible: 0 };
  for (const l of lines) {
    const s = lineStatus(l);
    if (s === "linked") out.linked++;
    else if (s === "estimate") out.estimated++;
    else if (s === "negligible") out.negligible++;
    else out.unlinked++; // none and broken
  }
  return out;
}

export function summaryText(s: LinesSummary): string {
  const bits = [`${s.linked} linked`];
  if (s.estimated > 0) bits.push(`${s.estimated} AI estimate${s.estimated === 1 ? "" : "s"}`);
  if (s.unlinked > 0) bits.push(`${s.unlinked} not linked`);
  if (s.negligible > 0) bits.push(`${s.negligible} not counted`);
  return bits.join(" · ");
}

export interface CaloriesHeadline {
  /** "490 kcal per serving" or "no calories yet". */
  main: string;
  /** "calories partly estimated" until no estimated or unlinked lines remain; null otherwise. */
  partly: string | null;
  /** "website says 520", beside the calculated figure, when the page gave one. */
  site: string | null;
  /** Where the figure came from, for a small caption. */
  origin: string | null;
}

export function caloriesHeadline(r: Pick<RecipeDetail, "nutrition" | "kcalPerServing">): CaloriesHeadline {
  const n = r.nutrition;
  if (!n) return { main: "no calories yet", partly: null, site: null, origin: null };
  const kcal = r.kcalPerServing ?? n.perServing.kcal;
  const fromSite = n.origin === "site";
  return {
    main: `${kcalText(kcal)} kcal per serving`,
    partly: !fromSite && !n.complete ? "calories partly estimated" : null,
    site: !fromSite && n.siteKcalPerServing !== undefined ? `website says ${kcalText(n.siteKcalPerServing)}` : null,
    origin: fromSite ? "from the website" : n.origin === "mixed" ? "added up from the linked foods and AI estimates" : "added up from the linked foods",
  };
}

// ---- requests ------------------------------------------------------------------------------------------------------

export type AmountBody = { quantity: number; servingId?: string } | { grams: number };

/** The body of POST /links that links line `index` to a food at an amount (the sheet's computed `body`). */
export function linkBody(index: number, foodId: string, amount: Partial<Amount>): { links: Array<Record<string, unknown>> } {
  const a: Record<string, unknown> = {};
  if (amount.grams != null && !amount.servingId) a.grams = amount.grams;
  else {
    if (amount.quantity != null) a.quantity = amount.quantity;
    if (amount.servingId) a.servingId = amount.servingId;
  }
  return { links: [{ index, foodId, ...a }] };
}

/** The body of POST /links that takes a line's food (and estimate) off. */
export const unlinkBody = (index: number): { links: Array<Record<string, unknown>> } => ({ links: [{ index, clear: true }] });

/** Where the amount step starts for a food the line is about to use: the amount the reader worked out, else 1 serving. */
export function startFor(food: Food, amount: Partial<Amount> | null | undefined): AmountInput {
  return startAmount(food, amount ?? null);
}

/**
 * Search results a line may use. A recipe's own food can't be an ingredient of another recipe yet, and a joint
 * recipe can't name someone's personal food (the household reads it). The server refuses both; this just doesn't offer them.
 */
export function usableFoods(foods: Food[], recipeScope: "joint" | "personal"): Food[] {
  return foods.filter((f) => f.source !== "recipe" && (recipeScope === "personal" || f.scope !== "personal"));
}

// ---- yield and serving ----------------------------------------------------------------------------------------------

export interface YieldForm {
  yieldServings: string;
  servingLabel: string;
  totalCookedG: string;
}

export const yieldFormOf = (r: Pick<RecipeDetail, "yieldServings" | "servingLabel" | "totalCookedG">): YieldForm => ({
  yieldServings: r.yieldServings === null ? "" : String(r.yieldServings),
  servingLabel: r.servingLabel ?? "",
  totalCookedG: r.totalCookedG === undefined ? "" : String(r.totalCookedG),
});

export interface YieldBody {
  yieldServings: number;
  /** "" puts the default name back ("serving"). */
  servingLabel: string;
  /** null clears the cooked weight. */
  totalCookedG: number | null;
}

const num = (text: string): number | null => (text.trim() !== "" && Number.isFinite(Number(text)) ? Number(text) : null);

/** The PUT body for the yield form, or the sentence that says what to fix. Limits are the server's. */
export function yieldBody(form: YieldForm): { body: YieldBody } | { error: string } {
  const y = num(form.yieldServings);
  if (y === null || y < 0.01 || y > 1000) return { error: "Say how many servings it makes (a number above 0)." };
  const label = form.servingLabel.trim();
  if (label.length > 40) return { error: "Keep the serving name to 40 characters or fewer." };
  let g: number | null = null;
  if (form.totalCookedG.trim() !== "") {
    g = num(form.totalCookedG);
    if (g === null || g < 0.01 || g > 100_000) return { error: "The cooked weight is a number of grams above 0, or leave it empty." };
  }
  return { body: { yieldServings: y, servingLabel: label, totalCookedG: g } };
}

/** Did the form change anything compared with the recipe? */
export function yieldChanged(form: YieldForm, r: Pick<RecipeDetail, "yieldServings" | "servingLabel" | "totalCookedG">): boolean {
  const was = yieldFormOf(r);
  return form.yieldServings.trim() !== was.yieldServings || form.servingLabel.trim() !== was.servingLabel || form.totalCookedG.trim() !== was.totalCookedG;
}
