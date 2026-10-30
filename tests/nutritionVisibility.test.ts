// Who sees what (merge plan, Phase 5 decisions): each diary login decides what the OTHER diary logins can see of
// THEIR food data -- nothing (default) / totals / everything -- and the server enforces it on every route that
// exposes another person's data: the household streaks, the week's calorie view, and the read-only "view a
// person" routes. Progress photos are never shared. Clock 2026-03-10 15:00Z: ann's (New York) today is
// 2026-03-10, ben's (Auckland) is 2026-03-11.

import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { cleanupDb, loadDb } from "./helpers/testdb.ts";
import { newApi, type Api, type Person } from "./helpers/nutritionApi.ts";
import { TODAY, YESTERDAY, customFood } from "./helpers/nutritionWorld.ts";
import { weekCalories } from "../nutrition/data/planCalories.ts";
import { sharersFor, setVisibility, visibilityOf } from "../nutrition/data/visibility.ts";
import { all } from "../nutrition/data/sql.ts";
import { PNG_1X1_BASE64 } from "./helpers/images.ts";

const { setConfig } = await loadDb();
after(cleanupDb);
beforeEach(() => setConfig("lock_pin_hash", null));

const LEVELS = ["nothing", "totals", "everything"] as const;
type Level = (typeof LEVELS)[number];

const setLevel = (api: Api, who: Person, visibility: unknown) => api.call(who, "PUT", "/me/visibility", { visibility });

/** Ann with a weight, a logged breakfast (240 kcal), a planned dinner, a run, a weigh-in history and steps; Ben with a weight and a lunch. */
async function household(api: Api) {
  await api.call("ann", "POST", "/weights", { weightKg: 66, measuredOn: "2026-03-01" });
  await api.call("ann", "POST", "/weights", { weightKg: 65, measuredOn: TODAY });
  await api.call("ben", "POST", "/weights", { weightKg: 80, measuredOn: "2026-03-11" });
  const bar = (await api.call("ann", "POST", "/foods", customFood("Secret Brownie", 240))).body;
  const soup = (await api.call("ben", "POST", "/foods", customFood("Ben Soup", 300))).body;
  const logged = (await api.call("ann", "POST", `/diary/${TODAY}`, { slot: "breakfast", foodId: bar.id, quantity: 1, status: "logged" })).body.entry;
  const planned = (await api.call("ann", "POST", `/diary/${TODAY}`, { slot: "dinner", foodId: bar.id, quantity: 1, status: "planned" })).body.entry;
  await api.call("ann", "POST", `/diary/${YESTERDAY}`, { slot: "lunch", foodId: bar.id, quantity: 2, status: "logged" });
  const run = (await api.call("ann", "POST", "/exercise", { name: "Secret Run", minutes: 30, kcal: 300, localDate: TODAY })).body;
  await api.call("ann", "PUT", `/steps/${YESTERDAY}`, { steps: 8123 });
  await api.call("ann", "POST", `/days/${YESTERDAY}/done`);
  await api.call("ben", "POST", "/diary/2026-03-11", { slot: "lunch", foodId: soup.id, quantity: 1, status: "logged" });
  const weight = (await api.call("ann", "GET", "/weights")).body[0];
  return { logged, planned, run, weight };
}

// ---- the setting ------------------------------------------------------------------------------------

test("the setting: per login, defaults to nothing, only the three words, only for diary logins", async (t) => {
  const api = await newApi(t);
  assert.deepEqual((await api.call("ann", "GET", "/me/visibility")).body, { visibility: "nothing", defaultVisibility: "nothing", levels: LEVELS });
  assert.equal((await setLevel(api, "ann", "totals")).body.visibility, "totals");
  assert.equal((await api.call("ann", "GET", "/me/visibility")).body.visibility, "totals");
  assert.equal((await api.call("ben", "GET", "/me/visibility")).body.visibility, "nothing", "Ben's setting is his own");
  for (const bad of ["all", "TOTALS", "", 1, null, undefined, ["totals"]]) {
    const r = await setLevel(api, "ann", bad);
    assert.equal(r.status, 400, String(bad));
  }
  assert.equal((await api.call("ann", "PUT", "/me/visibility", [])).status, 400);
  assert.equal((await api.call("ann", "GET", "/me/visibility")).body.visibility, "totals", "refused writes changed nothing");
  assert.equal((await api.call("kiosk", "GET", "/me/visibility")).status, 403);
  assert.equal((await api.call("kiosk", "PUT", "/me/visibility", { visibility: "everything" })).status, 403);
  // Choosing a level first does not disturb the snack allowance that shares the row, and the other way round.
  await api.call("ann", "PUT", "/me/snack-allowance", { snackAllowancePct: 30 });
  assert.equal((await api.call("ann", "GET", "/me/visibility")).body.visibility, "totals");
  await setLevel(api, "ben", "everything");
  assert.equal((await api.call("ben", "GET", "/me/snack-allowance")).body.snackAllowancePct, 10);
  // A watch (device token) can read and change its owner's own setting like any own-data route.
  assert.equal((await api.callDevice("ann", "GET", "/me/visibility")).body.visibility, "totals");
});

test("the data layer: sharersFor lists only the OTHER logins at or above the level asked for", async (t) => {
  const api = await newApi(t);
  const { db, ids } = api.w;
  assert.deepEqual(sharersFor(db, ids.ann).map((s) => s.tracker.id), []);
  setVisibility(db, api.w.ben, { visibility: "totals" });
  assert.deepEqual(sharersFor(db, ids.ann, "totals").map((s) => [s.tracker.id, s.level]), [[ids.ben, "totals"]]);
  assert.deepEqual(sharersFor(db, ids.ann, "everything").map((s) => s.tracker.id), []);
  assert.deepEqual(sharersFor(db, ids.ben, "totals").map((s) => s.tracker.id), [], "you are never in your own list");
  setVisibility(db, api.w.ben, { visibility: "everything" });
  assert.equal(visibilityOf(db, ids.ben), "everything");
  assert.deepEqual(sharersFor(db, ids.ann, "everything").map((s) => s.tracker.id), [ids.ben]);
  assert.throws(() => setVisibility(db, { ...api.w.ann, role: "kiosk" } as any, { visibility: "totals" }), /Food diaries are for admin and parent/);
});

// ---- GET /household/streaks -------------------------------------------------------------------------

for (const level of LEVELS) {
  test(`streaks at level "${level}": Ben sees Ann's streak only from "totals" up; he always sees his own`, async (t) => {
    const api = await newApi(t);
    await household(api);
    await setLevel(api, "ann", level);
    const r = await api.call("ben", "GET", "/household/streaks");
    assert.equal(r.status, 200);
    const names = r.body.map((m: any) => m.name);
    assert.deepEqual(names, level === "nothing" ? ["Ben"] : ["Ann", "Ben"]);
    assert.equal(r.body.find((m: any) => m.name === "Ben").mine, true);
    if (level !== "nothing") {
      assert.deepEqual(r.body[0], { userId: api.w.ids.ann, name: "Ann", mine: false, current: 1, best: 1, countedToday: false });
    }
    // Ann's own view always has her; and she sees Ben only if Ben shares (he does not).
    assert.deepEqual((await api.call("ann", "GET", "/household/streaks")).body.map((m: any) => m.name), ["Ann"]);
  });
}

// ---- GET /plan/calories -----------------------------------------------------------------------------

for (const level of LEVELS) {
  test(`the week's calorie view at level "${level}": Ben sees Ann's numbers only from "totals" up`, async (t) => {
    const api = await newApi(t);
    await household(api);
    await setLevel(api, "ann", level);
    const r = await api.call("ben", "GET", "/plan/calories?weekStart=2026-03-10");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.people.map((p: any) => [p.name, p.isMe]), level === "nothing" ? [["Ben", true]] : [["Ann", false], ["Ben", true]]);
    if (level !== "nothing") {
      const annDay = r.body.people[0].days.find((d: any) => d.date === TODAY);
      assert.equal(annDay.loggedKcal, 240);
      assert.ok(annDay.calorieBudget > 0);
    }
  });
}

test("the week's calorie view: server-side callers can still ask for everyone, whatever anyone shares", async (t) => {
  const api = await newApi(t);
  await household(api);
  const now = new Date("2026-03-10T15:00:00Z");
  assert.deepEqual(weekCalories(api.w.db, api.w.ids.ann, TODAY, now).people.map((p) => p.name), ["Ann"], "no say-so: only your own");
  assert.deepEqual(weekCalories(api.w.db, api.w.ids.ann, TODAY, now, { everyone: true }).people.map((p) => p.name), ["Ann", "Ben"]);
  assert.deepEqual(weekCalories(api.w.db, api.w.ids.ann, TODAY, now, { shared: new Set([api.w.ids.ben]) }).people.map((p) => p.name), ["Ann", "Ben"]);
});

// ---- GET /sharing ------------------------------------------------------------------------------------

test("who shares with me: only the other diary logins at totals or everything, with their level", async (t) => {
  const api = await newApi(t);
  assert.deepEqual((await api.call("ben", "GET", "/sharing")).body, []);
  await setLevel(api, "ann", "totals");
  assert.deepEqual((await api.call("ben", "GET", "/sharing")).body, [{ userId: api.w.ids.ann, name: "Ann", level: "totals" }]);
  await setLevel(api, "ann", "everything");
  assert.equal((await api.call("ben", "GET", "/sharing")).body[0].level, "everything");
  assert.deepEqual((await api.call("ann", "GET", "/sharing")).body, [], "Ann's own list does not hold herself, or Ben who shares nothing");
  assert.equal((await api.call("kiosk", "GET", "/sharing")).status, 403);
  assert.deepEqual((await api.callDevice("ben", "GET", "/sharing")).body, [], "a watch is shown nobody");
});

// ---- GET /people/:userId/day/:date -------------------------------------------------------------------

test("view a person's day at each level: nothing = refused, totals = the top-card numbers and the streak, everything = entries and exercise too", async (t) => {
  const api = await newApi(t);
  const seeded = await household(api);
  const url = `/people/${api.w.ids.ann}/day/${TODAY}`;

  await setLevel(api, "ann", "nothing");
  const refused = await api.call("ben", "GET", url);
  assert.deepEqual([refused.status, refused.body.error], [403, "Ann doesn't share that with you."]);
  assert.equal(JSON.stringify(refused.body).includes("Brownie"), false);

  await setLevel(api, "ann", "totals");
  const totals = await api.call("ben", "GET", url);
  assert.equal(totals.status, 200);
  assert.deepEqual(Object.keys(totals.body).sort(), ["date", "person", "streak", "summary", "today"]);
  assert.deepEqual(Object.keys(totals.body.summary).sort(), ["calorieBudget", "date", "eaten", "exercise", "remaining"]);
  assert.deepEqual([totals.body.person.name, totals.body.person.level, totals.body.today], ["Ann", "totals", TODAY]);
  assert.equal(totals.body.summary.eaten, 240);
  assert.equal(totals.body.summary.exercise, 300);
  assert.equal(totals.body.summary.remaining, totals.body.summary.calorieBudget - 240 + 300);
  assert.deepEqual(totals.body.streak, { current: 1, best: 1, countedToday: false });
  const flat = JSON.stringify(totals.body);
  for (const secret of ["Brownie", "Secret Run", seeded.logged.id, seeded.planned.id, "protein", "dinner", "breakfast"]) {
    assert.equal(flat.includes(secret), false, `totals leaked ${secret}`);
  }
  // Totals cannot ask for the weigh-ins, however the request is dressed.
  assert.equal((await api.call("ben", "GET", `/people/${api.w.ids.ann}/progress`)).status, 403);

  await setLevel(api, "ann", "everything");
  const full = await api.call("ben", "GET", url);
  assert.equal(full.status, 200);
  assert.equal(full.body.person.level, "everything");
  const breakfast = full.body.slots.find((s: any) => s.key === "breakfast");
  assert.deepEqual(breakfast.entries.map((e: any) => [e.name, e.status, e.nutrients.kcal]), [["Secret Brownie", "logged", 240]]);
  assert.equal(breakfast.kcal, 240);
  const dinner = full.body.slots.find((s: any) => s.key === "dinner");
  assert.deepEqual(dinner.entries.map((e: any) => e.status), ["planned"], "planned entries show as planned");
  assert.deepEqual(full.body.exercise, [{ name: "Secret Run", kcal: 300, minutes: 30, excludeFromBudget: false }]);
  assert.deepEqual(Object.keys(full.body.summary.macros), ["protein", "carbs", "fat"]);
  assert.equal(full.body.summary.macros.protein.goal, null, "macro goals are settings and stay Ann's");
  // No ids of foods or rows, no relog amounts, no meal targets: read-only means nothing to act on.
  const fullFlat = JSON.stringify(full.body);
  for (const hidden of ["foodId", "relog", "targetKcal", "targetPct", "groupId", "mealPlanId", seeded.run.id]) {
    assert.equal(fullFlat.includes(hidden), false, `everything leaked ${hidden}`);
  }
  // "today" means the OWNER's today: Ben's is 2026-03-11 (Auckland), Ann's is 2026-03-10 (New York).
  assert.equal((await api.call("ben", "GET", `/people/${api.w.ids.ann}/day/today`)).body.date, TODAY);
  await setLevel(api, "ben", "totals");
  assert.equal((await api.call("ann", "GET", `/people/${api.w.ids.ben}/day/today`)).body.date, "2026-03-11");
  // Another day, in Ann's own calendar.
  const yesterday = await api.call("ben", "GET", `/people/${api.w.ids.ann}/day/${YESTERDAY}`);
  assert.equal(yesterday.body.summary.eaten, 480);
  assert.equal(yesterday.body.streak.countedToday, false);
});

test("view a person's day: yourself, strangers, the kiosk login, bad dates, a watch", async (t) => {
  const api = await newApi(t);
  await household(api);
  await setLevel(api, "ann", "everything");
  await setLevel(api, "ben", "everything");
  const day = (id: string, date = TODAY) => `/people/${id}/day/${date}`;
  assert.equal((await api.call("ann", "GET", day(api.w.ids.ann))).status, 400, "yourself: use your own diary");
  assert.equal((await api.call("ann", "GET", day("no-such-user"))).status, 404);
  assert.equal((await api.call("ann", "GET", day(api.w.ids.kiosk))).status, 404, "the kiosk login is not a person with a diary");
  assert.equal((await api.call("ann", "GET", day(api.w.ids.ben, "2026-02-30"))).status, 400);
  assert.equal((await api.call("ann", "GET", day(api.w.ids.ben, "yesterday"))).status, 400);
  assert.equal((await api.call("ann", "GET", day(api.w.ids.ben, "2026-03-11"))).status, 200);
  const watch = await api.callDevice("ann", "GET", day(api.w.ids.ben, "2026-03-11"));
  assert.equal(watch.status, 403, "a watch never views another person");
  assert.equal((await api.callDevice("ann", "GET", `/people/${api.w.ids.ben}/progress`)).status, 403);
});

test("view a person's progress: only at everything -- weigh-ins with their trend, and steps; no goal, no photos", async (t) => {
  const api = await newApi(t);
  await household(api);
  await api.call("ann", "POST", "/me/goals", { planLbPerWeek: 1, activityLevel: "light", macroProtein: 20, macroCarbs: 50, macroFat: 30, goalWeightKg: 60 });
  await api.call("ann", "POST", "/photos", { data: PNG_1X1_BASE64 });
  const url = `/people/${api.w.ids.ann}/progress`;
  for (const level of ["nothing", "totals"] as Level[]) {
    await setLevel(api, "ann", level);
    const r = await api.call("ben", "GET", url);
    assert.equal(r.status, 403, level);
    assert.equal(JSON.stringify(r.body).includes("8123"), false);
  }
  await setLevel(api, "ann", "everything");
  const r = await api.call("ben", "GET", url);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.weights, [{ date: "2026-03-01", weightKg: 66 }, { date: TODAY, weightKg: 65 }]);
  assert.deepEqual(r.body.steps, [{ date: YESTERDAY, steps: 8123 }]);
  assert.equal(r.body.trend.points.length, 2);
  assert.deepEqual(Object.keys(r.body.trend).sort(), ["points", "trendKg"], "the goal weight, weekly plan and goal date are settings, not weigh-ins");
  const flat = JSON.stringify(r.body).toLowerCase();
  for (const hidden of ["goalkg", "photo", "planlbperweek", "projection"]) assert.equal(flat.includes(hidden), false, hidden);
  assert.equal((await api.call("ben", "GET", `${url}?from=2026-03-05`)).body.weights.length, 1, "from= narrows the range");
  assert.equal((await api.call("ben", "GET", `${url}?from=nope`)).status, 400);
});

// ---- read-only: nothing is ever written to the owner's rows ---------------------------------------------

test("looking at someone's data writes nothing to their rows (no frozen day, no default meals) and no write route reaches them", async (t) => {
  const api = await newApi(t);
  const seeded = await household(api);
  await setLevel(api, "ann", "everything");
  const tables = all<{ name: string }>(api.w.db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'nutrition_%' AND name NOT LIKE '%fts%' ORDER BY name").map((r) => r.name);
  const snapshot = () => Object.fromEntries(tables.map((tb) => {
    try { return [tb, JSON.stringify(all(api.w.db, `SELECT * FROM ${tb}`))]; } catch { return [tb, ""]; }
  }));
  const before = snapshot();
  // A past day nobody has opened yet: Ann's own opening would freeze its calorie budget; Ben's look must not.
  for (const date of [TODAY, YESTERDAY, "2026-02-20", "2026-03-30"]) {
    assert.equal((await api.call("ben", "GET", `/people/${api.w.ids.ann}/day/${date}`)).status, 200, date);
  }
  assert.equal((await api.call("ben", "GET", `/people/${api.w.ids.ann}/progress`)).status, 200);
  assert.equal((await api.call("ben", "GET", "/household/streaks")).status, 200);
  assert.equal((await api.call("ben", "GET", "/plan/calories")).status, 200);
  assert.equal((await api.call("ben", "GET", "/sharing")).status, 200);
  assert.deepEqual(snapshot(), before, "no table changed");

  // And the write routes only ever act on the caller's own rows: Ann's ids are 404 to Ben, and nothing moves.
  const mine = snapshot();
  for (const [method, url, body] of [
    ["PATCH", `/diary/entry/${seeded.logged.id}`, { quantity: 9 }], ["DELETE", `/diary/entry/${seeded.planned.id}`],
    ["PATCH", `/exercise/${seeded.run.id}`, { kcal: 1 }], ["DELETE", `/exercise/${seeded.run.id}`],
    ["DELETE", `/weights/${seeded.weight.id}`],
  ] as Array<[string, string, unknown?]>) {
    const r = await api.call("ben", method, url, body);
    assert.equal(r.status, 404, `${method} ${url}`);
  }
  assert.equal((await api.call("ben", "DELETE", `/steps/${YESTERDAY}`)).status, 404, "Ben has no steps that day; Ann's are not his to delete");
  assert.equal((await api.call("ben", "PUT", `/steps/${YESTERDAY}`, { steps: 1 })).status, 200, "this writes BEN's row");
  assert.equal((await api.call("ann", "GET", `/steps?from=${YESTERDAY}&to=${YESTERDAY}`)).body[0].steps, 8123, "Ann's steps are untouched");
  void mine;
  // There is no route that takes another login's id on a write: these do not exist.
  for (const [method, url] of [
    ["PUT", `/people/${api.w.ids.ann}/day/${TODAY}`], ["POST", `/people/${api.w.ids.ann}/day/${TODAY}`], ["DELETE", `/people/${api.w.ids.ann}/day/${TODAY}`],
    ["POST", `/people/${api.w.ids.ann}/progress`], ["PUT", `/me/visibility/${api.w.ids.ann}`],
  ] as Array<[string, string]>) {
    const r = await api.call("ben", method, url, {});
    assert.equal(r.status, 404, `${method} ${url}`);
  }
  assert.equal(visibilityOf(api.w.db, api.w.ids.ann), "everything", "Ben changed nothing of Ann's setting");
});

// ---- the food-diary PIN -----------------------------------------------------------------------------------

test("an owner who locks their diary behind the PIN locks it for the viewer too: 423 until the viewer's session is unlocked", async (t) => {
  const api = await newApi(t);
  await household(api);
  await setLevel(api, "ann", "everything");
  const annId = api.w.ids.ann;
  const day = `/people/${annId}/day/${TODAY}`;

  // The household PIN is set and Ann requires it for her diary; Ben does not (his own routes stay open).
  setConfig("lock_pin_hash", "x-not-checked-here");
  setConfig(`nutrition_require_pin:${annId}`, true);
  t.after(() => { setConfig("lock_pin_hash", null); setConfig(`nutrition_require_pin:${annId}`, false); });

  assert.equal((await api.call("ben", "GET", "/me/streak")).status, 200, "Ben's own diary is not locked");
  const locked = await api.call("ben", "GET", day);
  assert.deepEqual([locked.status, locked.body], [423, { error: "locked" }]);
  assert.equal((await api.call("ben", "GET", `/people/${annId}/progress`)).status, 423);
  assert.deepEqual((await api.call("ben", "GET", "/household/streaks")).body.map((m: any) => m.name), ["Ben"], "aggregates leave a locked diary out");
  assert.deepEqual((await api.call("ben", "GET", "/plan/calories")).body.people.map((p: any) => p.name), ["Ben"]);
  assert.equal((await api.call("ben", "GET", "/sharing")).body.length, 1, "the switcher still lists Ann; opening her asks for the PIN");

  api.sessions.ben.unlockedUntil = Date.now() + 60_000;
  assert.equal((await api.call("ben", "GET", day)).status, 200);
  assert.equal((await api.call("ben", "GET", `/people/${annId}/progress`)).status, 200);
  assert.deepEqual((await api.call("ben", "GET", "/household/streaks")).body.map((m: any) => m.name), ["Ann", "Ben"]);
  assert.deepEqual((await api.call("ben", "GET", "/plan/calories")).body.people.map((p: any) => p.name), ["Ann", "Ben"]);

  // A level that shares nothing is still a 403 first: the lock never reveals that a diary exists or is shared.
  api.sessions.ann.unlockedUntil = Date.now() + 60_000; // Ann's own routes are PIN-gated too
  await setLevel(api, "ann", "nothing");
  api.sessions.ben.unlockedUntil = 0;
  assert.equal((await api.call("ben", "GET", day)).status, 403);
});

// ---- the kiosk and watches ---------------------------------------------------------------------------------

test("the kiosk gets nothing from any of the new routes, whatever anyone shares", async (t) => {
  const api = await newApi(t);
  await household(api);
  await setLevel(api, "ann", "everything");
  await setLevel(api, "ben", "everything");
  api.kioskSetting.value = "plan_and_quick_log";
  for (const [method, url, body] of [
    ["GET", "/me/visibility"], ["PUT", "/me/visibility", { visibility: "everything" }], ["GET", "/sharing"],
    ["GET", `/people/${api.w.ids.ann}/day/${TODAY}`], ["GET", `/people/${api.w.ids.ben}/progress`], ["GET", "/household/streaks"], ["GET", "/plan/calories"],
    ["GET", "/steps"], ["PUT", `/steps/${TODAY}`, { steps: 5 }], ["DELETE", `/steps/${TODAY}`],
  ] as Array<[string, string, unknown?]>) {
    const r = await api.call("kiosk", method, url, body);
    assert.equal(r.status, 403, `${method} ${url}`);
    const flat = JSON.stringify(r.body);
    for (const secret of ["Brownie", "8123", "240", "Soup"]) assert.equal(flat.includes(secret), false, `${method} ${url} leaked ${secret}`);
  }
  // The kiosk board is unchanged: names and PLANNED entries only, never totals, logged food or anyone's numbers.
  const board = await api.call("kiosk", "GET", "/kiosk/today");
  assert.equal(board.status, 200);
  const flat = JSON.stringify(board.body);
  for (const absent of ["calorieBudget", "eaten", "remaining", "streak", "weightKg", "steps"]) assert.equal(flat.includes(absent), false, absent);
});
