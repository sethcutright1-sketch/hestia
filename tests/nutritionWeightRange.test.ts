// The weight chart's range buttons and "lost so far", on the server: the range table, the trend at a day, the
// /weights/trend and /people/:id/progress routes with `range=`, and the per-login "I started my weight loss on" setting
// (GET/PUT /me/weight-start). Clock 2026-03-10 15:00Z: ann's (New York) today is 2026-03-10, ben's (Auckland) 2026-03-11.
//
// ann's history: 2024-01-10 100 kg, 2025-06-01 90, 2026-01-03 85, 2026-02-10 82, 2026-03-10 80.

import { test, after } from "node:test";
import assert from "node:assert/strict";

import { cleanupDb, loadDb } from "./helpers/testdb.ts";
import { newApi, type Api } from "./helpers/nutritionApi.ts";
import { TODAY } from "./helpers/nutritionWorld.ts";
import { get } from "../nutrition/data/sql.ts";
import { addWeight } from "../nutrition/data/weights.ts";
import { sharedProgress } from "../nutrition/data/sharedView.ts";
import { weightTrendFor, weightTrendForRange } from "../nutrition/data/weightProgress.ts";
import { setWeightStartDate, weightStartDate } from "../nutrition/data/weightStart.ts";
import { DEFAULT_WEIGHT_RANGE, RANGE_DAYS, WEIGHT_RANGES, isWeightRange, rangeStart } from "../nutrition/weightRange.ts";
import { trendAtDate, trendSeries } from "../nutrition/weightTrend.ts";

await loadDb();
after(cleanupDb);

const HISTORY: Array<[string, number]> = [["2024-01-10", 100], ["2025-06-01", 90], ["2026-01-03", 85], ["2026-02-10", 82], [TODAY, 80]];

async function seeded(t: Parameters<typeof newApi>[0]): Promise<Api> {
  const api = await newApi(t);
  for (const [measuredOn, weightKg] of HISTORY) assert.equal((await api.call("ann", "POST", "/weights", { weightKg, measuredOn })).status, 201);
  return api;
}
const trend = (api: Api, who: "ann" | "ben", query: string) => api.call(who, "GET", `/weights/trend${query}`);
const dates = (body: any): string[] => body.points.map((p: any) => p.date);

// ---- the range table ------------------------------------------------------------------------------------

test("ranges: five words, 1y is the default and the old 365 days, All has no start", () => {
  assert.deepEqual([...WEIGHT_RANGES], ["1m", "3m", "6m", "1y", "all"]);
  assert.equal(DEFAULT_WEIGHT_RANGE, "1y");
  assert.deepEqual(RANGE_DAYS, { "1m": 30, "3m": 91, "6m": 182, "1y": 365 });
  assert.deepEqual(WEIGHT_RANGES.map((r) => rangeStart(r, "2026-03-10")), ["2026-02-08", "2025-12-09", "2025-09-09", "2025-03-10", null]);
  assert.equal(isWeightRange("1y"), true);
  for (const bad of ["1Y", "year", "", null, undefined, 3, ["1y"]]) assert.equal(isWeightRange(bad), false, String(bad));
});

test("trendAtDate: the latest weigh-in on or before the day; the first one after it when there is none; null with no weigh-ins", () => {
  const s = trendSeries([{ date: "2026-01-01", kg: 90 }, { date: "2026-01-10", kg: 88 }, { date: "2026-01-20", kg: 86 }]);
  assert.equal(trendAtDate([], "2026-01-05"), null);
  assert.deepEqual(trendAtDate(s, "2026-01-10"), { date: "2026-01-10", trendKg: s[1].trendKg, later: false }, "a weigh-in ON the day counts");
  assert.deepEqual(trendAtDate(s, "2026-01-15"), { date: "2026-01-10", trendKg: s[1].trendKg, later: false }, "between two: the earlier one");
  assert.deepEqual(trendAtDate(s, "2027-01-01"), { date: "2026-01-20", trendKg: s[2].trendKg, later: false }, "after all of them: the last one");
  assert.deepEqual(trendAtDate(s, "2025-06-01"), { date: "2026-01-01", trendKg: 90, later: true }, "before the first: the first one, flagged");
});

// ---- GET /weights/trend?range= ---------------------------------------------------------------------------

test("/weights/trend?range= returns the points of the range, All reaches the whole history, and the trend is the same for every range", async (t) => {
  const api = await seeded(t);
  const by: Record<string, any> = Object.fromEntries(await Promise.all(WEIGHT_RANGES.map(async (r) => [r, (await trend(api, "ann", `?range=${r}`)).body])));
  assert.deepEqual(dates(by["1m"]), ["2026-02-10", TODAY]);
  assert.deepEqual(dates(by["3m"]), ["2026-01-03", "2026-02-10", TODAY]);
  assert.deepEqual(dates(by["6m"]), ["2026-01-03", "2026-02-10", TODAY], "2025-06-01 is 282 days back");
  assert.deepEqual(dates(by["1y"]), ["2025-06-01", "2026-01-03", "2026-02-10", TODAY]);
  assert.deepEqual(dates(by.all), ["2024-01-10", "2025-06-01", "2026-01-03", "2026-02-10", TODAY], "All reaches back past a year");
  assert.deepEqual(WEIGHT_RANGES.map((r) => by[r].range), [...WEIGHT_RANGES]);
  assert.deepEqual(WEIGHT_RANGES.map((r) => by[r].from), ["2026-02-08", "2025-12-09", "2025-09-09", "2025-03-10", null]);

  // The trend is worked out from the whole history whatever the button: one trend weight, one goal date.
  const whole = weightTrendFor(api.w.db, api.w.ann, TODAY, "2000-01-01");
  for (const r of WEIGHT_RANGES) assert.equal(by[r].trendKg, whole.trendKg, r);
  const full = new Map(whole.points.map((p) => [p.date, p]));
  for (const r of WEIGHT_RANGES) for (const p of by[r].points) assert.deepEqual(p, full.get(p.date), `${r} ${p.date}: the same trend value as in the whole history`);
  assert.notEqual(by["1m"].points[0].trendKg, by["1m"].points[0].weightKg, "the first point of a short range is not restarted at its own weight");
});

test("a range with no weigh-ins still has the current trend; the old `from` form is unchanged; bad or doubled parameters are 400", async (t) => {
  const api = await seeded(t);
  api.setNow(new Date("2026-06-30T15:00:00Z")); // 112 days later: the 1m and 3m windows are empty
  const empty = (await trend(api, "ann", "?range=1m")).body;
  assert.deepEqual(empty.points, []);
  assert.equal(typeof empty.trendKg, "number");
  assert.equal(empty.trendKg, (await trend(api, "ann", "?range=all")).body.trendKg);
  assert.deepEqual((await trend(api, "ben", "?range=all")).body.points, []);
  assert.equal((await trend(api, "ben", "?range=all")).body.trendKg, null);

  const legacy = (await trend(api, "ann", "")).body;
  assert.equal("weightStart" in legacy, false, "without range the answer has its old shape");
  assert.equal("range" in legacy, false);
  assert.equal((await trend(api, "ann", "?from=2026-02-01")).body.points.length, 2);

  for (const q of ["?range=2y", "?range=1Y", "?range="]) assert.equal((await trend(api, "ann", q)).status, 400, q);
  assert.equal((await trend(api, "ann", "?range=1y&from=2026-01-01")).status, 400);
  assert.equal(weightTrendForRange(api.w.db, api.w.ann, TODAY, "all").points.length, 5);
  assert.throws(() => weightTrendForRange(api.w.db, api.w.ann, TODAY, "year"), (e: any) => e.status === 400);
});

// ---- lost so far: the start day ----------------------------------------------------------------------------

test("weightStart in the trend answer: the trend on the start day, independent of the range, flagged when it is the first weigh-in after", async (t) => {
  const api = await seeded(t);
  assert.equal((await trend(api, "ann", "?range=1y")).body.weightStart, null, "no start day set: nothing to measure from");

  const series = trendSeries(HISTORY.map(([date, kg]) => ({ date, kg })));
  const at = (date: string) => series.find((p) => p.date === date)!.trendKg;
  const round2 = (n: number) => Math.round(n * 100) / 100;

  assert.equal((await api.call("ann", "PUT", "/me/weight-start", { weightStartDate: "2026-01-03" })).status, 200);
  for (const r of WEIGHT_RANGES) {
    const { weightStart } = (await trend(api, "ann", `?range=${r}`)).body;
    assert.deepEqual(weightStart, { date: "2026-01-03", trendKg: round2(at("2026-01-03")), weighedOn: "2026-01-03", later: false }, `${r}: same whatever the range`);
  }
  // A start day with no weigh-in of its own uses the latest one before it ...
  await api.call("ann", "PUT", "/me/weight-start", { weightStartDate: "2026-01-20" });
  assert.deepEqual((await trend(api, "ann", "?range=1m")).body.weightStart, { date: "2026-01-20", trendKg: round2(at("2026-01-03")), weighedOn: "2026-01-03", later: false });
  // ... and with none before it, the first one after it, and says so.
  await api.call("ann", "PUT", "/me/weight-start", { weightStartDate: "2023-05-01" });
  assert.deepEqual((await trend(api, "ann", "?range=1m")).body.weightStart, { date: "2023-05-01", trendKg: 100, weighedOn: "2024-01-10", later: true });
  // Cleared: back to nothing.
  await api.call("ann", "PUT", "/me/weight-start", { weightStartDate: null });
  assert.equal((await trend(api, "ann", "?range=all")).body.weightStart, null);

  // A start day and no weigh-ins at all: the day, but no trend.
  await api.call("ben", "PUT", "/me/weight-start", { weightStartDate: "2026-03-01" });
  assert.deepEqual((await trend(api, "ben", "?range=1y")).body.weightStart, { date: "2026-03-01", trendKg: null, weighedOn: null, later: false });
});

// ---- GET/PUT /me/weight-start -------------------------------------------------------------------------------

test("the start day: per login, can be cleared, a real date from 2000 up to the person's own today", async (t) => {
  const api = await newApi(t);
  assert.deepEqual((await api.call("ann", "GET", "/me/weight-start")).body, { weightStartDate: null, today: TODAY, earliest: "2000-01-01" });
  assert.deepEqual((await api.call("ann", "PUT", "/me/weight-start", { weightStartDate: "2026-01-03" })).body, { weightStartDate: "2026-01-03", today: TODAY, earliest: "2000-01-01" });
  assert.equal((await api.call("ann", "GET", "/me/weight-start")).body.weightStartDate, "2026-01-03");
  assert.equal((await api.call("ben", "GET", "/me/weight-start")).body.weightStartDate, null, "Ben's is his own");
  assert.equal(weightStartDate(api.w.db, api.w.ids.ann), "2026-01-03");

  for (const clear of [null, ""]) {
    await api.call("ann", "PUT", "/me/weight-start", { weightStartDate: "2026-01-03" });
    assert.equal((await api.call("ann", "PUT", "/me/weight-start", { weightStartDate: clear })).body.weightStartDate, null, `clear with ${JSON.stringify(clear)}`);
    assert.equal(weightStartDate(api.w.db, api.w.ids.ann), null);
  }

  await api.call("ann", "PUT", "/me/weight-start", { weightStartDate: "2026-01-03" });
  const bad: unknown[] = ["2026-02-30", "yesterday", "Jan 3", 20260103, true, [], "1999-12-31", "2026-03-11"];
  for (const value of bad) assert.equal((await api.call("ann", "PUT", "/me/weight-start", { weightStartDate: value })).status, 400, JSON.stringify(value));
  assert.equal((await api.call("ann", "PUT", "/me/weight-start", {})).status, 400, "leaving the field out is not a clear");
  assert.equal((await api.call("ann", "PUT", "/me/weight-start", [])).status, 400);
  assert.equal((await api.call("ann", "GET", "/me/weight-start")).body.weightStartDate, "2026-01-03", "refused writes changed nothing");
  assert.equal((await api.call("ann", "PUT", "/me/weight-start", { weightStartDate: TODAY })).status, 200, "today is allowed");
  assert.equal((await api.call("ann", "PUT", "/me/weight-start", { weightStartDate: "2000-01-01" })).status, 200);
  // Ben is a day ahead (Auckland): 2026-03-11 is his today, and the same day is the future for Ann.
  assert.equal((await api.call("ben", "PUT", "/me/weight-start", { weightStartDate: "2026-03-11" })).status, 200);
  assert.equal((await api.call("ann", "PUT", "/me/weight-start", { weightStartDate: "2026-03-11" })).status, 400);
});

test("the start day shares its row with the snack allowance and the visibility level without disturbing either", async (t) => {
  const api = await newApi(t);
  await api.call("ann", "PUT", "/me/snack-allowance", { snackAllowancePct: 30 });
  await api.call("ann", "PUT", "/me/visibility", { visibility: "totals" });
  await api.call("ann", "PUT", "/me/weight-start", { weightStartDate: "2026-01-03" });
  assert.equal((await api.call("ann", "GET", "/me/snack-allowance")).body.snackAllowancePct, 30);
  assert.equal((await api.call("ann", "GET", "/me/visibility")).body.visibility, "totals");
  await api.call("ann", "PUT", "/me/snack-allowance", { snackAllowancePct: 12 });
  await api.call("ann", "PUT", "/me/visibility", { visibility: "everything" });
  assert.equal((await api.call("ann", "GET", "/me/weight-start")).body.weightStartDate, "2026-01-03", "and the other way round");
  // Clearing before anything was ever saved writes a row of defaults, not an error.
  await api.call("ben", "PUT", "/me/weight-start", { weightStartDate: null });
  assert.deepEqual([(await api.call("ben", "GET", "/me/snack-allowance")).body.snackAllowancePct, (await api.call("ben", "GET", "/me/visibility")).body.visibility], [10, "nothing"]);
});

test("the start day: the kiosk gets 403, a watch reads and changes its owner's own, and the data layer refuses a kiosk", async (t) => {
  const api = await newApi(t);
  assert.equal((await api.call("kiosk", "GET", "/me/weight-start")).status, 403);
  assert.equal((await api.call("kiosk", "PUT", "/me/weight-start", { weightStartDate: "2026-01-03" })).status, 403);
  assert.equal((await api.callDevice("ann", "PUT", "/me/weight-start", { weightStartDate: "2026-01-03" })).body.weightStartDate, "2026-01-03");
  assert.equal((await api.call("ann", "GET", "/me/weight-start")).body.weightStartDate, "2026-01-03");
  assert.equal(get(api.w.db, "SELECT 1 FROM nutrition_user_settings WHERE user_id = ?", api.w.ids.kiosk), undefined);
  assert.throws(() => setWeightStartDate(api.w.db, { id: api.w.ids.kiosk, displayName: "K", role: "kiosk" as never, profile: null }, TODAY, { weightStartDate: null }), (e: any) => e.status === 403);
});

// ---- another person's view: the range works, the start day, goal and plan stay theirs ------------------------------

test("viewing someone's progress: the range buttons work; the payload still has no goal, plan, projection or start day", async (t) => {
  const api = await seeded(t);
  await api.call("ann", "POST", "/me/goals", { planLbPerWeek: 1, activityLevel: "light", macroProtein: 20, macroCarbs: 50, macroFat: 30, goalWeightKg: 70 });
  await api.call("ann", "PUT", "/me/weight-start", { weightStartDate: "2026-01-03" });
  await api.call("ann", "PUT", "/me/visibility", { visibility: "everything" });
  const url = `/people/${api.w.ids.ann}/progress`;
  const own = (await trend(api, "ann", "?range=all")).body;
  assert.equal(own.goalKg, 70, "the owner does have these");
  assert.ok(own.weightStart && own.projection);

  const results: Record<string, any> = {};
  for (const r of WEIGHT_RANGES) {
    const res = await api.call("ben", "GET", `${url}?range=${r}`);
    assert.equal(res.status, 200, r);
    results[r] = res.body;
    assert.deepEqual(Object.keys(res.body).sort(), ["person", "steps", "today", "trend", "weights"], r);
    assert.deepEqual(Object.keys(res.body.trend).sort(), ["points", "trendKg"], `${r}: only the points and the trend weight`);
    const flat = JSON.stringify(res.body).toLowerCase();
    for (const hidden of ["goalkg", "planlbperweek", "projection", "weightstart", "startdate", "weight_start", "later", "photo"]) assert.equal(flat.includes(hidden), false, `${r}: ${hidden}`);
  }
  assert.deepEqual(dates(results["1m"].trend), ["2026-02-10", TODAY]);
  assert.deepEqual(dates(results.all.trend), ["2024-01-10", "2025-06-01", "2026-01-03", "2026-02-10", TODAY]);
  for (const r of WEIGHT_RANGES) assert.equal(results[r].trend.trendKg, own.trendKg, `${r}: the same trend weight as the owner's`);
  assert.equal(results["1m"].weights.length, 4, "the weigh-in list is never shorter than the default year");
  assert.equal(results.all.weights.length, 5, "and All has them all");
  assert.equal(results["1m"].today, TODAY, "their today, for the axis");

  // The old forms still work, and mixing them is refused.
  assert.equal((await api.call("ben", "GET", url)).body.weights.length, 4);
  assert.equal((await api.call("ben", "GET", `${url}?from=2026-02-01`)).body.weights.length, 2);
  assert.equal((await api.call("ben", "GET", `${url}?range=nope`)).status, 400);
  assert.equal((await api.call("ben", "GET", `${url}?range=all&from=2026-02-01`)).status, 400);
  assert.throws(() => sharedProgress(api.w.db, api.w.ann, new Date("2026-03-10T15:00:00Z"), "2026-01-01", "all"), (e: any) => e.status === 400);

  // Not at "totals", whatever the range.
  await api.call("ann", "PUT", "/me/visibility", { visibility: "totals" });
  assert.equal((await api.call("ben", "GET", `${url}?range=all`)).status, 403);
});

test("a new weigh-in moves the trend but not the start day", async (t) => {
  const api = await seeded(t);
  await api.call("ann", "PUT", "/me/weight-start", { weightStartDate: "2026-01-03" });
  const before = (await trend(api, "ann", "?range=1y")).body;
  addWeight(api.w.db, api.w.ann, new Date("2026-03-10T15:00:00Z"), { weightKg: 70, measuredOn: TODAY });
  const after2 = (await trend(api, "ann", "?range=1y")).body;
  assert.ok(after2.trendKg < before.trendKg);
  assert.deepEqual(after2.weightStart, before.weightStart);
});
