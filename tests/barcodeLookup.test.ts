// Pantry's barcodeLookup.ts against a stubbed fetch -- never hits a real service.
//
// Since the nutrition merge it is a thin wrapper over the shared lookup cascade
// (nutrition/lookup.ts, tested on its own in nutritionLookup.test.ts): Open Food Facts, then
// USDA (only with a key), then UPCitemdb, remembered in the SQLite table
// nutrition_barcode_lookups. What is asserted here is the CONTRACT Pantry relies on: a name (and
// brand) for a hit, null for "nobody knows it", BarcodeLookupError for an outage, and that the
// old app_config cache is still honoured.
//
// Assumptions that changed with the merge (and so were rewritten rather than kept):
//   - barcodes must now be real UPC/EAN codes (check digit valid); a string that isn't one can't
//     be looked up upstream, so it resolves to null without a network call;
//   - a miss IS remembered (14 days, shared table) -- the old code never cached one;
//   - a failure needs every source to fail before it is an outage, since the cascade tries three.

import { test, describe, after, afterEach } from "node:test";
import assert from "node:assert/strict";

import { loadDb, cleanupDb } from "./helpers/testdb.ts";

// barcodeLookup.ts imports db.ts for its cache -- load the throwaway DB first, same ordering
// rule as every other test file here.
const { db, setConfig } = await loadDb();
const { lookupBarcode, BarcodeLookupError } = await import("../barcodeLookup.ts");

after(cleanupDb);

const realFetch = globalThis.fetch;
const realFdcKey = process.env.FDC_API_KEY;
afterEach(() => {
  globalThis.fetch = realFetch;
  if (realFdcKey === undefined) delete process.env.FDC_API_KEY;
  else process.env.FDC_API_KEY = realFdcKey;
});

// Real GTINs (valid check digit), one per test so the shared cache never leaks between them.
const COKE = "5449000000996";
let next = 0;
/** A new valid EAN-13 each call (a counter plus its check digit). */
function fresh(): string {
  const d12 = `50123${String(++next).padStart(7, "0")}`;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(d12[i]) * (i % 2 === 0 ? 1 : 3);
  return d12 + ((10 - (sum % 10)) % 10);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** Answers by host, counting calls. */
function stubNet(answers: { off?: unknown; fdc?: unknown; upc?: unknown; status?: number }) {
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    const which = url.includes("openfoodfacts") ? "off" : url.includes("usda.gov") ? "fdc" : "upc";
    calls.push(which);
    const body = answers[which];
    return body === undefined ? jsonResponse({}, answers.status ?? 404) : jsonResponse(body, answers.status ?? 200);
  }) as any;
  return calls;
}

describe("lookupBarcode (Pantry)", () => {
  test("resolves a hit to name/brand", async () => {
    stubNet({ off: { code: COKE, status: 1, product: { product_name: "Coca-Cola", brands: "Coca-Cola" } } });
    assert.deepEqual(await lookupBarcode(COKE), { name: "Coca-Cola", brand: "Coca-Cola" });
  });

  test("a product with a name but no nutrition still gives Pantry its name", async () => {
    const code = fresh();
    stubNet({ off: { product: { product_name: "Mystery Crackers" } } });
    assert.deepEqual(await lookupBarcode(code), { name: "Mystery Crackers" });
  });

  test("falls through to UPCitemdb when Open Food Facts has never heard of it", async () => {
    const code = fresh();
    const calls = stubNet({ upc: { items: [{ title: "Store Brand Rice", brand: "Acme" }] } });
    assert.deepEqual(await lookupBarcode(code), { name: "Store Brand Rice", brand: "Acme" });
    assert.deepEqual(calls, ["off", "upc"], "no USDA call without a key");
  });

  test("returns null when nobody knows it (a clean miss, not an error)", async () => {
    const code = fresh();
    stubNet({ off: { code: "0", status: 0, status_verbose: "no code or invalid code" } });
    assert.equal(await lookupBarcode(code), null);
  });

  test("a hit with no product_name and no calories is a miss", async () => {
    const code = fresh();
    stubNet({ off: { status: 1, product: {} } });
    assert.equal(await lookupBarcode(code), null);
  });

  test("throws BarcodeLookupError on a network failure", async () => {
    const code = fresh();
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as any;
    await assert.rejects(() => lookupBarcode(code), BarcodeLookupError);
  });

  test("throws BarcodeLookupError when the sources answer with server errors", async () => {
    const code = fresh();
    globalThis.fetch = (async () => jsonResponse({}, 500)) as any;
    await assert.rejects(() => lookupBarcode(code), BarcodeLookupError);
  });

  test("an outage is not remembered: the next lookup asks again", async () => {
    const code = fresh();
    globalThis.fetch = (async () => jsonResponse({}, 503)) as any;
    await assert.rejects(() => lookupBarcode(code), BarcodeLookupError);
    stubNet({ off: { product: { product_name: "Back Online" } } });
    assert.equal((await lookupBarcode(code))?.name, "Back Online");
  });

  test("caches a positive hit -- a second lookup never calls fetch again", async () => {
    const code = fresh();
    const calls = stubNet({ off: { status: 1, product: { product_name: "Cached Thing" } } });
    assert.equal((await lookupBarcode(code))?.name, "Cached Thing");
    const n = calls.length;
    assert.equal((await lookupBarcode(code))?.name, "Cached Thing");
    assert.equal(calls.length, n, "a cached hit must not call fetch again");
    // ...and it lives in the table the food diary's scanner reads too.
    const row = db.prepare("SELECT found, source FROM nutrition_barcode_lookups WHERE gtin14 = ?").get(code.padStart(14, "0")) as any;
    assert.deepEqual({ ...row }, { found: 1, source: "off" });
  });

  test("a miss is remembered too (14 days), shared with the diary scanner", async () => {
    const code = fresh();
    const calls = stubNet({ off: { status: 0 } });
    assert.equal(await lookupBarcode(code), null);
    const n = calls.length;
    assert.equal(await lookupBarcode(code), null);
    assert.equal(calls.length, n);
  });

  test("USDA is only asked when an FDC_API_KEY is configured", async () => {
    const withoutKey = fresh();
    delete process.env.FDC_API_KEY;
    let calls = stubNet({});
    await lookupBarcode(withoutKey);
    assert.ok(!calls.includes("fdc"));

    const withKey = fresh();
    process.env.FDC_API_KEY = "test-key";
    calls = stubNet({});
    await lookupBarcode(withKey);
    assert.ok(calls.includes("fdc"));
  });

  test("a code that is not a valid UPC/EAN resolves to null without a network call", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return jsonResponse({});
    }) as any;
    assert.equal(await lookupBarcode("hit-basic"), null);
    assert.equal(await lookupBarcode("1111111111111"), null, "wrong check digit");
    assert.equal(called, false);
  });

  describe("the old app_config cache (barcode_cache:*)", () => {
    test("an entry written before the merge still resolves, with no network call and nothing deleted", async () => {
      const code = fresh();
      setConfig(`barcode_cache:${code}`, { name: "Old Pantry Find", brand: "Legacy" });
      globalThis.fetch = (async () => {
        throw new Error("must not call the network for a barcode the old cache knew");
      }) as any;
      assert.deepEqual(await lookupBarcode(code), { name: "Old Pantry Find", brand: "Legacy" });
      assert.ok(db.prepare("SELECT 1 FROM app_config WHERE key = ?").get(`barcode_cache:${code}`), "the legacy entry is kept");
      assert.equal(db.prepare("SELECT 1 FROM nutrition_barcode_lookups WHERE gtin14 = ?").get(code.padStart(14, "0")), undefined,
        "not copied into the shared table, where a name-only copy could hide real nutrition for 90 days");
    });

    test("it is found under any spelling of the code (an old key was whatever the scanner sent)", async () => {
      const code = fresh();
      setConfig(`barcode_cache:${code.padStart(14, "0")}`, { name: "Padded Key" });
      globalThis.fetch = (async () => {
        throw new Error("no network");
      }) as any;
      assert.equal((await lookupBarcode(code))?.name, "Padded Key");
    });

    test("a legacy entry for a string that isn't a GTIN still answers", async () => {
      setConfig("barcode_cache:not-a-gtin", { name: "Odd Code" });
      assert.deepEqual(await lookupBarcode("not-a-gtin"), { name: "Odd Code" });
    });

    test("the shared cache wins over the legacy one once it has an answer", async () => {
      const code = fresh();
      stubNet({ off: { product: { product_name: "New Name" } } });
      await lookupBarcode(code);
      setConfig(`barcode_cache:${code}`, { name: "Stale Name" });
      assert.equal((await lookupBarcode(code))?.name, "New Name");
    });
  });
});
