// Who may keep a food diary: admin and parent logins, never the kiosk.
//
// The rule is enforced three ways and each is tested separately, because each catches a
// different mistake: assertCanTrack/getTracker (the front door), the write functions
// refusing a hand-built tracker (a caller that skipped the front door), and the SQL triggers
// (a path that skipped the data layer altogether).

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";

import { loadDb, cleanupDb } from "./helpers/testdb.ts";
import { TODAY, newWorld } from "./helpers/nutritionWorld.ts";
import { assertCanTrack, canTrack, type Tracker } from "../nutrition/data/access.ts";
import { addEntry } from "../nutrition/data/diary.ts";
import { addExercise } from "../nutrition/data/exercise.ts";
import { createFood } from "../nutrition/data/foods.ts";
import { addGoal } from "../nutrition/data/goals.ts";
import { markDayDone } from "../nutrition/data/days.ts";
import { householdStreaks } from "../nutrition/data/loggingStreaks.ts";
import { createSavedMeal } from "../nutrition/data/savedMeals.ts";
import { createSlot, updateSlot } from "../nutrition/data/slots.ts";
import { all, get } from "../nutrition/data/sql.ts";
import { getTracker, listTrackers, saveProfile } from "../nutrition/data/tracker.ts";
import { addWeight } from "../nutrition/data/weights.ts";

const real = await loadDb();
after(cleanupDb);

const status = (fn: () => unknown): number => {
  try {
    fn();
  } catch (err: any) {
    return err.status ?? -1;
  }
  return 0;
};

describe("assertCanTrack", () => {
  test("admin and parent can; kiosk and anything else cannot", () => {
    assert.ok(canTrack("admin") && canTrack("parent"));
    assert.ok(!canTrack("kiosk") && !canTrack("member") && !canTrack("") && !canTrack("ADMIN"));
    assert.doesNotThrow(() => assertCanTrack({ role: "admin" }));
    assert.doesNotThrow(() => assertCanTrack({ role: "parent" }));
    for (const role of ["kiosk", "kid", ""]) assert.equal(status(() => assertCanTrack({ role })), 403, role);
  });

  test("the refusal says why, in terms a kiosk's user would understand", () => {
    assert.throws(() => assertCanTrack({ role: "kiosk" }), /admin and parent logins; the kiosk login doesn't keep one/);
  });
});

describe("getTracker", () => {
  test("a tracker is an admin or parent login, carrying its display name and profile", async (t) => {
    const w = await newWorld(t);
    const ann = getTracker(w.db, w.ids.ann);
    assert.deepEqual([ann.id, ann.displayName, ann.role, ann.profile?.timezone], [w.ids.ann, "Ann", "admin", "America/New_York"]);
    assert.equal(getTracker(w.db, w.ids.ben).role, "parent");
  });

  test("the kiosk login is refused (403) and an unknown id is a 404", async (t) => {
    const w = await newWorld(t);
    assert.equal(status(() => getTracker(w.db, w.ids.kiosk)), 403);
    assert.equal(status(() => getTracker(w.db, "user-nobody")), 404);
  });

  test("a login's first visit gives it the four default meals; later visits change nothing", async (t) => {
    const w = await newWorld(t, { profiles: false });
    assert.equal(get<{ n: number }>(w.db, "SELECT COUNT(*) AS n FROM nutrition_meal_slots")!.n, 0);
    getTracker(w.db, w.ids.ann);
    getTracker(w.db, w.ids.ann);
    const slots = all<{ key: string }>(w.db, "SELECT key FROM nutrition_meal_slots WHERE user_id = ? ORDER BY sort", w.ids.ann).map((s) => s.key);
    assert.deepEqual(slots, ["breakfast", "lunch", "dinner", "snacks"]);
    assert.equal(get<{ n: number }>(w.db, "SELECT COUNT(*) AS n FROM nutrition_meal_slots WHERE user_id = ?", w.ids.ben)!.n, 0, "only the login that visited");
  });

  test("a kiosk request never creates any nutrition rows", async (t) => {
    const w = await newWorld(t, { profiles: false });
    assert.equal(status(() => getTracker(w.db, w.ids.kiosk)), 403);
    assert.equal(get<{ n: number }>(w.db, "SELECT COUNT(*) AS n FROM nutrition_meal_slots WHERE user_id = ?", w.ids.kiosk)!.n, 0);
  });

  test("listTrackers and the household streaks view leave the kiosk out", async (t) => {
    const w = await newWorld(t);
    assert.deepEqual(listTrackers(w.db).map((x) => x.displayName), ["Ann", "Ben"]);
    assert.deepEqual(householdStreaks(w.db, w.ids.ann, new Date(), { everyone: true }).map((s) => s.name), ["Ann", "Ben"]);
  });
});

describe("the write functions refuse a tracker that isn't one", () => {
  test("every per-person write rejects a kiosk-shaped tracker with a 403 and writes nothing", async (t) => {
    const w = await newWorld(t);
    const kiosk = { ...w.ann, id: w.ids.kiosk, role: "kiosk" } as unknown as Tracker;
    const attempts: Record<string, () => unknown> = {
      saveProfile: () => saveProfile(w.db, kiosk, { sex: "male", birthDate: "1990-01-01", heightCm: 180 }),
      addEntry: () => addEntry(w.db, kiosk, TODAY, TODAY, { slot: "lunch", kcal: 100 }),
      addWeight: () => addWeight(w.db, kiosk, new Date(), { weightKg: 80 }),
      addExercise: () => addExercise(w.db, kiosk, new Date(), { name: "Run", kcal: 100 }),
      addGoal: () => addGoal(w.db, kiosk, TODAY, { planLbPerWeek: 0, activityLevel: "light", macroProtein: 20, macroCarbs: 50, macroFat: 30 }),
      createSlot: () => createSlot(w.db, kiosk, { label: "Brunch" }),
      updateSlot: () => updateSlot(w.db, kiosk, "lunch", { label: "x" }),
      markDayDone: () => markDayDone(w.db, kiosk, TODAY, TODAY),
      createSavedMeal: () => createSavedMeal(w.db, kiosk, { name: "x", items: [] }),
      createFood: () => createFood(w.db, kiosk, { name: "x", basis: "per_serving", nutrients: { kcal: 1 } }),
    };
    for (const [name, attempt] of Object.entries(attempts)) assert.equal(status(attempt), 403, name);
    for (const table of ["nutrition_diary_entries", "nutrition_weights", "nutrition_exercise", "nutrition_saved_meals", "nutrition_foods"]) {
      assert.equal(get<{ n: number }>(w.db, `SELECT COUNT(*) AS n FROM ${table}`)!.n, 0, table);
    }
    assert.equal(get<{ n: number }>(w.db, "SELECT COUNT(*) AS n FROM nutrition_profiles WHERE user_id = ?", w.ids.kiosk)!.n, 0);
  });
});

describe("the database itself refuses a diary for anyone but an admin or parent", () => {
  const INSERTS: Record<string, (user: string) => string[]> = {
    nutrition_profiles: (u) => [`INSERT INTO nutrition_profiles (user_id, sex, birth_date, height_cm, timezone, created_at, updated_at) VALUES ('${u}', 'male', '1990-01-01', 180, 'UTC', 'x', 'x')`],
    nutrition_goals: (u) => [`INSERT INTO nutrition_goals (user_id, effective_from, plan_lb_per_week, activity_level, macro_protein, macro_carbs, macro_fat) VALUES ('${u}', '2000-01-01', 0, 'light', 20, 50, 30)`],
    nutrition_meal_slots: (u) => [`INSERT INTO nutrition_meal_slots (user_id, key, label, sort) VALUES ('${u}', 'breakfast', 'Breakfast', 0)`],
    nutrition_diary_entries: (u) => [`INSERT INTO nutrition_diary_entries (id, user_id, local_date, slot_key, name_snapshot, quantity, unit_snapshot, nutrients_total, logged_at, updated_at) VALUES ('e-${u}', '${u}', '2026-03-10', 'lunch', 'x', 1, 'serving', '{}', 'x', 'x')`],
    nutrition_day_logs: (u) => [`INSERT INTO nutrition_day_logs (user_id, local_date) VALUES ('${u}', '2026-03-10')`],
    nutrition_weights: (u) => [`INSERT INTO nutrition_weights (id, user_id, measured_on, weight_kg) VALUES ('w-${u}', '${u}', '2026-03-10', 80)`],
    nutrition_exercise: (u) => [`INSERT INTO nutrition_exercise (id, user_id, local_date, name, kcal) VALUES ('x-${u}', '${u}', '2026-03-10', 'Run', 100)`],
    nutrition_saved_meals: (u) => [`INSERT INTO nutrition_saved_meals (id, created_by_user_id, name, created_at, updated_at) VALUES ('m-${u}', '${u}', 'x', 'x', 'x')`],
  };

  test("a raw INSERT for the kiosk, or for an id that isn't a user, aborts in every per-person table", async (t) => {
    const w = await newWorld(t, { profiles: false });
    for (const [table, sql] of Object.entries(INSERTS)) {
      for (const who of [w.ids.kiosk, "user-nobody"]) {
        assert.throws(() => sql(who).forEach((s) => w.db.exec(s)), /only admin and parent logins can track/, `${table} for ${who}`);
      }
      assert.equal(get<{ n: number }>(w.db, `SELECT COUNT(*) AS n FROM ${table}`)!.n, 0, table);
    }
  });

  test("the same INSERTs succeed for an admin and for a parent", async (t) => {
    const w = await newWorld(t, { profiles: false });
    for (const [table, sql] of Object.entries(INSERTS)) {
      for (const who of [w.ids.ann, w.ids.ben]) assert.doesNotThrow(() => sql(who).forEach((s) => w.db.exec(s)), `${table} for ${who}`);
    }
  });

  test("on the real household handle too (db.ts's boot ran the same migrations)", () => {
    const kiosk = real.createUser("access-kiosk", "not-a-real-hash", "Kiosk", "kiosk");
    assert.throws(
      () => real.db.exec(INSERTS.nutrition_weights(kiosk)[0]),
      /only admin and parent logins can track/,
    );
    const parent = real.createUser("access-parent", "not-a-real-hash", "Parent", "parent");
    assert.doesNotThrow(() => real.db.exec(INSERTS.nutrition_weights(parent)[0]));
  });
});
