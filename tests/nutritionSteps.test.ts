// Steps typed by hand (migration 11 + /steps): one row per login per local date, re-entering a date replaces
// it, own rows only, and steps never touch the calorie budget. Clock 2026-03-10 15:00Z: ann's today is
// 2026-03-10, ben's (Auckland) is 2026-03-11.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { cleanupDb } from "./helpers/testdb.ts";
import { newApi } from "./helpers/nutritionApi.ts";
import { TODAY, YESTERDAY } from "./helpers/nutritionWorld.ts";
import { MAX_STEPS } from "../nutrition/data/steps.ts";
import { NUTRITION_MIGRATIONS, nutritionSchemaVersion, runNutritionMigrations } from "../nutrition/data/schema.ts";
import { all, get, run } from "../nutrition/data/sql.ts";

after(cleanupDb);

test("migration 11 adds nutrition_steps: one row per login per date, typed or imported, diary logins only", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE users (id TEXT PRIMARY KEY, role TEXT NOT NULL)");
  run(db, "INSERT INTO users (id, role) VALUES ('u1', 'admin'), ('u2', 'parent'), ('k', 'kiosk')");
  runNutritionMigrations(db, NUTRITION_MIGRATIONS.filter((m) => m.id <= 10));
  assert.equal(nutritionSchemaVersion(db), 10);
  assert.deepEqual(runNutritionMigrations(db, NUTRITION_MIGRATIONS.filter((m) => m.id <= 11)), [11]);

  run(db, "INSERT INTO nutrition_steps (user_id, local_date, steps, updated_at) VALUES ('u1', '2026-03-01', 5000, 'x')");
  assert.equal(get<{ source: string }>(db, "SELECT source FROM nutrition_steps")!.source, "manual", "typed by default");
  run(db, "INSERT INTO nutrition_steps (user_id, local_date, steps, source, updated_at) VALUES ('u1', '2026-03-02', 7000, 'import_loseit', 'x')");
  run(db, "INSERT INTO nutrition_steps (user_id, local_date, steps, updated_at) VALUES ('u2', '2026-03-01', 1, 'x')");
  assert.throws(() => run(db, "INSERT INTO nutrition_steps (user_id, local_date, steps, updated_at) VALUES ('u1', '2026-03-01', 6000, 'x')"), /UNIQUE|PRIMARY/);
  assert.throws(() => run(db, "INSERT INTO nutrition_steps (user_id, local_date, steps, updated_at) VALUES ('u1', '2026-03-03', -1, 'x')"), /CHECK/);
  assert.throws(() => run(db, "INSERT INTO nutrition_steps (user_id, local_date, steps, source, updated_at) VALUES ('u1', '2026-03-03', 1, 'guess', 'x')"), /CHECK/);
  assert.throws(() => run(db, "INSERT INTO nutrition_steps (user_id, local_date, steps, updated_at) VALUES ('k', '2026-03-03', 1, 'x')"), /only admin and parent/);
  // An importer can upsert by (login, date) and tell its rows from typed ones.
  run(db, `INSERT INTO nutrition_steps (user_id, local_date, steps, source, updated_at) VALUES ('u1', '2026-03-01', 5500, 'import_loseit', 'y')
           ON CONFLICT (user_id, local_date) DO UPDATE SET steps = excluded.steps, source = excluded.source`);
  assert.deepEqual(all(db, "SELECT local_date, steps, source FROM nutrition_steps WHERE user_id = 'u1' ORDER BY local_date").map((r: any) => [r.local_date, r.steps, r.source]),
    [["2026-03-01", 5500, "import_loseit"], ["2026-03-02", 7000, "import_loseit"]]);
});

test("steps: put a day, list a range, replace a day, delete a day -- all the caller's own", async (t) => {
  const api = await newApi(t);
  assert.deepEqual((await api.call("ann", "GET", "/steps")).body, []);

  const put = await api.call("ann", "PUT", `/steps/${YESTERDAY}`, { steps: 8123 });
  assert.deepEqual([put.status, put.body], [200, { date: YESTERDAY, steps: 8123, source: "manual" }]);
  await api.call("ann", "PUT", `/steps/${TODAY}`, { steps: 4000 });
  await api.call("ann", "PUT", "/steps/2026-02-01", { steps: 100 });
  assert.deepEqual((await api.call("ann", "GET", "/steps")).body.map((r: any) => [r.date, r.steps]), [["2026-02-01", 100], [YESTERDAY, 8123], [TODAY, 4000]], "oldest first");
  assert.deepEqual((await api.call("ann", "GET", `/steps?from=${YESTERDAY}`)).body.map((r: any) => r.date), [YESTERDAY, TODAY]);
  assert.deepEqual((await api.call("ann", "GET", `/steps?from=${YESTERDAY}&to=${YESTERDAY}`)).body.map((r: any) => r.date), [YESTERDAY]);
  assert.equal((await api.call("ann", "GET", "/steps?from=nope")).status, 400);

  // Re-entering a date replaces it: still one row.
  assert.equal((await api.call("ann", "PUT", `/steps/${YESTERDAY}`, { steps: 9000 })).body.steps, 9000);
  assert.equal(all(api.w.db, "SELECT 1 FROM nutrition_steps WHERE user_id = ? AND local_date = ?", api.w.ids.ann, YESTERDAY).length, 1);
  // 0 is a real count (a day on the couch); a replaced imported row becomes a typed one.
  assert.equal((await api.call("ann", "PUT", `/steps/${YESTERDAY}`, { steps: 0 })).status, 200);
  run(api.w.db, "UPDATE nutrition_steps SET source = 'import_loseit' WHERE user_id = ? AND local_date = ?", api.w.ids.ann, YESTERDAY);
  assert.equal((await api.call("ann", "GET", `/steps?from=${YESTERDAY}&to=${YESTERDAY}`)).body[0].source, "import_loseit");
  assert.equal((await api.call("ann", "PUT", `/steps/${YESTERDAY}`, { steps: 1234 })).body.source, "manual");

  // Ben never sees or touches Ann's rows, and his "today" is a day ahead of hers.
  assert.deepEqual((await api.call("ben", "GET", "/steps")).body, []);
  assert.equal((await api.call("ben", "DELETE", `/steps/${YESTERDAY}`)).status, 404);
  assert.equal((await api.call("ben", "PUT", "/steps/2026-03-11", { steps: 77 })).status, 200);
  assert.equal((await api.call("ann", "PUT", "/steps/2026-03-11", { steps: 77 })).status, 400, "tomorrow, for Ann");

  assert.equal((await api.call("ann", "DELETE", `/steps/${YESTERDAY}`)).status, 200);
  assert.equal((await api.call("ann", "DELETE", `/steps/${YESTERDAY}`)).status, 404, "a second delete says it was already gone");
  assert.deepEqual((await api.call("ann", "GET", "/steps")).body.map((r: any) => r.date), ["2026-02-01", TODAY]);
  assert.equal((await api.call("ann", "DELETE", "/steps/not-a-date")).status, 400);
});

test("steps: whole numbers from 0 to 200,000, a real date, a body that says so", async (t) => {
  const api = await newApi(t);
  for (const bad of [-1, MAX_STEPS + 1, 1.5, "100", null, NaN, Infinity, undefined]) {
    const r = await api.call("ann", "PUT", `/steps/${TODAY}`, { steps: bad });
    assert.equal(r.status, 400, String(bad));
  }
  assert.equal((await api.call("ann", "PUT", `/steps/${TODAY}`, { steps: MAX_STEPS })).status, 200);
  assert.equal((await api.call("ann", "PUT", `/steps/${TODAY}`, [])).status, 400);
  assert.equal((await api.call("ann", "PUT", "/steps/2026-02-30", { steps: 5 })).status, 400);
  assert.equal((await api.call("ann", "PUT", "/steps/2099-01-01", { steps: 5 })).status, 400, "a day that has not happened");
  assert.equal((await api.callDevice("ann", "PUT", `/steps/${YESTERDAY}`, { steps: 5 })).status, 200, "a watch writes its owner's own row, like weights");
});

test("steps never change a day's calorie budget or what is left", async (t) => {
  const api = await newApi(t);
  await api.call("ann", "POST", "/weights", { weightKg: 65 });
  const before = (await api.call("ann", "GET", `/days/${TODAY}`)).body;
  await api.call("ann", "PUT", `/steps/${TODAY}`, { steps: 25_000 });
  const after = (await api.call("ann", "GET", `/days/${TODAY}`)).body;
  assert.ok(before.calorieBudget > 0);
  assert.deepEqual(after, before);
});

test("the kiosk gets 403 on the steps routes", async (t) => {
  const api = await newApi(t);
  for (const [method, url, body] of [["GET", "/steps"], ["PUT", `/steps/${TODAY}`, { steps: 1 }], ["DELETE", `/steps/${TODAY}`]] as Array<[string, string, unknown?]>) {
    assert.equal((await api.call("kiosk", method, url, body)).status, 403, `${method} ${url}`);
  }
});
