// Calories per serving for Kroger products, borrowed from the Nutrition section's barcode lookup.
//
// Kroger's Products API gives us no nutrition facts, but its `upc` is a retail GTIN, so it goes
// straight into nutrition/lookup.ts (local cache -> Open Food Facts -> USDA FoodData Central).
// Calories are an extra on the send screen, never a requirement: a product nobody has data for,
// a slow upstream, or a failed lookup all just mean "no calories shown".
//
// Pure of Express and of the real network: the lookup is a parameter, so tests drive it with fakes.

import type { KrogerProduct, ProductCalories } from "./kroger.ts";
import type { LookupResult } from "./nutrition/lookup.ts";
import type { Preview } from "./krogerMatch.ts";

export type CalorieLookup = (upc: string) => Promise<LookupResult>;

/** How long one preview waits for calories before showing what it has. Lookups still running keep
 *  going and land in the lookup cache, so the next preview of the same list is warm. */
const BUDGET_MS = 6000;
const CONCURRENCY = 6;

/**
 * Calories in one serving, or null when the lookup can't say. Per serving only: a per-100 g figure
 * is used only when the serving's weight is known, so a number is never shown against the wrong
 * amount. In-store price-embedded labels (random weight) aren't stable product ids, so they never
 * count.
 */
export function caloriesOf(r: LookupResult): ProductCalories | null {
  if (r.randomWeight || r.nameOnly || (r.source !== "off" && r.source !== "fdc")) return null;
  const serving = r.servingText?.trim() || null;
  let kcal = r.perServing?.kcal ?? null;
  if (kcal === null && r.per100g?.kcal != null && r.servingGrams) kcal = (r.per100g.kcal * r.servingGrams) / 100;
  if (kcal === null || !Number.isFinite(kcal) || kcal < 0) return null;
  return { kcal: Math.round(kcal), serving };
}

/** Calories for each UPC that has them. Never throws; stops starting new lookups after the budget. */
export async function caloriesByUpc(
  upcs: string[],
  lookup: CalorieLookup,
  opts: { budgetMs?: number; concurrency?: number } = {}
): Promise<Map<string, ProductCalories>> {
  const found = new Map<string, ProductCalories>();
  const waiting = [...new Set(upcs)];
  const worker = async () => {
    for (let upc = waiting.shift(); upc !== undefined; upc = waiting.shift()) {
      try {
        const c = caloriesOf(await lookup(upc));
        if (c) found.set(upc, c);
      } catch {
        // A bad code or a flaky source: this product just has no calories.
      }
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, opts.budgetMs ?? BUDGET_MS);
  });
  await Promise.race([Promise.all(Array.from({ length: opts.concurrency ?? CONCURRENCY }, worker)), deadline]);
  clearTimeout(timer);
  waiting.length = 0;
  return new Map(found); // a copy: lookups still in flight must not change what this call returned
}

export function addCalories(products: KrogerProduct[], calories: Map<string, ProductCalories>): KrogerProduct[] {
  return products.map((p) => ({ ...p, calories: calories.get(p.upc) ?? null }));
}

function previewProducts(preview: Preview): KrogerProduct[] {
  return preview.items.flatMap((i) => [...(i.product ? [i.product] : []), ...i.options]);
}

/** The preview with calories on every product and every option. */
export async function previewWithCalories<P extends Preview>(preview: P, lookup: CalorieLookup): Promise<P> {
  const calories = await caloriesByUpc(previewProducts(preview).map((p) => p.upc), lookup);
  const tag = (p: KrogerProduct) => ({ ...p, calories: calories.get(p.upc) ?? null });
  return { ...preview, items: preview.items.map((i) => ({ ...i, product: i.product ? tag(i.product) : null, options: i.options.map(tag) })) };
}

export async function productsWithCalories(products: KrogerProduct[], lookup: CalorieLookup): Promise<KrogerProduct[]> {
  return addCalories(products, await caloriesByUpc(products.map((p) => p.upc), lookup));
}
