// The barcode routes over HTTP, ported from the calorie app's barcodes.test.ts: the scan
// (POST /barcodes/lookup, which was POST /foods/from-barcode), linking a code to a food you
// already have, the miss log, the offline list, and the two-spouse case migration 6 exists for.
// The lookup cascade itself is tested in nutritionLookup.test.ts; here it is either a fake
// that answers by code, or the real cascade over a fake network (the last test).

import { test, after } from "node:test";
import assert from "node:assert/strict";

import { cleanupDb } from "./helpers/testdb.ts";
import { newApi, type Api } from "./helpers/nutritionApi.ts";
import { NOW, TODAY, addGeneric, customFood } from "./helpers/nutritionWorld.ts";
import { gs1CheckDigitValid } from "../nutrition/barcode.ts";
import { get, all } from "../nutrition/data/sql.ts";
import { lookupBarcode } from "../nutrition/lookup.ts";

after(cleanupDb);

const CHEERIOS = "016000275287";
const CHEERIOS_14 = "00016000275287";

/** A valid UPC-A built from its first 11 digits (computes the check digit). */
function upcA(first11: string): string {
  for (let k = 0; k <= 9; k++) if (gs1CheckDigitValid(first11 + k)) return first11 + k;
  throw new Error("unreachable");
}
const UNKNOWN = upcA("01234567890");
const UNKNOWN_2 = upcA("07777777777");
const STORE_LABEL = upcA("21234500123"); // UPC-A starting 2: a price/weight label

const cheerios = {
  source: "off" as const, name: "Cheerios", brand: "General Mills", servingText: "1 cup (28 g)", servingGrams: 28,
  per100g: { kcal: 357, protein: 10.7, carbs: 71.4, fat: 7.1, satFat: 1.8, sugars: 3.6, fiber: 10.7, sodiumMg: 600 },
};

const scan = (api: Api, who: "ann" | "ben", code: string, extra: object = {}) => api.call(who, "POST", "/barcodes/lookup", { code, ...extra });
const mkFood = async (api: Api, who: "ann" | "ben", name: string, extra: object = {}) =>
  (await api.call(who, "POST", "/foods", { ...customFood(name, 100), ...extra })).body;
const link = (api: Api, who: "ann" | "ben", foodId: string, code: string, extra: object = {}) =>
  api.call(who, "POST", `/foods/${foodId}/barcode`, { code, ...extra });

test("a scan makes a joint food from the databases once, then resolves to it with no upstream lookup", async (t) => {
  const api = await newApi(t);
  api.answers[CHEERIOS] = cheerios;

  const first = await scan(api, "ann", CHEERIOS);
  assert.equal(first.status, 201);
  assert.deepEqual([first.body.created, first.body.lookupHit, first.body.food.scope, first.body.food.source], [true, true, "joint", "off"]);
  assert.deepEqual([first.body.food.gtin14, first.body.food.sourceRef, first.body.food.brand, first.body.food.basis], [CHEERIOS_14, CHEERIOS_14, "General Mills", "per100g"]);
  assert.deepEqual(first.body.food.servings.map((s: any) => [s.label, s.grams, s.isDefault]), [["1 cup (28 g)", 28, true], ["100 g", 100, false]]);
  assert.equal(first.body.food.nutrients.sodiumMg, 600);

  // Ben, another width of the same code: the household's food, no second lookup.
  const second = await scan(api, "ben", "0016000275287");
  assert.deepEqual([second.status, second.body.created, second.body.food.id], [200, false, first.body.food.id]);
  assert.deepEqual(api.lookupCalls, [CHEERIOS], "only the first scan went upstream");
  assert.equal(all(api.w.db, "SELECT id FROM nutrition_foods WHERE gtin14 = ?", CHEERIOS_14).length, 1);

  // Logging it like any scanned food: 28 g of 357 kcal/100 g.
  const entry = await api.call("ben", "POST", `/diary/${TODAY}`, { slot: "snacks", foodId: first.body.food.id, source: "scan" });
  assert.equal(entry.body.entry.nutrients.kcal, 99.96);
});

test("a drink whose serving Open Food Facts gives in ml is labelled in ml", async (t) => {
  const api = await newApi(t);
  api.answers[CHEERIOS] = { ...cheerios, name: "Cola", brand: "Fizz", servingText: "355 ml", servingGrams: 355, servingUnit: "ml", per100g: { ...cheerios.per100g, kcal: 42 } };
  const made = await scan(api, "ann", CHEERIOS);
  assert.deepEqual(made.body.food.servings.map((s: any) => [s.label, s.grams, s.isDefault]), [["355 ml", 355, true], ["100 ml", 100, false]]);
  const entry = await api.call("ann", "POST", `/diary/${TODAY}`, { slot: "snacks", foodId: made.body.food.id, quantity: 1, source: "scan" });
  assert.deepEqual([entry.body.entry.unit, entry.body.entry.nutrients.kcal], ["355 ml", 149.1]);
});

test("a name-only answer is not a hit: a miss is logged and the name comes back so the UI can offer 'create food'", async (t) => {
  const api = await newApi(t);
  api.answers[UNKNOWN] = { source: "upcitemdb", name: "Mystery Snack", brand: "Acme", nameOnly: true };
  const r = await scan(api, "ann", UNKNOWN);
  assert.equal(r.status, 404);
  assert.deepEqual([r.body.lookupHit, r.body.gtin14, r.body.lookup.name, r.body.lookup.brand, r.body.lookup.nameOnly], [false, `00${UNKNOWN}`, "Mystery Snack", "Acme", true]);
  assert.equal(all(api.w.db, "SELECT id FROM nutrition_foods").length, 0, "no food was made from just a name");
  const list = (await api.call("ann", "GET", "/barcodes/misses")).body;
  assert.deepEqual(list.map((m: any) => [m.code, m.count, m.name, m.brand, m.resolved]), [[UNKNOWN, 1, "Mystery Snack", "Acme", false]]);

  // The same holds for OFF knowing the product but not its calories (nameOnly with source "off").
  api.answers[UNKNOWN_2] = { source: "off", name: "No Calories Listed", nameOnly: true };
  assert.deepEqual([(await scan(api, "ann", UNKNOWN_2)).status, (await scan(api, "ann", UNKNOWN_2)).body.lookupHit], [404, false]);
});

test("misses: counted per code, most frequent first, shared by both logins, and keep a name an earlier scan found", async (t) => {
  const api = await newApi(t);
  assert.deepEqual((await api.call("ann", "GET", "/barcodes/misses")).body, []);
  api.answers[UNKNOWN] = { source: "upcitemdb", name: "Mystery Snack", brand: "Acme", nameOnly: true };

  assert.equal((await scan(api, "ann", UNKNOWN_2)).status, 404); // nothing knows it, not even a name
  assert.equal((await scan(api, "ann", UNKNOWN)).status, 404);
  api.setNow(new Date("2026-03-12T15:00:00Z"));
  assert.equal((await scan(api, "ben", UNKNOWN)).status, 404); // the partner scans the same item two days later

  const list = (await api.call("ann", "GET", "/barcodes/misses")).body;
  assert.deepEqual(list.map((m: any) => [m.code, m.count, m.name, m.brand, m.resolved]), [
    [UNKNOWN, 2, "Mystery Snack", "Acme", false],
    [UNKNOWN_2, 1, null, null, false],
  ]);
  assert.deepEqual([list[0].firstSeenAt, list[0].lastSeenAt], [NOW.toISOString(), "2026-03-12T15:00:00.000Z"]);
  assert.deepEqual((await api.call("ben", "GET", "/barcodes/misses")).body, list, "one list for the household");
  assert.equal((await api.call("ann", "GET", "/barcodes/misses?limit=1")).body.length, 1);

  delete api.answers[UNKNOWN];
  await scan(api, "ann", UNKNOWN);
  const kept = (await api.call("ann", "GET", "/barcodes/misses")).body[0];
  assert.deepEqual([kept.count, kept.name, kept.brand], [3, "Mystery Snack", "Acme"]);
});

test("misses are resolved by a food that owns the code (made by hand or linked), until it is deleted", async (t) => {
  const api = await newApi(t);
  await scan(api, "ann", UNKNOWN);
  await scan(api, "ann", UNKNOWN_2);
  const state = async (who: "ann" | "ben" = "ann") =>
    Object.fromEntries((await api.call(who, "GET", "/barcodes/misses")).body.map((m: any) => [m.code, m.resolved ? m.foodName : false]));
  assert.deepEqual(await state(), { [UNKNOWN]: false, [UNKNOWN_2]: false });

  const created = await mkFood(api, "ann", "Mystery Snack", { gtin14: UNKNOWN });
  const other = await mkFood(api, "ann", "Other snack");
  await link(api, "ann", other.id, UNKNOWN_2);
  assert.deepEqual(await state(), { [UNKNOWN]: "Mystery Snack", [UNKNOWN_2]: "Other snack" });
  assert.equal((await api.call("ann", "GET", "/barcodes/misses")).body.length, 2, "the row is kept as history");

  await api.call("ann", "DELETE", `/foods/${created.id}`);
  assert.equal((await state())[UNKNOWN], false);
  await mkFood(api, "ann", "Private snack", { gtin14: UNKNOWN, scope: "personal" });
  assert.equal((await state("ann"))[UNKNOWN], "Private snack");
  assert.equal((await state("ben"))[UNKNOWN], false, "a personal food only resolves it for its owner");
});

test("only definite answers are logged: not outages, store labels or bad codes", async (t) => {
  const api = await newApi(t);
  api.answers[UNKNOWN] = { sourcesErrored: ["off"] };

  const down = await scan(api, "ann", UNKNOWN);
  assert.deepEqual([down.status, down.body.unavailable, down.body.gtin14, down.body.lookup.sourcesErrored], [503, true, `00${UNKNOWN}`, ["off"]]);

  const calls = api.lookupCalls.length;
  const label = await scan(api, "ann", STORE_LABEL);
  assert.deepEqual([label.status, label.body.randomWeight], [422, true]);
  assert.equal((await scan(api, "ann", "012345678900")).status, 400, "check digit");
  assert.equal((await api.call("ann", "POST", "/barcodes/lookup", {})).status, 400, "no code");
  assert.equal(api.lookupCalls.length, calls, "none of those reached the lookup");
  assert.deepEqual((await api.call("ann", "GET", "/barcodes/misses")).body, []);
});

test("an imported food gets a barcode, and the next scan resolves to it with zero upstream lookups", async (t) => {
  const api = await newApi(t);
  api.answers[CHEERIOS] = cheerios;
  const oatmeal = await mkFood(api, "ann", "Oatmeal");
  assert.equal(oatmeal.gtin14, null);

  const linked = await link(api, "ann", oatmeal.id, "0016000275287"); // any width of the same product
  assert.deepEqual([linked.status, linked.body.food.gtin14, linked.body.replaced], [200, CHEERIOS_14, null]);
  for (const who of ["ann", "ben"] as const) {
    const hit = await scan(api, who, CHEERIOS);
    assert.deepEqual([hit.status, hit.body.created, hit.body.food.id], [200, false, oatmeal.id]);
  }
  assert.equal(api.lookupCalls.length, 0);

  const un = await api.call("ann", "DELETE", `/foods/${oatmeal.id}/barcode`);
  assert.deepEqual([un.status, un.body.food.gtin14], [200, null]);
  assert.equal((await scan(api, "ann", CHEERIOS)).body.created, true, "the next scan goes upstream again");
});

test("linking: who may, which codes, and what a clash says", async (t) => {
  const api = await newApi(t);
  const mine = await mkFood(api, "ann", "Ann bar");
  const priv = await mkFood(api, "ann", "Ann secret bar", { scope: "personal" });
  const generic = addGeneric(api.w.db, "Rolled oats", 380);
  const gone = await mkFood(api, "ann", "Deleted bar");
  await api.call("ann", "DELETE", `/foods/${gone.id}`);

  assert.equal((await link(api, "ben", priv.id, UNKNOWN)).status, 404);
  assert.equal((await link(api, "ann", generic, UNKNOWN)).status, 403);
  assert.equal((await link(api, "ann", gone.id, UNKNOWN)).status, 404);
  assert.equal((await link(api, "ann", "no-such-food", UNKNOWN)).status, 404);
  assert.equal((await api.call("ben", "DELETE", `/foods/${priv.id}/barcode`)).status, 404);
  assert.equal((await api.call("ann", "DELETE", `/foods/${generic}/barcode`)).status, 403);
  assert.equal((await link(api, "ben", mine.id, UNKNOWN)).status, 200, "a joint food is Ben's to edit too");
  assert.equal((await link(api, "ann", mine.id, UNKNOWN)).body.previousGtin14, null);

  assert.equal((await link(api, "ann", mine.id, "012345678900")).status, 400, "check digit");
  assert.equal((await link(api, "ann", mine.id, "123")).status, 400, "length");
  assert.equal((await api.call("ann", "POST", `/foods/${mine.id}/barcode`, {})).status, 400, "no code");
  const label = await link(api, "ann", mine.id, STORE_LABEL);
  assert.equal(label.status, 400);
  assert.match(label.body.error, /price\/weight label/);

  const other = await mkFood(api, "ann", "Other bar");
  assert.equal((await link(api, "ann", other.id, "04252614")).status, 400, "UPC-E needs its format hint");
  assert.equal((await link(api, "ann", other.id, "04252614", { format: "upc_e" })).body.food.gtin14, "00042100005264");

  const second = await mkFood(api, "ann", "Second bar");
  const clash = await link(api, "ann", second.id, UNKNOWN);
  assert.equal(clash.status, 409);
  assert.match(clash.body.error, /"Ann bar"/);
  assert.equal(clash.body.conflict.id, mine.id);

  assert.equal((await link(api, "ann", mine.id, upcA("04444444444"))).body.previousGtin14, `00${UNKNOWN}`);
});

test("scanning a product the scan flow just made, then saying it was really your own food, moves the code over", async (t) => {
  const api = await newApi(t);
  api.answers[CHEERIOS] = cheerios;
  const mine = await mkFood(api, "ann", "My Cheerios");
  const dup = (await scan(api, "ann", CHEERIOS)).body.food;

  assert.equal((await link(api, "ann", mine.id, CHEERIOS)).status, 409, "unnamed, the code is simply taken");
  const handmade = await mkFood(api, "ann", "Hand made", { gtin14: upcA("05555555555") });
  assert.equal((await link(api, "ann", mine.id, handmade.gtin14, { replaceFoodId: handmade.id })).status, 409, "a hand-made food is never swept aside");

  const done = await link(api, "ann", mine.id, CHEERIOS, { replaceFoodId: dup.id });
  assert.equal(done.status, 200);
  assert.deepEqual(done.body.replaced, { id: dup.id, name: "Cheerios", action: "deleted" });
  assert.equal((await scan(api, "ben", CHEERIOS)).body.food.id, mine.id);
  assert.equal(api.lookupCalls.length, 1, "only the first scan went upstream");
  assert.ok(!(await api.call("ann", "GET", "/foods/search?q=cheerios")).body.some((f: any) => f.id === dup.id));
});

test("the offline list: barcoded foods you can see, one per code, with what the amount step needs", async (t) => {
  const api = await newApi(t);
  api.answers[CHEERIOS] = cheerios;
  assert.deepEqual((await api.call("ann", "GET", "/foods/barcodes")).body, []);

  const scanned = (await scan(api, "ann", CHEERIOS)).body.food;
  await mkFood(api, "ann", "Barcoded bar", { gtin14: UNKNOWN });
  await mkFood(api, "ann", "No barcode");
  await mkFood(api, "ann", "Ann private", { gtin14: upcA("03333333333"), scope: "personal" });
  addGeneric(api.w.db, "Generic oats", 380);

  const mineList = (await api.call("ann", "GET", "/foods/barcodes")).body;
  assert.deepEqual(mineList.map((f: any) => f.name).sort(), ["Ann private", "Barcoded bar", "Cheerios"]);
  const ch = mineList.find((f: any) => f.id === scanned.id);
  assert.deepEqual([ch.gtin14, ch.defaultServing.label, ch.kcal, ch.nutrients.kcal, ch.servings.length], [CHEERIOS_14, "1 cup (28 g)", 99.96, 357, 2]);
  assert.equal(mineList.find((f: any) => f.name === "Barcoded bar").kcal, 100);
  assert.deepEqual((await api.call("ben", "GET", "/foods/barcodes")).body.map((f: any) => f.name).sort(), ["Barcoded bar", "Cheerios"]);
});

test("link candidates: your foods without a barcode that share a word, never the USDA list or a personal food of someone else's", async (t) => {
  const api = await newApi(t);
  const names = async (q: string, who: "ann" | "ben" = "ann", extra = "") =>
    (await api.call(who, "GET", `/foods/link-candidates?q=${encodeURIComponent(q)}${extra}`)).body.map((f: any) => f.name);
  await mkFood(api, "ann", "Honey Nut Cheerios");
  await mkFood(api, "ann", "Cheerios Oat Crunch", { gtin14: UNKNOWN });
  await mkFood(api, "ann", "Cheerios secret", { scope: "personal" });
  addGeneric(api.w.db, "Cheerios, cereal", 376);

  assert.deepEqual((await names("Cheerios Cereal General Mills")).sort(), ["Cheerios secret", "Honey Nut Cheerios"]);
  assert.deepEqual(await names("Cheerios Cereal General Mills", "ben"), ["Honey Nut Cheerios"]);
  assert.deepEqual(await names("the and of"), []);
  for (let i = 1; i <= 7; i++) await mkFood(api, "ann", `Oat bar ${i}`);
  assert.equal((await names("oat bar")).length, 5);
  assert.equal((await names("oat bar", "ann", "&limit=3")).length, 3);
});

test("two spouses: Ann's personal food with a code neither blocks Ben's scan nor answers it", async (t) => {
  const api = await newApi(t);
  api.answers[CHEERIOS] = cheerios;
  const annsOwn = await mkFood(api, "ann", "Ann's Cheerios", { scope: "personal", gtin14: CHEERIOS });

  // Ann's scan lands on her own food, with no lookup.
  const annScan = await scan(api, "ann", CHEERIOS);
  assert.deepEqual([annScan.status, annScan.body.food.id], [200, annsOwn.id]);
  assert.equal(api.lookupCalls.length, 0);

  // Ben can't see it: his scan goes upstream and makes HIS household's joint food -- the insert is not blocked.
  const benScan = await scan(api, "ben", CHEERIOS);
  assert.deepEqual([benScan.status, benScan.body.created, benScan.body.food.scope], [201, true, "joint"]);
  assert.notEqual(benScan.body.food.id, annsOwn.id);
  assert.deepEqual(api.lookupCalls, [CHEERIOS]);
  assert.doesNotMatch(JSON.stringify(benScan.body), /Ann's Cheerios/);

  // Now both exist; each resolves to the right one, and Ann still prefers hers.
  assert.equal((await scan(api, "ann", CHEERIOS)).body.food.id, annsOwn.id);
  assert.equal((await scan(api, "ben", CHEERIOS)).body.food.id, benScan.body.food.id);
  assert.deepEqual((await api.call("ann", "GET", "/foods/barcodes")).body.map((f: any) => f.name), ["Ann's Cheerios"]);

  // Ben saving his own food (personal or joint) with that code is no longer a 409, and no message names Ann's.
  const benFood = await mkFood(api, "ben", "Ben's own", { scope: "personal" });
  const linked = await link(api, "ben", benFood.id, CHEERIOS);
  assert.equal(linked.status, 200);
  assert.equal((await api.call("ben", "POST", "/foods", { ...customFood("Ben's other", 80), scope: "personal", gtin14: CHEERIOS })).status, 409, "his own scope still collides");
  const clash = await api.call("ben", "POST", "/foods", { ...customFood("Ben's other", 80), scope: "personal", gtin14: CHEERIOS });
  assert.doesNotMatch(JSON.stringify(clash.body), /Ann/);

  // The miss list stays per person too: a personal food resolves a miss only for its owner.
  const other = upcA("06060606060");
  await scan(api, "ann", other);
  await mkFood(api, "ben", "Ben only", { scope: "personal", gtin14: other });
  assert.equal((await api.call("ann", "GET", "/barcodes/misses")).body.find((m: any) => m.code === other).resolved, false);
  assert.equal((await api.call("ben", "GET", "/barcodes/misses")).body.find((m: any) => m.code === other).foodName, "Ben only");
});

test("the real cascade over a fake network: OFF -> a food and a cached answer; the next scan never reaches the network", async (t) => {
  let net = 0;
  const fetchFn = (async (url: string) => {
    net++;
    const off = String(url).includes("openfoodfacts") && String(url).includes("6000275287");
    return new Response(JSON.stringify(off ? { product: { product_name: "Cheerios", brands: "General Mills", serving_size: "28 g", serving_quantity: 28, nutriments: { "energy-kcal_100g": 357 } } } : {}), { status: off ? 200 : 404 });
  }) as unknown as typeof fetch;
  const api: Api = await newApi(t, { lookup: (code, format) => lookupBarcode(api.w.db, code, format, { fetch: fetchFn, now: () => NOW.getTime(), fdcApiKey: null }) });

  const first = await scan(api, "ann", CHEERIOS);
  assert.deepEqual([first.status, first.body.food.name, first.body.food.nutrients.kcal], [201, "Cheerios", 357]);
  assert.equal(net, 1);
  assert.equal((await scan(api, "ben", CHEERIOS)).status, 200);
  assert.equal(net, 1, "the product is a food now, so the scan doesn't reach the cascade");
  assert.equal(get<{ found: number }>(api.w.db, "SELECT found FROM nutrition_barcode_lookups WHERE gtin14 = ?", CHEERIOS_14)!.found, 1);

  // A scan of an unknown code is a miss in both the cache and the miss log -- and a later scan reuses the cached miss.
  assert.equal((await scan(api, "ann", UNKNOWN)).status, 404);
  const asked = net;
  assert.equal((await scan(api, "ben", UNKNOWN)).status, 404);
  assert.equal(net, asked, "a remembered miss costs no network");
  assert.equal((await api.call("ann", "GET", "/barcodes/misses")).body[0].count, 2);
});
