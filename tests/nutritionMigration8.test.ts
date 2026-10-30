// Migration 8: the meal plan's link on diary entries (meal_plan_id, plan_slot_key, pantry_used_at) and the
// per-login snack allowance table. It only ADDS columns and a table, so the check is that a database as migration 7
// left it, with real data in it, comes through whole, and that the new pieces behave.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import "./helpers/testdb.ts";
import { NUTRITION_MIGRATIONS, nutritionSchemaVersion, runNutritionMigrations } from "../nutrition/data/schema.ts";
import { all, get, run } from "../nutrition/data/sql.ts";

function dbAtMigration7(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE users (id TEXT PRIMARY KEY, role TEXT NOT NULL)");
  runNutritionMigrations(db, NUTRITION_MIGRATIONS.filter((m) => m.id <= 7));
  assert.equal(nutritionSchemaVersion(db), 7);
  run(db, "INSERT INTO users (id, role) VALUES ('u1', 'admin'), ('k', 'kiosk')");
  run(db, "INSERT INTO nutrition_diary_entries (id, user_id, local_date, slot_key, name_snapshot, quantity, unit_snapshot, nutrients_total, logged_at, updated_at) VALUES ('e1', 'u1', '2026-03-01', 'lunch', 'Soup', 1, 'serving', '{\"kcal\":100}', 'x', 'x')");
  return db;
}

test("migration 8 is next in the append-only list, and runs on top of a populated migration-7 database", () => {
  const m = NUTRITION_MIGRATIONS.find((x) => x.id === 8)!;
  assert.ok(m);
  assert.match(m.name, /meal plan/);
  assert.equal(NUTRITION_MIGRATIONS.slice(0, 8).map((x) => x.id).join(), "1,2,3,4,5,6,7,8");

  const db = dbAtMigration7();
  const upTo8 = NUTRITION_MIGRATIONS.filter((x) => x.id <= 8); // later migrations have their own tests
  assert.deepEqual(runNutritionMigrations(db, upTo8), [8]);
  const cols = all<{ name: string }>(db, "SELECT name FROM pragma_table_info('nutrition_diary_entries')").map((c) => c.name);
  for (const c of ["meal_plan_id", "plan_slot_key", "pantry_used_at"]) assert.ok(cols.includes(c), c);
  const e = get<any>(db, "SELECT * FROM nutrition_diary_entries WHERE id = 'e1'")!;
  assert.deepEqual([e.name_snapshot, e.meal_plan_id, e.plan_slot_key, e.pantry_used_at], ["Soup", null, null, null], "the existing entry is untouched, with nothing linked");
  assert.deepEqual(runNutritionMigrations(db, upTo8), [], "and it doesn't run twice");
});

test("the meal plan index covers a meal's entries, and the new entry columns accept plan entries", () => {
  const db = dbAtMigration7();
  runNutritionMigrations(db);
  assert.ok(get(db, "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'nutrition_diary_meal_plan'"));
  run(db, "INSERT INTO nutrition_diary_entries (id, user_id, local_date, slot_key, status, name_snapshot, quantity, unit_snapshot, nutrients_total, source, meal_plan_id, plan_slot_key, logged_at, updated_at) VALUES ('e2', 'u1', '2026-03-02', 'dinner', 'planned', 'Chili', 1, 'serving', '{}', 'plan', 'meal-1', 'brunch', 'x', 'x')");
  assert.equal(all(db, "SELECT id FROM nutrition_diary_entries WHERE meal_plan_id = 'meal-1' AND user_id = 'u1'").length, 1);
});

test("nutrition_user_settings: one row per login, 0 to 50 only, diary logins only", () => {
  const db = dbAtMigration7();
  runNutritionMigrations(db);
  run(db, "INSERT INTO nutrition_user_settings (user_id, snack_allowance_pct, updated_at) VALUES ('u1', 0, 'x')");
  run(db, "UPDATE nutrition_user_settings SET snack_allowance_pct = 50");
  assert.throws(() => run(db, "UPDATE nutrition_user_settings SET snack_allowance_pct = 50.5"), /CHECK/);
  assert.throws(() => run(db, "UPDATE nutrition_user_settings SET snack_allowance_pct = -0.1"), /CHECK/);
  assert.throws(() => run(db, "INSERT INTO nutrition_user_settings (user_id, snack_allowance_pct, updated_at) VALUES ('u1', 10, 'x')"), /UNIQUE|PRIMARY/);
  assert.throws(() => run(db, "INSERT INTO nutrition_user_settings (user_id, snack_allowance_pct, updated_at) VALUES ('k', 10, 'x')"), /only admin and parent/);
  assert.throws(() => run(db, "INSERT INTO nutrition_user_settings (user_id, snack_allowance_pct, updated_at) VALUES ('nobody', 10, 'x')"), /only admin and parent|FOREIGN/);
  assert.equal(get<any>(db, "SELECT column_default FROM (SELECT dflt_value AS column_default FROM pragma_table_info('nutrition_user_settings') WHERE name = 'snack_allowance_pct')")!.column_default, "10");
});
