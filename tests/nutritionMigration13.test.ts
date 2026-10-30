// Migration 13: the per-login "I started my weight loss on" day, a nullable column on nutrition_user_settings. It only ADDS a
// column, so the checks are that a database as migration 12 left it comes through whole (snack allowance and visibility
// untouched, start day empty), that the column takes a date or NULL and nothing else, and that it does not run twice.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import "./helpers/testdb.ts";
import { NUTRITION_MIGRATIONS, nutritionSchemaVersion, runNutritionMigrations } from "../nutrition/data/schema.ts";
import { all, get, run } from "../nutrition/data/sql.ts";

test("migration 13 adds weight_start_date (NULL by default), keeps existing rows, and takes only a date or NULL", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE users (id TEXT PRIMARY KEY, role TEXT NOT NULL)");
  run(db, "INSERT INTO users (id, role) VALUES ('u1', 'admin'), ('u2', 'parent'), ('k', 'kiosk')");
  runNutritionMigrations(db, NUTRITION_MIGRATIONS.filter((m) => m.id <= 12));
  assert.equal(nutritionSchemaVersion(db), 12);
  run(db, "INSERT INTO nutrition_user_settings (user_id, snack_allowance_pct, visibility, updated_at) VALUES ('u1', 25, 'everything', 'x')");

  // Up to 13 only: this test is about migration 13, so a later migration must not change what it expects.
  const upTo13 = NUTRITION_MIGRATIONS.filter((m) => m.id <= 13);
  assert.deepEqual(runNutritionMigrations(db, upTo13), [13]);
  assert.deepEqual(runNutritionMigrations(db, upTo13), [], "and it doesn't run twice");
  assert.equal(nutritionSchemaVersion(db), 13);
  const cols = all<{ name: string; notnull: number }>(db, "SELECT name, \"notnull\" FROM pragma_table_info('nutrition_user_settings')");
  assert.deepEqual(cols.map((c) => c.name), ["user_id", "snack_allowance_pct", "updated_at", "visibility", "weight_start_date"]);
  assert.equal(cols.find((c) => c.name === "weight_start_date")!.notnull, 0, "it can be empty");

  const row = get<any>(db, "SELECT * FROM nutrition_user_settings WHERE user_id = 'u1'")!;
  assert.deepEqual([row.snack_allowance_pct, row.visibility, row.weight_start_date], [25, "everything", null], "the existing row is untouched and has no start day");

  run(db, "INSERT INTO nutrition_user_settings (user_id, updated_at) VALUES ('u2', 'x')");
  assert.equal(get<any>(db, "SELECT weight_start_date FROM nutrition_user_settings WHERE user_id = 'u2'")!.weight_start_date, null);
  run(db, "UPDATE nutrition_user_settings SET weight_start_date = '2026-01-03' WHERE user_id = 'u2'");
  assert.equal(get<any>(db, "SELECT weight_start_date FROM nutrition_user_settings WHERE user_id = 'u2'")!.weight_start_date, "2026-01-03");
  run(db, "UPDATE nutrition_user_settings SET weight_start_date = NULL WHERE user_id = 'u2'");
  for (const bad of ["Jan 3", "2026-1-3", "", "yesterday", "20260103"]) {
    assert.throws(() => run(db, "UPDATE nutrition_user_settings SET weight_start_date = ? WHERE user_id = 'u2'", bad), /CHECK/, bad);
  }
  assert.throws(() => run(db, "INSERT INTO nutrition_user_settings (user_id, weight_start_date, updated_at) VALUES ('k', '2026-01-03', 'x')"), /only admin and parent/);
});
