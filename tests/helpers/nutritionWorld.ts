// A fresh household for one nutrition test: an in-memory database with the real `users` table
// and the real nutrition migrations, plus the three logins the rules are about.
//
//   ann    admin, America/New_York, female
//   ben    parent, Pacific/Auckland (a day ahead of ann on the shared clock), male
//   kiosk  the shared-device login, which must never keep a diary
//
// Why a private :memory: database per test instead of the shared throwaway file testdb.ts
// makes: the data layer takes its handle as an argument, so each test can start from nothing
// (search results, miss lists and counts would otherwise leak between tests in a file). The
// `users` DDL is copied out of the real db.ts schema rather than retyped here, so this can't
// drift from production. testdb.ts's rule still holds: db.ts is only reached through loadDb(),
// which forces DB_PATH to the throwaway file, so nothing here can touch household.db.

import "./testdb.ts";

import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import { loadDb } from "./testdb.ts";
import type { Tracker } from "../../nutrition/data/access.ts";
import { runNutritionMigrations } from "../../nutrition/data/schema.ts";
import { all, get, run, type Db } from "../../nutrition/data/sql.ts";
import { getTracker, saveProfile } from "../../nutrition/data/tracker.ts";

export const NOW = new Date("2026-03-10T15:00:00Z"); // 11:00 in New York, so ann's today = 2026-03-10
export const TODAY = "2026-03-10";
export const YESTERDAY = "2026-03-09";
export const LONG_AGO = "2026-03-05";

let usersDdl: string | undefined;
const scopedDdl = new Map<string, string>();

async function usersTableDdl(): Promise<string> {
  if (usersDdl) return usersDdl;
  const { db } = await loadDb();
  usersDdl = get<{ sql: string }>(db, "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'")!.sql;
  return usersDdl;
}

/**
 * A household-app JSON-document table (recipes, meal_plans, household_members, pantry_items), copied from db.ts the
 * same way. The nutrition data layer reads and writes these with plain SQL, so the test world needs them.
 */
async function scopedTableDdl(name: string): Promise<string> {
  const known = scopedDdl.get(name);
  if (known) return known;
  const { db } = await loadDb();
  const ddl = get<{ sql: string }>(db, "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", name)!.sql;
  scopedDdl.set(name, ddl);
  return ddl;
}

export interface World {
  db: Db;
  ids: { ann: string; ben: string; kiosk: string };
  /** Re-reads a login as a Tracker (so a profile saved after the first call shows up). */
  tracker(userId: string): Tracker;
  readonly ann: Tracker;
  readonly ben: Tracker;
}

let nextUser = 0;
function addUser(db: Db, username: string, role: string): string {
  const id = `user-${username}-${++nextUser}`;
  run(db, "INSERT INTO users (id, username, password_hash, display_name, created_at, role) VALUES (?, ?, 'not-a-real-hash', ?, ?, ?)",
    id, username, username[0].toUpperCase() + username.slice(1), new Date().toISOString(), role);
  return id;
}

/** `profiles: false` leaves the logins without a nutrition profile (no calorie budget possible). */
export async function newWorld(t: TestContext, opts: { profiles?: boolean } = {}): Promise<World> {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(await usersTableDdl());
  for (const table of ["recipes", "meal_plans", "household_members", "pantry_items"]) db.exec(await scopedTableDdl(table));
  runNutritionMigrations(db);

  const ids = { ann: addUser(db, "ann", "admin"), ben: addUser(db, "ben", "parent"), kiosk: addUser(db, "kiosk", "kiosk") };
  const tracker = (userId: string) => getTracker(db, userId);
  if (opts.profiles !== false) {
    saveProfile(db, tracker(ids.ann), { sex: "female", birthDate: "1990-06-15", heightCm: 170, timezone: "America/New_York" });
    saveProfile(db, tracker(ids.ben), { sex: "male", birthDate: "1988-01-01", heightCm: 180, timezone: "Pacific/Auckland" });
  }
  // ann/ben are getters, not values: reading a tracker gives that login its default meals, and a
  // test about first visits needs a world where nobody has been seen yet. A getter also means a
  // profile saved mid-test shows up the next time it is read.
  return { db, ids, tracker, get ann() { return tracker(ids.ann); }, get ben() { return tracker(ids.ben); } };
}

/** A generic USDA row, inserted the way the (later) importer will: owner-less, per 100 g, with a 100 g serving. */
export function addGeneric(db: Db, name: string, kcal: number): string {
  const id = crypto.randomUUID();
  run(db, `INSERT INTO nutrition_foods (id, name, basis, nutrients, source, source_ref, created_at)
           VALUES (?, ?, 'per100g', ?, 'usda_generic', ?, ?)`,
    id, name, JSON.stringify({ kcal, protein: 1, carbs: 20, fat: 0.3, satFat: 0, sugars: 12, fiber: 2, cholesterolMg: 0, sodiumMg: 1 }), id, new Date().toISOString());
  run(db, "INSERT INTO nutrition_food_servings (id, food_id, label, grams, is_default) VALUES (?, ?, '100 g', 100, 1)", crypto.randomUUID(), id);
  return id;
}

/** A custom per-serving food body: a 50 g bar. */
export const customFood = (name: string, kcal: number, extra: Record<string, unknown> = {}) => ({
  name, basis: "per_serving", nutrients: { kcal, protein: 10, carbs: 20, fat: 5 }, servings: [{ label: "1 bar", grams: 50 }], ...extra,
});

export const rowCount = (db: Db, table: string): number => get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM ${table}`)!.n;

export const tableNames = (db: Db): string[] =>
  all<{ name: string }>(db, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((r) => r.name);
