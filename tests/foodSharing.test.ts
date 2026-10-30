// Who sees what, as the screen words and uses it (src/sections/food/sharing.ts). The server enforces the rules
// (tests/nutritionVisibility.test.ts); this is only about not offering what it would refuse.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  LEVELS, PHOTOS_NEVER_SHARED, chipLabel, levelLabel, progressNotShared, stillShared, switcherPeople, switcherText, viewShape, viewerBanner,
} from "../src/sections/food/sharing.ts";
import type { Sharer } from "../src/sections/food/types.ts";

const bea: Sharer = { userId: "u-bea", name: "Bea", level: "totals" };
const dad: Sharer = { userId: "u-dad", name: "Dad", level: "everything" };

test("three levels, in order, nothing first (the default), each described in plain language", () => {
  assert.deepEqual(LEVELS.map((l) => l.value), ["nothing", "totals", "everything"]);
  assert.deepEqual(LEVELS.map((l) => l.label), ["Nothing", "Daily totals", "Everything"]);
  assert.match(LEVELS[0].detail, /default/);
  assert.match(LEVELS[1].detail, /calories eaten against your calorie budget/);
  assert.match(LEVELS[1].detail, /No foods/);
  assert.match(LEVELS[2].detail, /diary entries and exercise.*weigh-ins and trend.*steps/);
  assert.match(LEVELS[2].detail, /cannot change anything/);
  assert.match(PHOTOS_NEVER_SHARED, /Progress photos are never shared/);
  assert.equal(levelLabel("totals"), "Daily totals");
});

test("what a viewer's screen shows at each level: totals = the top card and streak only", () => {
  assert.deepEqual(viewShape("totals"), { summary: true, entries: false, progress: false });
  assert.deepEqual(viewShape("everything"), { summary: true, entries: true, progress: true });
  assert.match(viewerBanner("Bea", "totals"), /Bea shares daily totals.*calorie budget.*streak/);
  assert.match(viewerBanner("Dad", "everything"), /Dad shares everything with you, read-only\. Photos are never shared\./);
  assert.equal(progressNotShared("Bea"), "Bea doesn't share weight or steps with you.");
});

test("the switcher exists only when somebody shares: none = no switcher", () => {
  assert.equal(switcherPeople([]), null);
  assert.deepEqual(switcherPeople([bea]), [bea]);
  assert.equal(switcherText([bea]), "Me · Bea");
  assert.equal(switcherText([bea, dad]), "Me · Bea · Dad");
  assert.equal(chipLabel("Alex", true), "Me");
  assert.equal(chipLabel("Bea", false), "Bea");
});

test("a person who stops sharing drops out, and the screen goes back to Me", () => {
  assert.equal(stillShared([bea, dad], null), true, "viewing Me is always fine");
  assert.equal(stillShared([bea, dad], "u-bea"), true);
  assert.equal(stillShared([dad], "u-bea"), false);
  assert.equal(stillShared([], "u-bea"), false);
});
