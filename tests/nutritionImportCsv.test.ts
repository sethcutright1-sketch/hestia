// CSV parser and header-alias resolution.

import { test } from "node:test";
import assert from "node:assert/strict";
import { cell, normHeader, parseCsv, parseCsvGrid, resolveColumns } from "../nutrition/import/csv.ts";

test("parseCsvGrid: plain rows, CRLF, LF and lone CR line ends all read the same", () => {
  const want = [["a", "b"], ["1", "2"], ["3", "4"]];
  assert.deepEqual(parseCsvGrid("a,b\n1,2\n3,4\n"), want);
  assert.deepEqual(parseCsvGrid("a,b\r\n1,2\r\n3,4\r\n"), want);
  assert.deepEqual(parseCsvGrid("a,b\r1,2\r3,4"), want); // no trailing newline either
});

test("parseCsvGrid: a UTF-8 BOM is stripped, whether or not the first cell is quoted", () => {
  assert.deepEqual(parseCsvGrid("﻿Date,Name\n1,2"), [["Date", "Name"], ["1", "2"]]);
  assert.deepEqual(parseCsvGrid('﻿"Date",Name\n1,2'), [["Date", "Name"], ["1", "2"]]);
  assert.deepEqual(parseCsv("﻿Date,Name\n1,2").keys, ["date", "name"]);
});

test("parseCsvGrid: quoted commas, doubled quotes and line breaks inside a field", () => {
  const grid = parseCsvGrid('Name,Note\r\n"Mac, Cheese","say ""hi"""\r\n"two\r\nlines",x\r\n');
  assert.deepEqual(grid, [["Name", "Note"], ["Mac, Cheese", 'say "hi"'], ["two\r\nlines", "x"]]);
});

test("parseCsvGrid: a quote in the middle of an unquoted cell is literal; spaces before an opening quote are tolerated", () => {
  assert.deepEqual(parseCsvGrid('5" pizza,x\n'), [['5" pizza', "x"]]);
  assert.deepEqual(parseCsvGrid('a, "b,c",d\n'), [["a", "b,c", "d"]]);
});

test("parseCsvGrid: blank lines vanish but empty cells and a trailing empty cell survive", () => {
  assert.deepEqual(parseCsvGrid("a,b,c\n\n1,,3\n,\n4,5,\n"), [["a", "b", "c"], ["1", "", "3"], ["", ""], ["4", "5", ""]]);
  assert.deepEqual(parseCsvGrid(""), []);
  assert.deepEqual(parseCsvGrid("\n\n"), []);
  assert.deepEqual(parseCsvGrid('"",x'), [["", "x"]]);
});

test("parseCsvGrid: an unterminated quote swallows the rest rather than looping or throwing", () => {
  assert.deepEqual(parseCsvGrid('a,"b\nc'), [["a", "b\nc"]]);
});

test("normHeader lowercases, trims and collapses spaces", () => {
  assert.equal(normHeader("  Saturated   Fat (g) "), "saturated fat (g)");
  assert.equal(normHeader("﻿Date"), "date");
});

test("parseCsv keys records by normalized header, pads short rows, drops extras and numbers records for messages", () => {
  const t = parseCsv("Date, Fat (g) ,Name\n1/5/2026,3.6\n1/6/2026,1,Eggs,STRAY\n\n1/7/2026,2,Toast\n");
  assert.deepEqual(t.headers, ["Date", "Fat (g)", "Name"]);
  assert.deepEqual(t.keys, ["date", "fat (g)", "name"]);
  assert.deepEqual(t.rows[0], { date: "1/5/2026", "fat (g)": "3.6", name: "" });
  assert.deepEqual(t.rows[1], { date: "1/6/2026", "fat (g)": "1", name: "Eggs" });
  assert.equal(t.raggedRows, 1); // STRAY was dropped
  assert.deepEqual(t.rowNumbers, [2, 3, 4]); // blank line skipped; the header is record 1
});

test("parseCsv: duplicate headers keep the first column unless it is blank in that row", () => {
  const t = parseCsv("Name,Name\nA,B\n,C\n");
  assert.deepEqual(t.rows, [{ name: "A" }, { name: "C" }]);
});

test("parseCsv: a header-only or empty file has no rows", () => {
  assert.equal(parseCsv("Date,Name\n").rows.length, 0);
  assert.deepEqual(parseCsv(""), { headers: [], keys: [], rows: [], rowNumbers: [], raggedRows: 0 });
});

test("resolveColumns: exact match beats a looser one, aliases are tried in order, units in parentheses are optional", () => {
  const keys = ["date", "meal", "sugar", "fat (g)", "saturated fat (g)", "calories (kcal)"];
  const col = resolveColumns(keys, {
    date: ["date"],
    type: ["type", "meal", "mealtype"],
    sugars: ["sugars (g)", "sugars", "sugar"],
    fat: ["fat (g)", "fat"],
    satFat: ["saturated fat", "sat fat"],
    calories: ["calories"],
    missing: ["nope"],
  });
  assert.deepEqual(col, { date: "date", type: "meal", sugars: "sugar", fat: "fat (g)", satFat: "saturated fat (g)", calories: "calories (kcal)", missing: undefined });
});

test("resolveColumns: punctuation and spacing don't matter, and one header is never claimed twice", () => {
  const col = resolveColumns(["meal_type", "food  name"], { type: ["meal type"], name: ["foodname", "meal type"], other: ["meal type"] });
  assert.equal(col.type, "meal_type");
  assert.equal(col.name, "food  name");
  assert.equal(col.other, undefined); // meal_type already belongs to `type`
});

test("cell tolerates a column that doesn't exist", () => {
  assert.equal(cell({ a: "1" }, "a"), "1");
  assert.equal(cell({ a: "1" }, "b"), "");
  assert.equal(cell({ a: "1" }, undefined), "");
});
