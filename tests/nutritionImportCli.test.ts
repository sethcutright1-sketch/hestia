// npm run import:loseit: the flags, the --yes guard for a real run, --inspect needing no database, and the printed database
// path. The logic lives in nutrition/import/cli.ts with its dependencies passed in, so every case runs here against a
// private in-memory household and a ZIP built in memory.

import { test, after, type TestContext } from "node:test";
import assert from "node:assert/strict";

import { cleanupDb } from "./helpers/testdb.ts";
import { newWorld, rowCount } from "./helpers/nutritionWorld.ts";
import { dailyValuesCsv, photoName, photosCsv, token, zipOf, type Parts } from "./helpers/loseitExport.ts";
import { jpegBytes } from "./helpers/images.ts";
import { all } from "../nutrition/data/sql.ts";
import { parseArgs, runCli, type CliDeps } from "../nutrition/import/cli.ts";

after(cleanupDb);

const sample = (): Parts => ({
  food: [{ date: "1/5/2026", name: "Oatmeal", units: "Cup", kcal: 166 }],
  summary: [{ date: "1/5/2026", food: 166, budget: 1900 }],
  extra: { "daily-values.csv": dailyValuesCsv([["1/5/2026", 1]]), "progress-photos.csv": photosCsv([["6/5/2025", token(1)]]) },
  photos: { [photoName("2025-06-05", token(1))]: jpegBytes(640, 480, 500) },
});

async function setup(t: TestContext) {
  const w = await newWorld(t);
  const log: string[] = [];
  const calls = { databasePath: 0, openDb: 0, closed: 0 };
  // Ann: female, 170 cm, born 1990-06-15, so at 80 kg and age 35 her BMR is 1526.5; a calorie budget of BMR x 1.4 on her
  // starter goal (plan 0) implies a multiplier of 1.4.
  const calibrate: Parts = {
    food: [{ date: "2/1/2026", name: "X" }],
    summary: [1, 2, 3].map((d) => ({ date: `3/${d}/2026`, budget: 2137.1 })),
    weights: [["1/1/2026", 176.37]],
  };
  const files = new Map<string, Uint8Array>([
    ["export.zip", zipOf(sample())], ["calibrate.zip", zipOf(calibrate)], ["notazip.zip", new TextEncoder().encode("Date,Name\n")],
  ]);
  const deps: CliDeps = {
    out: (s) => log.push(s),
    readFile: (p) => {
      const f = files.get(p);
      if (!f) throw Object.assign(new Error("nope"), { code: "ENOENT" });
      return f;
    },
    databasePath: () => { calls.databasePath++; return "C:\\rehearsal\\household.db"; },
    openDb: async () => { calls.openDb++; return { db: w.db, close: () => { calls.closed++; } }; },
  };
  const run = (...argv: string[]) => runCli(argv, deps);
  return { w, log, calls, run, text: () => log.join("\n") };
}

test("parseArgs: switches, values (with = or a space), and a helpful error for anything else", () => {
  assert.deepEqual([...parseArgs(["--user", "alex", "--zip=a.zip", "--dry-run", "--only-me", "--conflict", "merge"])],
    [["user", "alex"], ["zip", "a.zip"], ["dry-run", true], ["only-me", true], ["conflict", "merge"]]);
  assert.throws(() => parseArgs(["--bogus"]), /Unknown option --bogus/);
  assert.throws(() => parseArgs(["alex"]), /Unexpected argument/);
  assert.throws(() => parseArgs(["--user"]), /--user needs a value/);
  assert.throws(() => parseArgs(["--user", "--zip", "a"]), /--user needs a value/);
});

test("--inspect lists the files and headers and needs NO database at all", async (t) => {
  const c = await setup(t);
  assert.equal(await c.run("--zip", "export.zip", "--inspect"), 0);
  assert.deepEqual(c.calls, { databasePath: 0, openDb: 0, closed: 0 });
  assert.match(c.text(), /Read 4 file\(s\) and 1 progress photo\(s\)/);
  assert.match(c.text(), /food-logs\.csv .* understood/);
  assert.match(c.text(), /headers: Date \| Name \| Icon \| Meal/);
  assert.match(c.text(), /progress-photos\.csv .* understood/);
  assert.equal(await c.run("--zip", "export.zip", "--inspect", "--samples"), 0);
  assert.match(c.text(), /first row: Date="1\/5\/2026" \| Name="Oatmeal"/);
  assert.equal(await c.run("--zip", "export.zip", "--samples"), 1);
  assert.match(c.text(), /--samples only goes with --inspect/);
});

test("a real run needs --yes: without it nothing is opened, nothing is written, and the exit code is 1", async (t) => {
  const c = await setup(t);
  assert.equal(await c.run("--user", "ann", "--zip", "export.zip"), 1);
  assert.match(c.text(), /needs --yes|add --yes/i);
  assert.match(c.text(), /--dry-run first/);
  assert.deepEqual(c.calls, { databasePath: 0, openDb: 0, closed: 0 }, "the database is not even looked at");
  assert.equal(rowCount(c.w.db, "nutrition_diary_entries"), 0);
  // --only-me and the other options don't change that.
  assert.equal(await c.run("--user", "ann", "--zip", "export.zip", "--only-me", "--conflict", "replace"), 1);
  assert.equal(rowCount(c.w.db, "nutrition_diary_entries"), 0);
});

test("--dry-run prints the database path first, runs the whole import, writes nothing, and needs no --yes", async (t) => {
  const c = await setup(t);
  assert.equal(await c.run("--user", "ann", "--zip", "export.zip", "--dry-run"), 0);
  const out = c.text();
  assert.ok(out.indexOf("Database: C:\\rehearsal\\household.db") >= 0, "the path it would write to");
  assert.ok(out.indexOf("Database:") < out.indexOf("DRY RUN"), "printed before the report");
  assert.match(out, /Lose It! import for Ann \(ann\): DRY RUN/);
  assert.match(out, /1 to create/);
  assert.match(out, /Run it again without --dry-run, with --yes, to import\./);
  assert.deepEqual([c.calls.databasePath, c.calls.openDb, c.calls.closed], [1, 1, 1]);
  for (const table of ["nutrition_diary_entries", "nutrition_foods", "nutrition_photos", "nutrition_day_logs"]) assert.equal(rowCount(c.w.db, table), 0, table);
});

test("--yes does the real import into the NAMED login's diary (username, any case), with the options", async (t) => {
  const c = await setup(t);
  assert.equal(await c.run("--user", "BEN", "--zip", "export.zip", "--yes", "--only-me"), 0);
  assert.match(c.text(), /Lose It! import for Ben \(ben\): DONE\./);
  assert.equal(rowCount(c.w.db, `nutrition_diary_entries WHERE user_id = '${c.w.ids.ben}'`), 1);
  assert.equal(rowCount(c.w.db, `nutrition_diary_entries WHERE user_id = '${c.w.ids.ann}'`), 0);
  assert.equal(rowCount(c.w.db, `nutrition_photos WHERE user_id = '${c.w.ids.ben}'`), 1);
  assert.deepEqual(all<any>(c.w.db, "SELECT owner_user_id FROM nutrition_foods WHERE source = 'import_loseit'").map((f) => f.owner_user_id), [c.w.ids.ben], "--only-me");
  assert.equal(c.calls.closed, 1);

  // The id works too; a second run adds nothing.
  assert.equal(await c.run("--user", c.w.ids.ben, "--zip", "export.zip", "--yes"), 0);
  assert.match(c.text(), /0 created, 1 already imported/);
});

test("the CLI never reaches the kiosk login, an unknown login, or a missing/odd file; each is a plain message and exit code 1", async (t) => {
  const c = await setup(t);
  assert.equal(await c.run("--user", "kiosk", "--zip", "export.zip", "--yes"), 1);
  assert.match(c.text(), /Food diaries are for admin and parent logins/);
  assert.equal(rowCount(c.w.db, "nutrition_diary_entries"), 0);
  assert.equal(await c.run("--user", "nobody", "--zip", "export.zip", "--dry-run"), 1);
  assert.match(c.text(), /No login "nobody"/);
  assert.equal(await c.run("--user", "ann", "--zip", "missing.zip", "--dry-run"), 1);
  assert.match(c.text(), /Can't read missing\.zip: no such file/);
  assert.equal(await c.run("--user", "ann", "--zip", "notazip.zip", "--dry-run"), 1);
  assert.match(c.text(), /isn't a ZIP/);
  assert.equal(await c.run("--zip", "export.zip", "--dry-run"), 1);
  assert.match(c.text(), /--user is required/);
  assert.equal(await c.run("--user", "ann", "--dry-run"), 1);
  assert.match(c.text(), /--zip is required/);
  assert.equal(await c.run("--user", "ann", "--zip", "export.zip", "--dry-run", "--conflict", "wipe"), 1);
  assert.match(c.text(), /conflict must be one of skip\|merge\|replace/);
  assert.equal(await c.run("--help"), 0);
  assert.match(c.text(), /A real run \(without --dry-run\) needs --yes/);
});

test("the calorie budget comparison is printed; only the explicit --apply-calibration flag on a real run ever changes a goal", async (t) => {
  const c = await setup(t);
  const goals = () => rowCount(c.w.db, "nutrition_goals");
  const before = goals();
  assert.equal(await c.run("--user", "ann", "--zip", "calibrate.zip", "--yes"), 0);
  assert.match(c.text(), /Lose It! gave you about 2,137 a day over the last 3 days; this app gives 2,099 \(2,137 with the matched multiplier\)/);
  assert.match(c.text(), /Implied multiplier: median 1\.4 .*Not applied; use --apply-calibration to set it\./);
  assert.equal(goals(), before, "an ordinary import never touches the goals");

  assert.equal(await c.run("--user", "ann", "--zip", "calibrate.zip", "--dry-run", "--apply-calibration"), 0);
  assert.match(c.text(), /Would be applied as a new goal row effective today/);
  assert.equal(goals(), before, "a dry run applies nothing");

  assert.equal(await c.run("--user", "ann", "--zip", "calibrate.zip", "--yes", "--apply-calibration"), 0);
  assert.match(c.text(), /Applied as a new goal row effective today/);
  assert.equal(goals(), before + 1);
  assert.equal(all<any>(c.w.db, "SELECT pal_override FROM nutrition_goals WHERE user_id = ? ORDER BY id DESC LIMIT 1", c.w.ids.ann)[0].pal_override, 1.4);
});
