// nutrition/data/schema.ts -- the migration runner, and what it does to the real household
// database when db.ts boots.
//
// Both halves matter for the same reason: this runs on the LIVE database file on every start.
// A runner that isn't idempotent, or a migration that half-applies, damages the only copy of
// the household's data; and a journal mode that quietly flipped to WAL would make every daily
// backup (a plain file copy) silently incomplete.

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { loadDb, cleanupDb } from "./helpers/testdb.ts";
import { newWorld, tableNames } from "./helpers/nutritionWorld.ts";
import { NUTRITION_MIGRATIONS, nutritionSchemaVersion, runNutritionMigrations } from "../nutrition/data/schema.ts";
import { all, get } from "../nutrition/data/sql.ts";

const { db: realDb, createUser } = await loadDb();

after(cleanupDb);

const IDS = NUTRITION_MIGRATIONS.map((m) => m.id);

/** A bare database that has only the table the nutrition tables point at. */
function bareDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE users (id TEXT PRIMARY KEY, role TEXT NOT NULL)");
  return db;
}

describe("the migration list", () => {
  test("ids are 1..N with no gaps or repeats, each named", () => {
    assert.deepEqual(IDS, IDS.map((_, i) => i + 1));
    assert.ok(NUTRITION_MIGRATIONS.every((m) => m.name.length > 0 && m.sql.trim().length > 0));
  });
});

describe("runNutritionMigrations", () => {
  test("a fresh database gets every migration, in order, recorded in nutrition_schema_migrations", () => {
    const db = bareDb();
    assert.deepEqual(runNutritionMigrations(db), IDS);
    const rows = all<{ id: number; name: string; applied_at: string }>(db, "SELECT * FROM nutrition_schema_migrations ORDER BY id");
    assert.deepEqual(rows.map((r) => r.id), IDS);
    assert.deepEqual(rows.map((r) => r.name), NUTRITION_MIGRATIONS.map((m) => m.name));
    assert.ok(rows.every((r) => !Number.isNaN(Date.parse(r.applied_at))));
    assert.equal(nutritionSchemaVersion(db), IDS[IDS.length - 1]);
  });

  test("running it again does nothing: no migration re-applied, no row rewritten", () => {
    const db = bareDb();
    runNutritionMigrations(db);
    const before = all(db, "SELECT * FROM nutrition_schema_migrations ORDER BY id");
    const tablesBefore = tableNames(db);
    assert.deepEqual(runNutritionMigrations(db), []);
    assert.deepEqual(runNutritionMigrations(db), []);
    assert.deepEqual(all(db, "SELECT * FROM nutrition_schema_migrations ORDER BY id"), before, "applied_at is untouched");
    assert.deepEqual(tableNames(db), tablesBefore);
  });

  test("a database that stopped part-way picks up exactly the rest", () => {
    const db = bareDb();
    assert.deepEqual(runNutritionMigrations(db, NUTRITION_MIGRATIONS.slice(0, 2)), [1, 2]);
    assert.equal(nutritionSchemaVersion(db), 2);
    assert.deepEqual(runNutritionMigrations(db), IDS.slice(2));
    assert.equal(nutritionSchemaVersion(db), IDS[IDS.length - 1]);
  });

  test("a migration that fails leaves nothing behind and is not recorded, so the next boot retries it", () => {
    const db = bareDb();
    const broken = [
      NUTRITION_MIGRATIONS[0],
      // The first statement is valid and creates a table; the second is not. SQLite DDL is
      // transactional, so the table must disappear with the failure.
      { id: 2, name: "broken", sql: "CREATE TABLE nutrition_half_made (x INTEGER); CREATE TABLE nutrition_oops (" },
    ];
    assert.throws(() => runNutritionMigrations(db, broken));
    assert.equal(nutritionSchemaVersion(db), 1, "migration 1 stayed applied");
    assert.ok(!tableNames(db).includes("nutrition_half_made"), "the failed migration rolled back whole");
    assert.equal(db.isTransaction, false, "no transaction left open");
    // A fixed list then applies it.
    assert.deepEqual(runNutritionMigrations(db), IDS.slice(1));
  });

  test("a version this build doesn't know (a database from a newer checkout) is left alone, not refused", () => {
    const db = bareDb();
    runNutritionMigrations(db);
    db.prepare("INSERT INTO nutrition_schema_migrations (id, name, applied_at) VALUES (999, 'from the future', 'x')").run();
    assert.deepEqual(runNutritionMigrations(db), []);
    assert.equal(nutritionSchemaVersion(db), 999);
  });

  test("it works when the caller is already inside a transaction (the migration becomes a savepoint)", () => {
    const db = bareDb();
    db.exec("BEGIN");
    assert.deepEqual(runNutritionMigrations(db), IDS);
    assert.equal(db.isTransaction, true, "the caller's transaction is still the caller's");
    db.exec("ROLLBACK");
    assert.ok(!tableNames(db).includes("nutrition_foods"), "rolling the caller back undoes it");
  });

  test("every table it makes is prefixed nutrition_ (so it can never collide with db.ts's own tables), and it touches no others", async (t) => {
    const w = await newWorld(t);
    // (users, recipes, the meal plan, the roster and the pantry are household-app's own tables, copied from db.ts into
    // the test world: the data layer reads them with plain SQL.)
    const mine = tableNames(w.db).filter((n) => !["users", "recipes", "meal_plans", "household_members", "pantry_items", "sqlite_sequence"].includes(n));
    assert.ok(mine.length >= 10, `expected the nutrition tables, got ${mine.join(", ")}`);
    assert.deepEqual(mine.filter((n) => !n.startsWith("nutrition_")), []);
    // The users table is exactly what db.ts made.
    assert.deepEqual(
      all<{ name: string }>(w.db, "PRAGMA table_info(users)").map((c) => c.name).sort(),
      all<{ name: string }>(realDb, "PRAGMA table_info(users)").map((c) => c.name).sort(),
    );
  });

  test("migration 6 swaps the household-wide barcode index for two per-scope ones, keeping existing foods", () => {
    const db = bareDb();
    runNutritionMigrations(db, NUTRITION_MIGRATIONS.slice(0, 5)); // a database as phase 1 left it
    db.exec("INSERT INTO users VALUES ('u1', 'admin'), ('u2', 'parent')");
    const ins = (id: string, owner: string | null, gtin: string | null, deleted: string | null = null) =>
      db.prepare("INSERT INTO nutrition_foods (id, owner_user_id, name, basis, nutrients, source, gtin14, created_at, deleted_at) VALUES (?, ?, ?, 'per100g', '{}', 'custom', ?, 'x', ?)")
        .run(id, owner, id, gtin, deleted);
    ins("old-joint", null, "00000000000017");
    assert.throws(() => ins("clash", "u2", "00000000000017"), /UNIQUE/, "the old index was household-wide");

    assert.deepEqual(runNutritionMigrations(db), IDS.slice(5)); // 6, and anything appended since (7 rebuilds this very table)
    const indexes = all<{ name: string }>(db, "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'nutrition_foods'").map((r) => r.name);
    assert.ok(!indexes.includes("nutrition_foods_gtin"));
    assert.ok(indexes.includes("nutrition_foods_gtin_joint") && indexes.includes("nutrition_foods_gtin_personal"));
    assert.equal(get<{ n: number }>(db, "SELECT COUNT(*) AS n FROM nutrition_foods")!.n, 1, "existing data kept");

    ins("u2-personal", "u2", "00000000000017"); // a personal food may share the joint food's code
    ins("u1-personal", "u1", "00000000000017"); // and so may another person's
    assert.throws(() => ins("joint-2", null, "00000000000017"), /UNIQUE/, "still one joint food per code");
    assert.throws(() => ins("u2-again", "u2", "00000000000017"), /UNIQUE/, "still one personal food per person per code");
    ins("gone", null, "00000000000017", "2026-01-01"); // a deleted food holds nothing
    ins("no-code", null, null);
    ins("no-code-2", null, null);
  });

  test("food search is backed by an FTS5 table kept in step by triggers", async (t) => {
    const w = await newWorld(t);
    assert.ok(tableNames(w.db).includes("nutrition_foods_fts"));
    w.db.prepare("INSERT INTO nutrition_foods (id, name, basis, nutrients, source, created_at) VALUES ('f1', 'Rolled oats', 'per100g', '{}', 'custom', 'x')").run();
    const hit = (q: string) => all(w.db, "SELECT food_id FROM nutrition_foods_fts WHERE nutrition_foods_fts MATCH ?", q).length;
    assert.equal(hit("oats"), 1);
    w.db.prepare("UPDATE nutrition_foods SET name = 'Steel cut groats' WHERE id = 'f1'").run();
    assert.equal(hit("oats"), 0);
    assert.equal(hit("groats"), 1);
    w.db.prepare("DELETE FROM nutrition_foods WHERE id = 'f1'").run();
    assert.equal(hit("groats"), 0);
  });
});

describe("db.ts at boot (the real household handle)", () => {
  test("the nutrition migrations ran, and the version table is complete", () => {
    assert.equal(nutritionSchemaVersion(realDb), IDS[IDS.length - 1]);
    assert.deepEqual(
      all<{ id: number }>(realDb, "SELECT id FROM nutrition_schema_migrations ORDER BY id").map((r) => r.id),
      IDS,
    );
    for (const table of ["nutrition_foods", "nutrition_diary_entries", "nutrition_profiles", "nutrition_barcode_misses"]) {
      assert.ok(tableNames(realDb).includes(table), table);
    }
  });

  test("household-app's own tables are still there, and untouched by the nutrition ones", () => {
    for (const table of ["users", "app_config", "device_tokens", "sessions", "pantry_items", "meal_plans", "transactions", "conversations"]) {
      assert.ok(tableNames(realDb).includes(table), table);
    }
  });

  test("the journal mode is still DELETE after the nutrition migrations -- never WAL", () => {
    // WAL would leave committed data in a -wal sidecar that backupIfNeeded()'s plain
    // fs.copyFileSync never copies: every daily snapshot would silently miss recent writes.
    assert.equal(get<{ journal_mode: string }>(realDb, "PRAGMA journal_mode")!.journal_mode, "delete");
    runNutritionMigrations(realDb); // a re-run (db.ts runs it every boot) must not change that either
    assert.equal(get<{ journal_mode: string }>(realDb, "PRAGMA journal_mode")!.journal_mode, "delete");
  });

  test("nutrition rows are in the one database file, written through the one handle", () => {
    const id = createUser("schema-test", "not-a-real-hash", "Schema Test", "parent");
    realDb.prepare("INSERT INTO nutrition_weights (id, user_id, measured_on, weight_kg) VALUES ('w-schema-1', ?, '2026-03-01', 80)").run(id);
    assert.equal(get<{ n: number }>(realDb, "SELECT COUNT(*) AS n FROM nutrition_weights WHERE user_id = ?", id)!.n, 1);
  });
});
