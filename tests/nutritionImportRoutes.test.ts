// POST /api/nutrition/import/loseit (+ /dry-run, + /match-calorie-budget): the ZIP as the raw request body, the options in
// the query, one transaction, the signed-in login's OWN diary only. The routes run through the real nutrition router and
// its kiosk / food-diary-PIN gate (routes/nutrition.ts); one test also runs them behind a real HTTP server with the same
// JSON-parser bypass server.ts uses, to prove a ZIP bigger than the app-wide 10 MB JSON limit gets through.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import bcrypt from "bcryptjs";
import express from "express";
import { strToU8, unzipSync, zipSync } from "fflate";

import { cleanupDb, loadDb } from "./helpers/testdb.ts";
import { callRoute } from "./helpers/router.ts";
import { newApi, type Api } from "./helpers/nutritionApi.ts";
import { TODAY, rowCount } from "./helpers/nutritionWorld.ts";
import { dailyValuesCsv, photoName, photosCsv, stepsCsv, token, zipOf, type Parts } from "./helpers/loseitExport.ts";
import { jpegBytes } from "./helpers/images.ts";
import { all, get, run } from "../nutrition/data/sql.ts";

const { setConfig } = await loadDb();
const { lockRoutes } = await import("../routes/lock.ts");
const { createNutritionRoutes } = await import("../routes/nutrition.ts");
const { IMPORT_BODY_LIMIT, isZipImportPath } = await import("../routes/nutrition/import.ts");

after(cleanupDb);

const buf = (parts: Parts) => Buffer.from(zipOf(parts));
const jpeg = jpegBytes(1200, 1600, 4000);

/** A small but complete export: food, a calorie budget day, a weight, exercise, a Done day, steps, a photo, a custom food. */
const sample = (): Parts => ({
  food: [{ date: "1/5/2026", name: "Oatmeal", units: "Cup", kcal: 166 }, { date: "1/6/2026", name: "Toast", kcal: 80 }],
  summary: [{ date: "1/5/2026", food: 166, exercise: 100, budget: 1900 }, { date: "1/6/2026", food: 80, exercise: 0, budget: 1900 }],
  weights: [["1/5/2026", 176.37]],
  exercise: [["1/5/2026", "Walk", -100, 30]],
  extra: {
    "daily-values.csv": dailyValuesCsv([["1/5/2026", 1]]),
    "steps.csv": stepsCsv([["1/5/2026", "8000.4"]]),
    "progress-photos.csv": photosCsv([["6/5/2025", token(1)]]),
    "recipes.csv": "Name,UniqueId\r\nChili,u1\r\n",
  },
  photos: { [photoName("2025-06-05", token(1))]: jpeg },
});

const DRY = "/import/loseit/dry-run";
const REAL = "/import/loseit";
const entryCount = (api: Api, who: "ann" | "ben") => rowCount(api.w.db, `nutrition_diary_entries WHERE user_id = '${api.w.ids[who]}'`);

// ---- the dry run and the import ---------------------------------------------------------------------------------

test("dry run: the ZIP is the raw body, the answer is the full report, and not one row is written", async (t) => {
  const api = await newApi(t);
  const r = await api.call("ann", "POST", DRY, buf(sample()));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.dryRun, true);
  assert.deepEqual([r.body.counts.created, r.body.weights.created, r.body.exercise.created, r.body.doneDays.marked, r.body.steps.created, r.body.photos.created],
    [2, 1, 1, 1, 1, 1]);
  assert.equal(r.body.files.find((f: any) => f.name === "recipes.csv").status, "skipped");
  assert.equal(JSON.stringify(r.body).includes(Buffer.from(jpeg).toString("base64").slice(0, 30)), false, "the report never carries picture bytes");
  for (const table of ["nutrition_diary_entries", "nutrition_foods", "nutrition_weights", "nutrition_exercise", "nutrition_steps", "nutrition_photos"]) {
    assert.equal(rowCount(api.w.db, table), 0, table);
  }
  assert.equal(rowCount(api.w.db, "nutrition_day_logs"), 0);
});

test("import: the same report with dryRun false, into the signed-in login's own diary and nobody else's; a second run adds nothing", async (t) => {
  const api = await newApi(t);
  const dry = await api.call("ann", "POST", DRY, buf(sample()));
  const real = await api.call("ann", "POST", REAL, buf(sample()));
  assert.equal(real.status, 200, JSON.stringify(real.body));
  assert.deepEqual({ ...real.body, dryRun: true }, dry.body, "what the preview said is exactly what happened");
  assert.equal(entryCount(api, "ann"), 2);
  assert.equal(entryCount(api, "ben"), 0);
  assert.equal(rowCount(api.w.db, `nutrition_photos WHERE user_id = '${api.w.ids.ann}'`), 1);
  assert.equal(rowCount(api.w.db, `nutrition_photos WHERE user_id = '${api.w.ids.ben}'`), 0);

  const again = await api.call("ann", "POST", REAL, buf(sample()));
  assert.deepEqual([again.body.counts.created, again.body.weights.created, again.body.exercise.created, again.body.steps.created, again.body.photos.created, again.body.doneDays.marked], [0, 0, 0, 0, 0, 0]);
  assert.equal(entryCount(api, "ann"), 2);

  // The person's screens see it: the day, its exercise, its frozen calorie budget, the weight, the steps.
  const day = await api.call("ann", "GET", "/diary/2026-01-05");
  assert.equal(day.body.summary.calorieBudget, 1900);
  assert.equal(day.body.summary.exercise, 100);
  assert.equal(typeof day.body.summary.doneLoggingAt, "string", "Done logging is set the way POST /days/:date/done sets it");
  assert.deepEqual((await api.call("ann", "GET", "/steps")).body, [{ date: "2026-01-05", steps: 8000, source: "import_loseit" }]);
  assert.equal((await api.call("ann", "GET", "/weights")).body[0].weightKg, 80);
  const streak = await api.call("ann", "GET", "/me/streak");
  assert.equal(streak.status, 200);
  assert.equal(streak.body.best, 2, "the two imported days (one also marked done) count toward the streak");
});

test("options come in the query: onlyMe makes the foods personal, conflict/from/to/weightUnit are passed through, bad values are a 400", async (t) => {
  const api = await newApi(t);
  assert.equal((await api.call("ann", "POST", `${REAL}?onlyMe=1&weightUnit=kg&from=2026-01-06&to=2026-01-31`, buf(sample()))).status, 200);
  const foods = all<any>(api.w.db, "SELECT owner_user_id FROM nutrition_foods WHERE source = 'import_loseit'");
  assert.ok(foods.length > 0 && foods.every((f) => f.owner_user_id === api.w.ids.ann), "Only me");
  assert.deepEqual(all<any>(api.w.db, "SELECT name_snapshot FROM nutrition_diary_entries").map((e) => e.name_snapshot), ["Toast"], "the window");
  assert.equal((await api.call("ben", "GET", "/foods/search?q=oatmeal")).body.length, 0, "Ben can't find Ann's personal foods");

  const shared = await newApi(t);
  await shared.call("ann", "POST", REAL, buf(sample()));
  assert.ok(all<any>(shared.w.db, "SELECT owner_user_id FROM nutrition_foods WHERE source = 'import_loseit'").every((f) => f.owner_user_id === null), "shared by default");
  assert.ok((await shared.call("ben", "GET", "/foods/search?q=oatmeal")).body.length > 0, "Ben can find the shared ones");

  for (const bad of ["conflict=wipe", "weightUnit=stone", "from=nope", "onlyMe=maybe", "from=2026-02-01&to=2026-01-01"]) {
    const r = await api.call("ann", "POST", `${DRY}?${bad}`, buf(sample()));
    assert.equal(r.status, 400, bad);
  }
});

test("the replace / skip conflict choice reaches the importer: skip leaves a day you logged alone, replace swaps it", async (t) => {
  const api = await newApi(t);
  run(api.w.db,
    `INSERT INTO nutrition_diary_entries (id, user_id, local_date, slot_key, status, name_snapshot, quantity, unit_snapshot, nutrients_total, source, logged_at, updated_at)
     VALUES ('mine', ?, '2026-01-05', 'lunch', 'logged', 'My own lunch', 1, 'serving', '{"kcal":500}', 'manual', 'x', 'x')`, api.w.ids.ann);
  const skip = await api.call("ann", "POST", `${DRY}?conflict=skip`, buf(sample()));
  assert.deepEqual([skip.body.conflicts.count, skip.body.conflicts.dates[0].action, skip.body.counts.created], [1, "skipped", 1]);
  const replace = await api.call("ann", "POST", `${REAL}?conflict=replace`, buf(sample()));
  assert.deepEqual([replace.body.conflicts.replacedEntries, replace.body.counts.created], [1, 2]);
  assert.ok(get<any>(api.w.db, "SELECT deleted_at FROM nutrition_diary_entries WHERE id = 'mine'")!.deleted_at);
});

test("the calorie budget is NEVER matched by an import: an applyCalibration query parameter is ignored", async (t) => {
  const api = await newApi(t);
  const parts: Parts = { food: [], summary: [{ date: "3/9/2026", budget: 1700 }], weights: [["1/1/2026", 80]] };
  const goals = () => rowCount(api.w.db, "nutrition_goals");
  const before = goals();
  for (const url of [`${REAL}?applyCalibration=1`, `${REAL}?applyCalibration=true&weightUnit=kg`, `${DRY}?applyCalibration=1`]) {
    const r = await api.call("ann", "POST", url, buf(parts));
    assert.equal(r.status, 200);
    assert.equal(r.body.calibration.applied, false, url);
    assert.equal(r.body.options.applyCalibration, false, url);
  }
  assert.equal(goals(), before);
});

test("what is not a Lose It! ZIP is refused with a plain reason: no body, a JSON body, a file that isn't a ZIP, a ZIP with no food log", async (t) => {
  const api = await newApi(t);
  assert.equal((await api.call("ann", "POST", REAL, {})).status, 415, "no ZIP sent (the usual JSON body)");
  assert.equal((await api.call("ann", "POST", REAL, Buffer.alloc(0))).status, 415);
  const notZip = await api.call("ann", "POST", REAL, Buffer.from("Date,Name\n1/5/2026,Oatmeal\n"));
  assert.deepEqual([notZip.status, /isn't a ZIP/.test(notZip.body.error)], [400, true]);
  const noFood = await api.call("ann", "POST", REAL, Buffer.from(zipSync({ "weights.csv": strToU8("Date,Weight\n") })));
  assert.deepEqual([noFood.status, /No food-logs\.csv/.test(noFood.body.error)], [400, true]);
  assert.equal(entryCount(api, "ann"), 0);
});

// ---- who may import ---------------------------------------------------------------------------------------------------

test("the kiosk never imports: 403 on every import route, and nothing is written", async (t) => {
  const api = await newApi(t);
  for (const [url, body] of [[DRY, buf(sample())], [REAL, buf(sample())], ["/import/loseit/match-calorie-budget", { palOverride: 1.4 }]] as const) {
    const r = await api.call("kiosk", "POST", url, body);
    assert.equal(r.status, 403, url);
  }
  assert.equal(rowCount(api.w.db, "nutrition_diary_entries"), 0);
  assert.equal(rowCount(api.w.db, "nutrition_photos"), 0);
});

test("a watch (device token) can't import or change the goal; a signed-in login can only ever import into their own diary", async (t) => {
  const api = await newApi(t);
  for (const [url, body] of [[DRY, buf(sample())], [REAL, buf(sample())], ["/import/loseit/match-calorie-budget", { palOverride: 1.4 }]] as const) {
    const r = await api.callDevice("ann", "POST", url, body);
    assert.equal(r.status, 403, url);
  }
  assert.equal(rowCount(api.w.db, "nutrition_diary_entries"), 0);
  // There is no way to name another login: no user id is read from the path, the query or the body.
  const r = await api.call("ben", "POST", `${REAL}?userId=${api.w.ids.ann}&user=ann`, buf(sample()));
  assert.equal(r.status, 200);
  assert.equal(entryCount(api, "ben"), 2);
  assert.equal(entryCount(api, "ann"), 0);
});

test("the food-diary PIN: with it on, a locked session gets 423 before the ZIP is read; unlocked, the import works", async (t) => {
  const api = await newApi(t);
  setConfig("lock_pin_hash", await bcrypt.hash("4826", 4));
  t.after(() => setConfig("lock_pin_hash", null));
  assert.equal((await api.call("ann", "PUT", "/settings/pin", { requirePin: true })).status, 200);

  for (const url of [DRY, REAL]) {
    const locked = await api.call("ann", "POST", url, buf(sample()));
    assert.deepEqual([locked.status, locked.body], [423, { error: "locked" }], url);
  }
  assert.equal((await api.call("ann", "POST", "/import/loseit/match-calorie-budget", { palOverride: 1.4 })).status, 423);
  assert.equal(entryCount(api, "ann"), 0);

  const unlock = await callRoute(lockRoutes, "POST", "/unlock", { session: api.sessions.ann, body: { code: "4826", trusted: false } });
  assert.equal(unlock.status, 200);
  assert.equal((await api.call("ann", "POST", DRY, buf(sample()))).status, 200);
  assert.equal((await api.call("ann", "POST", REAL, buf(sample()))).status, 200);
  assert.equal(entryCount(api, "ann"), 2);
  // Ben has no PIN option: his imports never ask.
  assert.equal((await api.call("ben", "POST", DRY, buf(sample()))).status, 200);
});

// ---- imported progress photos are private ------------------------------------------------------------------------------

test("imported progress photos are the owner's alone: another login, the kiosk and a watch all get 404, at every sharing level", async (t) => {
  const api = await newApi(t);
  await api.call("ann", "POST", REAL, buf(sample()));
  const list = await api.call("ann", "GET", "/photos");
  assert.equal(list.body.length, 1);
  const photo = list.body[0];
  assert.deepEqual([photo.source, photo.takenOn, photo.mime, photo.width, photo.height, photo.size], ["import_loseit", "2025-06-05", "image/jpeg", 1200, 1600, jpeg.length]);
  const image = await api.call("ann", "GET", `/photos/${photo.id}/image`);
  assert.equal(image.status, 200);
  assert.ok(Buffer.from(image.body).equals(jpeg), "kept exactly as it was exported");

  // Ann shares everything with the household; the photo is still unreachable.
  await api.call("ann", "PUT", "/me/visibility", { visibility: "everything" });
  assert.equal((await api.call("ben", "GET", `/people/${api.w.ids.ann}/progress`)).status, 200);
  assert.equal(JSON.stringify((await api.call("ben", "GET", `/people/${api.w.ids.ann}/progress`)).body).includes("photo"), false);
  assert.equal((await api.call("ben", "GET", `/photos/${photo.id}/image`)).status, 404);
  assert.equal((await api.call("ben", "DELETE", `/photos/${photo.id}`)).status, 404);
  assert.deepEqual((await api.call("ben", "GET", "/photos")).body, []);
  assert.equal((await api.call("kiosk", "GET", `/photos/${photo.id}/image`)).status, 404);
  assert.equal((await api.callDevice("ann", "GET", `/photos/${photo.id}/image`)).status, 404);
  assert.equal(rowCount(api.w.db, "nutrition_photos WHERE deleted_at IS NULL"), 1, "Ben's DELETE changed nothing");
});

// ---- steps typed by hand are safe ---------------------------------------------------------------------------------------

test("a day of steps you typed is kept by the import and reported", async (t) => {
  const api = await newApi(t);
  assert.equal((await api.call("ann", "PUT", "/steps/2026-01-05", { steps: 1234 })).status, 200);
  const r = await api.call("ann", "POST", REAL, buf(sample()));
  assert.deepEqual([r.body.steps.created, r.body.steps.keptManual], [0, 1]);
  assert.deepEqual((await api.call("ann", "GET", "/steps")).body, [{ date: "2026-01-05", steps: 1234, source: "manual" }]);
});

// ---- "Match my Lose It! calorie budget" ---------------------------------------------------------------------------------------

test("match-calorie-budget is its own explicit action: it adds one NEW goal row effective today and refuses nonsense", async (t) => {
  const api = await newApi(t);
  const before = rowCount(api.w.db, "nutrition_goals");
  const r = await api.call("ann", "POST", "/import/loseit/match-calorie-budget", { palOverride: 1.4 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual([r.body.applied, r.body.goal.palOverride, r.body.goal.effectiveFrom], [true, 1.4, TODAY]);
  assert.equal(rowCount(api.w.db, "nutrition_goals"), before + 1);
  const goals = await api.call("ann", "GET", "/me/goals");
  assert.equal(goals.body.current.palOverride, 1.4);
  assert.equal(goals.body.history.length, 2, "the older goal is still in the history");
  assert.equal((await api.call("ben", "GET", "/me/goals")).body.current.palOverride, null, "Ben's goal is untouched");

  assert.equal((await api.call("ann", "POST", "/import/loseit/match-calorie-budget", { palOverride: 5 })).status, 400);
  assert.equal((await api.call("ann", "POST", "/import/loseit/match-calorie-budget", { palOverride: "1.4" })).status, 400);
  assert.equal((await api.call("ann", "POST", "/import/loseit/match-calorie-budget", {})).status, 400);
  assert.equal(rowCount(api.w.db, "nutrition_goals"), before + 1);

  const noProfile = await newApi(t, { profiles: false });
  assert.equal((await noProfile.call("ann", "POST", "/import/loseit/match-calorie-budget", { palOverride: 1.4 })).status, 409);
});

// ---- the raw body behind a real server ------------------------------------------------------------------------------------------

test("behind a real HTTP server: a ZIP bigger than the 10 MB JSON limit gets through as application/zip, and the JSON parser still guards other routes", async (t) => {
  const api = await newApi(t);
  assert.equal(IMPORT_BODY_LIMIT, "100mb");
  assert.deepEqual(
    ["/api/nutrition/import/loseit", "/api/nutrition/import/loseit/", "/api/nutrition/import/loseit/dry-run", "/API/nutrition/Import/LoseIt?x=1"].map(isZipImportPath),
    [true, true, true, true]);
  assert.deepEqual(["/api/nutrition/import/loseit/match-calorie-budget", "/api/nutrition/diary/2026-01-05", "/api/nutrition/import/other"].map(isZipImportPath), [false, false, false]);

  // The same wiring server.ts has: the app-wide JSON parser steps aside for the two ZIP POSTs.
  const app = express();
  const jsonBody = express.json({ limit: "10mb" });
  app.use((req, res, next) => (req.method === "POST" && isZipImportPath(req.path) ? next() : jsonBody(req, res, next)));
  app.use((req, _res, next) => { (req as any).session = api.sessions.ann; next(); });
  app.use("/api/nutrition", createNutritionRoutes({ db: api.w.db, now: () => new Date("2026-03-10T15:00:00Z"), recipeModel: () => null, kioskSetting: { get: () => "hidden", set: () => {} } }));
  // (Answer a parser failure as JSON instead of letting Express print the stack trace into the test output.)
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(err?.status ?? 500).json({ error: String(err?.message ?? err) }));
  const server = http.createServer(app).listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/nutrition`;

  // A ZIP of about 11 MB: stored (not compressed) filler that is a meal photo, which is never read.
  const filler = Uint8Array.from({ length: 11 * 1024 * 1024 }, (_, i) => (i * 2654435761) & 0xff);
  const big = Buffer.from(zipSync({ ...unzipEntries(sample()), "food-photos/dinner-photo.jpg": [filler, { level: 0 }] } as any));
  assert.ok(big.length > 10 * 1024 * 1024, `the test ZIP is ${big.length} bytes`);

  const post = (path: string, body: Buffer | string, type: string) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "content-type": type }, body: new Uint8Array(typeof body === "string" ? Buffer.from(body) : body) });
  const ok = await post("/import/loseit/dry-run", big, "application/zip");
  assert.equal(ok.status, 200, await ok.clone().text().then((x) => x.slice(0, 200)));
  const report: any = await ok.json();
  assert.deepEqual([report.dryRun, report.counts.created, report.ignoredImages], [true, 2, 1]);
  const real = await post("/import/loseit", big, "application/zip");
  assert.equal(real.status, 200);
  assert.equal(entryCount(api, "ann"), 2);

  // A JSON body to the same route is not a ZIP (and the 10 MB JSON limit did not touch it either way).
  const json = await post("/import/loseit", JSON.stringify({ a: 1 }), "application/json");
  assert.equal(json.status, 415);
  // The JSON parser still guards every other route: an 11 MB JSON body is refused there.
  const tooBig = await post("/diary/2026-01-05", JSON.stringify({ pad: "x".repeat(11 * 1024 * 1024) }), "application/json");
  assert.equal(tooBig.status, 413);
});

/** The entries of a Parts export as zipSync wants them (so one more file can be added to the same archive). */
function unzipEntries(p: Parts): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  // zipOf lays progress photos under progress-photos/; read them back from its own bytes.
  const z = zipOf(p);
  const files = unzipSync(z);
  for (const [k, v] of Object.entries(files)) out[k] = v;
  return out;
}
