// Migration 10: the per-login "who can see my food data" level, a column on nutrition_user_settings. It only ADDS a
// column, so the check is that a database as migration 9 left it, with a real snack allowance in it, comes through whole,
// that every login starts at "nothing", and that the column accepts only the three levels.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import "./helpers/testdb.ts";
import { NUTRITION_MIGRATIONS, nutritionSchemaVersion, runNutritionMigrations } from "../nutrition/data/schema.ts";
import { get, run } from "../nutrition/data/sql.ts";

test("migration 10 adds visibility with a default of nothing, keeps existing rows, and accepts only the three levels", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE users (id TEXT PRIMARY KEY, role TEXT NOT NULL)");
  run(db, "INSERT INTO users (id, role) VALUES ('u1', 'admin'), ('u2', 'parent'), ('k', 'kiosk')");
  runNutritionMigrations(db, NUTRITION_MIGRATIONS.filter((m) => m.id <= 9));
  assert.equal(nutritionSchemaVersion(db), 9);
  run(db, "INSERT INTO nutrition_user_settings (user_id, snack_allowance_pct, updated_at) VALUES ('u1', 25, 'x')");

  assert.deepEqual(runNutritionMigrations(db, NUTRITION_MIGRATIONS.filter((m) => m.id <= 10)), [10]);
  assert.deepEqual(runNutritionMigrations(db, NUTRITION_MIGRATIONS.filter((m) => m.id <= 10)), [], "and it doesn't run twice");
  const row = get<any>(db, "SELECT * FROM nutrition_user_settings WHERE user_id = 'u1'")!;
  assert.deepEqual([row.snack_allowance_pct, row.visibility], [25, "nothing"], "the existing row keeps its allowance and shares nothing");

  run(db, "INSERT INTO nutrition_user_settings (user_id, updated_at) VALUES ('u2', 'x')");
  assert.equal(get<any>(db, "SELECT visibility FROM nutrition_user_settings WHERE user_id = 'u2'")!.visibility, "nothing");
  for (const ok of ["totals", "everything", "nothing"]) run(db, "UPDATE nutrition_user_settings SET visibility = ? WHERE user_id = 'u2'", ok);
  for (const bad of ["all", "TOTALS", "", "daily totals"]) {
    assert.throws(() => run(db, "UPDATE nutrition_user_settings SET visibility = ? WHERE user_id = 'u2'", bad), /CHECK/, bad);
  }
  assert.throws(() => run(db, "UPDATE nutrition_user_settings SET visibility = NULL WHERE user_id = 'u2'"), /NOT NULL/);
  assert.throws(() => run(db, "INSERT INTO nutrition_user_settings (user_id, visibility, updated_at) VALUES ('k', 'totals', 'x')"), /only admin and parent/);
});
