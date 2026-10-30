// The exercise log behind the Food section's Exercise list: name, minutes and calories burned;
// edit; the person's own recent exercises for one-tap repeat; and the day's calorie budget
// getting the burned calories back (the day summary's `exercise` and `remaining`).

import { test } from "node:test";
import assert from "node:assert/strict";

import { newApi } from "./helpers/nutritionApi.ts";
import { TODAY, YESTERDAY } from "./helpers/nutritionWorld.ts";
import { NUTRITION_MIGRATIONS, runNutritionMigrations } from "../nutrition/data/schema.ts";
import { DatabaseSync } from "node:sqlite";
import { all, get, run } from "../nutrition/data/sql.ts";

test("migration 9 adds a nullable minutes column and leaves existing exercise rows alone", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE users (id TEXT PRIMARY KEY, role TEXT NOT NULL)");
  runNutritionMigrations(db, NUTRITION_MIGRATIONS.filter((m) => m.id <= 8));
  run(db, "INSERT INTO users (id, role) VALUES ('u1', 'admin')");
  run(db, "INSERT INTO nutrition_exercise (id, user_id, local_date, name, kcal) VALUES ('x1', 'u1', '2026-03-10', 'Run', 300)");
  assert.deepEqual(runNutritionMigrations(db, NUTRITION_MIGRATIONS.filter((m) => m.id <= 9)), [9]); // later migrations have their own tests
  const cols = all<{ name: string }>(db, "SELECT name FROM pragma_table_info('nutrition_exercise')").map((c) => c.name);
  assert.ok(cols.includes("minutes"));
  assert.equal(get<{ minutes: number | null }>(db, "SELECT minutes FROM nutrition_exercise WHERE id = 'x1'")!.minutes, null);
});

test("exercise: minutes are stored and optional, bad values are refused", async (t) => {
  const api = await newApi(t);
  const run30 = await api.call("ann", "POST", "/exercise", { name: "Run", minutes: 30, kcal: 300 });
  assert.deepEqual([run30.status, run30.body.minutes, run30.body.kcal], [201, 30, 300]);
  const noMinutes = await api.call("ann", "POST", "/exercise", { name: "Dishes", kcal: 40 });
  assert.equal(noMinutes.body.minutes, null);
  assert.equal((await api.call("ann", "POST", "/exercise", { name: "Run", minutes: -5, kcal: 300 })).status, 400);
  assert.equal((await api.call("ann", "POST", "/exercise", { name: "Run", minutes: 5000, kcal: 300 })).status, 400);
  assert.equal((await api.call("ann", "POST", "/exercise", { name: "Run", kcal: -1 })).status, 400);
  assert.deepEqual((await api.call("ann", "GET", "/exercise")).body.map((e: any) => [e.name, e.minutes, e.kcal]), [["Run", 30, 300], ["Dishes", null, 40]]);
});

test("exercise: the burned calories are added back to that day's calorie budget, and editing or deleting follows", async (t) => {
  const api = await newApi(t, { profiles: true });
  await api.call("ann", "POST", "/weights", { weightKg: 70, measuredOn: TODAY });
  await api.call("ann", "POST", `/diary/${TODAY}`, { slot: "lunch", kcal: 500, name: "Lunch" });
  const base = (await api.call("ann", "GET", `/days/${TODAY}`)).body;
  assert.notEqual(base.calorieBudget, null, "the premise: this login has a calorie budget");
  assert.equal(base.remaining, base.calorieBudget - 500);

  const ex = (await api.call("ann", "POST", "/exercise", { name: "Run", minutes: 30, kcal: 300 })).body;
  let day = (await api.call("ann", "GET", `/days/${TODAY}`)).body;
  assert.deepEqual([day.exercise, day.remaining], [300, base.calorieBudget - 500 + 300]);
  assert.equal((await api.call("ann", "GET", `/diary/${TODAY}`)).body.summary.remaining, day.remaining, "the diary page carries the same summary");

  const edited = await api.call("ann", "PATCH", `/exercise/${ex.id}`, { kcal: 450, minutes: 45, name: "Long run" });
  assert.deepEqual([edited.status, edited.body.name, edited.body.kcal, edited.body.minutes], [200, "Long run", 450, 45]);
  day = (await api.call("ann", "GET", `/days/${TODAY}`)).body;
  assert.deepEqual([day.exercise, day.remaining], [450, base.calorieBudget - 500 + 450]);

  const partial = await api.call("ann", "PATCH", `/exercise/${ex.id}`, { minutes: null });
  assert.deepEqual([partial.body.minutes, partial.body.kcal, partial.body.name], [null, 450, "Long run"], "only the fields sent change; null clears minutes");
  assert.equal((await api.call("ann", "PATCH", `/exercise/${ex.id}`, { kcal: "lots" })).status, 400);

  await api.call("ann", "DELETE", `/exercise/${ex.id}`);
  day = (await api.call("ann", "GET", `/days/${TODAY}`)).body;
  assert.deepEqual([day.exercise, day.remaining], [0, base.calorieBudget - 500]);
});

test("exercise: another login can neither edit nor see it", async (t) => {
  const api = await newApi(t);
  const ex = (await api.call("ann", "POST", "/exercise", { name: "Run", kcal: 300 })).body;
  assert.equal((await api.call("ben", "PATCH", `/exercise/${ex.id}`, { kcal: 1 })).status, 404);
  assert.equal((await api.call("ben", "DELETE", `/exercise/${ex.id}`)).status, 404);
  assert.deepEqual((await api.call("ben", "GET", "/exercise/recent")).body, []);
  assert.equal((await api.call("ann", "GET", "/exercise")).body[0].kcal, 300, "unchanged");
  assert.equal((await api.call("ann", "PATCH", "/exercise/no-such-id", { kcal: 1 })).status, 404);
  await api.call("ann", "DELETE", `/exercise/${ex.id}`);
  assert.equal((await api.call("ann", "PATCH", `/exercise/${ex.id}`, { kcal: 1 })).status, 404, "a deleted entry can't be edited");
  assert.equal((await api.call("kiosk", "GET", "/exercise/recent")).status, 403);
  assert.equal((await api.call("kiosk", "PATCH", `/exercise/${ex.id}`, {})).status, 403);
});

test("recent exercises: distinct name + minutes + calories, newest first, only your own, deleted ones gone", async (t) => {
  const api = await newApi(t);
  await api.call("ann", "POST", "/exercise", { name: "Run", minutes: 30, kcal: 300, localDate: YESTERDAY });
  await api.call("ann", "POST", "/exercise", { name: "Walk", minutes: 20, kcal: 90, localDate: YESTERDAY });
  await api.call("ann", "POST", "/exercise", { name: "Run", minutes: 30, kcal: 300 }); // a repeat: shown once
  await api.call("ann", "POST", "/exercise", { name: "run", minutes: 30, kcal: 300 }); // same thing, different case
  await api.call("ann", "POST", "/exercise", { name: "Run", minutes: 60, kcal: 600 });
  await api.call("ann", "POST", "/exercise", { name: "Yoga", kcal: 120 });
  await api.call("ben", "POST", "/exercise", { name: "Ben's secret rowing", kcal: 999 });

  const recent = (await api.call("ann", "GET", "/exercise/recent")).body;
  assert.deepEqual(recent.map((e: any) => [e.name, e.minutes, e.kcal]), [["Yoga", null, 120], ["Run", 60, 600], ["run", 30, 300], ["Walk", 20, 90]]);
  assert.equal(JSON.stringify(recent).includes("secret"), false);
  assert.equal((await api.call("ann", "GET", "/exercise/recent?limit=2")).body.length, 2);

  await api.call("ann", "DELETE", `/exercise/${recent[0].id}`);
  assert.equal((await api.call("ann", "GET", "/exercise/recent")).body[0].name, "Run");
});
