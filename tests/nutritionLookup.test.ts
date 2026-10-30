// The one barcode lookup cascade and its SQLite cache, driven by a fake network and a fake clock:
// nothing here reaches Open Food Facts, USDA or UPCitemdb. Ported from the calorie app's
// lookup.test.ts and usda.test.ts (the one-time JSON-cache import is not ported: household-app
// never had that file), plus what is new in household-app: no FDC key means no FDC step, and
// the `fallback` hook Pantry uses for its old cache.

import { test, after } from "node:test";
import assert from "node:assert/strict";

import { cleanupDb } from "./helpers/testdb.ts";
import { newWorld } from "./helpers/nutritionWorld.ts";
import { NEGATIVE_TTL_MS, POSITIVE_TTL_MS } from "../nutrition/data/barcodeCache.ts";
import { get, type Db } from "../nutrition/data/sql.ts";
import {
  InvalidBarcodeError, lookupBarcode, lookupHit, offServing, type LookupDeps,
} from "../nutrition/lookup.ts";
import { mapFdcNutrients } from "../nutrition/usda.ts";

after(cleanupDb);

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 2, 10);
const CHEERIOS = "016000275287"; // GTIN-14 00016000275287
const UNKNOWN = "012345678905"; // valid check digit, in no database

type Reply = { status: number; body?: unknown } | "network";
type Source = "off" | "fdc" | "upc";

/** A network that answers per source and counts what it was asked. */
function fakeNet(replies: Partial<Record<Source, Reply | (() => Reply)>>) {
  const calls: Source[] = [];
  const urls: string[] = [];
  const headers: Array<Record<string, string> | undefined> = [];
  const set = { ...replies };
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const source: Source = url.includes("openfoodfacts") ? "off" : url.includes("nal.usda.gov") ? "fdc" : "upc";
    calls.push(source);
    urls.push(url);
    headers.push(init?.headers as Record<string, string> | undefined);
    const r = set[source] ?? { status: 404 };
    const reply = typeof r === "function" ? r() : r;
    if (reply === "network") throw new TypeError("fetch failed");
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status });
  }) as typeof fetch;
  return { fetch: fetchFn, calls, urls, headers, set };
}

const offProduct = (extra: Record<string, unknown> = {}) => ({
  status: 200,
  body: {
    product: {
      product_name: "Cheerios", brands: "General Mills, Other", serving_size: "1 cup (28 g)", serving_quantity: 28,
      nutriments: { "energy-kcal_100g": 357, proteins_100g: 10.7, carbohydrates_100g: 71.4, fat_100g: 7.1, sodium_100g: 0.6 },
      ...extra,
    },
  },
});

function clock(start = T0) {
  let t = start;
  const deps = { now: () => t, fdcApiKey: "test-key" } satisfies LookupDeps;
  return { deps, advance: (ms: number) => { t += ms; } };
}

const row = (db: Db, gtin14: string) =>
  get<{ found: number; source: string | null; tries: number; result: string | null }>(db, "SELECT * FROM nutrition_barcode_lookups WHERE gtin14 = ?", gtin14);

const newDb = async (t: Parameters<typeof newWorld>[0]) => (await newWorld(t)).db;

test("a hit is stored in nutrition_barcode_lookups and the next scan never touches the network", async (t) => {
  const db = await newDb(t);
  const net = fakeNet({ off: offProduct() });
  const { deps } = clock();

  const first = await lookupBarcode(db, CHEERIOS, undefined, { ...deps, fetch: net.fetch });
  assert.equal(first.source, "off");
  assert.equal(first.cached, false);
  assert.equal(first.name, "Cheerios");
  assert.equal(first.brand, "General Mills");
  assert.equal(first.per100g?.sodiumMg, 600);
  assert.ok(lookupHit(first));
  assert.deepEqual(net.calls, ["off"], "a complete answer stops the cascade");
  const stored = row(db, "00016000275287")!; // one row, keyed by the 14-digit form whatever width was scanned
  assert.deepEqual([stored.found, stored.source, stored.tries], [1, "off", 1]);
  assert.equal(JSON.parse(stored.result!).name, "Cheerios");

  const second = await lookupBarcode(db, "0016000275287", undefined, { ...deps, fetch: net.fetch }); // another width, same product
  assert.equal(second.cached, true);
  assert.equal(second.name, "Cheerios");
  assert.deepEqual(net.calls, ["off"]);
});

test("Open Food Facts is asked with the v3 API and an identifying User-Agent", async (t) => {
  const db = await newDb(t);
  const net = fakeNet({ off: offProduct() });
  await lookupBarcode(db, CHEERIOS, undefined, { ...clock().deps, fetch: net.fetch, offUserAgent: "Test/1.0 (me@example.com)" });
  assert.match(net.urls[0], /^https:\/\/world\.openfoodfacts\.org\/api\/v3\/product\/0016000275287\?fields=/);
  assert.equal(net.headers[0]!["User-Agent"], "Test/1.0 (me@example.com)");
});

test("a name-only answer is not a lookupHit; neither is nothing", async (t) => {
  const db = await newDb(t);
  const named = await lookupBarcode(db, CHEERIOS, undefined, { ...clock().deps, fetch: fakeNet({ off: { status: 200, body: { product: { product_name: "Cheerios" } } } }).fetch });
  assert.deepEqual([named.nameOnly, named.name, lookupHit(named)], [true, "Cheerios", false]);
  const nothing = await lookupBarcode(db, UNKNOWN, undefined, { ...clock().deps, fetch: fakeNet({}).fetch });
  assert.equal(lookupHit(nothing), false);
  const upc = await lookupBarcode(db, "012345678912", undefined, { ...clock().deps, fetch: fakeNet({ upc: { status: 200, body: { items: [{ title: "Snack" }] } } }).fetch });
  assert.deepEqual([upc.source, upc.nameOnly, lookupHit(upc)], ["upcitemdb", true, false]);
});

test("a miss is remembered for 14 days, then asked again", async (t) => {
  const db = await newDb(t);
  const net = fakeNet({}); // everything answers 404
  const c = clock();
  const deps = { ...c.deps, fetch: net.fetch };

  const first = await lookupBarcode(db, UNKNOWN, undefined, deps);
  assert.equal(first.source, null);
  assert.deepEqual(first.sourcesErrored, []);
  assert.equal(row(db, "00012345678905")?.found, 0);
  const asked = net.calls.length;
  assert.ok(asked >= 3, "off, fdc (each width) and upcitemdb all said no");

  c.advance(NEGATIVE_TTL_MS - DAY);
  const cachedMiss = await lookupBarcode(db, UNKNOWN, undefined, deps);
  assert.equal(cachedMiss.cached, true);
  assert.equal(net.calls.length, asked);

  c.advance(2 * DAY); // 15 days after the first lookup
  const again = await lookupBarcode(db, UNKNOWN, undefined, deps);
  assert.equal(again.cached, false);
  assert.equal(net.calls.length, asked * 2);
  assert.equal(row(db, "00012345678905")?.tries, 2, "tries counts the upstream lookups behind the row");
});

test("a hit is remembered for 90 days", async (t) => {
  const db = await newDb(t);
  const net = fakeNet({ off: offProduct() });
  const c = clock();
  const deps = { ...c.deps, fetch: net.fetch };
  await lookupBarcode(db, CHEERIOS, undefined, deps);

  c.advance(POSITIVE_TTL_MS - DAY);
  assert.equal((await lookupBarcode(db, CHEERIOS, undefined, deps)).cached, true);
  assert.equal(net.calls.length, 1);

  c.advance(2 * DAY);
  const stale = await lookupBarcode(db, CHEERIOS, undefined, deps);
  assert.equal(stale.cached, false);
  assert.equal(net.calls.length, 2);
  assert.equal(row(db, "00016000275287")?.tries, 2);
});

test("a miss is never cached when a source errored (it is unknown, not absent)", async (t) => {
  const db = await newDb(t);
  const net = fakeNet({ off: { status: 503 } });
  const deps = { ...clock().deps, fetch: net.fetch };

  const down = await lookupBarcode(db, CHEERIOS, undefined, deps);
  assert.equal(down.source, null);
  assert.deepEqual(down.sourcesErrored, ["off"]);
  assert.equal(row(db, "00016000275287"), undefined, "nothing was stored");

  // Open Food Facts recovers: the very next scan finds the product instead of a cached "not found".
  net.set.off = offProduct();
  const up = await lookupBarcode(db, CHEERIOS, undefined, deps);
  assert.equal(up.source, "off");
  assert.deepEqual(up.sourcesErrored, []);
  assert.equal(row(db, "00016000275287")?.found, 1);
});

test("timeouts, rate limits, bad keys and dropped connections all count as errors, not misses (a 401/403 from USDA included)", async (t) => {
  for (const reply of [{ status: 429 }, { status: 403 }, { status: 401 }, { status: 500 }, "network"] as Reply[]) {
    const db = await newDb(t);
    const net = fakeNet({ off: reply, fdc: reply, upc: reply });
    const out = await lookupBarcode(db, UNKNOWN, undefined, { ...clock().deps, fetch: net.fetch });
    assert.deepEqual(out.sourcesErrored, ["off", "fdc", "upcitemdb"], JSON.stringify(reply));
    assert.equal(row(db, "00012345678905"), undefined);
  }
});

test("a name-only answer is not stored while a better source was down, and is once everyone answered", async (t) => {
  const db = await newDb(t);
  const nameOnly = { status: 200, body: { items: [{ title: "Mystery Snack", brand: "Acme" }] } };
  const net = fakeNet({ off: { status: 503 }, upc: nameOnly });
  const deps = { ...clock().deps, fetch: net.fetch };

  const partial = await lookupBarcode(db, UNKNOWN, undefined, deps);
  assert.equal(partial.nameOnly, true);
  assert.equal(partial.name, "Mystery Snack");
  assert.deepEqual(partial.sourcesErrored, ["off"]);
  assert.equal(row(db, "00012345678905"), undefined, "OFF might have had real nutrition");

  net.set.off = { status: 404 };
  const settled = await lookupBarcode(db, UNKNOWN, undefined, deps);
  assert.equal(settled.nameOnly, true);
  assert.deepEqual(settled.sourcesErrored, []);
  assert.equal(row(db, "00012345678905")?.source, "upcitemdb");
});

test("UPCitemdb (100 lookups a day) is only spent when nothing else knew the product", async (t) => {
  const db = await newDb(t);
  // OFF knows the name but has no nutrition; FDC knows nothing.
  const net = fakeNet({ off: { status: 200, body: { product: { product_name: "Cheerios" } } } });
  const out = await lookupBarcode(db, CHEERIOS, undefined, { ...clock().deps, fetch: net.fetch });
  assert.equal(out.nameOnly, true);
  assert.equal(out.source, "off");
  assert.ok(!net.calls.includes("upc"));
});

test("a name-only OFF answer does not stop the cascade finding real nutrition in USDA", async (t) => {
  const db = await newDb(t);
  const fdc = { status: 200, body: { foods: [{
    gtinUpc: "016000275287", description: "CHEERIOS", brandOwner: "General Mills", servingSize: 28, servingSizeUnit: "g",
    foodNutrients: [{ nutrientId: 1008, value: 357 }, { nutrientId: 1003, value: 10.7 }],
  }] } };
  const net = fakeNet({ off: { status: 200, body: { product: { product_name: "Cheerios" } } }, fdc });
  const out = await lookupBarcode(db, CHEERIOS, undefined, { ...clock().deps, fetch: net.fetch });
  assert.deepEqual([out.source, out.nameOnly, out.per100g?.kcal, out.servingGrams, out.perServing?.kcal], ["fdc", false, 357, 28, 99.96]);
  assert.ok(lookupHit(out));
  assert.match(net.urls.find((u) => u.includes("nal.usda.gov"))!, /api_key=test-key/);
});

test("with no FDC key the USDA step is skipped: not called, not an error, and the answer is still cached", async (t) => {
  const db = await newDb(t);
  const net = fakeNet({});
  const out = await lookupBarcode(db, UNKNOWN, undefined, { now: () => T0, fetch: net.fetch, fdcApiKey: null });
  assert.ok(!net.calls.includes("fdc"));
  assert.deepEqual(out.sourcesErrored, []);
  assert.equal(row(db, "00012345678905")?.found, 0);
});

test("the FDC key is read from FDC_API_KEY when not passed in (an empty value is no key)", async (t) => {
  const saved = process.env.FDC_API_KEY;
  try {
    process.env.FDC_API_KEY = "  ";
    const none = fakeNet({});
    await lookupBarcode(await newDb(t), UNKNOWN, undefined, { now: () => T0, fetch: none.fetch });
    assert.ok(!none.calls.includes("fdc"));

    process.env.FDC_API_KEY = "env-key";
    const some = fakeNet({});
    await lookupBarcode(await newDb(t), UNKNOWN, undefined, { now: () => T0, fetch: some.fetch });
    assert.ok(some.urls.some((u) => u.includes("api_key=env-key")));
  } finally {
    if (saved === undefined) delete process.env.FDC_API_KEY;
    else process.env.FDC_API_KEY = saved;
  }
});

test("an invalid code throws before any network call", async (t) => {
  const db = await newDb(t);
  const net = fakeNet({});
  await assert.rejects(lookupBarcode(db, "012345678900", undefined, { fetch: net.fetch }), InvalidBarcodeError);
  assert.equal(net.calls.length, 0);
});

test("the fallback is consulted after the cache and before the network, and is not copied into the cache", async (t) => {
  const db = await newDb(t);
  const net = fakeNet({ off: offProduct() });
  const legacy = { source: "off" as const, name: "Old Name", brand: null, servingText: null, servingGrams: null, servingUnit: "g" as const, per100g: null, perServing: null, nameOnly: true };
  let asked = 0;
  const deps = { ...clock().deps, fetch: net.fetch, fallback: () => { asked++; return legacy; } };
  const out = await lookupBarcode(db, CHEERIOS, undefined, deps);
  assert.deepEqual([out.name, out.cached, net.calls.length, asked], ["Old Name", true, 0, 1]);
  assert.equal(row(db, "00016000275287"), undefined);

  // Once the cache has a real answer, the fallback is no longer asked.
  const real = await lookupBarcode(db, CHEERIOS, undefined, { ...clock().deps, fetch: net.fetch });
  assert.equal(real.name, "Cheerios");
  await lookupBarcode(db, CHEERIOS, undefined, deps);
  assert.equal(asked, 1);
});

test("Open Food Facts serving in ml: labelled 'N ml', stored as an explicit ml = g approximation, per-100 values untouched", async (t) => {
  const db = await newDb(t);
  const cola = offProduct({
    product_name: "Cola", brands: "Fizz", serving_size: "1 can (355 ml)", serving_quantity: 355, serving_quantity_unit: "ml",
    nutriments: { "energy-kcal_100g": 42, carbohydrates_100g: 10.6 },
  });
  const net = fakeNet({ off: cola });
  const out = await lookupBarcode(db, CHEERIOS, undefined, { ...clock().deps, fetch: net.fetch });
  assert.equal(out.servingUnit, "ml");
  assert.equal(out.servingText, "355 ml");
  assert.equal(out.servingGrams, 355);
  assert.equal(out.per100g?.kcal, 42, "per-100 figures are not rescaled");
  assert.equal(out.perServing?.kcal, 149.1);
  // And it survives the cache round trip.
  const cached = await lookupBarcode(db, CHEERIOS, undefined, { ...clock().deps, fetch: net.fetch });
  assert.deepEqual([cached.cached, cached.servingUnit, cached.servingText], [true, "ml", "355 ml"]);
});

test("offServing: unit field wins, older records fall back to the serving text, grams stay grams", () => {
  assert.deepEqual(offServing({ serving_size: "30 g", serving_quantity: 30, serving_quantity_unit: "g" }), { text: "30 g", grams: 30, unit: "g" });
  assert.deepEqual(offServing({ serving_size: "30 g", serving_quantity: 30 }), { text: "30 g", grams: 30, unit: "g" });
  assert.deepEqual(offServing({ serving_size: "250 ml", serving_quantity: "250" }), { text: "250 ml", grams: 250, unit: "ml" }, "no unit field, text says ml");
  assert.deepEqual(offServing({ serving_size: "1 glass (240ml)", serving_quantity: 240, serving_quantity_unit: "ML" }), { text: "240 ml", grams: 240, unit: "ml" });
  // A text with both units (a cup of cereal weighed in grams, mentioning ml) is not guessed to be a drink.
  assert.equal(offServing({ serving_size: "30 g (about 120 ml)", serving_quantity: 30 }).unit, "g");
  // ml but no number: keep the product's own words and no weight.
  assert.deepEqual(offServing({ serving_size: "1 bottle", serving_quantity_unit: "ml" }), { text: "1 bottle", grams: null, unit: "ml" });
  assert.deepEqual(offServing({}), { text: null, grams: null, unit: "g" });
});

// ---- USDA nutrient mapping (shared with the catalogue importer) ---------------------------------------

test("usda: maps nutrient ids (full-detail shape)", () => {
  const n = mapFdcNutrients([
    { nutrientId: 1008, amount: 89 }, { nutrientId: 1003, amount: 1.09 }, { nutrientId: 1005, amount: 22.84 },
    { nutrientId: 1004, amount: 0.33 }, { nutrientId: 1258, amount: 0.112 }, { nutrientId: 2000, amount: 12.23 },
    { nutrientId: 1079, amount: 2.6 }, { nutrientId: 1253, amount: 0 }, { nutrientId: 1093, amount: 1 },
    { nutrientId: 1062, amount: 372 }, // kJ: ignored
  ])!;
  assert.deepEqual(n, { kcal: 89, protein: 1.09, carbs: 22.84, fat: 0.33, satFat: 0.11, sugars: 12.23, fiber: 2.6, cholesterolMg: 0, sodiumMg: 1 });
});

test("usda: maps legacy nutrient numbers (abridged /foods/list shape)", () => {
  const n = mapFdcNutrients([{ number: "208", amount: 52 }, { number: 203, amount: 0.3 }, { number: "268", amount: 218 }])!;
  assert.equal(n.kcal, 52);
  assert.equal(n.protein, 0.3);
});

test("usda: Foundation foods without 1008 fall back to Atwater energy", () => {
  assert.equal(mapFdcNutrients([{ nutrientId: 2048, amount: 90 }, { nutrientId: 2047, amount: 95 }])!.kcal, 95);
  assert.equal(mapFdcNutrients([{ nutrientId: 2048, amount: 90 }])!.kcal, 90);
  assert.equal(mapFdcNutrients([{ nutrientId: 1008, amount: 80 }, { nutrientId: 2047, amount: 95 }])!.kcal, 80);
});

test("usda: no energy value at all -> null", () => {
  assert.equal(mapFdcNutrients([{ nutrientId: 1003, amount: 5 }]), null);
  assert.equal(mapFdcNutrients(undefined), null);
});
