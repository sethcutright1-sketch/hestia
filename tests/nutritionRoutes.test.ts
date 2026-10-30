// /api/nutrition/* over the real router (routes/nutrition.ts) against a private in-memory household:
// who the request is for, status codes and JSON shapes, idempotent replays, and that one login can
// never reach another's diary. The rules themselves (calorie maths, snapshots, scopes) are tested
// in the nutrition*.test.ts data-layer files; this file is the HTTP contract on top.
//
// ann = admin (New York), ben = parent (Auckland), kiosk = the shared screen. Clock: 2026-03-10 15:00Z,
// so ann's today is 2026-03-10 and ben's is already 2026-03-11.

import { test, after } from "node:test";
import assert from "node:assert/strict";

import { cleanupDb } from "./helpers/testdb.ts";
import { newApi } from "./helpers/nutritionApi.ts";
import { NOW, TODAY, YESTERDAY, customFood } from "./helpers/nutritionWorld.ts";
import { all, get } from "../nutrition/data/sql.ts";

after(cleanupDb);

const bar = (name = "Test bar", kcal = 200, extra: Record<string, unknown> = {}) => customFood(name, kcal, extra);

/** Every key anywhere in a JSON value. */
function keysOf(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => keysOf(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.add(k); keysOf(x, out); }
  return out;
}

// ---- who you are ----------------------------------------------------------------------------------

test("the person is the signed-in login, never anything in the request body", async (t) => {
  const api = await newApi(t);
  const food = (await api.call("ann", "POST", "/foods", bar())).body;
  // Ann tries to log into Ben's diary by naming him in every way a body could.
  const r = await api.call("ann", "POST", `/diary/${TODAY}`, { slot: "lunch", foodId: food.id, userId: api.w.ids.ben, user_id: api.w.ids.ben, user: { id: api.w.ids.ben } });
  assert.equal(r.status, 201);
  assert.equal(get<{ user_id: string }>(api.w.db, "SELECT user_id FROM nutrition_diary_entries WHERE id = ?", r.body.entry.id)!.user_id, api.w.ids.ann);
  assert.equal((await api.call("ben", "GET", `/diary/${TODAY}`)).body.slots.flatMap((s: any) => s.entries).length, 0);
});

test("profile: first save needs the facts, later saves are partial, and the kiosk is refused", async (t) => {
  const api = await newApi(t, { profiles: false });
  const empty = await api.call("ann", "GET", "/me/profile");
  assert.equal(empty.status, 200);
  assert.deepEqual([empty.body.hasProfile, empty.body.role, empty.body.name], [false, "admin", "Ann"]);
  assert.deepEqual(empty.body.slots.map((s: any) => s.key), ["breakfast", "lunch", "dinner", "snacks"], "first visit gives the default meals");

  assert.equal((await api.call("ann", "PUT", "/me/profile", { sex: "female" })).status, 400, "birthDate and heightCm are missing");
  const saved = await api.call("ann", "PUT", "/me/profile", { sex: "female", birthDate: "1990-06-15", heightCm: 170, timezone: "America/New_York" });
  assert.equal(saved.status, 200);
  assert.deepEqual([saved.body.hasProfile, saved.body.heightCm, saved.body.unitSystem], [true, 170, "imperial"]);
  const partial = await api.call("ann", "PUT", "/me/profile", { unitSystem: "metric" });
  assert.deepEqual([partial.body.unitSystem, partial.body.heightCm], ["metric", 170]);
  assert.equal((await api.call("ann", "PUT", "/me/profile", { timezone: "Mars/Olympus" })).status, 400);
  assert.equal((await api.call("ben", "GET", "/me/profile")).body.hasProfile, false, "profiles are per login");

  for (const [m, u] of [["GET", "/me/profile"], ["GET", "/foods/search?q=a"], ["GET", `/diary/${TODAY}`], ["GET", "/weights"]] as const) {
    assert.equal((await api.call("kiosk", m, u)).status, 403, `${m} ${u}`);
  }
});

// ---- calorie goals, the schedule, and the day's calorie budget ------------------------------------

test("calorie goals, the calorie schedule preview, and the day summary's calorieBudget", async (t) => {
  const api = await newApi(t);
  const noWeight = (await api.call("ann", "GET", `/days/${TODAY}`)).body;
  assert.equal(noWeight.calorieBudget, null);
  assert.deepEqual(noWeight.missing, ["weight"]);

  assert.equal((await api.call("ann", "POST", "/weights", { weightLb: 150, id: "weigh-in-ann-1" })).status, 201);
  const summary = (await api.call("ann", "GET", `/days/${TODAY}`)).body;
  assert.ok(summary.calorieBudget > 1200, "a calorie budget exists once there is a profile, a goal and a weight");
  assert.equal((await api.call("ann", "GET", `/days/${TODAY}/summary`)).body.calorieBudget, summary.calorieBudget, "the source app's longer URL still works");

  const before = (await api.call("ann", "GET", "/me/goals")).body;
  assert.equal(before.current.planLbPerWeek, 0);

  const preview = await api.call("ann", "POST", "/me/goals/preview", { planLbPerWeek: -1, calorieSchedule: { highDays: [6, 0], extraKcal: 300 } });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.days.length, 7);
  const high = preview.body.days.filter((d: any) => d.high);
  assert.deepEqual(high.map((d: any) => d.weekday).sort(), [0, 6]);
  assert.equal(high[0].kcal - preview.body.baseKcal, 300);
  assert.equal((await api.call("ann", "GET", "/me/goals")).body.history.length, before.history.length, "a preview saves nothing");
  assert.equal((await api.call("ann", "POST", "/me/goals/preview", { planLbPerWeek: 7 })).status, 400);

  const goal = await api.call("ann", "POST", "/me/goals", { planLbPerWeek: -1, activityLevel: "light", macroProtein: 30, macroCarbs: 40, macroFat: 30, calorieSchedule: { highDays: [6, 0], extraKcal: 300 } });
  assert.equal(goal.status, 201);
  assert.deepEqual(goal.body.calorieSchedule, { highDays: [0, 6], extraKcal: 300 });
  assert.equal((await api.call("ann", "POST", "/me/goals", { planLbPerWeek: -1, activityLevel: "light", macroProtein: 50, macroCarbs: 50, macroFat: 50 })).status, 400, "macros must add up");
  const after = (await api.call("ann", "GET", "/me/goals")).body;
  assert.equal(after.current.planLbPerWeek, -1);
  assert.equal(after.history.length, before.history.length + 1);
  assert.equal((await api.call("ben", "GET", "/me/goals")).body.current.planLbPerWeek, 0, "goals are per login");
});

test("the API never says a bare 'budget': every figure is a calorie budget", async (t) => {
  const api = await newApi(t);
  await api.call("ann", "POST", "/weights", { weightKg: 70 });
  const food = (await api.call("ann", "POST", "/foods", bar())).body;
  await api.call("ann", "POST", `/diary/${TODAY}`, { slot: "lunch", foodId: food.id });
  const bodies = [
    (await api.call("ann", "GET", `/diary/${TODAY}`)).body,
    (await api.call("ann", "GET", `/days/${TODAY}`)).body,
    (await api.call("ann", "GET", "/me/goals")).body,
    (await api.call("ann", "POST", "/me/goals/preview", {})).body,
    (await api.call("ann", "GET", "/me/slots")).body,
  ];
  const keys = [...keysOf(bodies)];
  assert.ok(keys.includes("calorieBudget") && keys.includes("minCalorieBudgetMode"));
  assert.deepEqual(keys.filter((k) => /budget/i.test(k) && !/calorie/i.test(k)), []);
});

// ---- meals (slots) -----------------------------------------------------------------------------------

test("meals: list, add a custom one, rename, targets, reorder, switch off", async (t) => {
  const api = await newApi(t);
  const list = (await api.call("ann", "GET", "/me/slots")).body;
  assert.deepEqual(list.map((s: any) => [s.key, s.custom]), [["breakfast", false], ["lunch", false], ["dinner", false], ["snacks", false]]);

  const made = await api.call("ann", "POST", "/me/slots", { label: "Pre-Workout", targetKcal: 150 });
  assert.equal(made.status, 201);
  assert.deepEqual([made.body.key, made.body.custom, made.body.targetKcal], ["pre-workout", true, 150]);
  assert.equal((await api.call("ann", "POST", "/me/slots", { label: "Both", targetKcal: 100, targetPct: 10 })).status, 400);

  const renamed = await api.call("ann", "PUT", "/me/slots/lunch", { label: "Midday", targetPct: 30 });
  assert.deepEqual([renamed.body.key, renamed.body.label, renamed.body.targetPct], ["lunch", "Midday", 30]);
  assert.equal((await api.call("ann", "PUT", "/me/slots/nope", { label: "x" })).status, 404);

  const order = ["snacks", "pre-workout", "breakfast", "lunch", "dinner"];
  assert.deepEqual((await api.call("ann", "POST", "/me/slots/reorder", { keys: order })).body.map((s: any) => s.key), order);
  assert.equal((await api.call("ann", "POST", "/me/slots/reorder", { keys: ["snacks"] })).status, 400);

  assert.equal((await api.call("ann", "PUT", "/me/slots/snacks", { enabled: false })).body.enabled, false);
  assert.ok(!(await api.call("ann", "GET", "/me/profile")).body.slots.some((s: any) => s.key === "snacks"), "a switched-off meal is gone from the profile's list");
  assert.ok((await api.call("ann", "GET", "/me/slots")).body.some((s: any) => s.key === "snacks"), "but not from the full list");
  assert.deepEqual((await api.call("ben", "GET", "/me/slots")).body.map((s: any) => s.key), ["breakfast", "lunch", "dinner", "snacks"], "per login");
});

// ---- foods -------------------------------------------------------------------------------------------

test("foods: create, search, read, edit, delete -- and a personal food is invisible to the other login", async (t) => {
  const api = await newApi(t);
  const joint = await api.call("ann", "POST", "/foods", bar("Oat bar", 190));
  assert.equal(joint.status, 201);
  assert.deepEqual([joint.body.scope, joint.body.source, joint.body.nutrients.kcal], ["joint", "custom", 190]);
  const personal = (await api.call("ann", "POST", "/foods", bar("Secret bar", 300, { scope: "personal" }))).body;
  assert.equal(personal.scope, "personal");

  const names = async (who: "ann" | "ben", q: string) => (await api.call(who, "GET", `/foods/search?q=${q}`)).body.map((f: any) => f.name);
  assert.deepEqual((await names("ann", "bar")).sort(), ["Oat bar", "Secret bar"]);
  assert.ok((await names("ann", "secret")).includes("Secret bar"));
  assert.deepEqual(await names("ben", "secret"), []);
  assert.deepEqual(await names("ben", "oat"), ["Oat bar"], "joint foods are shared");

  assert.equal((await api.call("ben", "GET", `/foods/${personal.id}`)).status, 404);
  assert.equal((await api.call("ben", "PATCH", `/foods/${personal.id}`, { name: "Stolen" })).status, 404);
  assert.equal((await api.call("ben", "DELETE", `/foods/${personal.id}`)).status, 404);

  const edited = await api.call("ben", "PATCH", `/foods/${joint.body.id}`, { name: "Oat bar XL", nutrients: { kcal: 250, protein: 5 } });
  assert.deepEqual([edited.status, edited.body.name, edited.body.nutrients.kcal], [200, "Oat bar XL", 250]);
  assert.equal((await api.call("ann", "GET", `/foods/${joint.body.id}`)).body.name, "Oat bar XL");
  assert.equal((await api.call("ann", "POST", "/foods", { name: "No nutrients" })).status, 400);
  assert.equal((await api.call("ann", "GET", "/foods/search")).body.length, 0, "no query, no results");

  assert.deepEqual((await api.call("ann", "DELETE", `/foods/${joint.body.id}`)).body, { ok: true });
  assert.equal((await api.call("ann", "GET", `/foods/${joint.body.id}`)).status, 404);
  assert.deepEqual(await names("ben", "oat"), []);
});

test("recent foods are what you actually ate, not what you only planned", async (t) => {
  const api = await newApi(t);
  const eaten = (await api.call("ann", "POST", "/foods", bar("Eaten bar"))).body;
  const planned = (await api.call("ann", "POST", "/foods", bar("Planned bar"))).body;
  await api.call("ann", "POST", `/diary/${TODAY}`, { slot: "snacks", foodId: eaten.id });
  await api.call("ann", "POST", `/diary/${TODAY}`, { slot: "snacks", foodId: planned.id, status: "planned" });
  assert.deepEqual((await api.call("ann", "GET", "/foods/recent")).body.map((f: any) => f.name), ["Eaten bar"]);
  assert.deepEqual((await api.call("ben", "GET", "/foods/recent")).body, []);
});

// ---- the diary -----------------------------------------------------------------------------------------

test("diary: log, plan, edit, delete -- with the day's summary riding along", async (t) => {
  const api = await newApi(t);
  await api.call("ann", "POST", "/weights", { weightKg: 65 });
  const food = (await api.call("ann", "POST", "/foods", bar("Lunch bar", 200))).body;

  const logged = await api.call("ann", "POST", `/diary/${TODAY}`, { slot: "lunch", food_id: food.id, quantity: 2 });
  assert.equal(logged.status, 201);
  assert.deepEqual([logged.body.entry.status, logged.body.entry.nutrients.kcal, logged.body.summary.eaten], ["logged", 400, 400]);
  assert.equal(logged.body.summary.remaining, logged.body.summary.calorieBudget - 400);

  const quick = await api.call("ann", "POST", `/diary/${TODAY}`, { slot: "snacks", kcal: 90, name: "Mystery" });
  assert.deepEqual([quick.body.entry.isQuickAdd, quick.body.entry.source], [true, "quick"]);

  const future = await api.call("ann", "POST", "/diary/2026-03-12", { slot: "dinner", foodId: food.id });
  assert.equal(future.body.entry.status, "planned", "a future day is a plan");
  assert.equal(future.body.summary.eaten, 0);
  assert.equal(future.body.summary.plannedKcal, 200);

  // A planned entry can be logged only on or after its own day (user decision 2026-10-15); other edits to it are fine.
  const early = await api.call("ann", "PATCH", `/diary/entry/${future.body.entry.id}`, { status: "logged" });
  assert.deepEqual([early.status, early.body.error], [400, "That day hasn't happened yet. Log it on the day."]);
  assert.equal((await api.call("ann", "PATCH", `/diary/entry/${future.body.entry.id}`, { quantity: 2 })).status, 200, "its amount can still change");
  assert.equal((await api.call("ann", "PATCH", `/diary/entry/${future.body.entry.id}`, { quantity: 1 })).status, 200);
  api.setNow(new Date("2026-03-12T15:00:00Z")); // the day arrives
  const ate = await api.call("ann", "PATCH", `/diary/entry/${future.body.entry.id}`, { status: "logged", slot: "lunch" });
  api.setNow(NOW);
  assert.deepEqual([ate.body.entry.status, ate.body.entry.slotKey, ate.body.summary.date], ["logged", "lunch", "2026-03-12"]);
  const half = await api.call("ann", "PATCH", `/diary/entry/${logged.body.entry.id}`, { quantity: 1 });
  assert.equal(half.body.entry.nutrients.kcal, 200);

  const page = (await api.call("ann", "GET", `/diary/${TODAY}`)).body;
  assert.deepEqual(page.slots.map((s: any) => s.key), ["breakfast", "lunch", "dinner", "snacks"]);
  assert.equal(page.slots.find((s: any) => s.key === "lunch").kcal, 200);
  assert.equal(page.slots.find((s: any) => s.key === "lunch").entries[0].relog.foodId, food.id);
  assert.equal(page.summary.eaten, 290);

  const del = await api.call("ann", "DELETE", `/diary/entry/${quick.body.entry.id}`);
  assert.deepEqual([del.status, del.body.summary.eaten], [200, 200]);
  assert.equal((await api.call("ann", "DELETE", `/diary/entry/${quick.body.entry.id}`)).status, 200, "deleting twice is fine");

  assert.equal((await api.call("ann", "POST", `/diary/${TODAY}`, { slot: "elevenses", kcal: 1 })).status, 400, "unknown meal");
  assert.equal((await api.call("ann", "POST", "/diary/not-a-date", { slot: "lunch", kcal: 1 })).status, 400);
  assert.equal((await api.call("ann", "POST", `/diary/${TODAY}`, { slot: "lunch", foodId: "no-such-food" })).status, 404);
  assert.equal((await api.call("ann", "PATCH", "/diary/entry/nope", { quantity: 1 })).status, 404);
});

test("diary writes are idempotent: a replayed id changes nothing and answers 200", async (t) => {
  const api = await newApi(t);
  const food = (await api.call("ann", "POST", "/foods", bar())).body;
  const body = { id: "client-entry-0001", slot: "lunch", foodId: food.id, quantity: 1, source: "scan" };
  const first = await api.call("ann", "POST", `/diary/${TODAY}`, body);
  const again = await api.call("ann", "POST", `/diary/${TODAY}`, body);
  assert.deepEqual([first.status, again.status, again.body.entry.id], [201, 200, "client-entry-0001"]);
  assert.equal(get<{ n: number }>(api.w.db, "SELECT COUNT(*) AS n FROM nutrition_diary_entries")!.n, 1);
  assert.equal(get<{ usage_count: number }>(api.w.db, "SELECT usage_count FROM nutrition_foods WHERE id = ?", food.id)!.usage_count, 1, "popularity counted once");

  // Someone else's id is refused, and does not reveal or touch their entry.
  const clash = await api.call("ben", "POST", `/diary/${TODAY}`, body);
  assert.equal(clash.status, 409);
  assert.equal(get<{ user_id: string }>(api.w.db, "SELECT user_id FROM nutrition_diary_entries WHERE id = 'client-entry-0001'")!.user_id, api.w.ids.ann);
});

test("bulk add: one transaction, idempotent by client ids, undone as a group, someone else's id refuses the lot", async (t) => {
  const api = await newApi(t);
  const a = (await api.call("ann", "POST", "/foods", bar("Bulk A", 100))).body;
  const b = (await api.call("ann", "POST", "/foods", bar("Bulk B", 50))).body;
  const req = { slot: "dinner", groupId: "group-aaaa-0001", items: [{ id: "bulk-item-0001", foodId: a.id }, { id: "bulk-item-0002", food_id: b.id, quantity: 2 }] };

  const first = await api.call("ann", "POST", `/diary/${TODAY}/bulk`, req);
  assert.equal(first.status, 201);
  assert.deepEqual([first.body.created, first.body.entries.length, first.body.summary.eaten], [2, 2, 200]);
  assert.deepEqual(first.body.entries.map((e: any) => [e.source, e.groupId]), [["copy", "group-aaaa-0001"], ["copy", "group-aaaa-0001"]]);

  const replay = await api.call("ann", "POST", `/diary/${TODAY}/bulk`, req);
  assert.deepEqual([replay.status, replay.body.created, replay.body.summary.eaten], [200, 0, 200]);

  assert.equal((await api.call("ann", "POST", `/diary/${TODAY}/bulk`, { slot: "dinner", items: [] })).status, 400);
  assert.equal((await api.call("ann", "POST", `/diary/${TODAY}/bulk`, { slot: "dinner", items: [{ foodId: a.id }] })).status, 400, "items need ids");

  const theft = await api.call("ben", "POST", `/diary/${TODAY}/bulk`, { slot: "dinner", items: [{ id: "bulk-new-0001", foodId: a.id }, { id: "bulk-item-0001", foodId: a.id }] });
  assert.equal(theft.status, 409);
  assert.equal(get<{ n: number }>(api.w.db, "SELECT COUNT(*) AS n FROM nutrition_diary_entries WHERE user_id = ?", api.w.ids.ben)!.n, 0, "nothing of Ben's was written");

  const undo = await api.call("ann", "DELETE", "/diary/group/group-aaaa-0001");
  assert.deepEqual([undo.status, undo.body.deleted, undo.body.summaries[0].eaten], [200, 2, 0]);
  assert.equal((await api.call("ann", "DELETE", "/diary/group/group-aaaa-0001")).body.deleted, 0, "undo is idempotent");
  assert.equal((await api.call("ann", "DELETE", "/diary/group/x")).status, 400);
  assert.equal((await api.call("ben", "DELETE", "/diary/group/group-aaaa-0001")).body.deleted, 0, "a group is only ever your own rows");
});

test("a parent cannot read or change another login's diary entries by id", async (t) => {
  const api = await newApi(t);
  const food = (await api.call("ann", "POST", "/foods", bar("Ann's lunch", 300))).body;
  const mine = (await api.call("ann", "POST", `/diary/${TODAY}`, { slot: "lunch", foodId: food.id })).body.entry;
  const planned = (await api.call("ann", "POST", `/diary/${TODAY}`, { slot: "dinner", foodId: food.id, status: "planned" })).body.entry;

  assert.equal((await api.call("ben", "PATCH", `/diary/entry/${mine.id}`, { quantity: 5 })).status, 404);
  assert.equal((await api.call("ben", "PATCH", `/diary/entry/${planned.id}`, { status: "logged" })).status, 404);
  assert.equal((await api.call("ben", "DELETE", `/diary/entry/${mine.id}`)).status, 404);

  // Ben's own view of the same date, in any timezone, shows none of it; Ann's entries are untouched.
  for (const date of [TODAY, "2026-03-11"]) {
    const page = (await api.call("ben", "GET", `/diary/${date}`)).body;
    assert.deepEqual(page.slots.flatMap((s: any) => s.entries), []);
    assert.equal(page.summary.eaten, 0);
  }
  const rows = all<{ id: string; status: string; quantity: number; deleted_at: string | null }>(api.w.db, "SELECT id, status, quantity, deleted_at FROM nutrition_diary_entries ORDER BY rowid");
  assert.deepEqual(rows.map((r) => [r.status, r.quantity, r.deleted_at]), [["logged", 1, null], ["planned", 1, null]]);
});

test("Done logging: refused while plans remain, then it counts toward the streak", async (t) => {
  const api = await newApi(t);
  const food = (await api.call("ann", "POST", "/foods", bar())).body;
  const plan = (await api.call("ann", "POST", `/diary/${YESTERDAY}`, { slot: "dinner", foodId: food.id, status: "planned" })).body.entry;

  const blocked = await api.call("ann", "POST", `/days/${YESTERDAY}/done`);
  assert.deepEqual([blocked.status, blocked.body.plannedCount], [409, 1]);
  await api.call("ann", "PATCH", `/diary/entry/${plan.id}`, { status: "logged" });
  const done = await api.call("ann", "POST", `/days/${YESTERDAY}/done`);
  assert.equal(done.status, 200);
  assert.ok(done.body.doneLoggingAt);
  assert.equal(done.body.streak.current, 1);
  assert.equal((await api.call("ann", "POST", "/days/2026-03-20/done")).status, 400, "not ahead of time");
  assert.equal((await api.call("ann", "POST", "/days/2026-01-01/done")).status, 400, "not months late");

  const streak = (await api.call("ann", "GET", "/me/streak")).body;
  assert.deepEqual([streak.current, streak.today], [1, TODAY]);
  // Nobody shares by default: Ben sees only his own streak, Ann sees only hers.
  assert.deepEqual((await api.call("ben", "GET", "/household/streaks")).body.map((m: any) => [m.name, m.mine, m.current]), [["Ben", true, 0]]);
  await api.call("ann", "PUT", "/me/visibility", { visibility: "totals" });
  const household = (await api.call("ben", "GET", "/household/streaks")).body;
  assert.deepEqual(household.map((m: any) => [m.name, m.mine, m.current]), [["Ann", false, 1], ["Ben", true, 0]]);
  assert.deepEqual(Object.keys(household[0]).sort(), ["best", "countedToday", "current", "mine", "name", "userId"], "numbers only, nothing about food");
});

test("previous meals list what was eaten lately, ready to log again", async (t) => {
  const api = await newApi(t);
  const food = (await api.call("ann", "POST", "/foods", bar("Usual bar", 120))).body;
  await api.call("ann", "POST", `/diary/${YESTERDAY}`, { slot: "breakfast", foodId: food.id, quantity: 2 });
  const meals = (await api.call("ann", "GET", "/meals/previous")).body;
  assert.equal(meals.length, 1);
  assert.deepEqual([meals[0].slotLabel, meals[0].kcal, meals[0].items[0].foodId, meals[0].items[0].quantity], ["Breakfast", 240, food.id, 2]);
  assert.deepEqual((await api.call("ben", "GET", "/meals/previous")).body, []);
});

// ---- weight and exercise ---------------------------------------------------------------------------------

test("weights: add (idempotent), list, trend, delete -- and exercise", async (t) => {
  const api = await newApi(t);
  const first = await api.call("ann", "POST", "/weights", { weightLb: 154.32, measuredOn: YESTERDAY, id: "weight-0000-0001" });
  assert.deepEqual([first.status, first.body.created, first.body.weightKg], [201, true, 70]);
  const replay = await api.call("ann", "POST", "/weights", { weightKg: 99, id: "weight-0000-0001" });
  assert.deepEqual([replay.status, replay.body.created, replay.body.weightKg], [200, false, 70], "the replay is a no-op");
  assert.equal((await api.call("ben", "POST", "/weights", { weightKg: 80, id: "weight-0000-0001" })).status, 409);
  assert.equal((await api.call("ann", "POST", "/weights", { weightKg: 5 })).status, 400);
  await api.call("ann", "POST", "/weights", { weightKg: 69.5, measuredOn: TODAY });

  assert.deepEqual((await api.call("ann", "GET", "/weights")).body.map((w: any) => w.weightKg), [70, 69.5]);
  assert.deepEqual((await api.call("ann", "GET", `/weights?from=${TODAY}`)).body.map((w: any) => w.weightKg), [69.5]);
  assert.deepEqual((await api.call("ben", "GET", "/weights")).body, []);
  const trend = (await api.call("ann", "GET", "/weights/trend")).body;
  assert.equal(trend.points.length, 2);
  assert.ok(trend.trendKg > 69 && trend.trendKg < 70.1);
  assert.equal(trend.projection, null, "no goal weight yet");

  const id = (await api.call("ann", "GET", "/weights")).body[0].id;
  assert.equal((await api.call("ben", "DELETE", `/weights/${id}`)).status, 404);
  assert.equal((await api.call("ann", "DELETE", `/weights/${id}`)).status, 200);
  assert.equal((await api.call("ann", "DELETE", `/weights/${id}`)).status, 404);

  const ex = await api.call("ann", "POST", "/exercise", { name: "Run", kcal: 300 });
  assert.deepEqual([ex.status, ex.body.localDate, ex.body.excludeFromBudget], [201, TODAY, false]);
  await api.call("ann", "POST", "/exercise", { name: "Walk", kcal: 100, excludeFromBudget: true });
  assert.deepEqual((await api.call("ann", "GET", "/exercise")).body.map((e: any) => e.name), ["Run", "Walk"]);
  assert.deepEqual((await api.call("ben", "GET", "/exercise")).body, []);
  const day = (await api.call("ann", "GET", `/days/${TODAY}`)).body;
  assert.deepEqual([day.exercise, day.exerciseExcluded], [300, 100], "excluded exercise is shown but doesn't raise the calorie budget");
  assert.equal((await api.call("ben", "DELETE", `/exercise/${ex.body.id}`)).status, 404);
  assert.equal((await api.call("ann", "DELETE", `/exercise/${ex.body.id}`)).status, 200);
});

// ---- saved meals -------------------------------------------------------------------------------------------

test("saved meals: CRUD, scope, and logging one (idempotent, undoable, skipping what's gone)", async (t) => {
  const api = await newApi(t);
  const oats = (await api.call("ann", "POST", "/foods", bar("Oats", 150))).body;
  const jam = (await api.call("ann", "POST", "/foods", bar("Jam", 50, { scope: "personal" }))).body;

  const created = await api.call("ann", "POST", "/saved-meals", { name: "Usual breakfast", scope: "personal", defaultSlotKey: "breakfast", items: [{ foodId: oats.id, quantity: 2 }, { foodId: jam.id }] });
  assert.equal(created.status, 201);
  assert.deepEqual([created.body.scope, created.body.kcal, created.body.items.length], ["personal", 350, 2]);
  assert.equal((await api.call("ann", "POST", "/saved-meals", { name: "Joint", items: [{ foodId: jam.id }] })).status, 400, "a joint meal can't hold a personal food");
  assert.equal((await api.call("ann", "POST", "/saved-meals", { name: "Empty", items: [] })).status, 400);

  assert.deepEqual((await api.call("ann", "GET", "/saved-meals")).body.map((m: any) => m.name), ["Usual breakfast"]);
  assert.deepEqual((await api.call("ben", "GET", "/saved-meals")).body, []);
  assert.equal((await api.call("ben", "GET", `/saved-meals/${created.body.id}`)).status, 404);
  assert.equal((await api.call("ben", "DELETE", `/saved-meals/${created.body.id}`)).status, 404);

  const renamed = await api.call("ann", "PUT", `/saved-meals/${created.body.id}`, { name: "Weekday breakfast" });
  assert.equal(renamed.body.name, "Weekday breakfast");

  // Log it: defaults to its own meal and today.
  const log = { groupId: "log-group-0001" };
  const first = await api.call("ann", "POST", `/saved-meals/${created.body.id}/log`, log);
  assert.equal(first.status, 201);
  assert.deepEqual([first.body.created, first.body.summary.eaten, first.body.entries.map((e: any) => e.slotKey)], [2, 350, ["breakfast", "breakfast"]]);
  const replay = await api.call("ann", "POST", `/saved-meals/${created.body.id}/log`, log);
  assert.deepEqual([replay.status, replay.body.created, replay.body.summary.eaten], [200, 0, 350], "same groupId, same entries");
  const other = await api.call("ann", "POST", `/saved-meals/${created.body.id}/log`, { groupId: "log-group-0002", date: YESTERDAY, slot: "snacks" });
  assert.deepEqual([other.body.entries[0].localDate, other.body.entries[0].slotKey], [YESTERDAY, "snacks"]);
  const undo = await api.call("ann", "DELETE", "/diary/group/log-group-0001");
  assert.deepEqual([undo.body.deleted, undo.body.summaries[0].eaten], [2, 0]);

  // A food that has since been deleted is skipped and reported.
  await api.call("ann", "DELETE", `/foods/${jam.id}`);
  const partial = await api.call("ann", "POST", `/saved-meals/${created.body.id}/log`, { groupId: "log-group-0003" });
  assert.equal(partial.body.created, 1);
  assert.equal(partial.body.skipped.length, 1);
  assert.equal((await api.call("ben", "POST", `/saved-meals/${created.body.id}/log`, {})).status, 404);

  // From a logged meal of a day, and the no-default-meal rule.
  const fromDay = await api.call("ann", "POST", "/saved-meals", { name: "From yesterday", fromDate: YESTERDAY, fromSlot: "snacks" });
  assert.equal(fromDay.status, 201);
  assert.equal((await api.call("ann", "POST", `/saved-meals/${fromDay.body.id}/log`, {})).body.entries[0].slotKey, "snacks");
  const noDefault = await api.call("ann", "POST", "/saved-meals", { name: "No default", items: [{ foodId: oats.id }] });
  assert.equal((await api.call("ann", "POST", `/saved-meals/${noDefault.body.id}/log`, {})).status, 400);

  assert.deepEqual((await api.call("ann", "DELETE", `/saved-meals/${created.body.id}`)).body, { ok: true });
  assert.equal((await api.call("ann", "GET", `/saved-meals/${created.body.id}`)).status, 404);
});

// ---- plumbing ------------------------------------------------------------------------------------------------

test("unknown paths answer JSON 404; a failure that isn't ours is a generic 500 and is logged", async (t) => {
  const api = await newApi(t, { lookup: async () => { throw new Error("secret internal detail"); } });
  assert.deepEqual((await api.call("ann", "GET", "/nope")).body, { error: "Not found." });

  const logged: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { logged.push(args); });
  const r = await api.call("ann", "POST", "/barcodes/lookup", { code: "016000275287" });
  assert.equal(r.status, 500);
  assert.deepEqual(r.body, { error: "Something went wrong on the server." });
  assert.ok(!JSON.stringify(r.body).includes("secret"));
  assert.ok(logged.some((a) => String(a[1]).includes("secret internal detail")), "the real error is logged server-side");
});

test("a planned entry can be logged only on or after its own day: tomorrow is refused, today and a past day work, other edits to a future entry work", async (t) => {
  const api = await newApi(t);
  const food = (await api.call("ann", "POST", "/foods", bar("Plan bar", 150))).body;
  const plan = async (date: string) => (await api.call("ann", "POST", `/diary/${date}`, { slot: "dinner", foodId: food.id, status: "planned" })).body.entry.id as string;
  const [tomorrow, today, past] = [await plan("2026-03-11"), await plan(TODAY), await plan("2026-03-01")];

  const early = await api.call("ann", "PATCH", `/diary/entry/${tomorrow}`, { status: "logged" });
  assert.deepEqual([early.status, early.body.error], [400, "That day hasn't happened yet. Log it on the day."]);
  const moved = await api.call("ann", "PATCH", `/diary/entry/${tomorrow}`, { slot: "lunch", quantity: 2 });
  assert.deepEqual([moved.status, moved.body.entry.status, moved.body.entry.slotKey], [200, "planned", "lunch"], "amount and meal can still change");

  for (const id of [today, past]) {
    const ok = await api.call("ann", "PATCH", `/diary/entry/${id}`, { status: "logged" });
    assert.deepEqual([ok.status, ok.body.entry.status], [200, "logged"]);
  }
  // Ben's today is a day ahead of Ann's (Auckland): tomorrow for Ann is Ben's today.
  const bens = (await api.call("ben", "POST", "/diary/2026-03-11", { slot: "dinner", foodId: food.id, status: "planned" })).body.entry.id;
  assert.equal((await api.call("ben", "PATCH", `/diary/entry/${bens}`, { status: "logged" })).status, 200);
  // Un-logging (logged -> planned) is not "logging": it is never refused.
  assert.equal((await api.call("ann", "PATCH", `/diary/entry/${today}`, { status: "planned" })).status, 200);
});
