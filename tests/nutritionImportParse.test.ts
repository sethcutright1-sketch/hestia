// The Lose It! file readers: values, headers, the legacy weekly format, the inventory.

import { test } from "node:test";
import assert from "node:assert/strict";
import { NutritionError } from "../nutrition/data/errors.ts";
import { parseCsv } from "../nutrition/import/csv.ts";
import {
  IssueLog, inventoryOf, numberCell, parseCustomFoods, parseDailyValues, parseDate, parseExercise, parseExport, parseFlag, parseFoodLog,
  parseNumber, parseProfile, parseProgressPhotos, parseSteps, parseSummary, parseWeights, profileWeightUnit,
} from "../nutrition/import/loseitParse.ts";

// The headers are the REAL export's (Meal, not Type; Icon and Deleted present); every row below is made up.
const FOOD_HEADER = "Date,Name,Icon,Meal,Quantity,Units,Calories,Deleted,Fat (g),Protein (g),Carbohydrates (g),Saturated Fat (g),Sugars (g),Fiber (g),Cholesterol (mg),Sodium (mg)";
const FOOD_SAMPLE = `${FOOD_HEADER}
01/05/2026,Oatmeal,Oatmeal,Breakfast,1,Cup,166,false,3.6,5.9,28,0.6,0.6,4,0,9
01/05/2026,Chicken Breast,Chicken,Dinner,1.5,Serving,248,false,5.4,46.5,0,1.5,0,0,128,111
`;

test("parseDate: M/D/YYYY, MM/DD/YYYY, M/D/YY and ISO all land on YYYY-MM-DD", () => {
  assert.equal(parseDate("1/5/2026"), "2026-01-05");
  assert.equal(parseDate("01/05/2026"), "2026-01-05");
  assert.equal(parseDate("12/31/25"), "2025-12-31"); // two-digit year -> 20YY
  assert.equal(parseDate("2026-01-05"), "2026-01-05");
  assert.equal(parseDate("  2026-1-5  "), "2026-01-05");
  assert.equal(parseDate("1/5/2026 12:00:00 AM"), "2026-01-05"); // a time of day is ignored
  assert.equal(parseDate("2026-01-05T00:00:00"), "2026-01-05");
  assert.equal(parseDate("2/29/2024"), "2024-02-29"); // leap day
});

test("parseDate: impossible dates and day-first dates are rejected, never guessed", () => {
  for (const bad of ["", "garbage", "13/45/2026", "2/30/2026", "2/29/2025", "31/01/2026", "1/5", "2026-13-01", "0/5/2026"]) {
    assert.equal(parseDate(bad), null, bad);
  }
});

test("numberCell: thousands separators are stripped; blank and n/a are a quiet null; junk is flagged", () => {
  assert.deepEqual(numberCell("1,250"), { value: 1250, invalid: false });
  assert.deepEqual(numberCell(" 1,250.75 "), { value: 1250.75, invalid: false });
  assert.deepEqual(numberCell("3.6"), { value: 3.6, invalid: false });
  assert.deepEqual(numberCell("-2"), { value: -2, invalid: false });
  assert.deepEqual(numberCell(".5"), { value: 0.5, invalid: false });
  for (const blank of ["", "  ", "n/a", "N/A", "NA", "null", "-", "--"]) assert.deepEqual(numberCell(blank), { value: null, invalid: false }, blank);
  assert.deepEqual(numberCell("12 g"), { value: null, invalid: true });
  assert.deepEqual(numberCell("abc"), { value: null, invalid: true });
  assert.deepEqual(numberCell("1e300"), { value: null, invalid: true }); // would overflow every sum downstream
  assert.deepEqual(numberCell("Infinity"), { value: null, invalid: true });
  assert.equal(parseNumber(undefined), null);
  assert.equal(parseNumber("1,000"), 1000);
});

test("the Deleted flag is 1/0 in food-logs and exercise-logs but true/false in weights: every file reads both spellings", () => {
  const food = (flag: string) => `${FOOD_HEADER}\n1/5/2026,A,,Lunch,1,Each,100,${flag},0,0,0,0,0,0,0,0\n`;
  assert.equal(parseFoodLog(parseCsv(food("1")), "food-logs.csv", new IssueLog()).rows[0].deleted, true);
  assert.equal(parseFoodLog(parseCsv(food("0")), "food-logs.csv", new IssueLog()).rows[0].deleted, false);
  assert.equal(parseFoodLog(parseCsv(food("true")), "food-logs.csv", new IssueLog()).rows[0].deleted, true);
  const ex = (flag: string) => `Date,Name,Icon,Type,Quantity,Units,Calories,Deleted\n1/5/2026,Walk,,Exercise,30,minutes,-100,${flag}\n`;
  assert.equal(parseExercise(parseCsv(ex("1")), "exercise-logs.csv", new IssueLog()).rows[0].deleted, true);
  assert.equal(parseExercise(parseCsv(ex("0")), "exercise-logs.csv", new IssueLog()).rows[0].deleted, false);
  const w = (flag: string) => `Date,Weight,Last Updated,Deleted\n1/5/2026,180,10/1/2026,${flag}\n`;
  assert.equal(parseWeights(parseCsv(w("true")), "weights.csv", new IssueLog()).rows[0].deleted, true);
  assert.equal(parseWeights(parseCsv(w("false")), "weights.csv", new IssueLog()).rows[0].deleted, false);
});

test("parseFlag: true / 1 / yes in any case; everything else, including nothing, is false", () => {
  for (const yes of ["true", "TRUE", "True", "1", "yes", "YES", " true "]) assert.equal(parseFlag(yes), true, yes);
  for (const no of ["false", "0", "no", "", "n/a", undefined]) assert.equal(parseFlag(no), false, String(no));
});

test("parseFoodLog: the fixture header and its two example rows, nutrients as totals", () => {
  const issues = new IssueLog();
  const p = parseFoodLog(parseCsv(FOOD_SAMPLE), "food-logs.csv", issues);
  assert.equal(p.recognized, true);
  assert.equal(issues.count, 0);
  assert.equal(p.rows.length, 2);
  assert.deepEqual(p.rows[0], {
    row: 2, date: "2026-01-05", name: "Oatmeal", type: "Breakfast", quantity: 1, units: "Cup", calories: 166, deleted: false,
    nutrients: { fat: 3.6, protein: 5.9, carbs: 28, satFat: 0.6, sugars: 0.6, fiber: 4, cholesterolMg: 0, sodiumMg: 9 },
  });
  assert.equal(p.rows[1].quantity, 1.5);
  assert.equal(p.rows[1].nutrients.cholesterolMg, 128);
});

test("parseFoodLog: BOM, CRLF, quoted names with commas and quotes, thousands separators, n/a calories, Deleted flag", () => {
  const text = "﻿" + FOOD_HEADER + "\r\n" +
    '1/6/2026,"Mac & Cheese, ""Deluxe""",Icon,Snacks,2,Serving,"1,250",TRUE,10,20,30,1,2,3,4,5\r\n' +
    "1/6/2026,Mystery,,Lunch,1,Each,n/a,yes,,,,,,,,\r\n" +
    "1/6/2026,Water,,Lunch,0,Cup,0,0,0,0,0,0,0,0,0,0\r\n";
  const issues = new IssueLog();
  const p = parseFoodLog(parseCsv(text), "food-logs.csv", issues);
  assert.equal(issues.count, 0);
  assert.equal(p.rows[0].name, 'Mac & Cheese, "Deluxe"');
  assert.equal(p.rows[0].calories, 1250);
  assert.equal(p.rows[0].deleted, true);
  assert.equal(p.rows[1].calories, null); // n/a is null, not 0: the importer warns about it
  assert.equal(p.rows[1].deleted, true);
  assert.deepEqual(p.rows[1].nutrients, { fat: 0, protein: 0, carbs: 0, satFat: 0, sugars: 0, fiber: 0, cholesterolMg: 0, sodiumMg: 0 });
  assert.equal(p.rows[2].quantity, 0);
  assert.equal(p.rows[2].deleted, false);
});

test("parseFoodLog: the older weekly export (no Icon, no Deleted) reads as not deleted", () => {
  const legacy = "Date,Name,Type,Quantity,Units,Calories,Fat (g),Protein (g),Carbohydrates (g),Saturated Fat (g),Sugars (g),Fiber (g),Cholesterol (mg),Sodium (mg)\n" +
    "1/5/2026,Oatmeal,Breakfast,1,Cup,166,3.6,5.9,28,0.6,0.6,4,0,9\n";
  const issues = new IssueLog();
  const p = parseFoodLog(parseCsv(legacy), "weekly.csv", issues);
  assert.equal(p.recognized, true);
  assert.equal(issues.count, 0);
  assert.equal(p.rows[0].deleted, false);
  assert.equal(p.rows[0].nutrients.fat, 3.6);
  assert.equal(p.rows[0].nutrients.sodiumMg, 9);
});

test("parseFoodLog: header aliases (Meal / MealType for Type, Sugar for Sugars, Fibre, Carbs)", () => {
  for (const meal of ["Meal", "MealType", "Meal Type"]) {
    const p = parseFoodLog(parseCsv(`Date,Name,${meal},Quantity,Unit,Calories,Sugar,Fibre,Carbs\n1/5/2026,Apple,Snacks,1,Each,95,19,4.4,25\n`), "f.csv", new IssueLog());
    assert.equal(p.recognized, true, meal);
    assert.equal(p.rows[0].type, "Snacks", meal);
    assert.equal(p.rows[0].units, "Each");
    assert.equal(p.rows[0].nutrients.sugars, 19);
    assert.equal(p.rows[0].nutrients.fiber, 4.4);
    assert.equal(p.rows[0].nutrients.carbs, 25);
  }
});

test("parseFoodLog: bad rows are skipped and reported with their record number; the rest still import", () => {
  const issues = new IssueLog();
  const p = parseFoodLog(parseCsv(`${FOOD_HEADER}\n13/45/2026,Bad,,Lunch,1,Each,100,false,0,0,0,0,0,0,0,0\n1/7/2026,,,Lunch,1,Each,abc,false,0,0,0,0,0,0,0,0\n`), "food-logs.csv", issues);
  assert.equal(p.rows.length, 1);
  assert.equal(p.rows[0].name, "Unnamed food");
  assert.equal(p.rows[0].calories, null);
  assert.equal(issues.count, 3);
  assert.match(issues.messages[0], /row 2: unreadable date "13\/45\/2026"/);
  assert.match(issues.messages.join("\n"), /row 3: unreadable Calories "abc"/);
});

test("parseFoodLog: missing required columns means unrecognized, with the names of what's missing", () => {
  const p = parseFoodLog(parseCsv("Day,Item\n1/5/2026,Apple\n"), "x.csv", new IssueLog());
  assert.equal(p.recognized, false);
  assert.deepEqual(p.missing, ["calories"]);
});

test("parseSummary: Date / Food cals / Exercise cals / Budget cals, extra columns ignored, last row per date wins", () => {
  const issues = new IssueLog();
  const p = parseSummary(parseCsv("Date,Food cals,Exercise cals,Budget cals,Weight\n1/5/2026,1800,200,2000,180\n1/6/2026,\"1,950\",,2000,\n1/5/2026,1900,0,2100,\n"), "daily-calorie-summary.csv", issues);
  assert.equal(p.recognized, true);
  assert.deepEqual(p.rows, [
    { date: "2026-01-05", foodCals: 1900, exerciseCals: 0, budgetCals: 2100 },
    { date: "2026-01-06", foodCals: 1950, exerciseCals: null, budgetCals: 2000 },
  ]);
  assert.equal(issues.count, 1); // the duplicate date
});

test("parseSummary: a file with only a date is not a summary", () => {
  assert.equal(parseSummary(parseCsv("Date,Notes\n1/5/2026,hi\n"), "s.csv", new IssueLog()).recognized, false);
});

test("parseWeights: Date / Weight / Deleted, and a unit named in the header is picked up", () => {
  const issues = new IssueLog();
  const p = parseWeights(parseCsv("Date,Weight,Deleted\n1/5/2026,180.5,false\n1/6/2026,181,true\n1/7/2026,,false\n1/8/2026,heavy,false\n"), "weights.csv", issues);
  assert.equal(p.recognized, true);
  assert.deepEqual(p.rows, [{ date: "2026-01-05", value: 180.5, deleted: false }, { date: "2026-01-06", value: 181, deleted: true }]);
  assert.equal(p.unitHint, null); // "Weight" alone says nothing about the unit
  assert.equal(issues.count, 2);
  assert.equal(parseWeights(parseCsv("Date,Weight (kg)\n1/5/2026,80\n"), "w.csv", new IssueLog()).unitHint, "kg");
  assert.equal(parseWeights(parseCsv("Date,Weight (lbs)\n1/5/2026,180\n"), "w.csv", new IssueLog()).unitHint, "lb");
});

test("parseExercise: the real layout stores calories BURNED as negatives: they are made positive, zero stays zero, minutes come from Units", () => {
  const issues = new IssueLog();
  const p = parseExercise(parseCsv("Date,Name,Icon,Type,Quantity,Units,Calories,Deleted\n1/5/2026,Walk,,Exercise,30,minutes,-172.53,0\n1/6/2026,Stretch,,Exercise,10,minutes,0,0\n1/7/2026,Old,,Exercise,5,minutes,-50,1\n1/8/2026,Laps,,Exercise,2,laps,-80,0\n1/9/2026,Nodur,,Exercise,-1,minutes,0,0\n"), "exercise-logs.csv", issues);
  assert.equal(p.recognized, true);
  assert.equal(issues.count, 0);
  assert.deepEqual(p.rows.map((r) => [r.date, r.name, r.calories, r.minutes, r.deleted]), [
    ["2026-01-05", "Walk", 172.53, 30, false],
    ["2026-01-06", "Stretch", 0, 10, false], // a zero-calorie row is real
    ["2026-01-07", "Old", 50, 5, true],
    ["2026-01-08", "Laps", 80, null, false], // Quantity is not minutes unless Units says so
    ["2026-01-09", "Nodur", 0, null, false], // the real file's -1 is "no duration recorded", never minus one minute
  ]);
});

test("parseExercise: recognized only when there is a date, an activity name and calories", () => {
  const ok = parseExercise(parseCsv("Date,Activity,Calories Burned,Minutes,Deleted\n1/5/2026,Running,300,30,false\n1/6/2026,Yoga,,60,true\n"), "exercise-logs.csv", new IssueLog());
  assert.equal(ok.recognized, true);
  assert.deepEqual(ok.rows.map((r) => [r.date, r.name, r.calories, r.minutes, r.deleted]), [["2026-01-05", "Running", 300, 30, false], ["2026-01-06", "Yoga", null, 60, true]]);
  const bad = parseExercise(parseCsv("When,What,Burn\n1/5/2026,Running,300\n"), "exercise-logs.csv", new IssueLog());
  assert.equal(bad.recognized, false);
  assert.deepEqual(bad.missing, ["date", "name", "calories"]);
});

test("parseProfile: Name/Value rows, a two-column file under other headers, or one wide row", () => {
  const kv = parseProfile(parseCsv("Name,Value\nWeight Units,Pounds\nHeight,70\n"));
  assert.deepEqual(kv.rows, [{ key: "Weight Units", value: "Pounds" }, { key: "Height", value: "70" }]);
  assert.deepEqual(parseProfile(parseCsv("A,B\nUnits,kg\n")).rows, [{ key: "Units", value: "kg" }]);
  assert.deepEqual(parseProfile(parseCsv("Age,Height,Units\n40,70,Metric\n")).rows.map((e) => e.key), ["Age", "Height", "Units"]);
  assert.equal(parseProfile(parseCsv("x,y,z\n1,2,3\n4,5,6\n")).recognized, false);
});

test("profileWeightUnit: a setting about units whose value says kg or lb; weight settings win over other units", () => {
  assert.deepEqual(profileWeightUnit([{ key: "Units", value: "Kilograms" }]), { unit: "kg", key: "Units" });
  assert.deepEqual(profileWeightUnit([{ key: "Distance Unit", value: "Imperial" }, { key: "Weight Unit", value: "kg" }]), { unit: "kg", key: "Weight Unit" });
  assert.deepEqual(profileWeightUnit([{ key: "Weight units", value: "lbs" }]), { unit: "lb", key: "Weight units" });
  assert.equal(profileWeightUnit([{ key: "Energy Unit", value: "Calories" }, { key: "Birthday", value: "kg 1990" }]), null); // no "unit" in the key, or a value that isn't a weight unit
  assert.equal(profileWeightUnit([]), null);
});

test("parseExport: file inventory with row counts, headers and what each file is for", () => {
  const files = new Map([
    ["food-logs.csv", FOOD_SAMPLE],
    ["daily-calorie-summary.csv", "Date,Food cals,Exercise cals,Budget cals\n1/5/2026,414,0,2000\n"],
    ["weights.csv", "Date,Weight,Deleted\n1/5/2026,180,false\n"],
    ["exercise-logs.csv", "When,What,Burn\n1/5/2026,Run,300\n"],
    ["custom-foods.csv", "Foo,Bar\n1,2\n3,4\n"],
    ["recipes.csv", "Name,UniqueId,Quantity\nSoup,abc,1\n"],
    ["sodium.csv", "Date,Value,Secondary Value,Last Updated\n1/5/2026,100,0,x\n"],
    ["fasting-logs.csv", "Start,End\n"],
    ["protein(g).csv", "Date,Goal\n"],
    ["profile.csv", "Name,Value\nWeight Units,Pounds\nBirthday,1990-01-01\n"],
    ["README.txt", "hello\nworld\n"],
  ]);
  const parsed = parseExport(files);
  const byName = new Map(parsed.inventory.map((i) => [i.name, i]));
  assert.deepEqual(parsed.inventory.map((i) => i.name), [...files.keys()].sort());

  const food = byName.get("food-logs.csv")!;
  assert.deepEqual([food.kind, food.rows, food.recognized], ["food-log", 2, true]);
  assert.equal(food.headers.length, 16);
  assert.equal(byName.get("weights.csv")!.recognized, true);
  assert.equal(byName.get("daily-calorie-summary.csv")!.recognized, true);

  const ex = byName.get("exercise-logs.csv")!;
  assert.deepEqual([ex.kind, ex.recognized, ex.headers, ex.status], ["exercise", false, ["When", "What", "Burn"], "not understood"]);
  assert.match(ex.note, /columns not recognized/);
  assert.equal(parsed.exercise, null);

  for (const name of ["fasting-logs.csv", "protein(g).csv", "sodium.csv"]) {
    assert.deepEqual([byName.get(name)!.kind, byName.get(name)!.recognized, byName.get(name)!.status], ["other", false, "skipped"], name);
  }
  assert.match(byName.get("sodium.csv")!.note, /count everything twice/);
  assert.match(byName.get("fasting-logs.csv")!.note, /fasting isn't tracked/);
  // recipes.csv is skipped BY CHOICE, never reported as a file the importer failed to understand.
  assert.deepEqual([byName.get("recipes.csv")!.kind, byName.get("recipes.csv")!.status], ["recipes", "skipped"]);
  assert.match(byName.get("recipes.csv")!.note, /skipped by choice/);
  // custom-foods.csv is read now; these headers do not fit, so it is flagged.
  assert.deepEqual([byName.get("custom-foods.csv")!.kind, byName.get("custom-foods.csv")!.status], ["custom-foods", "not understood"]);
  assert.equal(byName.get("custom-foods.csv")!.rows, 2);
  assert.match(byName.get("README.txt")!.note, /not a CSV/);

  const profile = byName.get("profile.csv")!;
  assert.deepEqual(profile.settings, ["Weight Units", "Birthday"]); // names only: values can be personal
  assert.deepEqual(parsed.profile, { unit: "lb", key: "Weight Units" });
});

test("parseExport: file names match case-insensitively with spaces or underscores, and the food log can be found by its headers", () => {
  const renamed = parseExport(new Map([["Food_Logs.csv", FOOD_SAMPLE], ["Daily Calorie Summary.csv", "Date,Food cals\n1/5/2026,414\n"]]));
  assert.equal(renamed.foodLog.length, 2);
  assert.equal(renamed.summary!.length, 1);

  const weekly = parseExport(new Map([["loseit-weekly-2026-01-05.csv", FOOD_SAMPLE.replace(/,Icon|,Oatmeal,B/g, (m) => m).split("\n").join("\n")], ["notes.csv", "Date,Text\n"]]));
  assert.equal(weekly.foodLogFile, "loseit-weekly-2026-01-05.csv");
  assert.equal(weekly.foodLog.length, 2);
});

test("parseExport: not an export, or a food log it can't read, is a 400 that says why", () => {
  assert.throws(() => parseExport(new Map([["weights.csv", "Date,Weight\n"]])), (e: any) => e instanceof NutritionError && e.status === 400 && /No food-logs\.csv/.test(e.message) && /weights\.csv/.test(e.message));
  assert.throws(() => parseExport(new Map()), /No food-logs\.csv/);
  assert.throws(() => parseExport(new Map([["food-logs.csv", "Day,Item\n1/5/2026,Apple\n"]])), (e: any) => e instanceof NutritionError && /Date, Name, Calories/.test(e.message) && /Day, Item/.test(e.message));
});

test("parseExport: a header-only food log is a valid, empty export", () => {
  const p = parseExport(new Map([["food-logs.csv", `${FOOD_HEADER}\n`]]));
  assert.equal(p.foodLog.length, 0);
  assert.equal(p.inventory[0].recognized, true);
});

test("inventoryOf: works on any folder (no food log needed) and adds each file's first row on request", () => {
  const files = new Map([["custom-foods.csv", "Name,Serving\nBar,1 bar\nOther,2\n"], ["empty.csv", "A,B\n"]]);
  const plain = inventoryOf(files);
  assert.equal(plain.length, 2);
  assert.equal(plain[0].sample, undefined);
  const withSamples = inventoryOf(files, { samples: true });
  assert.deepEqual(withSamples.find((i) => i.name === "custom-foods.csv")!.sample, { Name: "Bar", Serving: "1 bar" });
  assert.equal(withSamples.find((i) => i.name === "empty.csv")!.sample, undefined); // no data rows, no sample
});

// ---- the files only the real export has ----------------------------------------------------------------------------

test("parseDailyValues: Complete rows carry 1/0, RecordedWeightsResetDate rows are kept apart, a bad Complete date is reported", () => {
  const issues = new IssueLog();
  const p = parseDailyValues(parseCsv("Date,Name,Value\n1/5/2026,Complete,1\n1/6/2026,Complete,0\n1/7/2026,RecordedWeightsResetDate,7188\nnope,Complete,1\n"), "daily-values.csv", issues);
  assert.equal(p.recognized, true);
  assert.deepEqual(p.rows.map((r) => [r.date, r.name, r.value]), [["2026-01-05", "Complete", "1"], ["2026-01-06", "Complete", "0"], ["2026-01-07", "RecordedWeightsResetDate", "7188"]]);
  assert.equal(issues.count, 1);
  assert.equal(parseDailyValues(parseCsv("Foo,Bar\n1,2\n"), "x.csv", new IssueLog()).recognized, false);
});

test("parseSteps: Date|Value|Secondary Value|Last Updated, values like 9999.9 kept as written for the importer to round", () => {
  const issues = new IssueLog();
  const p = parseSteps(parseCsv("Date,Value,Secondary Value,Last Updated\n1/5/2026,9999.9,0.0,x\n1/6/2026,\"12,000\",0.0,x\n1/7/2026,lots,0.0,x\n1/8/2026,,0.0,x\n"), "steps.csv", issues);
  assert.deepEqual(p.rows.map((r) => [r.date, r.steps]), [["2026-01-05", 9999.9], ["2026-01-06", 12000]]);
  assert.equal(issues.count, 1, "only the unreadable value is reported; an empty one is quietly nothing");
});

test("parseProgressPhotos: Date|Goal Tag|Visibility|Token|Deleted|Created|Last Updated", () => {
  const p = parseProgressPhotos(parseCsv("Date,Goal Tag,Visibility,Token,Deleted,Created,Last Updated\n6/5/2025,WEIGHT,Private,0123456789abcdef0123456789abcdef,false,x,y\n6/6/2025,WEIGHT,Private,fedcba9876543210fedcba9876543210,true,x,y\n6/7/2025,WEIGHT,Private,,false,x,y\n"), "progress-photos.csv", new IssueLog());
  assert.deepEqual(p.rows.map((r) => [r.date, r.token, r.deleted, r.visibility]), [
    ["2025-06-05", "0123456789abcdef0123456789abcdef", false, "Private"],
    ["2025-06-06", "fedcba9876543210fedcba9876543210", true, "Private"],
  ]);
});

test("parseCustomFoods: Name|UniqueId|Brand|Image|Quantity|Measure|Calories|nutrients, as totals for Quantity x Measure", () => {
  const p = parseCustomFoods(parseCsv("Name,UniqueId,Brand,Image,Quantity,Measure,Calories,Fat (g),Protein (g),Carbohydrates (g),Saturated Fat (g),Sugars (g),Fiber (g),Cholesterol (mg),Sodium (mg)\nTest Bar,u1,Acme,,1.0,Serving,200,8,10,20,2,5,3,0,150\n,u2,,,1,Each,50,0,0,0,0,0,0,0,0\n"), "custom-foods.csv", new IssueLog());
  assert.equal(p.rows.length, 1, "a row with no name is skipped");
  assert.deepEqual(p.rows[0], {
    row: 2, name: "Test Bar", brand: "Acme", measure: "Serving", quantity: 1, calories: 200,
    nutrients: { fat: 8, protein: 10, carbs: 20, satFat: 2, sugars: 5, fiber: 3, cholesterolMg: 0, sodiumMg: 150 },
  });
});

test("parseExport reads every file of a real-shaped export and files each one's verdict", () => {
  const parsed = parseExport(new Map([
    ["food-logs.csv", FOOD_SAMPLE],
    ["daily-values.csv", "Date,Name,Value\n1/5/2026,Complete,1\n"],
    ["steps.csv", "Date,Value,Secondary Value,Last Updated\n1/5/2026,5000,0.0,x\n"],
    ["progress-photos.csv", "Date,Goal Tag,Visibility,Token,Deleted,Created,Last Updated\n1/5/2026,WEIGHT,Private,abcdefabcdefabcdefabcdefabcdefab,false,x,y\n"],
    ["custom-foods.csv", "Name,UniqueId,Brand,Image,Quantity,Measure,Calories\nBar,u,,,1,Serving,100\n"],
    ["recipes.csv", "Name,UniqueId,Quantity,Measure,Author,Image Name,Calories\nSoup,u,1,Serving,,,300\n"],
    ["sodium.csv", "Date,Value,Secondary Value,Last Updated\n"],
    ["water-intake.csv", "Date,Value,Secondary Value,Last Updated\n"],
  ]));
  assert.equal(parsed.dailyValues!.length, 1);
  assert.equal(parsed.steps!.length, 1);
  assert.equal(parsed.progressPhotos!.length, 1);
  assert.equal(parsed.customFoods!.length, 1);
  assert.deepEqual(Object.fromEntries(parsed.inventory.map((i) => [i.name, i.status])), {
    "custom-foods.csv": "understood", "daily-values.csv": "understood", "food-logs.csv": "understood", "progress-photos.csv": "understood",
    "recipes.csv": "skipped", "sodium.csv": "skipped", "steps.csv": "understood", "water-intake.csv": "skipped",
  });
});
