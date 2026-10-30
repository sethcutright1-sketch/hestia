// Barcode -> product name for Pantry scan in/out. Only ever called for a barcode not already
// linked to a local pantry item -- routes/pantry.ts checks findByBarcode first, so this is
// strictly the "we've never seen this barcode before" path.
//
// Since the nutrition merge this is a thin wrapper over the ONE barcode service the food diary's
// scanner uses too (nutrition/lookup.ts): local cache -> Open Food Facts -> USDA FoodData Central
// -> UPCitemdb, answers remembered in the SQLite table nutrition_barcode_lookups (90 days for a
// product, 14 for "nobody knows it"). So a product scanned into the pantry is already cached when
// the same barcode is scanned into a diary, and the other way round. Pantry only needs a name, so
// a name-only answer (Open Food Facts knowing the product but not its calories, or UPCitemdb) is
// perfectly good here even though the diary treats it as "no nutrition".
//
// What used to live here: an Open Food Facts-only fetch cached forever in app_config under
// `barcode_cache:<barcode>`. Those entries are kept and still READ (see legacyCore below), so no
// barcode that already resolved is lost; nothing new is written to them and nothing is deleted.

import { getConfig, db } from "./db.ts";
import { InvalidBarcodeError, lookupBarcode as lookupInSharedService, type Core } from "./nutrition/lookup.ts";
import { lookupVariants } from "./nutrition/barcode.ts";

export class BarcodeLookupError extends Error {}

export interface BarcodeProduct {
  name: string;
  brand?: string;
}

const LEGACY_CACHE_PREFIX = "barcode_cache:";

/** A name-only Core for a product Pantry resolved under the old per-barcode cache, if any. */
function legacyProduct(...spellings: string[]): BarcodeProduct | undefined {
  for (const s of spellings) {
    const hit = getConfig(`${LEGACY_CACHE_PREFIX}${s}`, undefined) as BarcodeProduct | undefined;
    if (hit && typeof hit.name === "string" && hit.name.trim()) return hit;
  }
  return undefined;
}

function legacyCore(gtin14: string, raw: string): Core | null {
  // The old key was whatever string the scanner produced: try it as scanned, then every width of the GTIN.
  const hit = legacyProduct(raw, ...lookupVariants(gtin14));
  if (!hit) return null;
  return {
    source: "off", name: hit.name, brand: hit.brand ?? null, servingText: null, servingGrams: null, servingUnit: "g",
    per100g: null, perServing: null, nameOnly: true,
  };
}

export async function lookupBarcode(barcode: string): Promise<BarcodeProduct | null> {
  let result;
  try {
    result = await lookupInSharedService(db, barcode, undefined, { fallback: legacyCore });
  } catch (err) {
    if (err instanceof InvalidBarcodeError) {
      // Not a UPC/EAN (or a misread): nothing upstream can know it. The old cache might, though.
      const hit = legacyProduct(barcode);
      return hit ? { name: hit.name.trim(), ...(hit.brand ? { brand: hit.brand } : {}) } : null;
    }
    throw err;
  }
  if (result.name) return { name: result.name.trim(), ...(result.brand ? { brand: result.brand } : {}) };
  // Nothing found. If a source was down it might have known: say so, so the caller doesn't read
  // an outage as "this product doesn't exist". A genuine "nobody knows it" is null.
  if (result.sourcesErrored.length > 0) {
    throw new BarcodeLookupError(`Barcode lookup failed (${result.sourcesErrored.join(", ")} unavailable)`);
  }
  return null;
}
