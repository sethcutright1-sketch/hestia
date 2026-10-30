// "Lost so far" above the weight chart: the maths and the words (src/sections/food/weightLoss.ts), and the start-day box's
// request body. Pure, so no browser.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { lossSummary, weightStartBody } from "../src/sections/food/weightLoss.ts";
import type { WeightStart } from "../src/sections/food/types.ts";

const start = (trendKg: number | null, over: Partial<WeightStart> = {}): WeightStart => ({ date: "2026-01-03", trendKg, weighedOn: trendKg === null ? null : "2026-01-03", later: false, ...over });

describe("lossSummary", () => {
  test("no start day: no number at all, just the 'unset' state the link is shown for", () => {
    assert.deepEqual(lossSummary(null, 80, 70, "imperial"), { kind: "unset" });
    assert.deepEqual(lossSummary(null, null, null, "metric"), { kind: "unset" });
  });

  test("a start day but no weigh-ins to measure with", () => {
    assert.deepEqual(lossSummary(start(null), null, null, "imperial"), { kind: "no-weigh-ins", text: "No weigh-ins yet to measure from Jan 3, 2026." });
    assert.equal(lossSummary(start(85), null, null, "imperial").kind, "no-weigh-ins", "no trend now");
  });

  test("lost: 'Lost 12.4 lb since Jan 3, 2026', in pounds from kilograms rounded once", () => {
    const s = lossSummary(start(85), 79.37, null, "imperial");
    assert.equal(s.kind === "ok" && s.headline, "Lost 12.4 lb since Jan 3, 2026");
    assert.equal(s.kind === "ok" && s.direction, "down");
    assert.equal(s.kind === "ok" && s.goalLine, null, "no goal weight: no 'to go'");
    assert.equal(s.kind === "ok" && s.note, null);
  });

  test("in kilograms the same loss reads in kilograms", () => {
    const s = lossSummary(start(85), 79.37, null, "metric");
    assert.equal(s.kind === "ok" && s.headline, "Lost 5.6 kg since Jan 3, 2026");
  });

  test("up: 'Up 2.2 lb since ...' when the trend is heavier than it was", () => {
    const s = lossSummary(start(80), 81, null, "imperial");
    assert.equal(s.kind === "ok" && s.headline, "Up 2.2 lb since Jan 3, 2026");
    assert.equal(s.kind === "ok" && s.direction, "up");
  });

  test("no change: a difference that rounds to zero is not 'Lost 0 lb'", () => {
    const s = lossSummary(start(80), 80.02, null, "imperial");
    assert.equal(s.kind === "ok" && s.headline, "No change since Jan 3, 2026");
    assert.equal(s.kind === "ok" && s.direction, "same");
  });

  test("the goal: 'to go' to the goal weight in the person's units", () => {
    const lb = lossSummary(start(85), 83.2, 79.38, "imperial");
    assert.equal(lb.kind === "ok" && lb.goalLine, "8.4 lb to go to 175 lb");
    assert.equal(lb.kind === "ok" && lb.goalReached, false);
    const kg = lossSummary(start(85), 83.2, 79.38, "metric");
    assert.equal(kg.kind === "ok" && kg.goalLine, "3.8 kg to go to 79.4 kg");
  });

  test("goal reached: at or below the goal weight (judged to the one decimal shown)", () => {
    for (const now of [78, 79.38, 79.39]) {
      const s = lossSummary(start(85), now, 79.38, "imperial");
      assert.equal(s.kind === "ok" && s.goalLine, "Goal reached", String(now));
      assert.equal(s.kind === "ok" && s.goalReached, true);
    }
    const near = lossSummary(start(85), 79.5, 79.38, "imperial");
    assert.equal(near.kind === "ok" && near.goalLine, "0.3 lb to go to 175 lb", "0.26 lb above is still to go");
  });

  test("a goal ABOVE where the person started is a gain goal: reached at or above it, 'to go' counts up", () => {
    const toGo = lossSummary(start(70), 72, 75, "metric");
    assert.equal(toGo.kind === "ok" && toGo.goalLine, "3 kg to go to 75 kg");
    assert.equal(toGo.kind === "ok" && toGo.headline, "Up 2 kg since Jan 3, 2026");
    assert.equal(lossSummary(start(70), 76, 75, "metric").kind === "ok" && (lossSummary(start(70), 76, 75, "metric") as any).goalLine, "Goal reached");
  });

  test("no weigh-in on or before the start day: the first one after it is used, and the wording says so", () => {
    const s = lossSummary(start(90, { later: true, weighedOn: "2026-01-09" }), 85, null, "metric");
    assert.equal(s.kind === "ok" && s.headline, "Lost 5 kg since Jan 3, 2026");
    assert.equal(s.kind === "ok" && s.note, "You had no weigh-in by then, so this is measured from your first one, on Jan 9, 2026.");
  });

  test("a weigh-in before the start day is just used, with no note", () => {
    const s = lossSummary(start(90, { weighedOn: "2025-12-28" }), 85, null, "metric");
    assert.equal(s.kind === "ok" && s.note, null);
  });
});

describe("weightStartBody", () => {
  const today = "2026-03-10";
  const earliest = "2000-01-01";
  test("empty clears the start day", () => {
    assert.deepEqual(weightStartBody("", today, earliest), { ok: true, body: { weightStartDate: null } });
    assert.deepEqual(weightStartBody("  ", today, earliest), { ok: true, body: { weightStartDate: null } });
  });
  test("a real day from 2000 up to today is accepted, trimmed", () => {
    assert.deepEqual(weightStartBody(" 2026-01-03 ", today, earliest), { ok: true, body: { weightStartDate: "2026-01-03" } });
    assert.equal(weightStartBody(today, today, earliest).ok, true);
    assert.equal(weightStartBody(earliest, today, earliest).ok, true);
  });
  test("anything else is refused with a sentence", () => {
    assert.deepEqual(weightStartBody("2026-02-30", today, earliest), { ok: false, error: "Pick a date." });
    assert.deepEqual(weightStartBody("Jan 3", today, earliest), { ok: false, error: "Pick a date." });
    assert.deepEqual(weightStartBody("2026-03-11", today, earliest), { ok: false, error: "Pick a day that has already happened." });
    assert.deepEqual(weightStartBody("1999-12-31", today, earliest), { ok: false, error: "Pick a date after Jan 1, 2000." });
  });
});
