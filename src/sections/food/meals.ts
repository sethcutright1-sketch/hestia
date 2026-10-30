// "A meal" as a list of food amounts, and what the Food section does with one: log a saved or previous
// meal, copy a meal or a day to another day, save a meal. Pure, so the request bodies and the wording are
// tested without a browser (tests/foodMeals.test.ts).
//
// The same item shape comes from three places:
//   - GET /saved-meals         the items of a saved meal
//   - GET /meals/previous      the items of a meal eaten lately
//   - itemsFromEntries()       a meal of the day on screen, for "Copy to..." and "Save as meal" (each food
//                              entry of the day carries `relog`, the amount that logs it again, which the
//                              server worked out)
//
// Logging any of them is one bulk diary write (POST /diary/:date/bulk): every item carries a client UUID, all
// share a groupId, so a replayed request creates nothing twice and DELETE /diary/group/:groupId undoes the lot.

import type { DiaryEntry, MealItem, PreviousMeal } from "./types.ts";

/** A fresh client id (8-64 of A-Z a-z 0-9 _ -, as the bulk write requires). randomUUID needs a secure context, so plain http gets a fallback. */
export function newId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return crypto.randomUUID();
  return "id-" + Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Items that can actually be written: a food that exists and is yours to log (not a quick add). */
export const loggable = (items: MealItem[]): MealItem[] => items.filter((i) => i.available && i.foodId && !i.isQuickAdd);

/** Amount fields of a bulk item: a gram weight for per-100 g foods logged by weight, else servings. */
export const amountOf = (i: Pick<MealItem, "quantity" | "servingId" | "grams">): { grams: number } | { quantity: number; servingId?: string } =>
  i.servingId == null && i.grams != null
    ? { grams: i.grams }
    : { quantity: i.quantity, ...(i.servingId ? { servingId: i.servingId } : {}) };

export interface BulkBody {
  slot: string;
  groupId: string;
  source: string;
  items: Array<{ id: string; foodId: string; grams?: number; quantity?: number; servingId?: string }>;
}

/** The body of POST /diary/:date/bulk. `ids` are the client ids, one per item, in the same order. */
export function bulkBody(o: { slot: string; items: MealItem[]; groupId: string; ids: string[]; source?: string }): BulkBody {
  return {
    slot: o.slot,
    groupId: o.groupId,
    source: o.source ?? "copy",
    items: o.items.map((i, k) => ({ id: o.ids[k], foodId: i.foodId!, ...amountOf(i) })),
  };
}

/**
 * Items from a meal of the day. Only LOGGED entries count: a planned entry is an intention, not something
 * eaten, so it is neither copied nor saved (the same rule as "previous meals"). Quick adds and foods that
 * are gone have no `relog`; they come back in `skipped` so the screen can say so.
 */
export function itemsFromEntries(entries: DiaryEntry[]): { items: MealItem[]; skipped: DiaryEntry[]; plannedLeftOut: number } {
  const items: MealItem[] = [];
  const skipped: DiaryEntry[] = [];
  let plannedLeftOut = 0;
  for (const e of entries) {
    if (e.status !== "logged") { plannedLeftOut++; continue; }
    if (e.isQuickAdd || !e.foodId || !e.relog) { skipped.push(e); continue; }
    items.push({
      foodId: e.foodId,
      name: e.name,
      quantity: e.relog.quantity ?? e.quantity,
      servingId: e.relog.servingId ?? null,
      grams: e.relog.grams ?? null,
      unit: e.unit,
      totalGrams: e.grams ?? null,
      nutrients: e.nutrients,
      kcal: e.nutrients.kcal,
      isQuickAdd: false,
      available: true,
    });
  }
  return { items, skipped, plannedLeftOut };
}

/** kcal that logging these items adds (only what can be logged counts). */
export const mealKcal = (items: MealItem[]): number =>
  Math.round(loggable(items).reduce((a, i) => a + (i.kcal ?? i.nutrients?.kcal ?? 0), 0) * 100) / 100;

/** The previous meals worth offering for this slot and day: not the very meal being added to. */
export const previousFor = (meals: PreviousMeal[], date: string, slot: string): PreviousMeal[] =>
  meals.filter((m) => !(m.date === date && m.slotKey === slot));

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "Added 3 items to Breakfast." and, when something had no food to copy, say so. */
export function loggedMessage(o: { count: number; skippedCount?: number; where: string; planned?: boolean }): string {
  const base = `${o.planned ? "Planned" : "Added"} ${plural(o.count, "item")} ${o.planned ? "for" : "to"} ${o.where}`;
  const skipped = o.skippedCount ?? 0;
  if (skipped <= 0) return `${base}.`;
  const what = skipped === 1 ? "1 entry without a food wasn't" : `${skipped} entries without a food weren't`;
  return `${base} (${what} copied).`;
}

/** "Rolled oats", or "Rolled oats + 2 more": a starting name for a saved meal that the person is free to change. */
export function suggestName(items: Array<{ name: string }>): string {
  if (!items.length) return "";
  const first = items[0].name.replace(/\s*\(.*\)\s*$/, "");
  return items.length === 1 ? first : `${first} + ${items.length - 1} more`;
}

/** The sentence under a copy form: what the target day means. */
export const copyDayHint = (target: string, today: string): string =>
  target > today
    ? "That day is in the future, so the items are added as planned."
    : "The items are added to your diary for that day.";

export interface RecipeFromMealBody {
  name: string;
  scope: "joint" | "personal";
  yieldServings: number;
  items: Array<{ foodId: string } & ({ grams: number } | { quantity: number; servingId?: string })>;
}

/** The body of POST /recipes ("Save as recipe"): the meal's food amounts, shared with the household unless "Only me". */
export function recipeBody(o: { name: string; onlyMe: boolean; yieldServings: number; items: MealItem[] }): RecipeFromMealBody {
  return {
    name: o.name.trim(),
    scope: o.onlyMe ? "personal" : "joint",
    yieldServings: o.yieldServings,
    items: o.items.map((i) => ({ foodId: i.foodId!, ...amountOf(i) })),
  };
}

/** The servings box of "Save as recipe": a number above 0 (up to 1,000, the server's limit), else null. */
export function parseYield(text: string): number | null {
  const n = Number(text);
  return text.trim() !== "" && Number.isFinite(n) && n >= 0.01 && n <= 1000 ? n : null;
}

export const MAX_MEAL_NAME = 120;

/** Why a saved meal's new name won't do, or null: not empty, at most 120 characters (the server's limit). */
export function mealNameProblem(name: string): string | null {
  const n = name.trim();
  if (!n) return "Give the meal a name.";
  if (n.length > MAX_MEAL_NAME) return `Keep the name to ${MAX_MEAL_NAME} characters or fewer.`;
  return null;
}

/** What to say after "Save as recipe": the recipe's name, its lines and its calories per serving. */
export function recipeSavedMessage(r: { name: string; lines: unknown[]; kcalPerServing: number | null }, scope: "joint" | "personal"): string {
  const kcal = r.kcalPerServing === null ? "" : `, ${Math.round(r.kcalPerServing).toLocaleString("en-US")} kcal per serving`;
  const where = scope === "personal" ? "Only you can see it, and it can't go on the shared meal plan." : "It is in the household's recipes, so it can go on the meal plan.";
  return `Saved the recipe "${r.name}" (${plural(r.lines.length, "line")}${kcal}). ${where}`;
}
