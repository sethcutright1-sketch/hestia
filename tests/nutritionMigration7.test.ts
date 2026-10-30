// Migration 7 rebuilds nutrition_foods so its source CHECK allows 'recipe' and it gains recipe_id.
// A table rebuild is the one kind of migration that can lose data (drop the old table before
// the new one is right) or lose side tables (indexes, triggers, the FTS index), so this builds a
// database exactly as migration 6 left it, fills it, and checks nothing went missing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import "./helpers/testdb.ts";
import { NUTRITION_MIGRATIONS, nutritionSchemaVersion, runNutritionMigrations } from "../nutrition/data/schema.ts";
import { all, get, run } from "../nutrition/data/sql.ts";
import { searchFoods } from "../nutrition/data/foods.ts";

function dbAtMigration6(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE users (id TEXT PRIMARY KEY, role TEXT NOT NULL)");
  runNutritionMigrations(db, NUTRITION_MIGRATIONS.filter((m) => m.id <= 6));
  assert.equal(nutritionSchemaVersion(db), 6);
  return db;
}

const schemaObjects = (db: DatabaseSync, type: string) =>
  all<{ name: string; sql: string }>(db, "SELECT name, sql FROM sqlite_master WHERE type = ? AND tbl_name = 'nutrition_foods' AND sql IS NOT NULL ORDER BY name", type);

const norm = (sql: string) => sql.replace(/\s+/g, " ").trim();

function fill(db: DatabaseSync) {
  run(db, "INSERT INTO users (id, role) VALUES ('u1', 'admin'), ('u2', 'parent')");
  const food = (id: string, name: string, extra: { owner?: string | null; gtin?: string | null; source?: string; ref?: string | null; deleted?: string | null } = {}) =>
    run(db,
      `INSERT INTO nutrition_foods (id, owner_user_id, created_by_user_id, name, brand, gtin14, basis, nutrients, source, source_ref, usage_count, last_used_at, created_at, deleted_at)
       VALUES (?, ?, 'u1', ?, 'Brand', ?, 'per_serving', '{"kcal":100}', ?, ?, 3, '2026-03-01T00:00:00Z', '2026-01-01T00:00:00Z', ?)`,
      id, extra.owner ?? null, name, extra.gtin ?? null, extra.source ?? "custom", extra.ref ?? null, extra.deleted ?? null);
  food("f1", "Rolled oats", { gtin: "00012345678905" });
  food("f2", "Greek yogurt", { owner: "u2" });
  food("f3", "Old soup", { deleted: "2026-02-01T00:00:00Z" });
  food("f4", "Chicken breast", { source: "usda_generic", ref: "171077" });
  run(db, "INSERT INTO nutrition_food_servings (id, food_id, label, grams, is_default) VALUES ('s1', 'f1', '1 cup', 80, 1)");
  run(db, "INSERT INTO nutrition_diary_entries (id, user_id, local_date, slot_key, food_id, name_snapshot, quantity, unit_snapshot, nutrients_total, logged_at, updated_at) VALUES ('e1', 'u1', '2026-03-01', 'lunch', 'f1', 'Rolled oats', 1, '1 cup', '{\"kcal\":100}', 'x', 'x')");
  run(db, "INSERT INTO nutrition_saved_meals (id, created_by_user_id, name, created_at, updated_at) VALUES ('m1', 'u1', 'Breakfast', 'x', 'x')");
  run(db, "INSERT INTO nutrition_saved_meal_items (id, saved_meal_id, position, food_id, quantity, serving_id) VALUES ('i1', 'm1', 0, 'f1', 1, 's1')");
}

test("migration 7 is the next entry in the append-only list", () => {
  const m = NUTRITION_MIGRATIONS.find((x) => x.id === 7)!;
  assert.ok(m);
  assert.match(m.name, /recipe/);
});

test("rebuilding nutrition_foods keeps every row, serving, diary entry and saved meal item", () => {
  const db = dbAtMigration6();
  fill(db);
  const before = all<Record<string, unknown>>(db, "SELECT * FROM nutrition_foods ORDER BY id").map((r) => ({ ...r }));
  // Only up to 7: this file is about the rebuild (migration 8, the meal plan link, has its own test).
  assert.deepEqual(runNutritionMigrations(db, NUTRITION_MIGRATIONS.filter((m) => m.id <= 7)), [7]);

  const after = all<Record<string, unknown>>(db, "SELECT * FROM nutrition_foods ORDER BY id");
  assert.equal(after.length, 4);
  for (let i = 0; i < before.length; i++) {
    const { recipe_id, ...rest } = { ...after[i] };
    assert.deepEqual(rest, before[i], `row ${i} unchanged`);
    assert.equal(recipe_id, null);
  }
  assert.equal(get<{ n: number }>(db, "SELECT COUNT(*) AS n FROM nutrition_food_servings")!.n, 1);
  assert.equal(get<{ n: number }>(db, "SELECT COUNT(*) AS n FROM nutrition_diary_entries WHERE food_id = 'f1'")!.n, 1);
  assert.equal(get<{ n: number }>(db, "SELECT COUNT(*) AS n FROM nutrition_saved_meal_items WHERE food_id = 'f1'")!.n, 1);
  assert.equal(get<{ integrity_check: string }>(db, "PRAGMA integrity_check")!.integrity_check, "ok");
  assert.equal(all(db, "PRAGMA foreign_key_check").length, 0);
});

test("every index and the three FTS triggers come back exactly as they were, plus the new recipe index", () => {
  const db = dbAtMigration6();
  const indexesBefore = schemaObjects(db, "index").map((i) => [i.name, norm(i.sql)]);
  const triggersBefore = schemaObjects(db, "trigger").map((i) => [i.name, norm(i.sql)]);
  assert.deepEqual(triggersBefore.map((t) => t[0]), ["nutrition_foods_fts_ad", "nutrition_foods_fts_ai", "nutrition_foods_fts_au"]);

  runNutritionMigrations(db);
  const indexesAfter = schemaObjects(db, "index").map((i) => [i.name, norm(i.sql)]);
  const triggersAfter = schemaObjects(db, "trigger").map((i) => [i.name, norm(i.sql)]);

  assert.deepEqual(triggersAfter, triggersBefore, "FTS triggers identical");
  assert.deepEqual(indexesAfter.filter(([n]) => n !== "nutrition_foods_recipe"), indexesBefore, "old indexes identical");
  assert.ok(indexesAfter.some(([n, s]) => n === "nutrition_foods_recipe" && /UNIQUE/.test(s as string) && /recipe_id IS NOT NULL AND deleted_at IS NULL/.test(s as string)));
  for (const n of ["nutrition_foods_gtin_joint", "nutrition_foods_gtin_personal", "nutrition_foods_gtin_any", "nutrition_foods_owner", "nutrition_foods_source_ref"]) {
    assert.ok(indexesAfter.some(([name]) => name === n), n);
  }
});

test("the search index survives the rebuild: old foods are still found, and new ones, renames and deletes still sync", () => {
  const db = dbAtMigration6();
  fill(db);
  const ftsBefore = all(db, "SELECT name, brand, food_id FROM nutrition_foods_fts ORDER BY food_id");
  runNutritionMigrations(db);
  assert.deepEqual(all(db, "SELECT name, brand, food_id FROM nutrition_foods_fts ORDER BY food_id"), ftsBefore, "FTS rows untouched");

  assert.deepEqual(searchFoods(db, "u1", "oats", 10).map((f) => f.id), ["f1"]);
  assert.deepEqual(searchFoods(db, "u1", "chicken", 10).map((f) => f.id), ["f4"], "the catalogue row is found too");
  assert.deepEqual(searchFoods(db, "u1", "yogurt", 10), [], "someone else's personal food stays invisible");
  assert.deepEqual(searchFoods(db, "u2", "yogurt", 10).map((f) => f.id), ["f2"]);

  // The recreated triggers work: insert, rename, delete.
  run(db, "INSERT INTO nutrition_foods (id, name, basis, nutrients, source, created_at, recipe_id) VALUES ('r1', 'Lasagna bake', 'per_serving', '{\"kcal\":400}', 'recipe', 'x', 'recipe-1')");
  assert.deepEqual(searchFoods(db, "u1", "lasagna", 10).map((f) => f.id), ["r1"]);
  run(db, "UPDATE nutrition_foods SET name = 'Pasta bake' WHERE id = 'r1'");
  assert.deepEqual(searchFoods(db, "u1", "lasagna", 10), []);
  assert.deepEqual(searchFoods(db, "u1", "pasta", 10).map((f) => f.id), ["r1"]);
  run(db, "DELETE FROM nutrition_foods WHERE id = 'r1'");
  assert.deepEqual(searchFoods(db, "u1", "pasta", 10), []);
});

test("the new table accepts source 'recipe' with a recipe_id, refuses a recipe_id on any other source, and keeps the old CHECKs", () => {
  const db = dbAtMigration6();
  runNutritionMigrations(db);
  const insert = (id: string, source: string, recipeId: string | null, owner: string | null = null, deleted: string | null = null) =>
    run(db, "INSERT INTO nutrition_foods (id, owner_user_id, name, basis, nutrients, source, created_at, recipe_id, deleted_at) VALUES (?, ?, 'x', 'per_serving', '{}', ?, 'x', ?, ?)",
      id, owner, source, recipeId, deleted);

  insert("a", "recipe", "rec-1");
  assert.throws(() => insert("b", "recipe", "rec-1"), /UNIQUE/, "one live food per recipe");
  insert("c", "recipe", "rec-1", null, "2026-01-01T00:00:00Z"); // a soft-deleted one does not block
  assert.throws(() => insert("d", "custom", "rec-2"), /CHECK/, "recipe_id only on recipe foods");
  assert.throws(() => insert("e", "mystery", null), /CHECK/, "unknown sources still refused");
  assert.throws(() => insert("f", "usda_generic", null, "u1"), /CHECK/, "the catalogue stays owner-less");
  insert("g", "recipe", null); // allowed: a food row that is not yet linked
});

test("barcodes stay unique per scope after the rebuild (migration 6's rule survives)", () => {
  const db = dbAtMigration6();
  fill(db);
  runNutritionMigrations(db);
  const add = (id: string, owner: string | null, gtin: string) =>
    run(db, "INSERT INTO nutrition_foods (id, owner_user_id, name, basis, nutrients, source, gtin14, created_at) VALUES (?, ?, 'x', 'per_serving', '{}', 'custom', ?, 'x')", id, owner, gtin);
  assert.throws(() => add("dup-joint", null, "00012345678905"), /UNIQUE/);
  add("mine", "u1", "00012345678905"); // a personal food may share a joint food's code
  assert.throws(() => add("mine2", "u1", "00012345678905"), /UNIQUE/);
  add("theirs", "u2", "00012345678905");
});

test("running the migrations again after 7 does nothing", () => {
  const db = dbAtMigration6();
  runNutritionMigrations(db);
  assert.deepEqual(runNutritionMigrations(db), []);
  assert.equal(nutritionSchemaVersion(db), NUTRITION_MIGRATIONS[NUTRITION_MIGRATIONS.length - 1].id);
});

test("foreign keys are enforced here (node:sqlite turns them on), so the rebuild switches them off and puts them back", () => {
  const db = dbAtMigration6();
  fill(db);
  assert.equal(get<{ foreign_keys: number }>(db, "PRAGMA foreign_keys")!.foreign_keys, 1, "the premise: on by default");
  assert.throws(() => run(db, "DELETE FROM nutrition_foods WHERE id = 'f1'"), /FOREIGN KEY/, "a food in use can't be deleted");
  runNutritionMigrations(db);
  assert.equal(get<{ foreign_keys: number }>(db, "PRAGMA foreign_keys")!.foreign_keys, 1, "enforcement is back on afterwards");
  assert.throws(() => run(db, "DELETE FROM nutrition_foods WHERE id = 'f1'"), /FOREIGN KEY/, "and still protects the rebuilt table");
  assert.throws(() => run(db, "INSERT INTO nutrition_food_servings (id, food_id, label, is_default) VALUES ('x', 'no-such-food', 'y', 0)"), /FOREIGN KEY/);
});

test("a rebuild that would leave a dangling reference is refused whole, and enforcement still comes back", () => {
  const db = dbAtMigration6();
  fill(db);
  const evil = { id: 7, name: "evil", rebuildsTable: true, sql: "DELETE FROM nutrition_foods WHERE id = 'f1';" };
  assert.throws(() => runNutritionMigrations(db, [...NUTRITION_MIGRATIONS.filter((m) => m.id <= 6), evil]), /foreign key violations/);
  assert.equal(nutritionSchemaVersion(db), 6, "nothing recorded");
  assert.equal(get<{ n: number }>(db, "SELECT COUNT(*) AS n FROM nutrition_foods WHERE id = 'f1'")!.n, 1, "rolled back");
  assert.equal(get<{ foreign_keys: number }>(db, "PRAGMA foreign_keys")!.foreign_keys, 1);
  assert.equal(db.isTransaction, false);
});
