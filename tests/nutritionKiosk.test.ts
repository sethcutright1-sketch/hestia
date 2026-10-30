// The kiosk (fridge) login and nutrition (merge plan decision 10): the admin setting
// nutrition_kiosk_access, who may read and change it, what the kiosk is refused, and the two
// routes it may use. Clock 2026-03-10 15:00Z: ann's (New York) today is 2026-03-10, ben's (Auckland)
// is 2026-03-11.

import { test, after } from "node:test";
import assert from "node:assert/strict";

import { cleanupDb } from "./helpers/testdb.ts";
import { newApi, type Api } from "./helpers/nutritionApi.ts";
import { TODAY, customFood } from "./helpers/nutritionWorld.ts";
import { get, run } from "../nutrition/data/sql.ts";

after(cleanupDb);

const BEN_TODAY = "2026-03-11";

/** Entries the household meal plan made carry source = 'plan' (mealPlanSync.ts); the kiosk only handles those. */
function asPlanEntry(api: Api, id: string): string {
  run(api.w.db, "UPDATE nutrition_diary_entries SET source = 'plan' WHERE id = ?", id);
  return id;
}

/**
 * Ann and Ben each with one planned MEAL-PLAN entry for their own today, one logged, one meal-plan entry for
 * tomorrow, and Ann's privately planned snack (planned in her own diary, not from the household plan), which
 * the kiosk must never see or log (phase 5b review: the kiosk reaches the meal plan, never anyone's diary).
 */
async function household(api: Api) {
  const sandwich = (await api.call("ann", "POST", "/foods", customFood("Sandwich", 400))).body;
  const soup = (await api.call("ben", "POST", "/foods", customFood("Soup", 250))).body;
  await api.call("ann", "POST", "/weights", { weightKg: 65 });
  const entry = async (who: "ann" | "ben", date: string, foodId: string, status: string, slot = "lunch") =>
    (await api.call(who, "POST", `/diary/${date}`, { slot, foodId, status })).body.entry.id as string;
  const fromPlan = (id: string) => asPlanEntry(api, id);
  return {
    annPlanned: fromPlan(await entry("ann", TODAY, sandwich.id, "planned")),
    annPrivate: await entry("ann", TODAY, sandwich.id, "planned", "snacks"),
    annLogged: await entry("ann", TODAY, sandwich.id, "logged", "breakfast"),
    annTomorrow: fromPlan(await entry("ann", "2026-03-11", sandwich.id, "planned")),
    benPlanned: fromPlan(await entry("ben", BEN_TODAY, soup.id, "planned", "dinner")),
  };
}

const setting = (api: Api, who: "ann" | "ben" | "kiosk" = "ann") => api.call(who, "GET", "/settings/kiosk");
const choose = (api: Api, value: string, who: "ann" | "ben" | "kiosk" = "ann") => api.call(who, "PUT", "/settings/kiosk", { kioskAccess: value });

test("the setting: defaults to hidden, any signed-in non-kiosk login can read it, only an admin can change it, and it validates", async (t) => {
  const api = await newApi(t);
  const initial = await setting(api);
  assert.deepEqual([initial.status, initial.body.kioskAccess, initial.body.options], [200, "hidden", ["hidden", "plan_only", "plan_and_quick_log"]]);
  assert.equal((await setting(api, "ben")).body.kioskAccess, "hidden", "a parent may read it");
  assert.equal((await setting(api, "kiosk")).status, 403, "the kiosk may not even read the setting");

  assert.equal((await choose(api, "plan_only", "ben")).status, 403, "a parent may not change it");
  assert.equal((await choose(api, "plan_only", "kiosk")).status, 403);
  assert.equal((await setting(api)).body.kioskAccess, "hidden", "refused writes changed nothing");

  assert.equal((await choose(api, "plan_only")).body.kioskAccess, "plan_only");
  assert.equal((await setting(api, "ben")).body.kioskAccess, "plan_only");
  assert.equal((await choose(api, "plan_and_quick_log")).body.kioskAccess, "plan_and_quick_log");
  for (const bad of ["everything", "", "PLAN_ONLY", 3, null]) {
    assert.equal((await choose(api, bad as any)).status, 400, String(bad));
  }
  assert.equal((await api.call("ann", "PUT", "/settings/kiosk", {})).status, 400);
  assert.equal((await setting(api)).body.kioskAccess, "plan_and_quick_log");

  // A stored value nobody recognises (a hand-edited config) is the safe default.
  api.kioskSetting.value = "show-everything";
  assert.equal((await setting(api)).body.kioskAccess, "hidden");
});

test("the kiosk gets 403 on every nutrition route, whatever the setting, except its own three", async (t) => {
  const api = await newApi(t);
  const everything: Array<[string, string, unknown?]> = [
    ["GET", "/me/profile"], ["PUT", "/me/profile", { heightCm: 170 }], ["GET", "/me/weight-start"], ["PUT", "/me/weight-start", { weightStartDate: "2026-01-03" }], ["GET", "/weights/trend?range=all"], ["GET", "/me/goals"], ["POST", "/me/goals/preview", {}],
    ["GET", "/me/slots"], ["GET", "/me/streak"], ["GET", "/household/streaks"],
    ["GET", "/foods/search?q=a"], ["GET", "/foods/recent"], ["POST", "/foods", customFood("x", 1)], ["GET", "/foods/barcodes"], ["GET", "/foods/someid"],
    ["POST", "/barcodes/lookup", { code: "016000275287" }], ["GET", "/barcodes/misses"],
    ["GET", `/diary/${TODAY}`], ["POST", `/diary/${TODAY}`, { slot: "lunch", kcal: 1 }], ["POST", `/diary/${TODAY}/bulk`, {}], ["PATCH", "/diary/entry/x", {}], ["DELETE", "/diary/entry/x"],
    ["GET", `/days/${TODAY}`], ["POST", `/days/${TODAY}/done`], ["GET", "/meals/previous"],
    ["GET", "/weights"], ["POST", "/weights", { weightKg: 70 }], ["GET", "/weights/trend"], ["GET", "/exercise"], ["GET", "/exercise/recent"], ["PATCH", "/exercise/x", {}],
    ["GET", "/saved-meals"], ["POST", "/saved-meals/x/log", {}],
    ["GET", "/settings/kiosk"], ["PUT", "/settings/kiosk", { kioskAccess: "plan_and_quick_log" }],
    ["GET", "/kiosk/today/extra"], ["GET", "/kiosk/log"], ["POST", "/kiosk/today", {}], ["GET", "/nope"],
    ["GET", "/kiosk/day"], ["GET", "/kiosk/day/2026-03-10/extra"], ["POST", "/kiosk/day/2026-03-10", {}], ["PUT", "/kiosk/day/2026-03-10", {}],
    ["GET", "/recipes"], ["GET", "/recipes/x"], ["PUT", "/recipes/x", {}], ["POST", "/recipes/x/calculate", {}], ["POST", "/recipes/x/links", {}],
    ["GET", "/settings/pin"], ["PUT", "/settings/pin", { requirePin: true }],
  ];
  for (const value of ["hidden", "plan_only", "plan_and_quick_log"]) {
    api.kioskSetting.value = value;
    for (const [method, url, body] of everything) {
      const r = await api.call("kiosk", method, url, body);
      assert.equal(r.status, 403, `[${value}] ${method} ${url}`);
    }
  }
  assert.equal(get<{ n: number }>(api.w.db, "SELECT COUNT(*) AS n FROM nutrition_foods")!.n, 0, "none of those wrote anything");
  assert.equal(api.kioskSetting.value, "plan_and_quick_log", "and the kiosk could not change the setting");
});

test("kiosk/today: 403 when hidden; otherwise each person's name and today's PLANNED entries, and nothing else", async (t) => {
  const api = await newApi(t);
  const ids = await household(api);

  const hidden = await api.call("kiosk", "GET", "/kiosk/today");
  assert.deepEqual([hidden.status, hidden.body.error], [403, "Nutrition isn't shown on the kiosk."]);

  for (const value of ["plan_only", "plan_and_quick_log"]) {
    api.kioskSetting.value = value;
    const r = await api.call("kiosk", "GET", "/kiosk/today");
    assert.equal(r.status, 200, value);
    assert.equal(r.body.canQuickLog, value === "plan_and_quick_log");
    assert.deepEqual(r.body.people.map((p: any) => [p.name, p.date, p.planned.map((e: any) => [e.id, e.name, e.kcal, e.slotLabel])]), [
      ["Ann", TODAY, [[ids.annPlanned, "Sandwich", 400, "Lunch"]]],
      ["Ben", BEN_TODAY, [[ids.benPlanned, "Soup", 250, "Dinner"]]],
    ], "own timezone's today; planned only (not Ann's logged breakfast or tomorrow's plan)");
    // The least that identifies the entry -- no health detail anywhere in the answer.
    const keys = new Set<string>();
    JSON.stringify(r.body, (k, v) => { keys.add(k); return v; });
    for (const forbidden of ["calorieBudget", "weightKg", "protein", "carbs", "fat", "eaten", "remaining", "nutrients", "maintenance", "sex", "birthDate", "heightCm", "macros", "eaten"]) {
      assert.ok(!keys.has(forbidden), forbidden);
    }
    assert.deepEqual(Object.keys(r.body.people[0]).sort(), ["date", "name", "planned", "userId"]);
    assert.deepEqual(Object.keys(r.body.people[0].planned[0]).sort(), ["id", "kcal", "mealId", "name", "slotKey", "slotLabel"]);
  }

  // Logged and deleted entries drop off the board; a person with nothing planned is still listed.
  await api.call("ann", "PATCH", `/diary/entry/${ids.annPlanned}`, { status: "logged" });
  await api.call("ben", "DELETE", `/diary/entry/${ids.benPlanned}`);
  const after = (await api.call("kiosk", "GET", "/kiosk/today")).body;
  assert.deepEqual(after.people.map((p: any) => [p.name, p.planned.length]), [["Ann", 0], ["Ben", 0]]);
});

test("real logins cannot use the kiosk routes", async (t) => {
  const api = await newApi(t);
  api.kioskSetting.value = "plan_and_quick_log";
  for (const who of ["ann", "ben"] as const) {
    assert.equal((await api.call(who, "GET", "/kiosk/today")).status, 403);
    assert.equal((await api.call(who, "POST", "/kiosk/log", { userId: api.w.ids.ann, entryIds: ["x"] })).status, 403);
    // Express matches routes case-insensitively and ignores a trailing slash; the gate must too.
    assert.equal((await api.call(who, "GET", "/Kiosk/Today")).status, 403);
    assert.equal((await api.call(who, "GET", `/KIOSK/Day/${TODAY}/`)).status, 403);
    assert.equal((await api.call(who, "GET", `/kiosk/day/${TODAY}`)).status, 403);
    assert.equal((await api.call(who, "POST", "/KIOSK/log/", { userId: api.w.ids.ann, entryIds: ["x"] })).status, 403);
  }
});

test("kiosk/log: only with plan_and_quick_log, only planned entries of that person, all or nothing", async (t) => {
  const api = await newApi(t);
  const ids = await household(api);
  const log = (userId: unknown, entryIds: unknown) => api.call("kiosk", "POST", "/kiosk/log", { userId, entryIds });
  const status = (id: string) => get<{ status: string }>(api.w.db, "SELECT status FROM nutrition_diary_entries WHERE id = ?", id)!.status;

  for (const value of ["hidden", "plan_only"]) {
    api.kioskSetting.value = value;
    assert.equal((await log(api.w.ids.ann, [ids.annPlanned])).status, 403, value);
    assert.equal(status(ids.annPlanned), "planned");
  }

  api.kioskSetting.value = "plan_and_quick_log";
  // Refused, with nothing written: already logged, another person's, deleted, unknown. (Another DAY is fine: see the next test.)
  const deleted = (await api.call("ann", "POST", `/diary/${TODAY}`, { slot: "snacks", kcal: 10, status: "planned" })).body.entry.id;
  await api.call("ann", "DELETE", `/diary/entry/${deleted}`);
  for (const bad of [ids.annLogged, ids.benPlanned, deleted, "no-such-entry"]) {
    const r = await log(api.w.ids.ann, [ids.annPlanned, bad]);
    assert.equal(r.status, 409, bad);
    assert.deepEqual(r.body.rejected, [bad]);
    assert.equal(status(ids.annPlanned), "planned", "the good id in the same request was not logged either");
  }
  assert.equal(status(ids.benPlanned), "planned");
  assert.equal(status(ids.annTomorrow), "planned");

  // Input checks.
  assert.equal((await log(api.w.ids.ann, [])).status, 400);
  assert.equal((await log(api.w.ids.ann, "x")).status, 400);
  assert.equal((await log(api.w.ids.ann, [1])).status, 400);
  assert.equal((await log(api.w.ids.ann, Array.from({ length: 51 }, (_, i) => `id-${i}`))).status, 400);
  assert.equal((await log("nobody", [ids.annPlanned])).status, 404);
  assert.equal((await log(api.w.ids.kiosk, [ids.annPlanned])).status, 404, "the kiosk is not a person with a diary, and the answer doesn't say so");
  assert.equal((await log(undefined, [ids.annPlanned])).status, 404);

  // The good case: Ann's planned entry becomes logged, counts in her day, and only that changed.
  const before = get<{ n: number }>(api.w.db, "SELECT COUNT(*) AS n FROM nutrition_diary_entries")!.n;
  const ok = await log(api.w.ids.ann, [ids.annPlanned, ids.annPlanned]);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.logged, [ids.annPlanned]);
  assert.equal(ok.body.people.find((p: any) => p.name === "Ann").planned.length, 0);
  assert.equal(JSON.stringify(ok.body).includes("calorieBudget"), false, "no health detail comes back");
  assert.equal(status(ids.annPlanned), "logged");
  assert.equal(status(ids.annTomorrow), "planned");
  assert.equal(status(ids.benPlanned), "planned");
  assert.equal(get<{ n: number }>(api.w.db, "SELECT COUNT(*) AS n FROM nutrition_diary_entries")!.n, before, "it never creates entries");
  const day = (await api.call("ann", "GET", `/days/${TODAY}`)).body;
  assert.equal(day.eaten, 800, "Ann's own day now counts the sandwich she ate");
  assert.equal(day.plannedCount, 1, "only her private snack is still planned: the kiosk never touched it");
  assert.equal(status(ids.annPrivate), "planned");

  // A privately planned entry (not from the household meal plan) is diary data: never on the board, never loggable from the kiosk.
  assert.equal(ok.body.people.find((p: any) => p.name === "Ann").planned.some((e: any) => e.id === ids.annPrivate), false);
  assert.equal((await log(api.w.ids.ann, [ids.annPrivate])).status, 409);
  assert.equal(status(ids.annPrivate), "planned");

  // Already logged now: a second tap is refused rather than silently repeated.
  assert.equal((await log(api.w.ids.ann, [ids.annPlanned])).status, 409);

  // Ben's, in his own timezone's today.
  assert.equal((await log(api.w.ids.ben, [ids.benPlanned])).status, 200);
  assert.equal(status(ids.benPlanned), "logged");
});

test("the setting changes behaviour immediately, in both directions", async (t) => {
  const api = await newApi(t);
  const ids = await household(api);
  assert.equal((await api.call("kiosk", "GET", "/kiosk/today")).status, 403);
  await choose(api, "plan_and_quick_log");
  assert.equal((await api.call("kiosk", "GET", "/kiosk/today")).status, 200);
  assert.equal((await api.call("kiosk", "POST", "/kiosk/log", { userId: api.w.ids.ann, entryIds: [ids.annPlanned] })).status, 200);
  await choose(api, "plan_only");
  assert.equal((await api.call("kiosk", "GET", "/kiosk/today")).status, 200);
  assert.equal((await api.call("kiosk", "POST", "/kiosk/log", { userId: api.w.ids.ben, entryIds: [ids.benPlanned] })).status, 403);
  await choose(api, "hidden");
  assert.equal((await api.call("kiosk", "GET", "/kiosk/today")).status, 403);
});

test("kiosk/day/:date shows the same minimal board for another day; today stays each person's own today", async (t) => {
  const api = await newApi(t);
  const ids = await household(api);
  const day = (date: string, who: "kiosk" | "ann" = "kiosk") => api.call(who, "GET", `/kiosk/day/${date}`);

  // Phase 5c: each planned entry names the plan meal it came from, so the kiosk screen can put "Log for: Ann" on the right meal.
  run(api.w.db, "UPDATE nutrition_diary_entries SET meal_plan_id = 'meal-xyz' WHERE id = ?", ids.annPlanned);
  api.kioskSetting.value = "plan_only";
  const withMeal = (await api.call("kiosk", "GET", "/kiosk/today")).body.people;
  assert.deepEqual(withMeal.map((p: any) => p.planned.map((e: any) => e.mealId)), [["meal-xyz"], [null]], "null for an entry no plan meal made");
  api.kioskSetting.value = "hidden";

  assert.equal((await day("2026-03-11")).status, 403, "hidden: nothing, for any day");
  api.kioskSetting.value = "plan_only";
  const tomorrow = await day("2026-03-11");
  assert.equal(tomorrow.status, 200);
  assert.deepEqual(tomorrow.body.people.map((p: any) => [p.name, p.date, p.planned.map((e: any) => e.id)]), [
    ["Ann", "2026-03-11", [ids.annTomorrow]],
    ["Ben", "2026-03-11", [ids.benPlanned]],
  ], "the same calendar date for everyone (Ben's own today happens to be the 11th)");
  assert.deepEqual(Object.keys(tomorrow.body.people[0].planned[0]).sort(), ["id", "kcal", "mealId", "name", "slotKey", "slotLabel"]);
  // `date` and `meals` are the plan side (phase 4): the day's approved meals, with no calories (nutritionPlanKiosk.test.ts).
  assert.deepEqual(Object.keys(tomorrow.body).sort(), ["canQuickLog", "date", "kioskAccess", "meals", "people"]);
  assert.equal(tomorrow.body.canQuickLog, false);

  // Days with nothing planned still list the people; logged entries are not on any board.
  assert.deepEqual((await day("2026-01-01")).body.people.map((p: any) => [p.name, p.planned.length]), [["Ann", 0], ["Ben", 0]]);
  assert.equal((await day(TODAY)).body.people[0].planned.map((e: any) => e.id).join(), ids.annPlanned, "Ann's logged breakfast is not on it");

  // /kiosk/today is unchanged: each person's own today.
  assert.deepEqual((await api.call("kiosk", "GET", "/kiosk/today")).body.people.map((p: any) => [p.name, p.date]), [["Ann", TODAY], ["Ben", "2026-03-11"]]);

  // Bad dates are refused, not guessed at.
  for (const bad of ["tomorrow", "2026-13-01", "2026-02-30", "20260311"]) assert.equal((await day(bad)).status, 400, bad);
  // Trailing slash and letter case reach the same route.
  assert.equal((await api.call("kiosk", "GET", "/Kiosk/Day/2026-03-11/")).status, 200);
});

test("kiosk/log works on any day's planned entries up to today, never a future one; the answer is the board for the date asked", async (t) => {
  const api = await newApi(t);
  const ids = await household(api);
  api.kioskSetting.value = "plan_and_quick_log";
  const status = (id: string) => get<{ status: string }>(api.w.db, "SELECT status FROM nutrition_diary_entries WHERE id = ?", id)!.status;

  // Two past days for the same person (both only planned, never logged), and one far-off future day.
  const older = asPlanEntry(api, (await api.call("ann", "POST", "/diary/2026-02-20", { slot: "dinner", kcal: 500, name: "Lasagna", status: "planned" })).body.entry.id);
  const past = asPlanEntry(api, (await api.call("ann", "POST", "/diary/2026-03-01", { slot: "lunch", kcal: 300, name: "Soup", status: "planned" })).body.entry.id);
  const future = asPlanEntry(api, (await api.call("ann", "POST", "/diary/2026-04-20", { slot: "dinner", kcal: 700, name: "Roast", status: "planned" })).body.entry.id);

  // User decision 2026-10-15: a planned entry can be logged only on or after its own day, the kiosk included.
  for (const entryIds of [[future], [ids.annTomorrow], [past, ids.annTomorrow]]) {
    const refused = await api.call("kiosk", "POST", "/kiosk/log", { userId: api.w.ids.ann, entryIds });
    assert.deepEqual([refused.status, refused.body.error], [400, "That day hasn't happened yet. Log it on the day."]);
  }
  for (const id of [future, ids.annTomorrow, past]) assert.equal(status(id), "planned", "a refused request writes nothing");
  // Ben's own today is a day ahead of Ann's: his entry on his today (2026-03-11) is fine.
  assert.equal((await api.call("kiosk", "POST", "/kiosk/log", { userId: api.w.ids.ben, entryIds: [ids.benPlanned] })).status, 200);
  assert.equal(status(ids.benPlanned), "logged");

  const r = await api.call("kiosk", "POST", "/kiosk/log", { userId: api.w.ids.ann, entryIds: [older, past], date: "2026-02-20" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.logged.sort(), [older, past].sort());
  assert.deepEqual(r.body.people.map((p: any) => p.date), ["2026-02-20", "2026-02-20"], "the board comes back for the date asked");
  assert.equal(JSON.stringify(r.body).includes("calorieBudget"), false);
  for (const id of [older, past]) assert.equal(status(id), "logged");
  assert.equal(status(ids.annPlanned), "planned", "today's untouched");

  // Each entry keeps its own date and counts in THAT day (and only there).
  assert.equal((await api.call("ann", "GET", "/days/2026-02-20")).body.eaten, 500);
  assert.equal((await api.call("ann", "GET", "/days/2026-03-01")).body.eaten, 300);
  assert.equal((await api.call("ann", "GET", `/days/${TODAY}`)).body.eaten, 400, "just the breakfast she already logged");

  // Without a date the answer is today's board, as before.
  const today = await api.call("kiosk", "POST", "/kiosk/log", { userId: api.w.ids.ann, entryIds: [ids.annPlanned] });
  assert.deepEqual(today.body.people.map((p: any) => p.date), [TODAY, "2026-03-11"]);

  // Still all-or-nothing and still only that person's planned entries, on any day up to today.
  const other = asPlanEntry(api, (await api.call("ben", "POST", "/diary/2026-03-05", { slot: "dinner", kcal: 100, name: "Stew", status: "planned" })).body.entry.id);
  const refused = await api.call("kiosk", "POST", "/kiosk/log", { userId: api.w.ids.ann, entryIds: [other], date: "2026-03-05" });
  assert.equal(refused.status, 409);
  assert.equal(status(other), "planned");
  assert.equal((await api.call("kiosk", "POST", "/kiosk/log", { userId: api.w.ids.ann, entryIds: [older] })).status, 409, "already logged");
  assert.equal((await api.call("kiosk", "POST", "/kiosk/log", { userId: api.w.ids.ben, entryIds: [other], date: "nonsense" })).status, 400);
  assert.equal(status(other), "planned");
  assert.equal((await api.call("kiosk", "POST", "/kiosk/log", { userId: api.w.ids.ben, entryIds: [other], date: "2026-03-05" })).status, 200);
});
