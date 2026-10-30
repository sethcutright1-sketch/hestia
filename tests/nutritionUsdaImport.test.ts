// The USDA generic-catalogue importer's logic (nutrition/usdaImport.ts) on a tiny fixture in a private
// in-memory database. Nothing is downloaded: the page fetcher is a fake. (scripts/import-usda-generic.ts
// is only the real download wrapped around this; it is never run by the test suite.)

import { test, after } from "node:test";
import assert from "node:assert/strict";

import { cleanupDb } from "./helpers/testdb.ts";
import { newWorld } from "./helpers/nutritionWorld.ts";
import { USDA_PAGE_SIZE, importUsdaGeneric, upsertGenericFood, type ImportCounts } from "../nutrition/usdaImport.ts";
import { searchFoods } from "../nutrition/data/foods.ts";
import { all, get, run } from "../nutrition/data/sql.ts";

after(cleanupDb);

const food = (fdcId: number, description: string, kcal: number | null, extra: unknown[] = []) => ({
  fdcId, description,
  foodNutrients: [...(kcal === null ? [] : [{ number: "208", amount: kcal }]), { number: "203", amount: 1.5 }, ...extra],
});
const fresh = (): ImportCounts => ({ inserted: 0, updated: 0, unchanged: 0, skipped: 0 });

/** A fake /foods/list: pages of fixture foods per data type, recording every request. */
function fakeApi(byType: Record<string, any[]>) {
  const asked: string[] = [];
  return {
    asked,
    fetchPage: async (dataType: string, page: number, size: number) => {
      asked.push(`${dataType}:${page}:${size}`);
      return (byType[dataType] ?? []).slice((page - 1) * size, page * size);
    },
  };
}

test("an item becomes an owner-less, read-only, per-100 g catalogue food with one 100 g serving, found by search", async (t) => {
  const { db, ann, ben } = await newWorld(t);
  const counts = fresh();
  upsertGenericFood(db, food(1750340, "Rolled oats, dry", 379), counts);
  assert.deepEqual(counts, { inserted: 1, updated: 0, unchanged: 0, skipped: 0 });

  const row = get<any>(db, "SELECT * FROM nutrition_foods WHERE source_ref = '1750340'")!;
  assert.deepEqual([row.source, row.owner_user_id, row.created_by_user_id, row.basis, row.gtin14, row.deleted_at], ["usda_generic", null, null, "per100g", null, null]);
  assert.deepEqual([JSON.parse(row.nutrients).kcal, JSON.parse(row.nutrients).protein], [379, 1.5]);
  const servings = all<any>(db, "SELECT label, grams, is_default FROM nutrition_food_servings WHERE food_id = ?", row.id);
  assert.deepEqual(servings.map((s) => [s.label, s.grams, s.is_default]), [["100 g", 100, 1]]);

  // Everyone finds it; no one edits it.
  for (const who of [ann, ben]) assert.deepEqual(searchFoods(db, who.id, "oats", 5).map((f) => f.name), ["Rolled oats, dry"]);
});

test("re-importing is an upsert by FDC id: unchanged rows are not rewritten, changed ones are, a hidden one comes back", async (t) => {
  const { db } = await newWorld(t);
  const first = fresh();
  upsertGenericFood(db, food(1, "Apple, raw", 52), first);
  upsertGenericFood(db, food(2, "Banana, raw", 89), first);
  const before = get<{ n: number }>(db, "SELECT COUNT(*) AS n FROM nutrition_foods_fts")!.n;

  const again = fresh();
  upsertGenericFood(db, food(1, "Apple, raw", 52), again);
  upsertGenericFood(db, food(2, "Banana, raw", 90), again); // USDA corrected the energy
  assert.deepEqual(again, { inserted: 0, updated: 1, unchanged: 1, skipped: 0 });
  assert.equal(get<{ n: number }>(db, "SELECT COUNT(*) AS n FROM nutrition_foods WHERE source = 'usda_generic'")!.n, 2, "no duplicates");
  assert.equal(JSON.parse(get<any>(db, "SELECT nutrients FROM nutrition_foods WHERE source_ref = '2'")!.nutrients).kcal, 90);
  assert.equal(get<{ n: number }>(db, "SELECT COUNT(*) AS n FROM nutrition_foods_fts")!.n, before, "the search index did not grow or churn");
  assert.equal(get<{ n: number }>(db, "SELECT COUNT(*) AS n FROM nutrition_food_servings")!.n, 2, "servings are made once");

  // A rename re-indexes under the new name; the old one stops matching.
  upsertGenericFood(db, food(1, "Apple, fuji, raw", 52), fresh());
  const hit = (q: string) => all(db, "SELECT food_id FROM nutrition_foods_fts WHERE nutrition_foods_fts MATCH ?", q).length;
  assert.deepEqual([hit("fuji"), hit("apple")], [1, 1]);

  // If a food had been soft-deleted by hand, importing brings it back.
  run(db, "UPDATE nutrition_foods SET deleted_at = 'x' WHERE source_ref = '1'");
  const revive = fresh();
  upsertGenericFood(db, food(1, "Apple, fuji, raw", 52), revive);
  assert.equal(revive.updated, 1);
  assert.equal(get<any>(db, "SELECT deleted_at FROM nutrition_foods WHERE source_ref = '1'")!.deleted_at, null);
});

test("items with no energy value, no name or no id are skipped, not half-imported", async (t) => {
  const { db } = await newWorld(t);
  const c = fresh();
  upsertGenericFood(db, food(1, "Water", null), c); // no energy row at all
  upsertGenericFood(db, food(2, "   ", 10), c);
  upsertGenericFood(db, { description: "No id", foodNutrients: [{ number: "208", amount: 5 }] }, c);
  upsertGenericFood(db, null, c);
  upsertGenericFood(db, food(3, "Foundation, Atwater only", null, [{ nutrientId: 2047, amount: 95 }]), c); // energy from the Atwater factor
  assert.deepEqual(c, { inserted: 1, updated: 0, unchanged: 0, skipped: 4 });
  assert.deepEqual(all<any>(db, "SELECT name FROM nutrition_foods").map((r) => r.name), ["Foundation, Atwater only"]);
});

test("the importer walks every data type page by page and stops on a short page", async (t) => {
  const { db } = await newWorld(t);
  const api = fakeApi({
    Foundation: [food(1, "Foundation one", 10), food(2, "Foundation two", 20)],
    "SR Legacy": Array.from({ length: USDA_PAGE_SIZE + 3 }, (_, i) => food(100 + i, `Legacy ${i}`, 50)),
    "Survey (FNDDS)": [food(900, "Survey one", 70)],
  });
  const state: Record<string, number> = {};
  let saves = 0;
  const counts = await importUsdaGeneric(db, { fetchPage: api.fetchPage, state, saveState: () => { saves++; } });
  assert.equal(counts.inserted, 2 + USDA_PAGE_SIZE + 3 + 1);
  assert.deepEqual(api.asked, [
    `Foundation:1:${USDA_PAGE_SIZE}`, `SR Legacy:1:${USDA_PAGE_SIZE}`, `SR Legacy:2:${USDA_PAGE_SIZE}`, `Survey (FNDDS):1:${USDA_PAGE_SIZE}`,
  ]);
  assert.deepEqual(state, { Foundation: 1, "Foundation:done": 1, "SR Legacy": 2, "SR Legacy:done": 1, "Survey (FNDDS)": 1, "Survey (FNDDS):done": 1 });
  assert.ok(saves > 0);

  // A second run with the saved state asks for nothing; with the state cleared it re-reads and changes nothing.
  const quiet = fakeApi({ Foundation: [food(1, "Foundation one", 10)] });
  assert.equal((await importUsdaGeneric(db, { fetchPage: quiet.fetchPage, state })).inserted, 0);
  assert.deepEqual(quiet.asked, []);
  const refresh = await importUsdaGeneric(db, { fetchPage: api.fetchPage, state: {} });
  assert.deepEqual([refresh.inserted, refresh.updated, refresh.unchanged], [0, 0, 2 + USDA_PAGE_SIZE + 3 + 1]);
});

test("--limit caps the foods imported, asks for no more than it needs, and ignores saved progress", async (t) => {
  const { db } = await newWorld(t);
  const api = fakeApi({ Foundation: Array.from({ length: 10 }, (_, i) => food(i + 1, `Item ${i}`, 10)) });
  const counts = await importUsdaGeneric(db, { fetchPage: api.fetchPage, limit: 4, state: { Foundation: 7, "Foundation:done": 0 } });
  assert.equal(counts.inserted, 4);
  assert.deepEqual(api.asked, ["Foundation:1:4"], "one request, for 4 foods, starting at page 1 whatever was saved");
});

test("a failing page stops the import and leaves the earlier pages in place (and resumable)", async (t) => {
  const { db } = await newWorld(t);
  let calls = 0;
  const state: Record<string, number> = {};
  const fetchPage = async (_type: string, page: number) => {
    if (++calls === 2) throw new Error("FDC Foundation page 2: status 503");
    return Array.from({ length: USDA_PAGE_SIZE }, (_, i) => food(page * 1000 + i, `P${page} item ${i}`, 10));
  };
  await assert.rejects(importUsdaGeneric(db, { fetchPage, state }), /status 503/);
  assert.equal(get<{ n: number }>(db, "SELECT COUNT(*) AS n FROM nutrition_foods")!.n, USDA_PAGE_SIZE, "page 1 was committed");
  assert.deepEqual(state, { Foundation: 1 }, "so the next run starts at page 2");
});
