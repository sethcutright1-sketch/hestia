// A tracker's profile (the facts a calorie budget needs), the starting goal that comes with it,
// and the transaction helper every multi-step write leans on.

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";

import { cleanupDb } from "./helpers/testdb.ts";
import { NOW, newWorld } from "./helpers/nutritionWorld.ts";
import { listGoals } from "../nutrition/data/goals.ts";
import { all, get, run, tx } from "../nutrition/data/sql.ts";
import { defaultTimezone, getTracker, profileJson, saveProfile, timezoneOf, todayFor } from "../nutrition/data/tracker.ts";

after(cleanupDb);

const status = (fn: () => unknown): number => {
  try {
    fn();
  } catch (err: any) {
    return err.status ?? -1;
  }
  return 0;
};

describe("saveProfile", () => {
  test("the first save needs sex, birth date and height, and also gives a 'maintain weight' starting goal", async (t) => {
    const w = await newWorld(t, { profiles: false });
    const ann = () => getTracker(w.db, w.ids.ann);
    assert.equal(ann().profile, null);
    assert.equal(status(() => saveProfile(w.db, ann(), {})), 400);
    assert.equal(status(() => saveProfile(w.db, ann(), { sex: "female", birthDate: "1990-06-15" })), 400, "height missing");
    assert.equal(status(() => saveProfile(w.db, ann(), { sex: "other", birthDate: "1990-06-15", heightCm: 170 })), 400);
    assert.equal(status(() => saveProfile(w.db, ann(), { sex: "female", birthDate: "1990-02-30", heightCm: 170 })), 400);
    assert.equal(status(() => saveProfile(w.db, ann(), { sex: "female", birthDate: "1990-06-15", heightCm: 20 })), 400);
    assert.equal(status(() => saveProfile(w.db, ann(), { sex: "female", birthDate: "1990-06-15", heightCm: 170, timezone: "Mars/Olympus" })), 400);
    assert.equal(ann().profile, null, "refused saves wrote nothing");
    assert.equal(all(w.db, "SELECT * FROM nutrition_goals").length, 0);

    saveProfile(w.db, ann(), { sex: "female", birthDate: "1990-06-15", heightCm: 170, timezone: "America/New_York" });
    assert.deepEqual(profileJson(ann()), {
      id: w.ids.ann, name: "Ann", role: "admin", hasProfile: true, sex: "female", birthDate: "1990-06-15",
      heightCm: 170, timezone: "America/New_York", unitSystem: "imperial",
    });
    const goals = listGoals(w.db, ann(), "2026-03-10");
    assert.equal(goals.history.length, 1);
    assert.deepEqual([goals.current!.planLbPerWeek, goals.current!.activityLevel, goals.current!.macroProtein], [0, "light", 20]);
  });

  test("after that it is a partial update: only fields present change, and no second starting goal appears", async (t) => {
    const w = await newWorld(t);
    const ann = () => w.tracker(w.ids.ann);
    saveProfile(w.db, ann(), { heightCm: 172, unitSystem: "metric" });
    assert.deepEqual(
      [ann().profile!.sex, ann().profile!.birth_date, ann().profile!.height_cm, ann().profile!.unit_system, ann().profile!.timezone],
      ["female", "1990-06-15", 172, "metric", "America/New_York"],
    );
    saveProfile(w.db, ann(), { timezone: "Europe/London" });
    assert.equal(timezoneOf(ann()), "Europe/London");
    assert.equal(listGoals(w.db, ann(), "2026-03-10").history.length, 1);
    assert.equal(status(() => saveProfile(w.db, ann(), { unitSystem: "stones" })), 400);
    assert.equal(status(() => saveProfile(w.db, ann(), "not an object")), 400);
  });

  test("each login has its own profile, and 'today' follows it", async (t) => {
    const w = await newWorld(t);
    // 2026-03-10 15:00 UTC: Tuesday morning in New York, already Wednesday 04:00 in Auckland.
    assert.equal(todayFor(w.ann, NOW), "2026-03-10");
    assert.equal(todayFor(w.ben, NOW), "2026-03-11");
    assert.equal(w.ann.profile!.sex, "female");
    assert.equal(w.ben.profile!.sex, "male");
  });

  test("a login with no profile still has a 'today': the server's own timezone", async (t) => {
    const w = await newWorld(t, { profiles: false });
    const bare = getTracker(w.db, w.ids.ann);
    assert.equal(timezoneOf(bare), defaultTimezone());
    assert.match(todayFor(bare, NOW), /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(profileJson(bare).hasProfile, false);
  });
});

describe("tx", () => {
  const counts = (db: Parameters<typeof tx>[0]) => get<{ n: number }>(db, "SELECT COUNT(*) AS n FROM app_t")!.n;
  async function db(t: Parameters<typeof newWorld>[0]) {
    const w = await newWorld(t);
    w.db.exec("CREATE TABLE app_t (x INTEGER)");
    return w.db;
  }

  test("commits what the function did, or rolls all of it back when it throws", async (t) => {
    const d = await db(t);
    tx(d, () => { run(d, "INSERT INTO app_t VALUES (1)"); run(d, "INSERT INTO app_t VALUES (2)"); });
    assert.equal(counts(d), 2);
    assert.throws(() => tx(d, () => { run(d, "INSERT INTO app_t VALUES (3)"); throw new Error("boom"); }), /boom/);
    assert.equal(counts(d), 2);
    assert.equal(d.isTransaction, false);
  });

  test("inside a caller's transaction it becomes a savepoint: a throw undoes only its own writes", async (t) => {
    const d = await db(t);
    d.exec("BEGIN");
    run(d, "INSERT INTO app_t VALUES (1)");
    assert.throws(() => tx(d, () => { run(d, "INSERT INTO app_t VALUES (2)"); throw new Error("inner"); }), /inner/);
    assert.equal(d.isTransaction, true, "the caller's transaction survives");
    tx(d, () => run(d, "INSERT INTO app_t VALUES (3)"));
    d.exec("COMMIT");
    assert.deepEqual(all<{ x: number }>(d, "SELECT x FROM app_t ORDER BY x").map((r) => r.x), [1, 3]);
  });

  test("returns the function's value", async (t) => {
    const d = await db(t);
    assert.equal(tx(d, () => 42), 42);
  });
});
