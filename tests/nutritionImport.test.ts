// The Lose It! importer engine against synthetic exports: every scenario builds a small export in memory (headers as the
// REAL export writes them, rows made up), imports it into a private in-memory household, and checks the rows, the report,
// and what a second run does. Ported from the calorie app's importer tests, plus the fixes the real export proved
// necessary (negative exercise calories, the Deleted flag's two spellings, the weight unit from the account) and the new
// imports (Done logging days, steps, progress photos, custom foods, the food-sharing choice, the recipes skip).

import { test, after, type TestContext } from "node:test";
import assert from "node:assert/strict";

import { cleanupDb } from "./helpers/testdb.ts";
import { newWorld, rowCount, TODAY, type World } from "./helpers/nutritionWorld.ts";
import {
  csv, customFoodsCsv, dailyValuesCsv, exerciseCsv, exportOf, foodCsv, photoName, photosCsv, stepsCsv, token,
  type Food, type Parts,
} from "./helpers/loseitExport.ts";
import { jpegBytes, pngBytes } from "./helpers/images.ts";
import { NutritionError } from "../nutrition/data/errors.ts";
import { daySummary } from "../nutrition/data/days.ts";
import { canSee, getFood, searchFoods, recentFoods } from "../nutrition/data/foods.ts";
import { addGoal, goalOn } from "../nutrition/data/goals.ts";
import { streakFor } from "../nutrition/data/loggingStreaks.ts";
import { deletePhoto, MAX_PHOTO_BYTES } from "../nutrition/data/photos.ts";
import { allSlotsFor } from "../nutrition/data/slots.ts";
import { all, get, run, type Db } from "../nutrition/data/sql.ts";
import { putSteps } from "../nutrition/data/steps.ts";
import { peekTracker, saveProfile } from "../nutrition/data/tracker.ts";
import { applyCalibration } from "../nutrition/import/calibration.ts";
import { formatInventory, formatReport } from "../nutrition/import/format.ts";
import { importLoseIt, type ImportOptions, type ImportReport } from "../nutrition/import/loseitImport.ts";
import { inventoryOf } from "../nutrition/import/loseitParse.ts";
import { photoIdFor } from "../nutrition/import/progressPhotos.ts";
import type { Tracker } from "../nutrition/data/access.ts";
import type { LoseItExport } from "../nutrition/import/zip.ts";

after(cleanupDb);

// ---- helpers ------------------------------------------------------------------------------------

const go = (db: Db, user: Tracker, e: Parts | ReturnType<typeof exportOf>, o: Partial<ImportOptions> = {}): ImportReport =>
  importLoseIt(db, user, "food" in e ? exportOf(e) : e, { dryRun: false, today: TODAY, ...o });

const entriesOf = (db: Db, userId: string, where = "1=1") =>
  all<any>(db, `SELECT * FROM nutrition_diary_entries WHERE user_id = ? AND ${where} ORDER BY local_date, logged_at, rowid`, userId);
const live = (db: Db, userId: string) => entriesOf(db, userId, "deleted_at IS NULL");
const kcalOf = (e: any) => JSON.parse(e.nutrients_total).kcal as number;
/** node:sqlite rows have a null prototype, which strict deepEqual rejects; copy them into plain objects. */
const rows = (db: Db, sql: string, ...params: any[]): any[] => all<any>(db, sql, ...params).map((r) => ({ ...r }));
const count = (db: Db, table: string) => rowCount(db, table);

/** Everything the importer can touch, as one string: equal strings mean nothing changed. */
function dump(db: Db): string {
  const tables = [
    "nutrition_diary_entries", "nutrition_foods", "nutrition_food_servings", "nutrition_meal_slots", "nutrition_weights",
    "nutrition_exercise", "nutrition_day_logs", "nutrition_goals", "nutrition_steps",
  ];
  return JSON.stringify([
    ...tables.map((tb) => all(db, `SELECT * FROM ${tb} ORDER BY rowid`)),
    all(db, "SELECT id, user_id, taken_on, mime, hex(bytes) AS b, width, height, source, deleted_at FROM nutrition_photos ORDER BY rowid"),
    all(db, "SELECT COUNT(*) AS n FROM nutrition_foods_fts"),
  ]);
}

async function world(t: TestContext, opts: { profiles?: boolean } = {}): Promise<World> {
  return newWorld(t, opts);
}

// ---- diary entries, foods ----------------------------------------------------------------------

test("the documented sample rows: right slots, totals as logged, per-unit foods shared with the household by default", async (t) => {
  const w = await world(t);
  const report = go(w.db, w.ann, { food: [
    { date: "01/05/2026", name: "Oatmeal", type: "Breakfast", qty: 1, units: "Cup", kcal: 166, fat: 3.6, protein: 5.9, carbs: 28, sat: 0.6, sugars: 0.6, fiber: 4, chol: 0, sodium: 9 },
    { date: "01/05/2026", name: "Chicken Breast", type: "Dinner", qty: 1.5, units: "Serving", kcal: 248, fat: 5.4, protein: 46.5, carbs: 0, sat: 1.5, sugars: 0, fiber: 0, chol: 128, sodium: 111 },
  ] });

  assert.equal(report.counts.created, 2);
  assert.equal(report.foods.created, 2);
  assert.deepEqual(report.dateRange, { from: "2026-01-05", to: "2026-01-05", daysWithEntries: 1 });

  const [oats, chicken] = entriesOf(w.db, w.ids.ann);
  assert.deepEqual([oats.slot_key, oats.name_snapshot, oats.quantity, oats.unit_snapshot, oats.status, oats.source], ["breakfast", "Oatmeal", 1, "Cup", "logged", "import_loseit"]);
  assert.deepEqual(JSON.parse(oats.nutrients_total), { kcal: 166, protein: 5.9, carbs: 28, fat: 3.6, satFat: 0.6, sugars: 0.6, fiber: 4, cholesterolMg: 0, sodiumMg: 9 });
  assert.deepEqual([chicken.slot_key, chicken.quantity, kcalOf(chicken), chicken.grams], ["dinner", 1.5, 248, null]); // the row's totals, untouched
  assert.ok(oats.logged_at < chicken.logged_at, "breakfast sorts before dinner");
  assert.match(oats.import_hash, /^[0-9a-f]{64}$/);

  const food = getFood(w.db, chicken.food_id)!;
  assert.deepEqual(
    [food.name, food.basis, food.source, food.source_ref, food.owner_user_id, food.created_by_user_id, food.usage_count, food.last_used_at],
    ["Chicken Breast", "per_serving", "import_loseit", "loseit:chicken breast|serving", null, w.ids.ann, 1, "2026-01-05T12:00:00.000Z"],
    "owner null = shared with the household");
  assert.deepEqual(JSON.parse(food.nutrients), { kcal: 165.33, protein: 31, carbs: 0, fat: 3.6, satFat: 1, sugars: 0, fiber: 0, cholesterolMg: 85.33, sodiumMg: 74 }); // per ONE serving
  assert.deepEqual(rows(w.db, "SELECT label, grams, is_default FROM nutrition_food_servings WHERE food_id = ?", food.id), [{ label: "Serving", grams: null, is_default: 1 }]);
});

test("Deleted rows (1 / true / TRUE / yes) are never imported and don't create foods", async (t) => {
  const w = await world(t);
  const r = go(w.db, w.ann, { food: [
    { date: "1/5/2026", name: "Kept" },
    { date: "1/5/2026", name: "Gone A", deleted: "true" },
    { date: "1/5/2026", name: "Gone B", deleted: "TRUE" },
    { date: "1/5/2026", name: "Gone C", deleted: 1 }, // the real food-logs.csv spelling
    { date: "1/5/2026", name: "Gone D", deleted: "yes" },
  ] });
  assert.equal(r.counts.created, 1);
  assert.equal(r.counts.deletedInExport, 4);
  assert.deepEqual(entriesOf(w.db, w.ids.ann).map((e) => e.name_snapshot), ["Kept"]);
  assert.deepEqual(rows(w.db, "SELECT name FROM nutrition_foods WHERE source = 'import_loseit'").map((f) => f.name), ["Kept"]);
});

test("one food per (name, units), case-insensitive; the newest usable row defines it; usage and last-used follow the rows", async (t) => {
  const w = await world(t);
  const r = go(w.db, w.ann, { food: [
    { date: "1/5/2026", name: "Oatmeal", units: "Cup", qty: 1, kcal: 166 },
    { date: "1/20/2026", name: " oatmeal ", units: "cup", qty: 2, kcal: 360 }, // same food: case and spacing don't matter
    { date: "1/12/2026", name: "Oatmeal", units: "Cup", qty: 1, kcal: 170 },
    { date: "1/6/2026", name: "Oatmeal", units: "Bowl", qty: 1, kcal: 300 }, // different units: a different food
  ] });
  assert.equal(r.foods.created, 2);
  const cup = get<any>(w.db, "SELECT * FROM nutrition_foods WHERE source_ref = 'loseit:oatmeal|cup'")!;
  assert.equal(JSON.parse(cup.nutrients).kcal, 180); // the Jan 20 row: 360 for 2 cups
  assert.equal(cup.name, "oatmeal"); // as written on the newest row
  assert.deepEqual([cup.usage_count, cup.last_used_at], [3, "2026-01-20T12:00:00.000Z"]);
  assert.equal(get<any>(w.db, "SELECT usage_count FROM nutrition_foods WHERE source_ref = 'loseit:oatmeal|bowl'")!.usage_count, 1);
  assert.equal(new Set(entriesOf(w.db, w.ids.ann).map((e) => e.food_id)).size, 2);
});

test("grams -> per-100 g; ounces convert at 28.3495 g; every other unit stays per-serving with no invented weight", async (t) => {
  const w = await world(t);
  go(w.db, w.ann, { food: [
    { date: "1/5/2026", name: "Rice", units: "Grams", qty: 150, kcal: 195, protein: 4.5 },
    { date: "1/5/2026", name: "Cheddar", units: "Ounces", qty: 2, kcal: 226.796, fat: 18.8 }, // 2 oz = 56.699 g
    { date: "1/5/2026", name: "Milk", units: "Fluid Ounce", qty: 8, kcal: 120 }, // a volume, not a weight
    { date: "1/5/2026", name: "Pasta", units: "Cup", qty: 2, kcal: 400 },
  ] });
  const food = (ref: string) => get<any>(w.db, "SELECT * FROM nutrition_foods WHERE source_ref = ?", ref)!;
  const servings = (id: string) => rows(w.db, "SELECT label, grams, is_default FROM nutrition_food_servings WHERE food_id = ?", id);

  const rice = food("loseit:rice|grams");
  assert.equal(rice.basis, "per100g");
  assert.deepEqual([JSON.parse(rice.nutrients).kcal, JSON.parse(rice.nutrients).protein], [130, 3]); // 195 kcal / 150 g * 100
  assert.deepEqual(servings(rice.id), [{ label: "100 g", grams: 100, is_default: 1 }]);

  const cheddar = food("loseit:cheddar|ounces");
  assert.equal(cheddar.basis, "per100g");
  assert.equal(JSON.parse(cheddar.nutrients).kcal, 400); // 226.796 kcal / (2 x 28.3495 g) * 100
  assert.deepEqual(servings(cheddar.id), [{ label: "1 oz", grams: 28.35, is_default: 1 }]);

  for (const [ref, label] of [["loseit:milk|fluid ounce", "Fluid Ounce"], ["loseit:pasta|cup", "Cup"]] as const) {
    const f = food(ref);
    assert.equal(f.basis, "per_serving", ref);
    assert.deepEqual(servings(f.id), [{ label, grams: null, is_default: 1 }], ref);
  }
  assert.equal(JSON.parse(food("loseit:pasta|cup").nutrients).kcal, 200);

  const byName = Object.fromEntries(entriesOf(w.db, w.ids.ann).map((e) => [e.name_snapshot, e]));
  assert.deepEqual([byName.Rice.grams, byName.Rice.unit_snapshot, byName.Rice.quantity], [150, "Grams", 150]);
  assert.equal(byName.Cheddar.grams, 56.7); // 2 x 28.3495, rounded
  assert.equal(byName.Milk.grams, null);
  assert.equal(byName.Pasta.grams, null);
});

test("quantity 0 and n/a calories: logged anyway, counted in warnings, and never poison a food's nutrition", async (t) => {
  const w = await world(t);
  const r = go(w.db, w.ann, { food: [
    { date: "1/5/2026", name: "Banana", qty: 1, kcal: 105 },
    { date: "1/9/2026", name: "Banana", qty: 1, kcal: "n/a" }, // newest, but unusable: the Jan 5 row defines the food
    { date: "1/5/2026", name: "Water", qty: 0, kcal: 0 },
    { date: "1/5/2026", name: "Mystery", qty: 1, kcal: "n/a" },
  ] });
  assert.equal(r.counts.created, 4);
  assert.equal(JSON.parse(get<any>(w.db, "SELECT nutrients FROM nutrition_foods WHERE source_ref = 'loseit:banana|serving'")!.nutrients).kcal, 105);

  const water = get<any>(w.db, "SELECT * FROM nutrition_diary_entries WHERE name_snapshot = 'Water'")!;
  assert.deepEqual([water.quantity, water.food_id], [1, null]); // quantity 0 -> 1; no row to build a food from
  const mystery = get<any>(w.db, "SELECT * FROM nutrition_diary_entries WHERE name_snapshot = 'Mystery'")!;
  assert.deepEqual([kcalOf(mystery), mystery.food_id], [0, null]);

  assert.equal(r.foods.withoutNutrition, 2); // Water and Mystery
  assert.equal(r.foods.created, 1);
  assert.equal(r.counts.warnings, 5); // Banana n/a, Water qty, Mystery n/a, plus a "no usable row" for Water and Mystery
  assert.ok(r.warnings.some((x) => /Water.*quantity 0, logged as 1/.test(x)));
  assert.ok(r.warnings.some((x) => /Mystery.*calories n\/a, counted as 0/.test(x)));
});

test("meal names map case-insensitively; Snack is Snacks; an empty meal is Snacks; other names become the person's own slots", async (t) => {
  const w = await world(t);
  go(w.db, w.ann, { food: [
    { date: "1/5/2026", name: "A", type: "BREAKFAST" },
    { date: "1/5/2026", name: "B", type: "lunch" },
    { date: "1/5/2026", name: "C", type: "  Dinner " },
    { date: "1/5/2026", name: "D", type: "snack" },
    { date: "1/5/2026", name: "E", type: "Snacks" },
    { date: "1/5/2026", name: "F", type: "" },
    { date: "1/5/2026", name: "G", type: "Dinner!" }, // slugs to "dinner": the default meal, not a lookalike
    { date: "1/5/2026", name: "H", type: "Second Breakfast" },
  ] });
  assert.deepEqual(Object.fromEntries(entriesOf(w.db, w.ids.ann).map((e) => [e.name_snapshot, e.slot_key])),
    { A: "breakfast", B: "lunch", C: "dinner", D: "snacks", E: "snacks", F: "snacks", G: "dinner", H: "second-breakfast" });
  assert.deepEqual(allSlotsFor(w.db, w.ids.ann).map((s) => s.key), ["breakfast", "lunch", "dinner", "snacks", "second-breakfast"]);
  assert.deepEqual(allSlotsFor(w.db, w.ids.ben).map((s) => s.key), ["breakfast", "lunch", "dinner", "snacks"], "the other login's meals are untouched");
});

test("custom meals: enabled if used in the export's last 60 days, disabled otherwise", async (t) => {
  const w = await world(t);
  const r = go(w.db, w.ann, { food: [
    { date: "12/20/2025", name: "Pancakes", type: "Brunch", kcal: 400 }, // 78 days before the newest entry: stale
    { date: "12/20/2025", name: "Coffee", type: "Breakfast", kcal: 5 },
    { date: "3/1/2026", name: "Shake", type: "Pre-Workout", kcal: 200 },
    { date: "3/8/2026", name: "Shake", type: "pre-workout", kcal: 200 },
    { date: "3/8/2026", name: "Toast", type: "Breakfast", kcal: 80 },
  ] });
  assert.deepEqual(r.customSlots, [
    { name: "Pre-Workout", key: "pre-workout", entries: 2, enabled: true, created: true },
    { name: "Brunch", key: "brunch", entries: 1, enabled: false, created: true },
  ]);
  assert.deepEqual(rows(w.db, "SELECT key, label, enabled FROM nutrition_meal_slots WHERE user_id = ? AND sort > 3 ORDER BY sort", w.ids.ann), [
    { key: "brunch", label: "Brunch", enabled: 0 }, // each is created when its first entry goes in, so file order
    { key: "pre-workout", label: "Pre-Workout", enabled: 1 },
  ]);
  // The disabled slot still holds its entries (labelled by its own row), so the diary can show them.
  assert.equal(entriesOf(w.db, w.ids.ann, "slot_key = 'brunch'")[0].name_snapshot, "Pancakes");
});

test("an existing slot is never touched by an import", async (t) => {
  const w = await world(t);
  run(w.db, "INSERT INTO nutrition_meal_slots (user_id, key, label, sort, enabled) VALUES (?, 'brunch', 'My Brunch', 9, 1)", w.ids.ann);
  const r = go(w.db, w.ann, { food: [{ date: "12/20/2025", name: "Pancakes", type: "Brunch" }, { date: "3/8/2026", name: "Toast" }] });
  assert.deepEqual(r.customSlots, [{ name: "Brunch", key: "brunch", entries: 1, enabled: true, created: false }]);
  assert.deepEqual(rows(w.db, "SELECT label, enabled, sort FROM nutrition_meal_slots WHERE user_id = ? AND key = 'brunch'", w.ids.ann), [{ label: "My Brunch", enabled: 1, sort: 9 }]);
});

test("names with commas and quotes survive in the entry and the food", async (t) => {
  const w = await world(t);
  go(w.db, w.ann, { food: [{ date: "1/5/2026", name: 'Mac & Cheese, "Deluxe"', kcal: 400 }] });
  assert.equal(entriesOf(w.db, w.ids.ann)[0].name_snapshot, 'Mac & Cheese, "Deluxe"');
  assert.equal(get<any>(w.db, "SELECT name FROM nutrition_foods WHERE source = 'import_loseit'")!.name, 'Mac & Cheese, "Deluxe"');
});

test("Lose It!'s own Quick Add rows stay quick adds instead of becoming one averaged 'food'", async (t) => {
  const w = await world(t);
  go(w.db, w.ann, { food: [
    { date: "1/5/2026", name: "Quick Add", kcal: 300 },
    { date: "1/6/2026", name: "Quick Add", kcal: 450 },
  ] });
  assert.equal(count(w.db, "nutrition_foods"), 0);
  assert.deepEqual(entriesOf(w.db, w.ids.ann).map((e) => [e.is_quick_add, e.food_id, kcalOf(e)]), [[1, null, 300], [1, null, 450]]);
});

test("rows dated after today are filed as plans and don't count as eaten", async (t) => {
  const w = await world(t);
  const r = go(w.db, w.ann, { food: [{ date: "3/10/2026", name: "Today" }, { date: "3/11/2026", name: "Tomorrow" }] });
  assert.equal(r.counts.plannedInFuture, 1);
  assert.deepEqual(entriesOf(w.db, w.ids.ann).map((e) => [e.name_snapshot, e.status]), [["Today", "logged"], ["Tomorrow", "planned"]]);
  assert.equal(get<any>(w.db, "SELECT usage_count FROM nutrition_foods WHERE name = 'Tomorrow'")!.usage_count, 0);
});

test("the older weekly export (no Icon, no Deleted columns) imports end to end", async (t) => {
  const w = await world(t);
  const legacy = csv("Date,Name,Type,Quantity,Units,Calories,Fat (g),Protein (g),Carbohydrates (g),Saturated Fat (g),Sugars (g),Fiber (g),Cholesterol (mg),Sodium (mg)",
    [["1/5/2026", "Oatmeal", "Breakfast", 1, "Cup", 166, 3.6, 5.9, 28, 0.6, 0.6, 4, 0, 9]]);
  const r = go(w.db, w.ann, { files: new Map([["food-logs.csv", legacy]]), photos: new Map(), ignoredImages: 0 });
  assert.equal(r.counts.created, 1);
  assert.equal(JSON.parse(entriesOf(w.db, w.ids.ann)[0].nutrients_total).sodiumMg, 9);
  assert.equal(go(w.db, w.ann, { files: new Map([["food-logs.csv", legacy]]), photos: new Map(), ignoredImages: 0 }).counts.created, 0);
});

test("imported foods are searchable and in Recent right away", async (t) => {
  const w = await world(t);
  go(w.db, w.ann, { food: [{ date: "3/8/2026", name: "Greek Yogurt", units: "Cup", kcal: 130 }, { date: "1/2/2026", name: "Old Cereal", kcal: 150 }] });
  const hits = searchFoods(w.db, w.ids.ann, "yogurt", 5);
  assert.deepEqual(hits.map((f) => [f.name, f.source]), [["Greek Yogurt", "import_loseit"]]);
  assert.deepEqual(recentFoods(w.db, w.ann, TODAY).map((f) => f.name), ["Greek Yogurt"]); // Old Cereal is past the 60 days
});

// ---- idempotency ---------------------------------------------------------------------------------

const everything = (): Parts => ({
  food: [{ date: "1/5/2026", name: "Oatmeal", units: "Cup" }, { date: "1/6/2026", name: "Oatmeal", units: "Cup" }, { date: "1/6/2026", name: "Toast", deleted: true }],
  summary: [{ date: "1/5/2026", food: 100, exercise: 50, budget: 2000 }],
  weights: [["1/5/2026", 180]],
  exercise: [["1/5/2026", "Walk", -50, 30]],
  extra: {
    "daily-values.csv": dailyValuesCsv([["1/5/2026", 1]]),
    "steps.csv": stepsCsv([["1/5/2026", "8000.4"]]),
    "custom-foods.csv": customFoodsCsv([{ name: "Protein Bar", kcal: 200 }]),
    "progress-photos.csv": photosCsv([["1/5/2026", token(1)]]),
  },
  photos: { [photoName("2026-01-05", token(1))]: jpegBytes(800, 600, 300) },
});

test("re-importing the same export creates nothing at all (every kind), and doesn't inflate usage counts", async (t) => {
  const w = await world(t);
  const first = go(w.db, w.ann, everything());
  const before = dump(w.db);
  const second = go(w.db, w.ann, everything());
  assert.equal(first.counts.created, 2);
  assert.deepEqual(
    { ...second.counts, warnings: 0 },
    { created: 0, alreadyImported: 2, deletedSince: 0, skippedByConflict: 0, outsideRange: 0, deletedInExport: 1, plannedInFuture: 0, warnings: 0 });
  assert.deepEqual([second.foods.created, second.customFoods.created, second.customFoods.reused], [0, 0, 1]);
  assert.deepEqual([second.weights!.created, second.weights!.alreadyImported, second.exercise.created, second.exercise.alreadyImported], [0, 1, 0, 1]);
  assert.deepEqual([second.budgetSnapshots.written, second.budgetSnapshots.unchanged], [0, 1]);
  assert.deepEqual([second.doneDays.marked, second.doneDays.alreadyDone], [0, 1]);
  assert.deepEqual([second.steps.created, second.steps.alreadyImported], [0, 1]);
  assert.deepEqual([second.photos.created, second.photos.alreadyImported], [0, 1]);
  assert.equal(dump(w.db), before, "a second run changes no row at all");
  assert.equal(get<any>(w.db, "SELECT usage_count FROM nutrition_foods WHERE name = 'Oatmeal'")!.usage_count, 2);
});

test("a row deleted in Lose It! since the last import is soft-deleted here (once), and an unrelated deleted row is ignored", async (t) => {
  const w = await world(t);
  const base: Food[] = [{ date: "1/5/2026", name: "Oatmeal" }, { date: "1/5/2026", name: "Eggs" }, { date: "1/5/2026", name: "Toast" }];
  go(w.db, w.ann, { food: base });

  const second = go(w.db, w.ann, { food: [base[0], { ...base[1], deleted: 1 }, base[2], { date: "1/5/2026", name: "Never imported", deleted: 1 }] });
  assert.deepEqual([second.counts.created, second.counts.alreadyImported, second.counts.deletedSince], [0, 2, 1]);
  assert.deepEqual(live(w.db, w.ids.ann).map((e) => e.name_snapshot), ["Oatmeal", "Toast"]);
  assert.ok(get<any>(w.db, "SELECT * FROM nutrition_diary_entries WHERE name_snapshot = 'Eggs'")!.deleted_at, "soft-deleted, not removed");

  const third = go(w.db, w.ann, { food: [base[0], { ...base[1], deleted: 1 }, base[2]] });
  assert.deepEqual([third.counts.created, third.counts.alreadyImported, third.counts.deletedSince], [0, 2, 0]);

  // Eating the same thing again later is a new row, which imports as a new entry.
  const again = go(w.db, w.ann, { food: [base[0], { ...base[1], deleted: 1 }, base[2], base[1]] });
  assert.equal(again.counts.created, 1);
  assert.equal(live(w.db, w.ids.ann).filter((e) => e.name_snapshot === "Eggs").length, 1);
});

test("something you deleted here stays deleted: a re-import doesn't resurrect it", async (t) => {
  const w = await world(t);
  const files = { food: [{ date: "1/5/2026", name: "Oatmeal" }] };
  go(w.db, w.ann, files);
  run(w.db, "UPDATE nutrition_diary_entries SET deleted_at = '2026-02-01T00:00:00.000Z' WHERE user_id = ?", w.ids.ann);
  const r = go(w.db, w.ann, files);
  assert.deepEqual([r.counts.created, r.counts.alreadyImported], [0, 1]);
  assert.equal(live(w.db, w.ids.ann).length, 0);
});

test("twin identical rows both import, stay stable on re-import, and a later deletion removes exactly one", async (t) => {
  const w = await world(t);
  const egg: Food = { date: "1/5/2026", name: "Egg", kcal: 70 };
  assert.equal(go(w.db, w.ann, { food: [egg, egg] }).counts.created, 2);
  assert.equal(go(w.db, w.ann, { food: [egg, egg] }).counts.created, 0);
  const [a, b] = entriesOf(w.db, w.ids.ann);
  assert.notEqual(a.import_hash, b.import_hash);

  // One egg is deleted in Lose It!: the file now lists a live row and a Deleted one, in either order.
  const r = go(w.db, w.ann, { food: [egg, { ...egg, deleted: 1 }] });
  assert.deepEqual([r.counts.alreadyImported, r.counts.deletedSince], [1, 1]);
  assert.deepEqual(live(w.db, w.ids.ann).map((e) => e.id), [a.id]);

  const other = await world(t);
  go(other.db, other.ann, { food: [egg, egg] });
  const r2 = go(other.db, other.ann, { food: [{ ...egg, deleted: 1 }, egg] });
  assert.deepEqual([r2.counts.alreadyImported, r2.counts.deletedSince], [1, 1]);
  assert.equal(live(other.db, other.ids.ann).length, 1);
});

test("the same export imports into two people's diaries (hashes are per login) and each import stays in its own diary", async (t) => {
  const w = await world(t);
  const files = { food: [{ date: "1/5/2026", name: "Oatmeal" }] };
  assert.equal(go(w.db, w.ann, files).counts.created, 1);
  assert.equal(go(w.db, w.ben, files).counts.created, 1);
  assert.equal(count(w.db, "nutrition_diary_entries"), 2);
  assert.equal(live(w.db, w.ids.ann).length, 1);
  assert.equal(live(w.db, w.ids.ben).length, 1);
});

// ---- conflicts -------------------------------------------------------------------------------------------

async function withNative(t: TestContext) {
  const w = await world(t);
  // Ann already logged Jan 5 in this app: one entry of her own, and one planned item.
  const native = (id: string, status = "logged", source = "manual") => run(w.db,
    `INSERT INTO nutrition_diary_entries (id, user_id, local_date, slot_key, status, name_snapshot, quantity, unit_snapshot, nutrients_total, source, logged_at, updated_at)
     VALUES (?, ?, '2026-01-05', 'lunch', ?, 'Native lunch', 1, 'serving', '{"kcal":500,"protein":0,"carbs":0,"fat":0,"satFat":0,"sugars":0,"fiber":0,"cholesterolMg":0,"sodiumMg":0}', ?, '2026-01-05T12:00:00.000Z', '2026-01-05T12:00:00.000Z')`,
    id, w.ids.ann, status, source);
  native("native-1");
  native("native-2");
  return { w, native };
}
const conflictFiles = (): Parts => ({
  food: [{ date: "1/5/2026", name: "Oatmeal" }, { date: "1/5/2026", name: "Toast" }, { date: "1/6/2026", name: "Eggs" }],
  summary: [{ date: "1/5/2026", food: 200, exercise: 300, budget: 1900 }, { date: "1/6/2026", food: 100, exercise: 0, budget: 1950 }],
  extra: { "daily-values.csv": dailyValuesCsv([["1/5/2026", 1], ["1/6/2026", 1]]), "steps.csv": stepsCsv([["1/5/2026", 5000]]) },
});

test("conflict = skip (the default): a day you already logged here gets nothing at all", async (t) => {
  const { w } = await withNative(t);
  const r = go(w.db, w.ann, conflictFiles());
  assert.deepEqual(r.conflicts, { mode: "skip", count: 1, replacedEntries: 0, dates: [{ date: "2026-01-05", nativeEntries: 2, importRows: 2, action: "skipped" }] });
  assert.deepEqual([r.counts.created, r.counts.skippedByConflict], [1, 2]);
  assert.deepEqual(live(w.db, w.ids.ann).map((e) => e.name_snapshot).sort(), ["Eggs", "Native lunch", "Native lunch"]);
  // The skipped day also gets no frozen calorie budget, no imported exercise and no Done logging mark; the other day gets them.
  assert.equal(get<any>(w.db, "SELECT COUNT(*) AS n FROM nutrition_day_logs WHERE user_id = ? AND local_date = '2026-01-05'", w.ids.ann)!.n, 0);
  assert.equal(get<any>(w.db, "SELECT calorie_budget_kcal_snapshot AS b FROM nutrition_day_logs WHERE user_id = ? AND local_date = '2026-01-06'", w.ids.ann)!.b, 1950);
  assert.equal(r.exercise.skippedByConflict, 1);
  assert.equal(count(w.db, "nutrition_exercise"), 0);
  assert.deepEqual([r.doneDays.marked, r.doneDays.skippedByConflict], [1, 1]);
  // Days the report didn't list as conflicts aren't reconciled against the diary, only against the file.
  assert.equal(r.reconciliation.mismatches, 0);
});

test("conflict = merge: the import lands alongside what you logged", async (t) => {
  const { w } = await withNative(t);
  const r = go(w.db, w.ann, conflictFiles(), { conflict: "merge" });
  assert.equal(r.conflicts.dates[0].action, "merged");
  assert.equal(r.counts.created, 3);
  assert.equal(live(w.db, w.ids.ann).length, 5);
  assert.equal(r.conflicts.replacedEntries, 0);
  assert.equal(get<any>(w.db, "SELECT calorie_budget_kcal_snapshot AS b FROM nutrition_day_logs WHERE user_id = ? AND local_date = '2026-01-05'", w.ids.ann)!.b, 1900);
  assert.equal(count(w.db, "nutrition_exercise"), 1);
  assert.equal(r.doneDays.marked, 2);
});

test("conflict = replace: your logged entries for that day are soft-deleted, then the import lands", async (t) => {
  const { w } = await withNative(t);
  const r = go(w.db, w.ann, conflictFiles(), { conflict: "replace" });
  assert.deepEqual(r.conflicts, { mode: "replace", count: 1, replacedEntries: 2, dates: [{ date: "2026-01-05", nativeEntries: 2, importRows: 2, action: "replaced" }] });
  assert.equal(r.counts.created, 3);
  assert.deepEqual(live(w.db, w.ids.ann).map((e) => e.name_snapshot).sort(), ["Eggs", "Oatmeal", "Toast"]);
  assert.ok(get<any>(w.db, "SELECT deleted_at FROM nutrition_diary_entries WHERE id = 'native-1'")!.deleted_at, "soft-deleted, not removed");
  // Running it again: nothing of yours is left to conflict with.
  const again = go(w.db, w.ann, conflictFiles(), { conflict: "replace" });
  assert.deepEqual([again.conflicts.count, again.counts.created, again.counts.alreadyImported], [0, 0, 3]);
});

test("planned entries (the meal plan's) are not food you logged: they never make a conflict and are never replaced", async (t) => {
  const w = await world(t);
  run(w.db,
    `INSERT INTO nutrition_diary_entries (id, user_id, local_date, slot_key, status, name_snapshot, quantity, unit_snapshot, nutrients_total, source, logged_at, updated_at)
     VALUES ('plan-1', ?, '2026-01-05', 'dinner', 'planned', 'Planned stew', 1, 'serving', '{"kcal":600}', 'plan', '2026-01-05T12:00:00.000Z', '2026-01-05T12:00:00.000Z')`, w.ids.ann);
  for (const conflict of ["skip", "replace"] as const) {
    const r = go(w.db, w.ann, conflictFiles(), { conflict, dryRun: true });
    assert.equal(r.conflicts.count, 0, conflict);
    assert.equal(r.counts.created, 3, conflict);
  }
  go(w.db, w.ann, conflictFiles(), { conflict: "replace" });
  assert.equal(get<any>(w.db, "SELECT deleted_at FROM nutrition_diary_entries WHERE id = 'plan-1'")!.deleted_at, null, "the plan entry is untouched");
});

test("a day with food in the export but entries only from an earlier import is not a conflict", async (t) => {
  const w = await world(t);
  go(w.db, w.ann, conflictFiles());
  assert.equal(go(w.db, w.ann, conflictFiles()).conflicts.count, 0);
});

test("someone else's entries never conflict", async (t) => {
  const w = await world(t);
  run(w.db, `INSERT INTO nutrition_diary_entries (id, user_id, local_date, slot_key, name_snapshot, quantity, unit_snapshot, nutrients_total, source, logged_at, updated_at)
             VALUES ('bens', ?, '2026-01-05', 'lunch', 'Ben lunch', 1, 'serving', '{"kcal":1}', 'manual', 'x', 'x')`, w.ids.ben);
  assert.equal(go(w.db, w.ann, conflictFiles()).conflicts.count, 0);
});

// ---- reconciliation -----------------------------------------------------------------------------------------

test("reconciliation: a day whose Food cals disagree is flagged; small differences and 1% are not", async (t) => {
  const w = await world(t);
  const r = go(w.db, w.ann, {
    food: [
      { date: "1/5/2026", name: "A", kcal: 500 }, { date: "1/5/2026", name: "B", kcal: 500 },   // 1000
      { date: "1/6/2026", name: "C", kcal: 800 },                                                 // 800
      { date: "1/7/2026", name: "D", kcal: 1000 },                                                // 1000
      { date: "1/8/2026", name: "E", kcal: 2000 },                                                // 2000
      { date: "1/9/2026", name: "F", kcal: "1,250" },                                             // 1250
    ],
    summary: [
      { date: "1/5/2026", food: 1000 },   // exact
      { date: "1/6/2026", food: 1100 },   // deliberately wrong: 300 kcal off
      { date: "1/7/2026", food: 1002 },   // 2 kcal off: within tolerance
      { date: "1/8/2026", food: 2015 },   // 15 kcal off but under 1% of 2015
      { date: "1/9/2026", food: 1250 },   // thousands separator parsed
      { date: "1/10/2026", food: 600 },   // Lose It! says 600 kcal, the log has nothing
      { date: "1/11/2026" },              // no Food cals, nothing to compare
    ],
  });
  assert.equal(r.reconciliation.compared, 6);
  assert.equal(r.reconciliation.mismatches, 2);
  assert.deepEqual(r.reconciliation.first, [
    { date: "2026-01-06", summaryKcal: 1100, fileKcal: 800, diaryKcal: 800 },
    { date: "2026-01-10", summaryKcal: 600, fileKcal: 0, diaryKcal: 0 },
  ]);
});

test("reconciliation lists at most 15 days but counts them all", async (t) => {
  const w = await world(t);
  const days = Array.from({ length: 20 }, (_, i) => `1/${i + 1}/2026`);
  const r = go(w.db, w.ann, { food: days.map((d) => ({ date: d, name: "X", kcal: 100 })), summary: days.map((d) => ({ date: d, food: 999 })) });
  assert.deepEqual([r.reconciliation.compared, r.reconciliation.mismatches, r.reconciliation.first.length], [20, 20, 15]);
  assert.equal(r.reconciliation.first[0].date, "2026-01-01");
});

test("reconciliation also catches an entry edited in Lose It! after an earlier import (it re-imports beside the old one)", async (t) => {
  const w = await world(t);
  go(w.db, w.ann, { food: [{ date: "1/5/2026", name: "Oatmeal", qty: 1, kcal: 100 }, { date: "1/5/2026", name: "Toast", kcal: 100 }], summary: [{ date: "1/5/2026", food: 200 }] });
  // Quantity of the oatmeal changed 1 -> 2 in Lose It!: new content, so a new hash.
  const r = go(w.db, w.ann, { food: [{ date: "1/5/2026", name: "Oatmeal", qty: 2, kcal: 200 }, { date: "1/5/2026", name: "Toast", kcal: 100 }], summary: [{ date: "1/5/2026", food: 300 }] });
  assert.equal(r.counts.created, 1);
  assert.deepEqual(r.reconciliation.first, [{ date: "2026-01-05", summaryKcal: 300, fileKcal: 300, diaryKcal: 400 }]);
});

// ---- daily summary: calorie budgets and exercise ----------------------------------------------------------------

test("calorie budgets: only past days are frozen at the Lose It! number; maintenance is left empty; 0 or blank is 'no budget'", async (t) => {
  const w = await world(t);
  const files: Parts = {
    food: [{ date: "3/9/2026", name: "X" }],
    summary: [
      { date: "3/8/2026", budget: 2100 }, { date: "3/9/2026", budget: "2,000.5" }, { date: "3/10/2026", budget: 1900 }, // today
      { date: "3/11/2026", budget: 1800 },                                                                            // future
      { date: "3/7/2026", budget: 0 }, { date: "3/6/2026" },                                                          // none
    ],
  };
  const r = go(w.db, w.ann, files);
  assert.deepEqual(r.budgetSnapshots, { written: 2, unchanged: 0 });
  assert.deepEqual(rows(w.db, "SELECT local_date AS d, calorie_budget_kcal_snapshot AS b, maintenance_kcal_snapshot AS m FROM nutrition_day_logs WHERE user_id = ? ORDER BY d", w.ids.ann),
    [{ d: "2026-03-08", b: 2100, m: null }, { d: "2026-03-09", b: 2000.5, m: null }]);
  assert.deepEqual(go(w.db, w.ann, files).budgetSnapshots, { written: 0, unchanged: 2 });
});

test("an imported calorie budget survives the day being viewed, and a goal edit", async (t) => {
  const w = await world(t);
  go(w.db, w.ann, { food: [{ date: "3/8/2026", name: "Oatmeal", kcal: 400 }], summary: [{ date: "3/8/2026", budget: 2100 }] });
  run(w.db, "INSERT INTO nutrition_weights (id, user_id, measured_on, weight_kg) VALUES ('w', ?, '2026-03-01', 80)", w.ids.ann);
  const view = () => daySummary(w.db, w.ann, "2026-03-08", TODAY);
  assert.deepEqual([view().calorieBudget, view().maintenance, view().remaining], [2100, null, 1700]);
  addGoal(w.db, w.ann, TODAY, { effectiveFrom: "2026-03-01", planLbPerWeek: 2, activityLevel: "very", macroProtein: 20, macroCarbs: 50, macroFat: 30 });
  assert.equal(view().calorieBudget, 2100);
  assert.equal(get<any>(w.db, "SELECT calorie_budget_kcal_snapshot AS b FROM nutrition_day_logs WHERE user_id = ? AND local_date = '2026-03-08'", w.ids.ann)!.b, 2100);
});

test("exercise falls back to the summary's Exercise cals: one entry per day, kept in step with later exports", async (t) => {
  const w = await world(t);
  const mk = (e1: number | string): Parts => ({ food: [{ date: "1/5/2026", name: "X" }], summary: [{ date: "1/5/2026", exercise: e1 }, { date: "1/6/2026", exercise: 0 }, { date: "1/7/2026", exercise: "" }] });
  const r = go(w.db, w.ann, mk(200));
  assert.equal(r.exercise.mode, "summary");
  assert.deepEqual(rows(w.db, "SELECT id, name, kcal, source FROM nutrition_exercise"), [
    { id: `loseit-exday-${w.ids.ann}-2026-01-05`, name: "Exercise (from Lose It!)", kcal: 200, source: "import_loseit" },
  ]);
  assert.equal(daySummary(w.db, w.ann, "2026-01-05", TODAY).exercise, 200);

  assert.deepEqual([go(w.db, w.ann, mk(200)).exercise.created, go(w.db, w.ann, mk(200)).exercise.alreadyImported], [0, 1]);
  const bigger = go(w.db, w.ann, mk(350)); // the first export was taken mid-day
  assert.deepEqual([bigger.exercise.created, bigger.exercise.updated], [0, 1]);
  assert.equal(get<any>(w.db, "SELECT kcal FROM nutrition_exercise")!.kcal, 350);
  const gone = go(w.db, w.ann, mk(0));
  assert.equal(gone.exercise.deletedSince, 1);
  assert.equal(daySummary(w.db, w.ann, "2026-01-05", TODAY).exercise, 0);
  // Removed here by hand? Then it stays removed.
  go(w.db, w.ann, mk(400));
  run(w.db, "UPDATE nutrition_exercise SET deleted_at = 'x'");
  assert.equal(go(w.db, w.ann, mk(500)).exercise.alreadyImported, 1);
  assert.equal(get<any>(w.db, "SELECT deleted_at FROM nutrition_exercise")!.deleted_at, "x");
});

test("FIX 1: exercise-logs.csv stores calories burned as NEGATIVE numbers; they are imported (made positive), zero rows import as 0, and the summary's positive Exercise cals reconciles", async (t) => {
  const w = await world(t);
  const mk = (): Parts => ({
    food: [{ date: "1/5/2026", name: "X" }],
    exercise: [
      ["1/5/2026", "Walking", -172.53, 30],
      ["1/5/2026", "Cycling", -100, 20],
      ["1/6/2026", "Stretching", 0, 10],       // a real zero-calorie row
      ["1/6/2026", "Deleted run", -300, 30, true], // the real file spells Deleted 1/0
    ],
    summary: [{ date: "1/5/2026", exercise: 272.53 }, { date: "1/6/2026", exercise: 0 }],
  });
  const r = go(w.db, w.ann, mk());
  assert.equal(r.exercise.mode, "logs");
  assert.deepEqual([r.exercise.created, r.exercise.mismatches], [3, 0], "none skipped as negative; the summary agrees");
  assert.deepEqual(rows(w.db, "SELECT name, kcal, minutes, source FROM nutrition_exercise ORDER BY rowid"), [
    { name: "Walking", kcal: 172.53, minutes: 30, source: "import_loseit" },
    { name: "Cycling", kcal: 100, minutes: 20, source: "import_loseit" },
    { name: "Stretching", kcal: 0, minutes: 10, source: "import_loseit" },
  ]);
  assert.equal(daySummary(w.db, w.ann, "2026-01-05", TODAY).exercise, 272.53, "added back to the day, once");
  assert.equal(r.counts.warnings, 0, "no 'negative calories, skipped' warning any more");
  assert.deepEqual([go(w.db, w.ann, mk()).exercise.created, go(w.db, w.ann, mk()).exercise.alreadyImported], [0, 3]);
});

test("exercise-logs.csv, when its headers fit, replaces the summary fallback (never both) and is cross-checked against it", async (t) => {
  const w = await world(t);
  const mk = (ex: number): Parts => ({
    food: [{ date: "1/5/2026", name: "X" }], summary: [{ date: "1/5/2026", exercise: ex }],
    exercise: [["1/5/2026", "Running", -150, 20], ["1/5/2026", "Walking", -100, 30], ["1/5/2026", "Walking", -100, 30], ["1/6/2026", "Yoga", -80, 30, true]],
  });
  const r = go(w.db, w.ann, mk(350));
  assert.equal(r.exercise.mode, "logs");
  assert.deepEqual([r.exercise.created, r.exercise.mismatches], [3, 0]); // twin walks both import
  const logged = all<any>(w.db, "SELECT id, name, kcal FROM nutrition_exercise ORDER BY name, id");
  assert.equal(logged.length, 3);
  assert.ok(logged.every((x) => x.id.startsWith("loseit-ex-") && !x.id.startsWith("loseit-exday-")));
  assert.equal(daySummary(w.db, w.ann, "2026-01-05", TODAY).exercise, 350, "counted once, not logs plus summary");

  assert.deepEqual([go(w.db, w.ann, mk(350)).exercise.created, go(w.db, w.ann, mk(350)).exercise.alreadyImported], [0, 3]);
  assert.equal(go(w.db, w.ann, mk(999)).exercise.mismatches, 1); // the log and the summary disagree: the columns may have been misread

  // A row deleted in Lose It! later comes out; the file's own Deleted row never went in.
  const r2 = go(w.db, w.ann, { ...mk(350), exercise: [["1/5/2026", "Running", -150, 20, true], ["1/5/2026", "Walking", -100, 30], ["1/5/2026", "Walking", -100, 30]] });
  assert.equal(r2.exercise.deletedSince, 1);
  assert.equal(daySummary(w.db, w.ann, "2026-01-05", TODAY).exercise, 200);
});

test("an exercise-logs.csv whose headers aren't recognized is reported and the summary fallback is used instead", async (t) => {
  const w = await world(t);
  const r = go(w.db, w.ann, {
    food: [{ date: "1/5/2026", name: "X" }], summary: [{ date: "1/5/2026", exercise: 120 }],
    extra: { "exercise-logs.csv": csv("When,What,Burn", [["1/5/2026", "Run", 300]]) },
  });
  assert.equal(r.exercise.mode, "summary");
  assert.equal(get<any>(w.db, "SELECT kcal FROM nutrition_exercise")!.kcal, 120);
  const file = r.files.find((f) => f.name === "exercise-logs.csv")!;
  assert.deepEqual([file.recognized, file.status, file.headers, file.rows], [false, "not understood", ["When", "What", "Burn"], 1]);
  assert.ok(r.warnings.some((x) => /exercise-logs\.csv: columns not recognized/.test(x)));
});

// ---- weights ----------------------------------------------------------------------------------------------------------

test("weights: pounds become kilograms with deterministic ids, imports are idempotent, bad values are rejected", async (t) => {
  const w = await world(t); // Ann's account is imperial, so the unit defaults to lb
  const files: Parts = { food: [], weights: [["1/5/2026", 176.37], ["1/6/2026", 180], ["1/7/2026", 10], ["1/8/2026", 1000], ["1/9/2026", 181, true]] };
  const r = go(w.db, w.ann, files);
  assert.deepEqual(r.weights, {
    unit: "lb", unitSource: "account setting", created: 2, alreadyImported: 0, updated: 0, deletedSince: 0, rejected: 2, outsideRange: 0,
    first: { date: "2026-01-05", kg: 80 }, last: { date: "2026-01-06", kg: 81.65 },
  });
  const stored = all<any>(w.db, "SELECT id, measured_on, weight_kg, source FROM nutrition_weights ORDER BY measured_on");
  assert.deepEqual(stored.map((x) => [x.measured_on, x.weight_kg, x.source]), [["2026-01-05", 80, "import_loseit"], ["2026-01-06", 81.65, "import_loseit"]]);
  assert.match(stored[0].id, new RegExp(`^loseit-w-${w.ids.ann}-2026-01-05-[0-9a-f]{12}$`));
  assert.match(r.warnings.join("\n"), /weight 10 lb \(4\.54 kg\) is outside 20-400 kg/);

  const again = go(w.db, w.ann, files);
  assert.deepEqual([again.weights!.created, again.weights!.alreadyImported, again.weights!.rejected], [0, 2, 2]);
  assert.equal(count(w.db, "nutrition_weights"), 2);
});

test("FIX 2: weights.csv spells Deleted true/false (food and exercise spell it 1/0): a weight deleted in Lose It! since the last import is removed", async (t) => {
  const w = await world(t);
  go(w.db, w.ann, { food: [], weights: [["1/5/2026", 180], ["1/6/2026", 181]] });
  const r = go(w.db, w.ann, { food: [], weights: [["1/5/2026", 180], ["1/6/2026", 181, true]] });
  assert.deepEqual([r.weights!.alreadyImported, r.weights!.deletedSince], [1, 1]);
  assert.deepEqual(rows(w.db, "SELECT measured_on FROM nutrition_weights WHERE deleted_at IS NULL"), [{ measured_on: "2026-01-05" }]);
  // ...and the 1/0 spelling works in weights.csv too.
  const numeric = go(w.db, w.ann, { food: [], extra: { "weights.csv": csv("Date,Weight,Last Updated,Deleted", [["1/5/2026", 180, "x", 1]]) } });
  assert.equal(numeric.weights!.deletedSince, 1);
  assert.equal(count(w.db, "nutrition_weights WHERE deleted_at IS NULL"), 0);
});

test("FIX 3 (weight unit): the file has bare numbers, so the unit comes from the login's account setting unless an option says otherwise", async (t) => {
  const w = await world(t);
  saveProfile(w.db, w.ben, { unitSystem: "metric" }); // Ben's account is metric; Ann's is imperial
  const base: Parts = { food: [], weights: [["1/5/2026", 80]] };
  const unitOf = (user: Tracker, e: Parts | LoseItExport, o: Partial<ImportOptions> = {}) => {
    const wt = go(w.db, user, e, { dryRun: true, ...o }).weights!;
    return [wt.unit, wt.unitSource, wt.first!.kg];
  };

  assert.deepEqual(unitOf(w.ann, base), ["lb", "account setting", 36.29]);
  assert.deepEqual(unitOf(w.ben, base), ["kg", "account setting", 80]);
  // A real profile.csv (bare numbers, no unit setting) changes nothing.
  const bare = { ...base, extra: { "profile.csv": csv("Name,Value", [["Birthday", "1/1/1990"], ["Height", 70], ["Current Weight", 180]]) } };
  assert.deepEqual(unitOf(w.ann, bare), ["lb", "account setting", 36.29]);
  assert.deepEqual(unitOf(w.ben, bare), ["kg", "account setting", 80]);
  // The explicit option wins over everything.
  assert.deepEqual(unitOf(w.ann, bare, { weightUnit: "kg" }), ["kg", "option", 80]);
  assert.deepEqual(unitOf(w.ben, bare, { weightUnit: "lb" }), ["lb", "option", 36.29]);
  // A unit the FILE names is a fact, not a guess: it beats the account setting (and the report says so).
  const named = { ...base, extra: { "profile.csv": csv("Name,Value", [["Weight Units", "Kilograms"]]) } };
  assert.deepEqual(unitOf(w.ann, named), ["kg", "profile.csv", 80]);
  assert.deepEqual(unitOf(w.ann, named, { weightUnit: "lb" }), ["lb", "option", 36.29]);
  const headed = exportOf({ food: [] }); headed.files.set("weights.csv", csv("Date,Weight (kg)", [["1/5/2026", 80]]));
  assert.deepEqual(unitOf(w.ann, headed), ["kg", "weights.csv header", 80]);
  // A login with no profile at all counts as imperial (the profile's own default).
  const bare2 = await world(t, { profiles: false });
  const bareReport = go(bare2.db, peekTracker(bare2.db, bare2.ids.ann), base, { dryRun: true }).weights!;
  assert.deepEqual([bareReport.unit, bareReport.unitSource], ["lb", "account setting"]);
});

test("a wrong weight unit is repaired by re-importing with the right one: values update in place, no duplicates", async (t) => {
  const w = await world(t);
  const files: Parts = { food: [], weights: [["1/5/2026", 80], ["1/6/2026", 79.5]] };
  go(w.db, w.ann, files, { weightUnit: "lb" }); // wrongly assumed pounds: 36 kg
  assert.deepEqual(rows(w.db, "SELECT weight_kg FROM nutrition_weights ORDER BY measured_on").map((x) => x.weight_kg), [36.29, 36.06]);
  const fixed = go(w.db, w.ann, files, { weightUnit: "kg" });
  assert.deepEqual([fixed.weights!.created, fixed.weights!.updated], [0, 2]);
  assert.deepEqual(rows(w.db, "SELECT weight_kg FROM nutrition_weights ORDER BY measured_on").map((x) => x.weight_kg), [80, 79.5]);
});

// ---- Done logging days (daily-values.csv) -----------------------------------------------------------------------

test("IMPORT 4: Complete rows mark Done logging the way the Done button does, so streaks count them; Complete=0 is not done; the weights reset date is noted", async (t) => {
  const w = await world(t);
  const r = go(w.db, w.ann, {
    food: [],
    extra: { "daily-values.csv": dailyValuesCsv([
      ["1/5/2026", 1], ["1/6/2026", 1], ["1/7/2026", 0], ["3/20/2026", 1], ["1/5/2026", 1], ["1/9/2026", "RecordedWeightsResetDate", "7188"],
    ]) },
  });
  assert.deepEqual(
    { ...r.doneDays },
    { inFile: 3, marked: 2, alreadyDone: 0, notComplete: 1, outsideRange: 0, skippedByConflict: 0, future: 1, weightsResetDates: ["7188"] });
  // The same column POST /days/:date/done sets: nutrition_day_logs.done_logging_at.
  assert.equal(typeof daySummary(w.db, w.ann, "2026-01-05", TODAY).doneLoggingAt, "string");
  assert.equal(daySummary(w.db, w.ann, "2026-01-07", TODAY).doneLoggingAt, null, "Complete=0 means the day was not completed");
  assert.equal(daySummary(w.db, w.ann, "2026-03-20", TODAY).doneLoggingAt, null, "a day that has not happened can't be done");
  // Streaks count them with no food entries at all.
  assert.deepEqual(streakFor(w.db, w.ids.ann, "2026-01-06"), { current: 2, best: 2, countedToday: true });
  assert.equal(streakFor(w.db, w.ids.ben, "2026-01-06").best, 0, "the other login's streak is untouched");

  // Re-running never refreshes the time of a day already done.
  const stamp = get<any>(w.db, "SELECT done_logging_at AS d FROM nutrition_day_logs WHERE user_id = ? AND local_date = '2026-01-05'", w.ids.ann)!.d;
  const again = go(w.db, w.ann, { food: [], extra: { "daily-values.csv": dailyValuesCsv([["1/5/2026", 1]]) } });
  assert.deepEqual([again.doneDays.marked, again.doneDays.alreadyDone], [0, 1]);
  assert.equal(get<any>(w.db, "SELECT done_logging_at AS d FROM nutrition_day_logs WHERE user_id = ? AND local_date = '2026-01-05'", w.ids.ann)!.d, stamp);
});

test("Done logging: a day you already finished here keeps its mark, and the --from/--to window applies", async (t) => {
  const w = await world(t);
  run(w.db, "INSERT INTO nutrition_day_logs (user_id, local_date, done_logging_at) VALUES (?, '2026-01-05', '2026-01-05T20:00:00.000Z')", w.ids.ann);
  const r = go(w.db, w.ann, { food: [], extra: { "daily-values.csv": dailyValuesCsv([["1/5/2026", 1], ["2/5/2026", 1], ["3/5/2026", 1]]) } }, { from: "2026-02-01", to: "2026-02-28" });
  assert.deepEqual([r.doneDays.marked, r.doneDays.outsideRange], [1, 2]);
  assert.equal(get<any>(w.db, "SELECT done_logging_at AS d FROM nutrition_day_logs WHERE user_id = ? AND local_date = '2026-01-05'", w.ids.ann)!.d, "2026-01-05T20:00:00.000Z");
});

// ---- steps (steps.csv) ------------------------------------------------------------------------------------------

test("IMPORT 5: steps go into nutrition_steps as import_loseit, rounded to whole steps; a day you typed yourself is NEVER overwritten", async (t) => {
  const w = await world(t);
  putSteps(w.db, w.ann, TODAY, "2026-01-06", { steps: 4321 }); // typed by hand
  const mk = (n5: number | string): Parts => ({
    food: [], extra: { "steps.csv": stepsCsv([["1/5/2026", n5], ["1/6/2026", 7000], ["1/7/2026", 0.4], ["3/11/2026", 100], ["1/8/2026", 999999]]) },
  });
  const r = go(w.db, w.ann, mk("9999.9"));
  assert.deepEqual(r.steps, { inFile: 5, created: 2, updated: 0, alreadyImported: 0, keptManual: 1, outsideRange: 0, future: 1, rejected: 1 });
  assert.deepEqual(rows(w.db, "SELECT local_date, steps, source FROM nutrition_steps WHERE user_id = ? ORDER BY local_date", w.ids.ann), [
    { local_date: "2026-01-05", steps: 10000, source: "import_loseit" },
    { local_date: "2026-01-06", steps: 4321, source: "manual" },
    { local_date: "2026-01-07", steps: 0, source: "import_loseit" },
  ]);
  assert.equal(count(w.db, "nutrition_steps WHERE user_id = '" + w.ids.ben + "'"), 0);

  // Again: nothing changes. A later export with a different number updates ITS rows only.
  const same = go(w.db, w.ann, mk("9999.9"));
  assert.deepEqual([same.steps.created, same.steps.updated, same.steps.alreadyImported, same.steps.keptManual], [0, 0, 2, 1]);
  const changed = go(w.db, w.ann, mk(12000));
  assert.deepEqual([changed.steps.updated, changed.steps.keptManual], [1, 1]);
  assert.equal(get<any>(w.db, "SELECT steps FROM nutrition_steps WHERE user_id = ? AND local_date = '2026-01-05'", w.ids.ann)!.steps, 12000);
  assert.equal(get<any>(w.db, "SELECT steps FROM nutrition_steps WHERE user_id = ? AND local_date = '2026-01-06'", w.ids.ann)!.steps, 4321);

  // Typing over an imported day turns it into a typed one, and from then on the import keeps it.
  putSteps(w.db, w.ann, TODAY, "2026-01-05", { steps: 11 });
  const kept = go(w.db, w.ann, mk(15000));
  assert.deepEqual([kept.steps.updated, kept.steps.keptManual], [0, 2]);
  assert.equal(get<any>(w.db, "SELECT steps FROM nutrition_steps WHERE user_id = ? AND local_date = '2026-01-05'", w.ids.ann)!.steps, 11);
});

// ---- progress photos ---------------------------------------------------------------------------------------------

function photoParts(extra: Partial<Parts> = {}): Parts & { jpeg: Buffer } {
  const jpeg = jpegBytes(1200, 1600, 5000);
  return {
    food: [],
    extra: { "progress-photos.csv": photosCsv([["6/5/2025", token(1)]]) },
    photos: { [photoName("2025-06-05", token(1))]: jpeg },
    jpeg,
    ...extra,
  };
}

test("IMPORT 6: a progress photo is stored exactly as it is (no resizing), private to the importing login, matched to its row by token", async (t) => {
  const w = await world(t);
  const p = photoParts();
  const r = go(w.db, w.ann, p);
  assert.equal(r.photos.created, 1);
  const row = get<any>(w.db, "SELECT * FROM nutrition_photos")!;
  assert.deepEqual([row.user_id, row.taken_on, row.mime, row.width, row.height, row.source, row.deleted_at], [w.ids.ann, "2025-06-05", "image/jpeg", 1200, 1600, "import_loseit", null]);
  assert.ok(Buffer.from(row.bytes).equals(p.jpeg), "the exact bytes: not resized, not re-encoded");
  assert.equal(row.id, photoIdFor(w.ids.ann, token(1)));
  assert.equal(count(w.db, "nutrition_photos WHERE user_id = '" + w.ids.ben + "'"), 0);
});

test("photos: the size limit skips (and reports) a big file instead of shrinking it; deleted rows, missing files and non-pictures are skipped too", async (t) => {
  const w = await world(t);
  const small = jpegBytes(100, 100, 1000);
  const big = jpegBytes(4000, 3000, MAX_PHOTO_BYTES); // over the cap
  const r = go(w.db, w.ann, {
    food: [],
    extra: { "progress-photos.csv": photosCsv([
      ["6/1/2025", token(1)], ["6/2/2025", token(2)], ["6/3/2025", token(3), true], ["6/4/2025", token(4)], ["6/5/2025", token(5)], ["6/6/2025", token(6)], ["3/11/2026", token(7)],
    ]) },
    photos: {
      [photoName("2025-06-01", token(1))]: small,
      [photoName("2025-06-02", token(2))]: big,
      [photoName("2025-06-03", token(3))]: small, // marked Deleted
      // token 4: no file at all
      [photoName("2025-06-05", token(5))]: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24]), // not a picture
      [photoName("2025-06-06", token(6))]: pngBytes(20000, 20000), // an absurd pixel size
      [photoName("2026-03-11", token(7))]: small, // dated after today
    },
  });
  assert.deepEqual(
    { ...r.photos, limitBytes: 0 },
    { inFile: 7, created: 1, alreadyImported: 0, skippedDeleted: 1, deletedSinceKept: 0, tooBig: 1, unusable: 3, outsideRange: 0, future: 1, limitBytes: 0 });
  assert.equal(r.photos.limitBytes, MAX_PHOTO_BYTES);
  assert.deepEqual(rows(w.db, "SELECT taken_on FROM nutrition_photos"), [{ taken_on: "2025-06-01" }]);
  assert.ok(r.warnings.some((x) => /over the 6 MB limit, skipped \(photos are never shrunk on import\)/.test(x)));
});

test("photos: a re-run adds nothing; a photo you deleted here stays deleted; one deleted in Lose It! since is kept here", async (t) => {
  const w = await world(t);
  const p = photoParts();
  go(w.db, w.ann, p);
  const again = go(w.db, w.ann, p);
  assert.deepEqual([again.photos.created, again.photos.alreadyImported], [0, 1]);

  // Deleted in Lose It! after the import: the picture stays (deleting here empties the bytes for good, so the import never does).
  const gone = go(w.db, w.ann, { ...p, extra: { "progress-photos.csv": photosCsv([["6/5/2025", token(1), true]]) } });
  assert.deepEqual([gone.photos.skippedDeleted, gone.photos.deletedSinceKept], [1, 1]);
  assert.equal(count(w.db, "nutrition_photos WHERE deleted_at IS NULL"), 1);

  // Deleted by the person here: a re-import does not bring it back.
  deletePhoto(w.db, w.ann, photoIdFor(w.ids.ann, token(1)));
  const noReturn = go(w.db, w.ann, p);
  assert.deepEqual([noReturn.photos.created, noReturn.photos.alreadyImported], [0, 1]);
  assert.equal(count(w.db, "nutrition_photos WHERE deleted_at IS NULL"), 0);
});

test("photos: two logins importing the same export each get their own private copy", async (t) => {
  const w = await world(t);
  const p = photoParts();
  go(w.db, w.ann, p);
  go(w.db, w.ben, p);
  assert.deepEqual(rows(w.db, "SELECT user_id FROM nutrition_photos ORDER BY rowid").map((x) => x.user_id), [w.ids.ann, w.ids.ben]);
});

// ---- custom foods, and who can see the foods an import creates ---------------------------------------------------------

test("IMPORT 7: custom foods are foods (read like a log row: nutrients are totals for Quantity x Measure), and the log rows for the same food reuse them", async (t) => {
  const w = await world(t);
  const r = go(w.db, w.ann, {
    food: [{ date: "1/5/2026", name: "Protein Bar", units: "Serving", kcal: 200 }, { date: "1/6/2026", name: "Plain Toast", units: "Slice", kcal: 80 }],
    extra: { "custom-foods.csv": customFoodsCsv([
      { name: "Protein Bar", brand: "Acme", qty: 1, measure: "Serving", kcal: 200, protein: 20 },
      { name: "House Rice", qty: 50, measure: "Grams", kcal: 65, carbs: 14 },
      { name: "Fizz", qty: 12, measure: "Fluid ounces", kcal: 150 },
    ]) },
  });
  assert.deepEqual(r.customFoods, { rows: 3, created: 3, reused: 0, withoutNutrition: 0 });
  assert.deepEqual(r.foods, { created: 1, reused: 1, withoutNutrition: 0 }, "the history's Protein Bar found the custom food; only Plain Toast is new");

  const bar = get<any>(w.db, "SELECT * FROM nutrition_foods WHERE source_ref = 'loseit:protein bar|serving'")!;
  assert.deepEqual([bar.brand, bar.basis, bar.source, bar.owner_user_id, JSON.parse(bar.nutrients).protein, bar.usage_count], ["Acme", "per_serving", "import_loseit", null, 20, 1]);
  assert.equal(entriesOf(w.db, w.ids.ann, "name_snapshot = 'Protein Bar'")[0].food_id, bar.id, "one food, not two");
  const rice = get<any>(w.db, "SELECT * FROM nutrition_foods WHERE source_ref = 'loseit:house rice|grams'")!;
  assert.deepEqual([rice.basis, JSON.parse(rice.nutrients).kcal, JSON.parse(rice.nutrients).carbs], ["per100g", 130, 28]); // 65 kcal for 50 g
  const fizz = get<any>(w.db, "SELECT * FROM nutrition_foods WHERE source_ref = 'loseit:fizz|fluid ounces'")!;
  assert.deepEqual([fizz.basis, JSON.parse(fizz.nutrients).kcal], ["per_serving", 12.5]); // 150 kcal for 12 fl oz -> per fl oz
  assert.deepEqual(rows(w.db, "SELECT label, grams FROM nutrition_food_servings WHERE food_id = ?", fizz.id), [{ label: "Fluid ounces", grams: null }]);

  // A custom food with no calories has no nutrition: reported, not invented.
  const bad = go(w.db, w.ann, { food: [], extra: { "custom-foods.csv": csv("Name,UniqueId,Brand,Image,Quantity,Measure,Calories", [["Mystery", "u", "", "", 1, "Each", "n/a"]]) } });
  assert.deepEqual(bad.customFoods, { rows: 1, created: 0, reused: 0, withoutNutrition: 1 });
});

test("IMPORT 8: foods the import creates are shared with the household by default; 'Only me' makes them personal (history foods and custom foods alike)", async (t) => {
  const w = await world(t);
  const parts = (): Parts => ({
    food: [{ date: "1/5/2026", name: "Oatmeal", units: "Cup", kcal: 166 }],
    extra: { "custom-foods.csv": customFoodsCsv([{ name: "House Bar", kcal: 150 }]) },
  });
  go(w.db, w.ann, parts());
  const shared = all<any>(w.db, "SELECT * FROM nutrition_foods WHERE source = 'import_loseit'");
  assert.equal(shared.length, 2);
  assert.ok(shared.every((f) => f.owner_user_id === null && f.created_by_user_id === w.ids.ann), "joint: owner null, made by Ann");
  assert.ok(shared.every((f) => canSee(f, w.ids.ben)), "Ben can see them");
  assert.deepEqual(searchFoods(w.db, w.ids.ben, "oatmeal", 5).map((f) => f.name), ["Oatmeal"]);

  const only = await world(t);
  const r = go(only.db, only.ann, parts(), { foodScope: "personal" });
  assert.deepEqual([r.foods.created, r.customFoods.created], [1, 1]);
  const mine = all<any>(only.db, "SELECT * FROM nutrition_foods WHERE source = 'import_loseit'");
  assert.ok(mine.every((f) => f.owner_user_id === only.ids.ann), "personal: owned by Ann");
  assert.ok(mine.every((f) => canSee(f, only.ids.ann) && !canSee(f, only.ids.ben)));
  assert.deepEqual(searchFoods(only.db, only.ids.ben, "oatmeal", 5), [], "Ben can't find Ann's personal foods");
  // Who ate it stays in each person's own diary either way.
  assert.equal(entriesOf(only.db, only.ids.ben).length, 0);
  assert.throws(() => go(only.db, only.ann, parts(), { foodScope: "everyone" as any }), NutritionError);
});

test("a partner's import reuses the household's imported foods, adds to their usage, and never touches existing nutrition", async (t) => {
  const w = await world(t);
  const a = go(w.db, w.ann, { food: [{ date: "2/1/2026", name: "Oatmeal", units: "Cup", kcal: 166 }, { date: "2/2/2026", name: "Oatmeal", units: "Cup", kcal: 166 }] });
  assert.equal(a.foods.created, 1);
  const shared = get<any>(w.db, "SELECT * FROM nutrition_foods WHERE source = 'import_loseit'")!;
  assert.deepEqual([shared.usage_count, shared.last_used_at], [2, "2026-02-02T12:00:00.000Z"]);

  const b = go(w.db, w.ben, { food: [
    { date: "1/20/2026", name: "OATMEAL", units: "cup", kcal: 999 }, // same food as far as the household is concerned
    { date: "1/21/2026", name: "Bagel", kcal: 300 },
  ] });
  assert.deepEqual([b.foods.created, b.foods.reused], [1, 1]);
  assert.equal(count(w.db, "nutrition_foods"), 2);
  const oats = getFood(w.db, shared.id)!;
  assert.equal(JSON.parse(oats.nutrients).kcal, 166, "the existing food keeps its nutrition");
  assert.deepEqual([oats.usage_count, oats.last_used_at], [3, "2026-02-02T12:00:00.000Z"]); // +1; last-used doesn't move backwards
  assert.equal(entriesOf(w.db, w.ids.ben)[0].food_id, shared.id);
  assert.equal(get<any>(w.db, "SELECT owner_user_id FROM nutrition_foods WHERE name = 'Bagel'")!.owner_user_id, null, "Ben's import was shared too (the default)");
});

test("private imported foods stay private: the partner gets their own", async (t) => {
  const w = await world(t);
  const row: Food = { date: "2/1/2026", name: "Secret Snack", kcal: 100 };
  go(w.db, w.ann, { food: [row] }, { foodScope: "personal" });
  const mine = get<any>(w.db, "SELECT * FROM nutrition_foods")!;
  assert.equal(mine.owner_user_id, w.ids.ann);
  assert.equal(canSee(mine, w.ids.ann), true);
  assert.equal(canSee(mine, w.ids.ben), false);

  const b = go(w.db, w.ben, { food: [row] });
  assert.deepEqual([b.foods.created, b.foods.reused], [1, 0]);
  assert.equal(count(w.db, "nutrition_foods"), 2);
  assert.equal(get<any>(w.db, "SELECT food_id FROM nutrition_diary_entries WHERE user_id = ?", w.ids.ben)!.food_id !== mine.id, true);
  // And a later import by Ann reuses her own personal one rather than Ben's shared one.
  const again = go(w.db, w.ann, { food: [{ ...row, date: "2/3/2026" }] }, { foodScope: "personal" });
  assert.deepEqual([again.foods.created, again.foods.reused], [0, 1]);
  assert.equal(entriesOf(w.db, w.ids.ann).at(-1).food_id, mine.id);
});

test("a soft-deleted imported food isn't reused: new entries get a fresh one", async (t) => {
  const w = await world(t);
  go(w.db, w.ann, { food: [{ date: "2/1/2026", name: "Oatmeal" }] });
  run(w.db, "UPDATE nutrition_foods SET deleted_at = 'x'");
  const r = go(w.db, w.ann, { food: [{ date: "2/2/2026", name: "Oatmeal" }] });
  assert.equal(r.foods.created, 1);
  assert.equal(count(w.db, "nutrition_foods"), 2);
});

// ---- skipped files -----------------------------------------------------------------------------------------------------

test("IMPORT 9: recipes.csv is SKIPPED by choice (reported, never imported); sodium, cholesterol and the rest are skipped on purpose with their reason", async (t) => {
  const w = await world(t);
  const r = go(w.db, w.ann, {
    food: [{ date: "1/5/2026", name: "X" }],
    extra: {
      "recipes.csv": csv("Name,UniqueId,Quantity,Measure,Author,Image Name,Calories", [["Chili", "u1", 6, "Servings", "me", "", 1800]]),
      "sodium.csv": csv("Date,Value,Secondary Value,Last Updated", [["1/5/2026", 1000, 0, "x"]]),
      "cholesterol.csv": csv("Date,Value,Secondary Value,Last Updated", [["1/5/2026", 100, 0, "x"]]),
      "fasting-logs.csv": "Scheduled start,Scheduled duration,Actual start,Actual end,Deleted\r\n",
      "achievements.csv": csv("Tag,Level,Earned On,Deleted", [["a", 1, "1/1/2026", 0]]),
      "water-intake.csv": csv("Date,Value,Secondary Value,Last Updated", [["1/5/2026", 8, 0, "x"]]),
      "food-photos.csv": csv("Date,Meal Type,Visibility,Token,Deleted,Last Updated", [["1/5/2026", "Dinner", "Private", token(9), "false", "x"]]),
      "notes.csv": "Date,Title,Body\r\n",
      "lab-report-entries.csv": "StartDate,EndDate,StorageToken,Score,ScoreVersion,ScoreComponents,Deleted\r\n",
      "mystery.csv": csv("A,B", [[1, 2]]),
    },
  });
  const status = Object.fromEntries(r.files.map((f) => [f.name, f.status]));
  assert.equal(status["recipes.csv"], "skipped");
  assert.match(r.files.find((f) => f.name === "recipes.csv")!.note, /^skipped by choice/);
  for (const name of ["sodium.csv", "cholesterol.csv", "fasting-logs.csv", "achievements.csv", "water-intake.csv", "food-photos.csv", "notes.csv", "lab-report-entries.csv", "mystery.csv"]) {
    assert.equal(status[name], "skipped", name);
  }
  assert.match(r.files.find((f) => f.name === "sodium.csv")!.note, /count everything twice/);
  assert.match(r.files.find((f) => f.name === "cholesterol.csv")!.note, /count everything twice/);
  assert.equal(r.counts.warnings, 0, "skipping is not a problem");
  // Nothing from any of them reached the database: no recipe food, no recipe document, no water, no sodium rows.
  assert.equal(count(w.db, "nutrition_foods WHERE source = 'recipe'"), 0);
  assert.equal(count(w.db, "recipes"), 0);
  assert.equal(entriesOf(w.db, w.ids.ann).length, 1);
  assert.match(formatReport(r, "Ann"), /recipes\.csv +\d+ rows +skipped +skipped by choice/);
});

// ---- the kiosk, the dry run, atomicity, windows ------------------------------------------------------------------------------

test("the kiosk login never imports: refused with 403 and nothing written", async (t) => {
  const w = await world(t);
  const before = dump(w.db);
  const kiosk = { id: w.ids.kiosk, displayName: "Kiosk", role: "kiosk", profile: null } as unknown as Tracker;
  assert.throws(() => go(w.db, kiosk, { food: [{ date: "1/5/2026", name: "Oatmeal" }] }), (e: any) => e instanceof NutritionError && e.status === 403);
  assert.equal(dump(w.db), before);
  // The table triggers are the backstop for anything that bypasses the check.
  assert.throws(() => run(w.db, "INSERT INTO nutrition_steps (user_id, local_date, steps, source, updated_at) VALUES (?, '2026-01-05', 1, 'import_loseit', 'x')", w.ids.kiosk), /only admin and parent/);
});

test("a dry run writes nothing at all, yet reports exactly what the real run then does", async (t) => {
  const { w } = await withNative(t);
  run(w.db, "INSERT INTO nutrition_weights (id, user_id, measured_on, weight_kg) VALUES ('w0', ?, '2026-01-01', 70)", w.ids.ann);
  run(w.db, "UPDATE nutrition_goals SET plan_lb_per_week = 1 WHERE user_id = ?", w.ids.ann);
  const p = photoParts();
  const files: Parts = {
    food: [
      { date: "1/5/2026", name: "Oatmeal", units: "Cup" }, { date: "1/5/2026", name: "Shake", type: "Pre-Workout" },
      { date: "1/6/2026", name: "Rice", units: "Grams", qty: 100 }, { date: "1/6/2026", name: "Gone", deleted: 1 },
    ],
    summary: [{ date: "1/5/2026", food: 200, exercise: 100, budget: 2000 }, { date: "1/6/2026", food: 200, exercise: 50, budget: 2000 }],
    weights: [["1/5/2026", 150]],
    extra: { ...p.extra, "daily-values.csv": dailyValuesCsv([["1/6/2026", 1]]), "steps.csv": stepsCsv([["1/6/2026", 4000]]), "custom-foods.csv": customFoodsCsv([{ name: "Bar" }]) },
    photos: p.photos,
  };
  const opts = { conflict: "replace" } as const;

  const before = dump(w.db);
  const preview = go(w.db, w.ann, files, { ...opts, dryRun: true });
  assert.equal(dump(w.db), before, "no row anywhere changed, including the replaced native entries, the photos and the goals");
  assert.equal(preview.dryRun, true);
  assert.ok(preview.counts.created > 0 && preview.foods.created > 0 && preview.conflicts.replacedEntries === 2);
  assert.deepEqual([preview.steps.created, preview.photos.created, preview.doneDays.marked, preview.customFoods.created], [1, 1, 1, 1]);

  const real = go(w.db, w.ann, files, opts);
  assert.notEqual(dump(w.db), before);
  assert.deepEqual({ ...real, dryRun: true }, preview, "same counts, same everything, apart from the flag");
});

test("a dry run leaves a brand-new login with no meals at all; a real run gives them the four defaults", async (t) => {
  const w = await world(t, { profiles: false });
  const ann = peekTracker(w.db, w.ids.ann);
  go(w.db, ann, { food: [{ date: "1/5/2026", name: "Oatmeal" }] }, { dryRun: true });
  assert.equal(allSlotsFor(w.db, w.ids.ann).length, 0);
  go(w.db, ann, { food: [{ date: "1/5/2026", name: "Oatmeal" }] });
  assert.deepEqual(allSlotsFor(w.db, w.ids.ann).map((s) => s.key), ["breakfast", "lunch", "dinner", "snacks"]);
});

test("a failure part-way leaves nothing behind", async (t) => {
  const w = await world(t);
  const before = dump(w.db);
  // Weights are imported after the diary; make that step blow up.
  w.db.exec("CREATE TRIGGER boom BEFORE INSERT ON nutrition_weights BEGIN SELECT RAISE(ABORT, 'boom'); END");
  assert.throws(() => go(w.db, w.ann, { food: [{ date: "1/5/2026", name: "Oatmeal" }], weights: [["1/5/2026", 180]], extra: { "steps.csv": stepsCsv([["1/5/2026", 100]]) } }), /boom/);
  assert.equal(dump(w.db), before);
});

test("not an export: nothing is written and the 400 says why", async (t) => {
  const w = await world(t);
  const before = dump(w.db);
  assert.throws(() => go(w.db, w.ann, { files: new Map([["weights.csv", "Date,Weight\n"]]), photos: new Map(), ignoredImages: 0 }),
    (e: any) => e instanceof NutritionError && e.status === 400 && /No food-logs\.csv/.test(e.message));
  assert.equal(dump(w.db), before);
});

test("--from / --to limit every part of the import to that window, and bad windows are rejected", async (t) => {
  const w = await world(t);
  const p = photoParts();
  const files: Parts = {
    food: [{ date: "1/5/2026", name: "Jan" }, { date: "2/5/2026", name: "Feb" }, { date: "3/5/2026", name: "Mar" }],
    summary: [{ date: "1/5/2026", exercise: 10, budget: 2000 }, { date: "2/5/2026", exercise: 20, budget: 2000 }, { date: "3/5/2026", exercise: 30, budget: 2000 }],
    weights: [["1/5/2026", 180], ["2/5/2026", 181], ["3/5/2026", 182]],
    extra: { "steps.csv": stepsCsv([["1/5/2026", 1], ["2/5/2026", 2], ["3/5/2026", 3]]), ...p.extra },
    photos: p.photos, // dated 2025-06-05: outside
  };
  const r = go(w.db, w.ann, files, { from: "2026-02-01", to: "2026-02-28" });
  assert.deepEqual(entriesOf(w.db, w.ids.ann).map((e) => e.name_snapshot), ["Feb"]);
  assert.deepEqual(r.options.from, "2026-02-01");
  assert.equal(r.counts.outsideRange, 2);
  assert.deepEqual(r.dateRange, { from: "2026-02-05", to: "2026-02-05", daysWithEntries: 1 });
  assert.deepEqual(rows(w.db, "SELECT local_date FROM nutrition_day_logs"), [{ local_date: "2026-02-05" }]);
  assert.deepEqual(rows(w.db, "SELECT local_date FROM nutrition_exercise"), [{ local_date: "2026-02-05" }]);
  assert.deepEqual([r.weights!.created, r.weights!.outsideRange], [1, 2]);
  assert.deepEqual([r.steps.created, r.steps.outsideRange], [1, 2]);
  assert.deepEqual([r.photos.created, r.photos.outsideRange], [0, 1]);
  assert.equal(r.reconciliation.compared, 0); // no Food cals in this fixture

  assert.throws(() => go(w.db, w.ann, files, { from: "nope" }), NutritionError);
  assert.throws(() => go(w.db, w.ann, files, { from: "2026-03-01", to: "2026-02-01" }), /must not be after/);
  assert.throws(() => go(w.db, w.ann, files, { conflict: "wipe" as any }), NutritionError);
});

// ---- the calorie budget comparison (IMPORT 10) --------------------------------------------------------------------------------

// Ann: female, born 1990-06-15, 170 cm. At 80 kg and age 35 her Mifflin-St Jeor BMR is
// 10*80 + 6.25*170 - 5*35 - 161 = 1526.5, so a calorie budget of BMR*PAL - 500 (1 lb/week) implies PAL.
const BMR = 1526.5;
const budgetFor = (pal: number) => Math.round((BMR * pal - 500) * 100) / 100;

async function calibrationWorld(t: TestContext, pals: number[]) {
  const w = await world(t);
  run(w.db, "UPDATE nutrition_goals SET plan_lb_per_week = 1 WHERE user_id = ?", w.ids.ann);
  // pals[0] is the newest day, ending on March 9.
  const summary = pals.map((pal, i) => {
    const d = new Date(Date.UTC(2026, 2, 9 - i));
    return { date: `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`, budget: budgetFor(pal) };
  });
  const files: Parts = { food: [{ date: "2/1/2026", name: "X" }], summary, weights: [["1/1/2026", 80]] };
  return { w, files };
}
const goalCount = (db: Db) => count(db, "nutrition_goals");

test("calibration: the median implied multiplier over the last 30 days is shown as a comparison, and never applied by the import", async (t) => {
  // 15 days at 1.3, 15 at 1.5 (the median is their midpoint), plus older days at 2.0 that must not count.
  const { w, files } = await calibrationWorld(t, [...Array(15).fill(1.3), ...Array(15).fill(1.5), ...Array(5).fill(2)]);
  const goalsBefore = goalCount(w.db);
  const r = go(w.db, w.ann, files, { weightUnit: "kg" });
  assert.deepEqual({ ...r.calibration }, {
    status: "computed", needsProfile: false, daysUsed: 30, median: 1.4, min: 1.3, max: 1.5,
    loseItAvgKcal: 1637, appAvgKcal: 1599, matchedAvgKcal: 1637, goalHasOwnBudget: false, canApply: true, applyRequested: false, applied: false,
  });
  assert.equal(goalCount(w.db), goalsBefore, "nothing written to the goals");
  assert.equal(goalOn(w.db, w.ids.ann, TODAY)!.pal_override, null);
  assert.match(formatReport(r, "Ann"), /Lose It! gave you about 1,637 a day over the last 30 days; this app gives 1,599 \(1,637 with the matched multiplier\)/);
  assert.match(formatReport(r, "Ann"), /Not applied; use --apply-calibration/);
});

test("calibration: the separate explicit action adds a NEW goal row effective today and nothing else changes", async (t) => {
  const { w, files } = await calibrationWorld(t, [1.2, 1.5, 1.4]);
  run(w.db, "UPDATE nutrition_goals SET calorie_schedule = ? WHERE user_id = ?", '{"highDays":[0,6],"extraKcal":300}', w.ids.ann);
  const r = go(w.db, w.ann, files, { weightUnit: "kg" });
  assert.deepEqual([r.calibration.median, r.calibration.daysUsed, r.calibration.applied, r.calibration.canApply], [1.4, 3, false, true]);
  const before = goalCount(w.db);

  const goal = applyCalibration(w.db, w.ann, TODAY, r.calibration.median);
  assert.equal(goalCount(w.db), before + 1);
  assert.deepEqual([goal.effective_from, goal.pal_override, goal.plan_lb_per_week, goal.activity_level, goal.macro_protein], [TODAY, 1.4, 1, "light", 20]);
  assert.equal(goalOn(w.db, w.ids.ann, "2026-03-09")!.pal_override, null, "yesterday keeps the goal it was lived under");
  assert.deepEqual(JSON.parse(goal.calorie_schedule!), { highDays: [0, 6], extraKcal: 300 }, "the calorie schedule carries over to the new goal row");
  assert.equal(goalOn(w.db, w.ids.ben, TODAY)!.pal_override, null, "the other login's goal is untouched");
});

test("calibration: the CLI's explicit --apply-calibration applies it inside the import (and a dry run still writes nothing)", async (t) => {
  const { w, files } = await calibrationWorld(t, [1.2, 1.5, 1.4]);
  const before = goalCount(w.db);
  const dry = go(w.db, w.ann, files, { weightUnit: "kg", applyCalibration: true, dryRun: true });
  assert.equal(dry.calibration.applied, true);
  assert.equal(goalCount(w.db), before);
  const real = go(w.db, w.ann, files, { weightUnit: "kg", applyCalibration: true });
  assert.equal(real.calibration.applied, true);
  assert.equal(goalCount(w.db), before + 1);
  assert.equal(goalOn(w.db, w.ids.ann, TODAY)!.pal_override, 1.4);
});

test("calibration: rounds to 3 decimals; refuses (with a reason) a multiplier outside 1-3, a goal with its own calorie budget, or a missing profile", async (t) => {
  const odd = await calibrationWorld(t, [1.23456, 1.23456, 1.23456]);
  assert.equal(go(odd.w.db, odd.w.ann, odd.files, { weightUnit: "kg" }).calibration.median, 1.235);

  const wild = await calibrationWorld(t, [0.5, 0.5, 0.5]);
  const wr = go(wild.w.db, wild.w.ann, wild.files, { weightUnit: "kg", applyCalibration: true }).calibration;
  assert.deepEqual([wr.median, wr.applied, wr.canApply], [0.5, false, false]);
  assert.match(wr.reason!, /outside 1-3/);
  assert.throws(() => applyCalibration(wild.w.db, wild.w.ann, TODAY, 0.5), (e: any) => e instanceof NutritionError && e.status === 400);
  assert.throws(() => applyCalibration(wild.w.db, wild.w.ann, TODAY, "1.4"), NutritionError);

  const own = await calibrationWorld(t, [1.4, 1.4]);
  run(own.w.db, "UPDATE nutrition_goals SET calorie_budget_override_kcal = 1800 WHERE user_id = ?", own.w.ids.ann);
  const oc = go(own.w.db, own.w.ann, own.files, { weightUnit: "kg" }).calibration;
  assert.deepEqual([oc.status, oc.goalHasOwnBudget, oc.canApply], ["computed", true, false]);
  assert.match(oc.reason!, /calorie budget of your own/);
  assert.throws(() => applyCalibration(own.w.db, own.w.ann, TODAY, 1.4), (e: any) => e instanceof NutritionError && e.status === 409);

  const noSummary = await world(t);
  assert.match(go(noSummary.db, noSummary.ann, { food: [] }).calibration.reason!, /no usable daily-calorie-summary/);
});

test("calibration: with no profile (sex, birth date, height) the comparison says it needs the profile first", async (t) => {
  const w = await world(t, { profiles: false });
  const r = go(w.db, peekTracker(w.db, w.ids.ann), { food: [], summary: [{ date: "3/9/2026", budget: 1800 }] });
  assert.deepEqual([r.calibration.status, r.calibration.needsProfile, r.calibration.canApply], ["skipped", true, false]);
  assert.match(r.calibration.reason!, /needs your profile first \(sex, birth date and height\)/);
  assert.throws(() => applyCalibration(w.db, peekTracker(w.db, w.ids.ann), TODAY, 1.4), (e: any) => e instanceof NutritionError && e.status === 409);

  const noWeight = await world(t);
  const bare = go(noWeight.db, noWeight.ann, { food: [], summary: [{ date: "3/9/2026", budget: 1800 }] });
  assert.deepEqual([bare.calibration.status, bare.calibration.needsProfile, bare.calibration.reason], ["skipped", false, "no day has both a Lose It! calorie budget and a weight"]);
});

// ---- the file inventory and the CLI text ------------------------------------------------------------------------------------

test("the report carries the file inventory, including files nobody can read", async (t) => {
  const w = await world(t);
  const r = go(w.db, w.ann, {
    food: [{ date: "1/5/2026", name: "X" }],
    extra: { "custom-foods.csv": csv("Foo,Bar", [[1, 2], [3, 4]]), "fasting-logs.csv": "Start,End\n" },
  });
  assert.deepEqual(r.files.map((f) => [f.name, f.rows, f.recognized, f.status]), [
    ["custom-foods.csv", 2, false, "not understood"], ["fasting-logs.csv", 0, false, "skipped"], ["food-logs.csv", 1, true, "understood"],
  ]);
  assert.deepEqual(r.files[0].headers, ["Foo", "Bar"]);
  assert.ok(r.warnings.some((x) => /^custom-foods\.csv: missing column/.test(x)), "a file it should read but can't is a warning");
});

test("the CLI text covers every part of a full report, and says dry run when it is one", async (t) => {
  const { w } = await withNative(t);
  run(w.db, "UPDATE nutrition_goals SET plan_lb_per_week = 1 WHERE user_id = ?", w.ids.ann);
  const p = photoParts();
  const files: Parts = {
    food: [{ date: "1/5/2026", name: "Oatmeal" }, { date: "1/6/2026", name: "Shake", type: "Pre-Workout" }, { date: "1/7/2026", name: "Water", qty: 0 }],
    summary: [{ date: "1/5/2026", food: 100, budget: 2000 }, { date: "1/6/2026", food: 500, exercise: 90, budget: 2000 }],
    weights: [["1/5/2026", 180]],
    extra: { ...p.extra, "daily-values.csv": dailyValuesCsv([["1/6/2026", 1]]), "steps.csv": stepsCsv([["1/6/2026", 4000]]), "custom-foods.csv": customFoodsCsv([{ name: "Bar" }]), "recipes.csv": csv("Name,UniqueId", [["x", "y"]]) },
    photos: p.photos,
  };
  const dry = formatReport(go(w.db, w.ann, files, { dryRun: true }), "Ann (ann)");
  for (const want of [
    "Lose It! import for Ann (ann): DRY RUN",
    "food-logs.csv", "understood", "skipped by choice",
    "2 to create", 'Meal:     "Pre-Workout" (pre-workout): 1 entries, enabled, slot created',
    "shared with the household", "Custom:   1 custom foods",
    "Days you already logged here (--conflict skip): 1", "2026-01-05",
    "Read as lb (decided by: account setting)", "Check the unit: first 2026-01-05 = 81.65 kg",
    "From the daily summary's Exercise cals: 1 to create",
    "Done logging days", "1 days marked Complete in the file: 1 to mark",
    "Steps", "Progress photos", "1 in the file: 1 to create",
    "to freeze at their Lose It! calorie budget",
    "1 of 2 days differ", "2026-01-06  Lose It! 500",
    "Calorie budget comparison", "Warnings (", "quantity 0, logged as 1",
  ]) assert.ok(dry.includes(want), `missing "${want}" in:\n${dry}`);

  const real = formatReport(go(w.db, w.ann, files, { conflict: "merge" }), "Ann (ann)");
  assert.match(real, /DONE\./);
  assert.doesNotMatch(real, /DRY RUN/);
  assert.match(real, /3 created/);
});

test("formatInventory lists headers, the setting names from profile.csv, and with samples the first row", () => {
  const files = new Map([
    ["food-logs.csv", foodCsv([{ date: "1/5/2026", name: "Oatmeal" }])],
    ["custom-foods.csv", csv("Foo,Bar", [["a", "b"]])],
    ["profile.csv", csv("Name,Value", [["Weight Units", "Pounds"]])],
  ]);
  const plain = formatInventory(inventoryOf(files));
  assert.match(plain, /custom-foods\.csv +\(1 data rows\) +NOT understood: missing column/);
  assert.match(plain, /headers: Foo \| Bar/);
  assert.match(plain, /settings: Weight Units/);
  assert.doesNotMatch(plain, /first row/);
  assert.match(formatInventory(inventoryOf(files, { samples: true }), { samples: true }), /first row: Foo="a" \| Bar="b"/);
  assert.equal(formatInventory([]), "No CSV files found.");
});
