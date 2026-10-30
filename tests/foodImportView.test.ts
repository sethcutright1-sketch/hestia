// The "Import from Lose It!" card's words and numbers. The sentences are worked out in src/sections/food/importView.ts from a REAL
// report (the importer run on a synthetic export), and the report view is rendered to static HTML, so a crash or a wrong sentence
// shows up without a browser. (The whole flow in a browser is the reviewer's check.)

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { cleanupDb } from "./helpers/testdb.ts";
import { newWorld } from "./helpers/nutritionWorld.ts";
import { customFoodsCsv, dailyValuesCsv, exportOf, photoName, photosCsv, stepsCsv, token, type Food, type Parts } from "./helpers/loseitExport.ts";
import { jpegBytes } from "./helpers/images.ts";
import { importLoseIt } from "../nutrition/import/loseitImport.ts";
import ImportCard from "../src/sections/food/settings/ImportCard.tsx";
import ImportReportView from "../src/sections/food/settings/ImportReportView.tsx";
import { calibrationView, CONFLICT_CHOICES, fileGroups, importQuery, num, plural, reconciliationView, sections } from "../src/sections/food/importView.ts";
import type { Profile } from "../src/sections/food/types.ts";

after(cleanupDb);

const TODAY = "2026-03-10";

/** Enough rows that the counts need thousands separators. */
function bigParts(): Parts {
  const food: Food[] = [];
  for (let i = 0; i < 1234; i++) food.push({ date: `1/${(i % 28) + 1}/2026`, name: `Food ${i}`, kcal: 100 });
  return {
    food,
    summary: [{ date: "1/1/2026", food: 9999, budget: 2000 }], // the 45 rows of that day add up to 4,500: a mismatch to show
    weights: [["1/5/2026", 176.37]],
    exercise: [["1/5/2026", "Walk", -100, 30]],
    extra: {
      "daily-values.csv": dailyValuesCsv([["1/5/2026", 1], ["1/6/2026", 0]]),
      "steps.csv": stepsCsv([["1/5/2026", 9000]]),
      "custom-foods.csv": customFoodsCsv([{ name: "House Bar" }]),
      "progress-photos.csv": photosCsv([["6/5/2025", token(1)]]),
      "recipes.csv": "Name,UniqueId\r\nChili,u\r\n",
      "sodium.csv": "Date,Value,Secondary Value,Last Updated\r\n",
    },
    photos: { [photoName("2025-06-05", token(1))]: jpegBytes(640, 480, 300) },
  };
}

async function report(opts: { dryRun: boolean; foodScope?: "joint" | "personal" } = { dryRun: true }) {
  let w: Awaited<ReturnType<typeof newWorld>> | undefined;
  await new Promise<void>((resolve, reject) => {
    // newWorld wants a TestContext for cleanup; a tiny stand-in is enough here (the in-memory database is dropped with the process).
    newWorld({ after: () => {} } as any).then((x) => { w = x; resolve(); }, reject);
  });
  return importLoseIt(w!.db, w!.ann, exportOf(bigParts()), { dryRun: opts.dryRun, today: TODAY, foodScope: opts.foodScope });
}

test("numbers are formatted and the counts read as a plain list; a dry run says 'will be added', the result says 'added'", async () => {
  assert.equal(num(1234), "1,234");
  assert.equal(num(1234567.4), "1,234,567");
  assert.equal(plural(1, "day"), "1 day");
  assert.equal(plural(1234, "day"), "1,234 days");

  const dry = await report({ dryRun: true });
  const dryHtml = renderToStaticMarkup(h(ImportReportView, { report: dry }));
  assert.match(dryHtml, /Food entries will be added<\/dt><dd[^>]*>1,234</);
  assert.match(dryHtml, /Weigh-ins will be added/);
  assert.match(dryHtml, /Progress photos will be added/);
  assert.match(dryHtml, /Days marked Done logging<\/dt><dd[^>]*>1</);
  assert.match(dryHtml, /Not completed in Lose It! \(not marked\)<\/dt><dd[^>]*>1</);
  assert.match(dryHtml, /Only you can see these\. They are kept exactly as Lose It! gave them\./);

  const done = await report({ dryRun: false });
  const doneHtml = renderToStaticMarkup(h(ImportReportView, { report: done }));
  assert.match(doneHtml, /Food entries added<\/dt><dd[^>]*>1,234</);
  assert.doesNotMatch(doneHtml, /will be added/);
});

test("the food-sharing sentence follows the Only me choice, even before the dry run is repeated", async () => {
  const r = await report({ dryRun: true });
  assert.match(renderToStaticMarkup(h(ImportReportView, { report: r })), /These foods are shared with the household\./);
  assert.match(renderToStaticMarkup(h(ImportReportView, { report: r, foodScope: "personal" })), /These foods are only yours\./);
  assert.match(renderToStaticMarkup(h(ImportReportView, { report: await report({ dryRun: true, foodScope: "personal" }) })), /These foods are only yours\./);
});

test("files: read, skipped (recipes by choice, sodium on purpose) and the reconciliation check against Lose It!'s own daily calories", async () => {
  const r = await report();
  const g = fileGroups(r);
  assert.ok(g.understood.some((f) => f.name === "food-logs.csv"));
  assert.deepEqual(g.skipped.map((f) => f.name).sort(), ["recipes.csv", "sodium.csv"]);
  assert.deepEqual(g.notUnderstood, []);

  const html = renderToStaticMarkup(h(ImportReportView, { report: r }));
  assert.match(html, /recipes\.csv: by choice, recipes aren&#x27;t imported/);
  assert.match(html, /sodium\.csv: these are per-day sums of the food log, so importing them would count everything twice/);

  const recon = reconciliationView(r);
  assert.equal(recon.tone, "warn");
  assert.match(recon.text, /1 of 1 days differ/);
  assert.match(recon.examples[0], /2026-01-01: Lose It! says 9,999, the file adds up to 4,500/);
  assert.equal(reconciliationView({ ...r, reconciliation: { compared: 752, mismatches: 0, first: [] } }).text, "All 752 days add up to Lose It!'s own daily calories.");
  assert.equal(reconciliationView({ ...r, reconciliation: { compared: 0, mismatches: 0, first: [] } }).tone, "info");
});

test("the calorie budget comparison: the sentence, the profile-first message, and when the match button is blocked", async () => {
  const base = (await report()).calibration;
  const ok = calibrationView({ ...base, status: "computed", needsProfile: false, daysUsed: 30, median: 1.42, loseItAvgKcal: 2126, appAvgKcal: 1998, matchedAvgKcal: 2126, canApply: true, goalHasOwnBudget: false, reason: undefined });
  assert.equal(ok.kind, "compare");
  assert.equal(ok.text, "Lose It! gave you about 2,126 calories a day over your last 30 days. This app gives you 1,998. Matching Lose It! would make it 2,126.");
  assert.deepEqual([ok.canApply, ok.pal], [true, 1.42]);

  const blocked = calibrationView({ ...base, status: "computed", needsProfile: false, daysUsed: 1, median: 0.5, loseItAvgKcal: 1000, appAvgKcal: 3000, matchedAvgKcal: 1000, canApply: false, goalHasOwnBudget: false, reason: "The matching multiplier would be 0.5, outside 1-3." });
  assert.deepEqual([blocked.kind, blocked.canApply], ["compare", false]);
  assert.match(blocked.blocked!, /outside 1-3/);
  assert.match(blocked.text, /over your last 1 day\./);

  const noProfile = calibrationView({ ...base, status: "skipped", needsProfile: true, canApply: false, reason: "x" });
  assert.equal(noProfile.kind, "needs-profile");
  assert.match(noProfile.text, /fill in your profile first \(sex, birth date and height\)/);
  const none = calibrationView({ ...base, status: "skipped", needsProfile: false, canApply: false, reason: "the export has no usable daily-calorie-summary.csv" });
  assert.deepEqual([none.kind, none.canApply], ["unavailable", false]);
  assert.match(none.text, /^No comparison: the export has no usable/);
});

test("the options: the query the routes read, the three conflict choices (skip is the default and says why)", () => {
  assert.equal(importQuery({ conflict: "skip", onlyMe: false, weight: "account" }), "conflict=skip");
  assert.equal(importQuery({ conflict: "replace", onlyMe: true, weight: "kg" }), "conflict=replace&onlyMe=1&weightUnit=kg");
  assert.deepEqual(CONFLICT_CHOICES.map((c) => c.value), ["skip", "merge", "replace"]);
  assert.match(CONFLICT_CHOICES[0].detail, /safe/);
  assert.match(CONFLICT_CHOICES[2].detail, /can't be brought back/);
});

test("conflict days are listed in the preview with what will happen to each", async () => {
  const w = await newWorld({ after: () => {} } as any);
  w.db.exec(`INSERT INTO nutrition_diary_entries (id, user_id, local_date, slot_key, status, name_snapshot, quantity, unit_snapshot, nutrients_total, source, logged_at, updated_at)
             VALUES ('n1', '${w.ids.ann}', '2026-01-05', 'lunch', 'logged', 'Mine', 1, 'serving', '{"kcal":1}', 'manual', 'x', 'x')`);
  const r = importLoseIt(w.db, w.ann, exportOf({ food: [{ date: "1/5/2026", name: "Oatmeal" }] }), { dryRun: true, today: TODAY, conflict: "replace" });
  const html = renderToStaticMarkup(h(ImportReportView, { report: r }));
  assert.match(html, /1 day you already logged here/);
  assert.match(html, /What you logged on these days would be replaced \(1 entry\)/);
  assert.match(html, /2026-01-05: 1 yours, 1 from Lose It! \(replaced\)/);
  assert.equal(sections(r)[0].rows[0].label, "Food entries will be added");
});

test("the card before a file is chosen: how to get the export, the file box, and nothing that could change data", () => {
  const profile: Profile = { id: "u", name: "Ann", role: "admin", hasProfile: true, sex: "female", birthDate: "1990-06-15", heightCm: 170, timezone: "America/New_York", unitSystem: "imperial" };
  const html = renderToStaticMarkup(h(ImportCard, { profile, fail: () => "", onChanged: () => {} }));
  assert.match(html, /Import from Lose It!/);
  assert.match(html, /my\.loseit\.com/);
  assert.match(html, /loseit\.com\/export\/data/);
  assert.match(html, /type="file"/);
  assert.match(html, /accept="\.zip,application\/zip/);
  assert.doesNotMatch(html, /Import into my diary/, "no Import button until a file has been checked");
  assert.doesNotMatch(html, /Match my Lose It! calorie budget/);
  assert.match(html, /into your diary only|goes into your diary only|It goes into your diary only/);
  // The words: a budget is always the calorie budget.
  assert.doesNotMatch(html.replace(/calorie budget/gi, ""), /\bbudget\b/i);
});
