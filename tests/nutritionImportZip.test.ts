// Getting an export's files out of a ZIP buffer: text files by lowercase basename, progress photos as bytes, meal
// photos only counted. (Ported from the calorie app's importer, plus the photo handling.)

import { test } from "node:test";
import assert from "node:assert/strict";
import { strToU8, zipSync } from "fflate";
import { NutritionError } from "../nutrition/data/errors.ts";
import { MAX_UNCOMPRESSED_BYTES, decodeText, isZip, readZip } from "../nutrition/import/zip.ts";

const u8 = strToU8;

test("readZip: names become lowercase basenames, nested folders are flattened, BOMs are stripped", () => {
  const zip = zipSync({
    "loseit-export/": new Uint8Array(0),
    "loseit-export/Food-Logs.CSV": u8("﻿Date,Name\n1/5/2026,Oatmeal\n"),
    "loseit-export/deeper/weights.csv": u8("Date,Weight\n1/5/2026,180\n"),
    "daily-calorie-summary.csv": u8("Date,Food cals\n"),
  });
  const { files } = readZip(zip);
  assert.deepEqual([...files.keys()].sort(), ["daily-calorie-summary.csv", "food-logs.csv", "weights.csv"]);
  assert.equal(files.get("food-logs.csv"), "Date,Name\n1/5/2026,Oatmeal\n"); // BOM gone
});

test("readZip: keeps text files, ignores images and archive junk", () => {
  const zip = zipSync({
    "profile.csv": u8("Name,Value\nUnits,Pounds\n"),
    "notes.txt": u8("hello"),
    "logo.png": new Uint8Array([1, 2, 3]),
    "__MACOSX/._profile.csv": u8("junk"),
    "._weights.csv": u8("junk"),
  });
  assert.deepEqual([...readZip(zip).files.keys()].sort(), ["notes.txt", "profile.csv"]);
});

test("readZip: a second file with the same basename keeps its path, so it can't pass for the first", () => {
  const { files } = readZip(zipSync({
    "a/weights.csv": u8("Date,Weight\n1/1/2026,1\n"),
    "b/weights.csv": u8("Date,Weight\n1/1/2026,2\n"),
  }));
  assert.deepEqual([...files.keys()].sort(), ["b/weights.csv", "weights.csv"]);
  assert.match(files.get("weights.csv")!, /,1\n/);
  assert.match(files.get("b/weights.csv")!, /,2\n/);
});

test("readZip: progress photos are kept as exact bytes by basename; meal photos are only counted, never read", () => {
  const photo = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
  const { files, photos, ignoredImages } = readZip(zipSync({
    "progress-photos/progress-photos.csv": u8("Date,Token\n"),
    "progress-photos/2025-06-05-AAAA1111BBBB2222-photo.JPG": photo,
    "progress-photos/2025-07-05-cccc3333dddd4444-photo.webp": new Uint8Array([9]),
    "food-photos/food-photos.csv": u8("Date,Token\n"),
    "food-photos/Dinner(2025-04-24)-ffff-photo.jpg": new Uint8Array([7, 7, 7]),
    "food-photos/Snacks(2026-07-01)-eeee-photo.jpg": new Uint8Array([8, 8]),
    "elsewhere/2025-06-05-zzzz-photo.jpg": new Uint8Array([6]), // not in a progress-photos folder
    "__MACOSX/progress-photos/._2025-06-05-aaaa-photo.jpg": new Uint8Array([5]),
  }));
  assert.deepEqual([...files.keys()].sort(), ["food-photos.csv", "progress-photos.csv"]);
  assert.deepEqual([...photos.keys()].sort(), ["2025-06-05-aaaa1111bbbb2222-photo.jpg", "2025-07-05-cccc3333dddd4444-photo.webp"]);
  assert.deepEqual(Array.from(photos.get("2025-06-05-aaaa1111bbbb2222-photo.jpg")!), Array.from(photo), "the exact bytes");
  assert.equal(ignoredImages, 3, "two meal photos and one stray picture were skipped, not read");
});

test("readZip: something that isn't a ZIP is a 400 with a plain explanation", () => {
  assert.equal(isZip(u8("Date,Name\n")), false);
  assert.throws(() => readZip(u8("Date,Name\n1/5/2026,Oatmeal\n")), (e: any) => e instanceof NutritionError && e.status === 400 && /isn't a ZIP/.test(e.message));
  assert.throws(() => readZip(new Uint8Array(0)), NutritionError);
});

test("readZip: a damaged archive is a 400, not a crash", () => {
  const zip = zipSync({ "food-logs.csv": u8("Date,Name\n1/5/2026,Oatmeal\n".repeat(50)) });
  const broken = zip.slice(0, Math.floor(zip.length / 2)); // keeps the PK header, loses the central directory
  assert.equal(isZip(broken), true);
  assert.throws(() => readZip(broken), (e: any) => e instanceof NutritionError && e.status === 400);
});

test("readZip: an archive that would expand past the limit is refused before anything is inflated", () => {
  assert.equal(MAX_UNCOMPRESSED_BYTES, 100 * 1024 * 1024);
  const zip = zipSync({ "a.csv": new Uint8Array(3000), "b.csv": new Uint8Array(3000) }); // compresses to almost nothing
  assert.throws(() => readZip(zip, 5000), (e: any) => e instanceof NutritionError && e.status === 400 && /expands to more than/.test(e.message));
  assert.equal(readZip(zip, 6000).files.size, 2); // at the limit is fine
  // The guard counts what is actually read (text and progress photos), so a progress photo counts...
  assert.throws(() => readZip(zipSync({ "progress-photos/2025-01-01-abcdef0123456789-photo.jpg": new Uint8Array(6000) }), 5000), NutritionError);
  // ...but a meal photo that is never inflated does not.
  assert.equal(readZip(zipSync({ "food-photos/a-photo.jpg": new Uint8Array(6000), "profile.csv": u8("Name,Value\n") }), 5000).ignoredImages, 1);
});

test("decodeText: UTF-8, UTF-16 with a BOM, and a Windows-1252 fallback", () => {
  assert.equal(decodeText(u8("Café")), "Café");
  const utf16 = new Uint8Array([0xff, 0xfe, ...[..."Date"].flatMap((c) => [c.charCodeAt(0), 0])]);
  assert.equal(decodeText(utf16), "Date");
  assert.equal(decodeText(new Uint8Array([0x43, 0x61, 0x66, 0xe9])), "Café"); // lone 0xE9 is invalid UTF-8
});
