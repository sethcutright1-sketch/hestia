// Progress photos grouped for the grid (src/sections/food/photoGroups.ts).

import { test } from "node:test";
import assert from "node:assert/strict";

import { groupPhotosByMonth, monthLabel, sizeText } from "../src/sections/food/photoGroups.ts";
import type { Photo } from "../src/sections/food/types.ts";

const photo = (id: string, takenOn: string, createdAt = "2026-10-15T12:00:00.000Z"): Photo =>
  ({ id, takenOn, mime: "image/jpeg", width: 1200, height: 1600, source: "manual", size: 400_000, createdAt });

test("photos group by month, newest first, and the same day orders by upload time", () => {
  const groups = groupPhotosByMonth([
    photo("a", "2026-09-30"), photo("b", "2026-10-02"), photo("c", "2026-10-12", "2026-10-12T08:00:00.000Z"), photo("d", "2026-10-12", "2026-10-12T18:00:00.000Z"), photo("e", "2025-12-25"),
  ]);
  assert.deepEqual(groups.map((g) => [g.key, g.label, g.photos.map((p) => p.id)]), [
    ["2026-10", "October 2026", ["d", "c", "b"]],
    ["2026-09", "September 2026", ["a"]],
    ["2025-12", "December 2025", ["e"]],
  ]);
  assert.deepEqual(groupPhotosByMonth([]), []);
});

test("labels", () => {
  assert.equal(monthLabel("2026-01-05"), "January 2026");
  assert.equal(sizeText(412 * 1024), "412 KB");
  assert.equal(sizeText(100), "1 KB");
  assert.equal(sizeText(1.3 * 1024 * 1024), "1.3 MB");
});
