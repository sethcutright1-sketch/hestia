// The database half of barcodes: attaching a scanned code to a food you already have, the miss
// log, the offline barcode list, "is this one of your foods?", and the lookup cache's lifetimes.
// Ported from the calorie app's barcodes.test.ts. The upstream lookup cascade and the
// scan route are tested in nutritionLookup / nutritionBarcodeRoutes, so a "scanned" food here is made with
// insertFood the way the scan route makes it.

import { test, after } from "node:test";
import assert from "node:assert/strict";

import { cleanupDb } from "./helpers/testdb.ts";
import { NOW, TODAY, addGeneric, customFood, newWorld, tableNames } from "./helpers/nutritionWorld.ts";
import { gs1CheckDigitValid } from "../nutrition/barcode.ts";
import { NEGATIVE_TTL_MS, POSITIVE_TTL_MS, readCached, writeCached } from "../nutrition/data/barcodeCache.ts";
import { displayCode, listMisses, recordMiss } from "../nutrition/data/barcodeMisses.ts";
import { addEntry } from "../nutrition/data/diary.ts";
import {
  attachBarcode, detachBarcode, findFoodByBarcode, linkCandidates, listBarcodedFoods,
} from "../nutrition/data/foodBarcodes.ts";
import { createFood, deleteFood, foodJson, getFood, insertFood, updateFood, type NewFood } from "../nutrition/data/foods.ts";
import { all, get } from "../nutrition/data/sql.ts";

after(cleanupDb);

const CHEERIOS = "016000275287";
const CHEERIOS_14 = "00016000275287";

/** A valid UPC-A built from its first 11 digits (computes the check digit). */
function upcA(first11: string): string {
  for (let k = 0; k <= 9; k++) if (gs1CheckDigitValid(first11 + k)) return first11 + k;
  throw new Error("unreachable");
}
const UNKNOWN = upcA("01234567890"); // 012345678905
const UNKNOWN_2 = upcA("07777777777");
const STORE_LABEL = upcA("21234500123"); // UPC-A starting 2: a price/weight label

const status = (fn: () => unknown): number => {
  try {
    fn();
  } catch (err: any) {
    return err.status ?? -1;
  }
  return 0;
};

async function setup(t: Parameters<typeof newWorld>[0]) {
  const w = await newWorld(t);
  const who = (name: "ann" | "ben") => w.tracker(w.ids[name]);
  const mk = (name: "ann" | "ben", foodName: string, extra: Record<string, unknown> = {}) => foodJson(w.db, createFood(w.db, who(name), customFood(foodName, 100, extra)));
  const link = (name: "ann" | "ben", foodId: string, code: string, extra: Record<string, unknown> = {}) => attachBarcode(w.db, who(name), foodId, { code, ...extra });
  /** What the scan flow makes from an Open Food Facts hit: a joint food holding the code, 357 kcal per 100 g, a 28 g serving. */
  const scanned = (name: "ann" | "ben", code14 = CHEERIOS_14, foodName = "Cheerios") => {
    const food: NewFood = {
      name: foodName, brand: "General Mills", gtin14: code14, basis: "per100g",
      nutrients: { kcal: 357, protein: 10.7, carbs: 71.4, fat: 7.1, satFat: 1.8, sugars: 3.6, fiber: 10.7, cholesterolMg: 0, sodiumMg: 600 },
      servings: [{ label: "1 cup (28 g)", grams: 28, isDefault: true }, { label: "100 g", grams: 100, isDefault: false }],
      scope: "joint", source: "off", sourceRef: code14,
    };
    return foodJson(w.db, insertFood(w.db, w.ids[name], food));
  };
  return { w, who, mk, link, scanned };
}

// ---- link a barcode to a food you already have ------------------------------------------------------

test("a food gets a barcode (any width of the same product), and the next scan resolves to it", async (t) => {
  const { w, who, mk, link } = await setup(t);
  const oatmeal = mk("ann", "Oatmeal", { basis: "per_serving" });
  assert.equal(oatmeal.gtin14, null);

  const linked = link("ann", oatmeal.id, "0016000275287");
  assert.deepEqual([linked.food.id, linked.food.gtin14, linked.replaced], [oatmeal.id, CHEERIOS_14, null]);

  // Both people's scans land on it, with no database to ask.
  for (const name of ["ann", "ben"] as const) assert.equal(findFoodByBarcode(w.db, w.ids[name], CHEERIOS_14)?.id, oatmeal.id);
  assert.equal(all(w.db, "SELECT id FROM nutrition_foods WHERE gtin14 = ?", CHEERIOS_14).length, 1, "no duplicate");

  // Logging it works like any scanned food.
  const entry = addEntry(w.db, who("ben"), TODAY, TODAY, { slot: "breakfast", foodId: oatmeal.id, quantity: 2, source: "scan" }).row;
  assert.equal(entry.source, "scan");

  // Unlinking hands the code back.
  assert.equal(detachBarcode(w.db, who("ann"), oatmeal.id).food.gtin14, null);
  assert.equal(findFoodByBarcode(w.db, w.ids.ann, CHEERIOS_14), undefined);
});

test("linking: who may, which codes, and what happens on a clash", async (t) => {
  const { w, who, mk, link } = await setup(t);
  const mine = mk("ann", "Ann bar");
  const priv = mk("ann", "Ann secret bar", { scope: "personal" });
  const generic = addGeneric(w.db, "Rolled oats", 380);
  const gone = mk("ann", "Deleted bar");
  deleteFood(w.db, who("ann"), gone.id);

  // Visibility and edit rights are the food's own: personal is invisible to Ben, USDA is read-only, deleted is gone.
  assert.equal(status(() => link("ben", priv.id, UNKNOWN)), 404);
  assert.equal(status(() => link("ann", generic, UNKNOWN)), 403);
  assert.equal(status(() => link("ann", gone.id, UNKNOWN)), 404);
  assert.equal(status(() => link("ann", "no-such-food", UNKNOWN)), 404);
  assert.equal(status(() => detachBarcode(w.db, who("ben"), priv.id)), 404);
  assert.equal(status(() => detachBarcode(w.db, who("ann"), generic)), 403);
  // But a joint food is Ben's to edit too.
  assert.equal(link("ben", mine.id, UNKNOWN).food.id, mine.id);
  assert.equal(link("ann", mine.id, UNKNOWN).previousGtin14, null, "same code again changes nothing");

  // Bad input.
  assert.equal(status(() => link("ann", mine.id, "012345678900")), 400, "check digit");
  assert.equal(status(() => link("ann", mine.id, "123")), 400, "length");
  assert.equal(status(() => attachBarcode(w.db, who("ann"), mine.id, {})), 400, "no code");
  assert.throws(() => link("ann", mine.id, STORE_LABEL), (e: any) => e.status === 400 && /price\/weight label/.test(e.message));
  assert.equal(getFood(w.db, mine.id)!.gtin14, `00${UNKNOWN}`, "a refused link changed nothing");

  // UPC-E needs its format hint, like everywhere else.
  const other = mk("ann", "Other bar");
  assert.equal(status(() => link("ann", other.id, "04252614")), 400);
  assert.equal(link("ann", other.id, "04252614", { format: "upc_e" }).food.gtin14, "00042100005264");

  // A code can belong to one food per scope: the clash names the food that has it...
  const second = mk("ann", "Second bar");
  let clash: any;
  try { link("ann", second.id, UNKNOWN); } catch (err) { clash = err; }
  assert.equal(clash.status, 409);
  assert.match(clash.message, /"Ann bar"/);
  assert.equal(clash.extra.conflict.id, mine.id);
  // Somebody's personal food never blocks another login (migration 6): see the two-spouse tests below.
  const privOwner = mk("ann", "Ann hidden bar", { scope: "personal" });
  assert.ok(link("ann", privOwner.id, UNKNOWN_2));
  assert.equal(link("ben", second.id, UNKNOWN_2).food.id, second.id, "Ben's joint food takes the code Ann's personal food holds");

  // Moving a food to a different code reports the one it let go of.
  assert.equal(link("ann", mine.id, upcA("04444444444")).previousGtin14, `00${UNKNOWN}`);
  // Unlinking a food with no barcode is fine too.
  assert.equal(detachBarcode(w.db, who("ann"), other.id).food.gtin14, null);
  assert.equal(detachBarcode(w.db, who("ann"), other.id).food.gtin14, null);
});

test("saying a scanned product was really your own food moves the code over -- but only from the scan flow's own copy", async (t) => {
  const { w, mk, link, scanned } = await setup(t);
  const mine = mk("ann", "My Cheerios");
  const dup = scanned("ann");

  // Without naming the duplicate, the code is simply taken.
  assert.equal(status(() => link("ann", mine.id, CHEERIOS)), 409);
  // A food you built by hand never gets swept aside, even when named.
  const handmade = mk("ann", "Hand made", { gtin14: upcA("05555555555") });
  assert.equal(status(() => link("ann", mine.id, handmade.gtin14!, { replaceFoodId: handmade.id })), 409);
  assert.equal(status(() => link("ann", mine.id, CHEERIOS, { replaceFoodId: mine.id })), 409, "must name the food that actually holds the code");

  // Naming the untouched duplicate: it is deleted (soft) and the code moves, in one step.
  const done = link("ann", mine.id, CHEERIOS, { replaceFoodId: dup.id });
  assert.deepEqual(done.replaced, { id: dup.id, name: "Cheerios", action: "deleted" });
  assert.ok(getFood(w.db, dup.id)!.deleted_at);
  assert.equal(findFoodByBarcode(w.db, w.ids.ben, CHEERIOS_14)?.id, mine.id);
});

test("a duplicate someone already logged is kept as a food, it just stops owning the code", async (t) => {
  const { w, who, mk, link, scanned } = await setup(t);
  const mine = mk("ann", "My Cheerios");
  const dup = scanned("ann");
  // Ben logged the scanned product before Ann decided it was her own food.
  addEntry(w.db, who("ben"), TODAY, TODAY, { slot: "snacks", foodId: dup.id, quantity: 1 });

  const done = link("ann", mine.id, CHEERIOS, { replaceFoodId: dup.id });
  assert.equal(done.replaced!.action, "unlinked");
  const kept = getFood(w.db, dup.id)!;
  assert.deepEqual([kept.gtin14, kept.deleted_at], [null, null]);
  assert.equal(findFoodByBarcode(w.db, w.ids.ann, CHEERIOS_14)?.id, mine.id);
});

// ---- the miss log -------------------------------------------------------------------------------------

test("misses: every scan without nutrition is counted, most frequent first, with the name we learned", async (t) => {
  const { w, who } = await setup(t);
  assert.deepEqual(listMisses(w.db, who("ann"), 100), []);

  recordMiss(w.db, `00${UNKNOWN_2}`, { name: null, brand: null }, NOW); // nothing knows it, not even a name
  recordMiss(w.db, `00${UNKNOWN}`, { name: "Mystery Snack", brand: "Acme" }, NOW); // a name, no nutrition
  recordMiss(w.db, `00${UNKNOWN}`, { name: "Mystery Snack", brand: "Acme" }, new Date("2026-03-12T15:00:00Z")); // the partner, two days later

  const list = listMisses(w.db, who("ann"), 100);
  assert.deepEqual(list.map((m) => [m.code, m.count, m.name, m.brand, m.resolved]), [
    [UNKNOWN, 2, "Mystery Snack", "Acme", false],
    [UNKNOWN_2, 1, null, null, false],
  ]);
  assert.equal(list[0].gtin14, `00${UNKNOWN}`);
  assert.equal(list[0].firstSeenAt, NOW.toISOString());
  assert.equal(list[0].lastSeenAt, "2026-03-12T15:00:00.000Z");
  assert.deepEqual(listMisses(w.db, who("ben"), 100), list, "one list for the household");
  assert.equal(listMisses(w.db, who("ann"), 1).length, 1);

  // A later scan that learns nothing (the name-only source is gone) keeps the name an earlier one found.
  recordMiss(w.db, `00${UNKNOWN}`, { name: null, brand: null }, NOW);
  const after_ = listMisses(w.db, who("ann"), 100)[0];
  assert.deepEqual([after_.count, after_.name, after_.brand], [3, "Mystery Snack", "Acme"]);
  assert.equal(displayCode(`00${UNKNOWN}`), UNKNOWN, "the shortest form people can read off the box");
});

test("misses: a food that now owns the code marks it resolved (created by hand or linked), until it is deleted", async (t) => {
  const { w, who, mk, link } = await setup(t);
  recordMiss(w.db, `00${UNKNOWN}`, { name: null, brand: null }, NOW);
  recordMiss(w.db, `00${UNKNOWN_2}`, { name: null, brand: null }, NOW);
  const state = (name: "ann" | "ben" = "ann") =>
    Object.fromEntries(listMisses(w.db, who(name), 100).map((m) => [m.code, m.resolved ? m.foodName : false]));
  assert.deepEqual(state(), { [UNKNOWN]: false, [UNKNOWN_2]: false });

  // Typing the label into Create food with the barcode filled in.
  const created = mk("ann", "Mystery Snack", { gtin14: UNKNOWN });
  assert.deepEqual(state(), { [UNKNOWN]: "Mystery Snack", [UNKNOWN_2]: false });
  // Linking an existing food.
  link("ann", mk("ann", "Other snack").id, UNKNOWN_2);
  assert.deepEqual(state(), { [UNKNOWN]: "Mystery Snack", [UNKNOWN_2]: "Other snack" });
  // The row is kept (it is history for the data gate), just flagged.
  assert.equal(listMisses(w.db, who("ann"), 100).length, 2);

  // Delete the food and the code is a miss again; a personal food only resolves it for its owner.
  deleteFood(w.db, who("ann"), created.id);
  assert.equal(state()[UNKNOWN], false);
  mk("ann", "Personal snack", { gtin14: UNKNOWN, scope: "personal" });
  assert.equal(state("ann")[UNKNOWN], "Personal snack");
  assert.equal(state("ben")[UNKNOWN], false);
});

// ---- the offline copy of your barcoded foods ------------------------------------------------------------

test("barcoded foods you can see, with what the amount step needs", async (t) => {
  const { w, who, mk, link, scanned } = await setup(t);
  assert.deepEqual(listBarcodedFoods(w.db, who("ann")), []);

  const cheerios = scanned("ann"); // 357 kcal/100 g, 28 g serving
  mk("ann", "Barcoded bar", { gtin14: UNKNOWN });
  const oats = foodJson(w.db, createFood(w.db, who("ann"), {
    name: "My oatmeal", basis: "per100g", nutrients: { kcal: 380 },
    servings: [{ label: "100 g", grams: 100 }, { label: "1 scoop", grams: 40, isDefault: true }],
  }));
  link("ann", oats.id, UNKNOWN_2);
  mk("ann", "No barcode");
  mk("ann", "Ann private", { gtin14: upcA("03333333333"), scope: "personal" });
  const removed = mk("ann", "Removed", { gtin14: upcA("04444444444") });
  deleteFood(w.db, who("ann"), removed.id);
  addGeneric(w.db, "Generic oats", 380);

  const mine = listBarcodedFoods(w.db, who("ann"));
  assert.deepEqual(mine.map((f) => f.name).sort(), ["Ann private", "Barcoded bar", "Cheerios", "My oatmeal"]);
  const ch = mine.find((f) => f.id === cheerios.id)!;
  assert.deepEqual(
    [ch.gtin14, ch.brand, ch.basis, ch.defaultServing!.label, ch.defaultServing!.grams, ch.kcal, ch.nutrients.kcal, ch.servings.length],
    [CHEERIOS_14, "General Mills", "per100g", "1 cup (28 g)", 28, 99.96, 357, 2]);
  const ov = mine.find((f) => f.id === oats.id)!;
  assert.deepEqual([ov.defaultServing!.label, ov.kcal], ["1 scoop", 152], "kcal is per the default serving (40 g of 380/100 g)");
  assert.equal(mine.find((f) => f.name === "Barcoded bar")!.kcal, 100, "per-serving foods: the nutrients are per serving");
  assert.ok(mine.every((f) => f.id && f.servings.every((s) => s.id && "isDefault" in s)));

  // Ben shares the joint foods but not Ann's personal one.
  assert.deepEqual(listBarcodedFoods(w.db, who("ben")).map((f) => f.name).sort(), ["Barcoded bar", "Cheerios", "My oatmeal"]);
});

// ---- "is this one of your foods?" -----------------------------------------------------------------------

test("link candidates: your foods without a barcode that share a word with the product, never the USDA list", async (t) => {
  const { w, who, mk, scanned } = await setup(t);
  const names = (q: string, name: "ann" | "ben" = "ann", limit?: number) => linkCandidates(w.db, who(name), q, limit).map((f) => f.name);

  mk("ann", "Honey Nut Cheerios");
  mk("ann", "Cheerios Oat Crunch", { gtin14: UNKNOWN }); // already has a code
  mk("ann", "Cheerios secret", { scope: "personal" });
  mk("ben", "Banana");
  addGeneric(w.db, "Cheerios, cereal", 376);
  scanned("ann"); // the just-created copy of the scanned product holds the code too

  // The product's own words ("Cereal", "General Mills") need not all be in your food's name.
  assert.deepEqual(names("Cheerios Cereal General Mills").sort(), ["Cheerios secret", "Honey Nut Cheerios"]);
  assert.deepEqual(names("Cheerios Cereal General Mills", "ben"), ["Honey Nut Cheerios"], "Ann's personal food isn't Ben's to see");
  assert.deepEqual(names("banan"), ["Banana"], "typed prefixes work (the household shares Ben's food)");
  assert.deepEqual(names("the and of"), [], "filler words alone match nothing");
  assert.deepEqual(names(""), []);

  for (let i = 1; i <= 7; i++) mk("ann", `Oat bar ${i}`);
  assert.equal(names("oat bar").length, 5, "five by default");
  assert.equal(names("oat bar", "ann", 3).length, 3);
});

// ---- servings ---------------------------------------------------------------------------------------------

test("a scanned drink whose serving is in ml is labelled in ml and logs by that serving", async (t) => {
  const { w, who } = await setup(t);
  const cola = foodJson(w.db, insertFood(w.db, w.ids.ann, {
    name: "Cola", brand: "Fizz", gtin14: CHEERIOS_14, basis: "per100g",
    nutrients: { kcal: 42, protein: 0, carbs: 10.6, fat: 0, satFat: 0, sugars: 10.6, fiber: 0, cholesterolMg: 0, sodiumMg: 10 },
    servings: [{ label: "355 ml", grams: 355, isDefault: true }, { label: "100 ml", grams: 100, isDefault: false }],
    scope: "joint", source: "off", sourceRef: CHEERIOS_14,
  }));
  assert.deepEqual(cola.servings.map((s) => [s.label, s.grams, s.isDefault]), [["355 ml", 355, true], ["100 ml", 100, false]]);
  const entry = addEntry(w.db, who("ann"), TODAY, TODAY, { slot: "snacks", foodId: cola.id, quantity: 1, source: "scan" }).row;
  assert.equal(entry.unit_snapshot, "355 ml");
  assert.equal(JSON.parse(entry.nutrients_total).kcal, 149.1); // 42 per 100 ml x 3.55
});

// ---- the lookup cache --------------------------------------------------------------------------------------

test("the lookup cache remembers an answer for 90 days and a miss for 14, and counts its refreshes", async (t) => {
  const { w } = await setup(t);
  const t0 = NOW.getTime();
  assert.equal(readCached(w.db, CHEERIOS_14, t0), null);

  writeCached(w.db, CHEERIOS_14, { source: "off", servingUnit: "ml", name: "Cola" }, t0);
  assert.deepEqual(readCached(w.db, CHEERIOS_14, t0 + POSITIVE_TTL_MS - 1), { core: { source: "off", servingUnit: "ml", name: "Cola" } });
  assert.equal(readCached(w.db, CHEERIOS_14, t0 + POSITIVE_TTL_MS), null, "expired");

  writeCached(w.db, `00${UNKNOWN}`, null, t0); // a remembered miss
  assert.deepEqual(readCached(w.db, `00${UNKNOWN}`, t0 + NEGATIVE_TTL_MS - 1), { core: null });
  assert.equal(readCached(w.db, `00${UNKNOWN}`, t0 + NEGATIVE_TTL_MS), null, "a miss is retried sooner, so a newly added product is found");

  writeCached(w.db, CHEERIOS_14, { source: "fdc", servingUnit: "g" }, t0 + 1000);
  assert.equal(get<{ tries: number; source: string }>(w.db, "SELECT tries, source FROM nutrition_barcode_lookups WHERE gtin14 = ?", CHEERIOS_14)!.tries, 2);
  // An old row without a serving unit was grams.
  w.db.prepare("UPDATE nutrition_barcode_lookups SET result = '{\"name\":\"Old\"}' WHERE gtin14 = ?").run(CHEERIOS_14);
  assert.deepEqual(readCached(w.db, CHEERIOS_14, t0 + 2000), { core: { name: "Old", source: "fdc", servingUnit: "g" } });
  // Unreadable JSON means "look it up again", not an error.
  w.db.prepare("UPDATE nutrition_barcode_lookups SET result = '{nope' WHERE gtin14 = ?").run(CHEERIOS_14);
  assert.equal(readCached(w.db, CHEERIOS_14, t0 + 2000), null);
});

test("the cache and miss tables exist in a fresh nutrition schema and start empty", async (t) => {
  const { w } = await setup(t);
  assert.ok(tableNames(w.db).includes("nutrition_barcode_lookups") && tableNames(w.db).includes("nutrition_barcode_misses"));
  assert.equal(all(w.db, "SELECT * FROM nutrition_barcode_lookups").length + all(w.db, "SELECT * FROM nutrition_barcode_misses").length, 0);
});

// ---- the two-spouse scenario (migration 6) ------------------------------------------------------------------
//
// Migration 1 made a barcode unique household-wide, but a personal food is invisible to the other
// login. If Ann kept a PERSONAL food with code X, Ben could never see it and never save a food of his
// own with X (his insert hit the index). Migration 6 makes a code unique per scope instead.

test("two spouses: Ann's personal food with a code neither blocks Ben nor shows up for him", async (t) => {
  const { w, who, mk, link, scanned } = await setup(t);
  const annPersonal = mk("ann", "Ann's protein bar", { scope: "personal", gtin14: UNKNOWN });

  // Ben cannot find or touch it...
  assert.equal(findFoodByBarcode(w.db, w.ids.ben, `00${UNKNOWN}`), undefined);
  assert.equal(status(() => link("ben", annPersonal.id, UNKNOWN)), 404);
  assert.deepEqual(listBarcodedFoods(w.db, who("ben")).map((f) => f.name), []);
  assert.equal(listMisses(w.db, who("ben"), 10).length, 0);

  // ...and Ben can save his own food (personal or joint) with the very same code.
  const benPersonal = mk("ben", "Ben's protein bar", { scope: "personal", gtin14: UNKNOWN });
  assert.equal(findFoodByBarcode(w.db, w.ids.ben, `00${UNKNOWN}`)!.id, benPersonal.id);
  assert.equal(findFoodByBarcode(w.db, w.ids.ann, `00${UNKNOWN}`)!.id, annPersonal.id, "each sees only their own");

  const joint = mk("ben", "Shared bar");
  assert.equal(link("ben", joint.id, UNKNOWN).food.gtin14, `00${UNKNOWN}`, "a joint food may hold it too");

  // A scan prefers your own personal food, then the joint one. Ann's lookup finds hers.
  assert.equal(findFoodByBarcode(w.db, w.ids.ann, `00${UNKNOWN}`)!.id, annPersonal.id);
  // And the offline list has ONE food per code: your personal one when you have it.
  assert.deepEqual(listBarcodedFoods(w.db, who("ann")).map((f) => f.name), ["Ann's protein bar"]);
  assert.deepEqual(listBarcodedFoods(w.db, who("ben")).map((f) => f.name), ["Ben's protein bar"]);
  // Without a personal food of their own, a third login would get the joint one. (Ann deletes hers.)
  deleteFood(w.db, who("ann"), annPersonal.id);
  assert.equal(findFoodByBarcode(w.db, w.ids.ann, `00${UNKNOWN}`)!.id, joint.id);
  assert.deepEqual(listBarcodedFoods(w.db, who("ann")).map((f) => f.name), ["Shared bar"]);

  // The scan flow's "create from lookup" (a joint food) works while only someone's personal food has the code.
  const personalOnly = mk("ann", "Ann only", { scope: "personal", gtin14: upcA("05050505050") });
  const fromLookup = scanned("ben", `00${upcA("05050505050")}`, "Looked up");
  assert.equal(fromLookup.scope, "joint");
  assert.equal(findFoodByBarcode(w.db, w.ids.ann, fromLookup.gtin14!)!.id, personalOnly.id, "Ann still lands on her own");
  assert.equal(findFoodByBarcode(w.db, w.ids.ben, fromLookup.gtin14!)!.id, fromLookup.id);
});

test("two spouses: conflicts are checked inside one scope only, and never name the other person's food", async (t) => {
  const { w, mk, link } = await setup(t);
  const annHidden = mk("ann", "Ann hidden bar", { scope: "personal", gtin14: UNKNOWN });
  mk("ben", "Shared bar", { gtin14: UNKNOWN_2 });

  // Same scope still collides, and the caller is told which of THEIR foods it is.
  const dupJoint = mk("ann", "Another shared");
  assert.throws(() => link("ann", dupJoint.id, UNKNOWN_2), (e: any) => e.status === 409 && /"Shared bar"/.test(e.message));
  const annSecond = mk("ann", "Ann second", { scope: "personal" });
  assert.throws(() => link("ann", annSecond.id, UNKNOWN), (e: any) => e.status === 409 && /"Ann hidden bar"/.test(e.message));
  assert.throws(() => mk("ann", "Ann third", { scope: "personal", gtin14: UNKNOWN }), (e: any) => e.status === 409);

  // Ben linking/creating with Ann's personal code: no conflict, and nothing in any message mentions it.
  const benFood = mk("ben", "Ben's own");
  assert.equal(link("ben", benFood.id, UNKNOWN).food.id, benFood.id);
  assert.doesNotMatch(JSON.stringify(mk("ben", "Ben's personal", { scope: "personal", gtin14: UNKNOWN })), /hidden/);

  // Changing scope can create a clash (Ann's hidden food made joint, while Ben's joint food has the code):
  // the answer is a generic 409 that names no food at all.
  assert.throws(() => updateFood(w.db, w.tracker(w.ids.ann), annHidden.id, { scope: "joint" }),
    (e: any) => e.status === 409 && !/Ben's own|Ann hidden/.test(e.message));
  assert.equal(findFoodByBarcode(w.db, w.ids.ann, `00${UNKNOWN}`)!.id, annHidden.id, "the failed change left it personal");
});

test("two spouses: a personal food may take a code the scan flow's joint copy holds, and can sweep that copy across scopes", async (t) => {
  const { w, mk, link, scanned } = await setup(t);
  const mine = mk("ann", "My Cheerios", { scope: "personal" });
  const dup = scanned("ann"); // joint, made from a lookup, holds the code

  // Different scopes: no clash. Ann now lands on her own food; Ben, who has none, on the joint copy.
  assert.equal(link("ann", mine.id, CHEERIOS).replaced, null);
  assert.equal(findFoodByBarcode(w.db, w.ids.ann, CHEERIOS_14)!.id, mine.id);
  assert.equal(findFoodByBarcode(w.db, w.ids.ben, CHEERIOS_14)!.id, dup.id);

  // Naming the joint copy as the one to replace removes it, so nobody is left with two "Cheerios".
  const other = mk("ben", "Ben's Cheerios", { scope: "personal" });
  const done = link("ben", other.id, CHEERIOS, { replaceFoodId: dup.id });
  assert.deepEqual(done.replaced, { id: dup.id, name: "Cheerios", action: "deleted" });
  assert.equal(findFoodByBarcode(w.db, w.ids.ben, CHEERIOS_14)!.id, other.id);
  assert.equal(findFoodByBarcode(w.db, w.ids.ann, CHEERIOS_14)!.id, mine.id, "Ann's own food is untouched");
});
