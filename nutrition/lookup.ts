// The one barcode lookup service, shared by the food diary's scanner and Pantry's scan in/out.
//
// A barcode goes through the same cascade whoever asks: local cache -> Open Food Facts -> USDA
// FoodData Central -> UPCitemdb (a name only). Each remote source gets a short timeout, and any
// failure just means "try the next one" -- a phone in a grocery aisle should never sit waiting on
// one flaky upstream. It is server-side so the FDC key never reaches a phone and one cache covers
// every device.
//
// The cache is the SQLite table nutrition_barcode_lookups (data/barcodeCache.ts: 90 days for an
// answer, 14 for a miss). Both the database and the network are parameters, so tests drive the
// whole cascade with a fake fetch and a fake clock and never reach the real services.
//
// Who calls this:
//   - routes/nutrition/barcodes.ts: a scan that turns into a food (and the miss log).
//   - barcodeLookup.ts: Pantry's `lookupBarcode(barcode)`, which only wants a name.
//
// Ported from the calorie app's lookup.ts. Changes: the cache and `Db` are the nutrition data
// layer's; the FDC key is read like every other key (process.env at call time) and with NO key
// the FDC step is skipped instead of using api.data.gov's throttled DEMO_KEY; a `fallback` hook
// lets Pantry consult its old app_config cache before going to the network.

import { canonicalGtin, isRandomWeight, lookupVariants } from "./barcode.ts";
import { readCached, writeCached, type CachedLookup } from "./data/barcodeCache.ts";
import type { Db } from "./data/sql.ts";

const SOURCE_TIMEOUT_MS = 5000;

export type Source = "off" | "fdc" | "upcitemdb";

export interface Nutrition {
  kcal: number | null;
  protein: number | null;
  carbs: number | null;
  fat: number | null;
  satFat: number | null;
  sugars: number | null;
  fiber: number | null;
  sodiumMg: number | null;
}

export interface LookupResult {
  gtin14: string;
  raw: string;
  source: Source | null;
  name: string | null;
  brand: string | null;
  servingText: string | null;
  // Serving size as a number. When servingUnit is "ml" this is the volume in ml and
  // doubles as grams (see offServing); either way it is what to multiply per100g by.
  servingGrams: number | null;
  servingUnit: "g" | "ml";
  per100g: Nutrition | null;
  perServing: Nutrition | null;
  nameOnly: boolean;
  cached: boolean;
  lookupMs: number;
  // Sources that failed (timeout/5xx/429/bad key) rather than answering "not found".
  sourcesErrored: Source[];
  // In-store price/weight labels aren't stable product ids; flagged for the UI.
  randomWeight: boolean;
}

/**
 * True only when the lookup found NUTRITION from a database we can build a food from. A name-only
 * answer (Open Food Facts knowing the product but not its calories, or UPCitemdb) is not a hit:
 * it cannot make a food, so the scan records a miss and offers "create food" with the name filled in.
 */
export function lookupHit(r: Pick<LookupResult, "per100g" | "nameOnly" | "source">): boolean {
  return r.per100g !== null && !r.nameOnly && (r.source === "off" || r.source === "fdc");
}

export class InvalidBarcodeError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "InvalidBarcodeError";
  }
}

// A source that is down, rate limited or refusing our key. Distinct from "not found" so we don't
// negative-cache a product just because an upstream hiccuped.
class SourceUnavailableError extends Error {
  constructor(public source: Source, detail: string) {
    super(`${source}: ${detail}`);
    this.name = "SourceUnavailableError";
  }
}

// Float math (per100g * grams / 100) yields 12.300000000000001, which then shows up
// in the UI and the stored JSON.
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function num(v: unknown): number | null {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? round2(n) : null;
}

/** What one source found: a LookupResult minus everything the cascade adds. This is what the cache stores. */
export type Core = Omit<LookupResult, "gtin14" | "raw" | "cached" | "lookupMs" | "sourcesErrored" | "randomWeight">;

function scale(n: Nutrition, grams: number): Nutrition {
  const f = (v: number | null) => (v === null ? null : round2((v * grams) / 100));
  return {
    kcal: f(n.kcal), protein: f(n.protein), carbs: f(n.carbs), fat: f(n.fat),
    satFat: f(n.satFat), sugars: f(n.sugars), fiber: f(n.fiber), sodiumMg: f(n.sodiumMg),
  };
}

function withServing(c: Omit<Core, "perServing">): Core {
  const perServing = c.per100g && c.servingGrams ? scale(c.per100g, c.servingGrams) : null;
  return { ...c, perServing };
}

// ---- sources -------------------------------------------------------------

type FetchJson = (source: Source, url: string, headers?: Record<string, string>) => Promise<{ status: number; body: any }>;

function makeFetchJson(fetchImpl: typeof fetch): FetchJson {
  return async (source, url, headers = {}) => {
    let res: Response;
    try {
      res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS) });
    } catch (err: any) {
      throw new SourceUnavailableError(source, err?.name === "TimeoutError" ? "timed out" : "network error");
    }
    // 401/403 is a bad or blocked key (api.data.gov answers this way), not "product
    // unknown"; treating it as a miss would negative-cache real products for 14 days.
    if (res.status === 401 || res.status === 403 || res.status === 429 || res.status >= 500) {
      throw new SourceUnavailableError(source, `status ${res.status}`);
    }
    let body: any = null;
    try {
      body = await res.json();
    } catch {
      // 404 bodies are sometimes empty/non-JSON; callers only need the status then.
    }
    return { status: res.status, body };
  };
}

const OFF_FIELDS = "code,product_name,brands,nutriments,serving_size,serving_quantity,serving_quantity_unit";

/**
 * Open Food Facts reports `serving_quantity` in grams for solids and in millilitres for
 * drinks, and says which in `serving_quantity_unit`. Reading a 355 ml can as "355 g" is a
 * silent mislabel, so a millilitre serving is labelled "355 ml".
 *
 * The number is still stored as grams: the per-100 figures are per 100 ml for liquids,
 * and the rest of the app has exactly one "weight of a serving" column. Treating 1 ml as
 * 1 g (density ~ 1, true to within a few percent for water, soda, juice, milk) is an
 * explicit approximation; it keeps the kcal per serving right, which is what gets logged.
 */
export function offServing(p: any): { text: string | null; grams: number | null; unit: "g" | "ml" } {
  const qty = num(p?.serving_quantity);
  const text = typeof p?.serving_size === "string" && p.serving_size.trim() ? p.serving_size.trim() : null;
  const field = typeof p?.serving_quantity_unit === "string" ? p.serving_quantity_unit.trim().toLowerCase() : "";
  // Older records have no unit field; a serving_size reading "250 ml" (and not grams) still says so.
  const ml = field ? field === "ml" : text !== null && /\d\s*ml\b/i.test(text) && !/\d\s*g\b/i.test(text);
  if (ml && qty) return { text: `${qty} ml`, grams: qty, unit: "ml" };
  return { text, grams: qty, unit: ml ? "ml" : "g" };
}

/** Map an Open Food Facts product to a lookup result; null when it has neither a name nor calories. */
export function offCore(p: any): Core | null {
  const n = p?.nutriments || {};
  const kcal = num(n["energy-kcal_100g"]);
  if (!p?.product_name && kcal === null) return null;
  const sodiumG = num(n["sodium_100g"]);
  const serving = offServing(p);
  return withServing({
    source: "off",
    name: p.product_name || null,
    brand: p.brands ? String(p.brands).split(",")[0].trim() : null,
    servingText: serving.text,
    servingGrams: serving.grams,
    servingUnit: serving.unit,
    per100g:
      kcal === null
        ? null
        : {
            kcal,
            protein: num(n["proteins_100g"]),
            carbs: num(n["carbohydrates_100g"]),
            fat: num(n["fat_100g"]),
            satFat: num(n["saturated-fat_100g"]),
            sugars: num(n["sugars_100g"]),
            fiber: num(n["fiber_100g"]),
            sodiumMg: sodiumG === null ? null : round2(sodiumG * 1000),
          },
    nameOnly: kcal === null,
  });
}

async function lookupOff(gtin14: string, fetchJson: FetchJson, ctx: Ctx): Promise<Core | null> {
  // OFF normalises to EAN-13; EAN-8s keep 8 digits.
  const code = gtin14.startsWith("000000") ? gtin14.slice(6) : gtin14.slice(1);
  const { status, body } = await fetchJson(
    "off",
    `https://world.openfoodfacts.org/api/v3/product/${code}?fields=${OFF_FIELDS}`,
    { "User-Agent": ctx.offUserAgent }
  );
  if (status === 404 || !body?.product) return null;
  return offCore(body.product);
}

// FDC nutrient ids (Branded foods report per 100 g).
const FDC = { kcal: 1008, protein: 1003, fat: 1004, carbs: 1005, fiber: 1079, sugars: 2000, satFat: 1258, sodium: 1093 };

async function lookupFdc(gtin14: string, fetchJson: FetchJson, ctx: Ctx): Promise<Core | null> {
  const key = ctx.fdcApiKey;
  if (!key) return null; // never reached: the cascade skips this source without a key
  // FDC matches the exact stored string, so try each width. Compare results after
  // canonicalising because it returns the code in whatever width it stored.
  for (const variant of lookupVariants(gtin14)) {
    const url =
      `https://api.nal.usda.gov/fdc/v1/foods/search?api_key=${encodeURIComponent(key)}` +
      `&query=${variant}&dataType=Branded&pageSize=10`;
    const { status, body } = await fetchJson("fdc", url);
    if (status !== 200 || !Array.isArray(body?.foods)) continue;
    const food = body.foods.find((f: any) => canonicalGtin(String(f.gtinUpc || ""))?.gtin14 === gtin14);
    if (!food) continue;

    const val = (id: number) => num(food.foodNutrients?.find((x: any) => x.nutrientId === id)?.value);
    const kcal = val(FDC.kcal);
    const unit = String(food.servingSizeUnit || "").toLowerCase();
    // Only grams convert cleanly here; a ml serving would need the density approximation
    // OFF gets (offServing) and FDC branded drinks have not been looked at yet.
    const servingGrams = unit === "g" || unit === "grm" ? num(food.servingSize) : null;
    return withServing({
      source: "fdc",
      name: food.description || null,
      brand: food.brandName || food.brandOwner || null,
      servingText:
        food.householdServingFullText ||
        (food.servingSize ? `${food.servingSize} ${food.servingSizeUnit || ""}`.trim() : null),
      servingGrams,
      servingUnit: "g",
      per100g:
        kcal === null
          ? null
          : {
              kcal,
              protein: val(FDC.protein),
              carbs: val(FDC.carbs),
              fat: val(FDC.fat),
              satFat: val(FDC.satFat),
              sugars: val(FDC.sugars),
              fiber: val(FDC.fiber),
              sodiumMg: val(FDC.sodium),
            },
      nameOnly: kcal === null,
    });
  }
  return null;
}

async function lookupUpcItemDb(gtin14: string, fetchJson: FetchJson): Promise<Core | null> {
  const variants = lookupVariants(gtin14);
  const code = variants.find((v) => v.length === 12) || variants.find((v) => v.length === 13) || variants[0];
  const { status, body } = await fetchJson("upcitemdb", `https://api.upcitemdb.com/prod/trial/lookup?upc=${code}`);
  const item = status === 200 ? body?.items?.[0] : null;
  if (!item?.title) return null;
  return {
    source: "upcitemdb",
    name: item.title,
    brand: item.brand || null,
    servingText: null,
    servingGrams: null,
    servingUnit: "g",
    per100g: null,
    perServing: null,
    nameOnly: true,
  };
}

interface Ctx {
  fdcApiKey: string | null;
  offUserAgent: string;
}

const SOURCES: Array<[Source, (g: string, fetchJson: FetchJson, ctx: Ctx) => Promise<Core | null>]> = [
  ["off", lookupOff],
  ["fdc", lookupFdc],
  ["upcitemdb", (g, f) => lookupUpcItemDb(g, f)],
];

// ---- cascade -------------------------------------------------------------

export interface LookupDeps {
  /** The network. Tests pass a fake that answers by URL. */
  fetch?: typeof fetch;
  /** Milliseconds since the epoch; tests move it to cross the cache TTLs. */
  now?: () => number;
  /** The FDC key. Default: process.env.FDC_API_KEY read now. Empty/absent: the FDC step is skipped. */
  fdcApiKey?: string | null;
  /** Sent to Open Food Facts (they ask apps to identify themselves). Default: process.env.OFF_USER_AGENT. */
  offUserAgent?: string;
  /**
   * Consulted after the cache and BEFORE the network: an older cache this service replaces
   * (Pantry's app_config entries). Whatever it returns is used as a cached answer and is not
   * copied into the table, so a name-only legacy answer can't hide real nutrition for 90 days.
   */
  fallback?: (gtin14: string, raw: string) => Core | null;
}

export async function lookupBarcode(db: Db, rawCode: string, format?: string, deps: LookupDeps = {}): Promise<LookupResult> {
  const now = deps.now ?? Date.now;
  const fetchJson = makeFetchJson(deps.fetch ?? fetch);
  const started = now();
  const canon = canonicalGtin(rawCode, format);
  if (!canon) throw new InvalidBarcodeError("Not a valid UPC/EAN barcode (length or check digit is wrong).");
  const { gtin14, raw } = canon;
  const randomWeight = isRandomWeight(gtin14);
  const ctx: Ctx = {
    fdcApiKey: (deps.fdcApiKey === undefined ? process.env.FDC_API_KEY : deps.fdcApiKey)?.trim() || null,
    offUserAgent: deps.offUserAgent ?? (process.env.OFF_USER_AGENT || "HouseholdApp/1.0 (self-hosted household app)"),
  };
  const miss: Core = {
    source: null, name: null, brand: null, servingText: null, servingGrams: null, servingUnit: "g",
    per100g: null, perServing: null, nameOnly: false,
  };
  const result = (core: Core, cached: boolean, sourcesErrored: Source[]): LookupResult => ({
    gtin14, raw, randomWeight, ...core, cached, sourcesErrored, lookupMs: now() - started,
  });

  const hit = readCached(db, gtin14, started);
  if (hit) return result((hit.core as Core | null) ?? miss, true, []);

  const old = deps.fallback?.(gtin14, raw);
  if (old) return result(old, true, []);

  const errored: Source[] = [];
  // A name-only answer (e.g. OFF has the product but no nutrition) shouldn't stop
  // us finding real numbers further down, so remember it and keep going.
  let best: Core | null = null;
  for (const [source, fn] of SOURCES) {
    // UPCitemdb is name-only and capped at 100/day: only spend it when nothing else knew the item.
    if (source === "upcitemdb" && best) continue;
    // No FDC key configured: not an error and not a miss, the source is simply not part of the cascade.
    if (source === "fdc" && !ctx.fdcApiKey) continue;
    let found: Core | null;
    try {
      found = await fn(gtin14, fetchJson, ctx);
    } catch (err) {
      if (err instanceof SourceUnavailableError) {
        errored.push(source);
        continue;
      }
      throw err;
    }
    if (!found) continue;
    if (!best || (best.nameOnly && !found.nameOnly)) best = found;
    if (!found.nameOnly) break;
  }

  // Remember what we learned, unless a source was down and could have known better:
  // a miss would hide the product for 14 days, and a name-only answer would hide real
  // nutrition for 90. A complete answer (nutrition) is final whatever else errored.
  const final = best !== null && !best.nameOnly;
  if (final || errored.length === 0) writeCached(db, gtin14, best as CachedLookup | null, now());
  return result(best ?? miss, false, errored);
}

/** The lookup the app uses: this database as the cache, the real network. */
export const makeLookup = (db: Db, deps: LookupDeps = {}) => (code: string, format?: string): Promise<LookupResult> =>
  lookupBarcode(db, code, format, deps);
