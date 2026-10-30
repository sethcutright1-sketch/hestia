// The steps chart's days, bars and sentences (src/sections/food/stepsChart.ts).

import { test } from "node:test";
import assert from "node:assert/strict";

import { CHART_DAYS, averageSteps, averageText, buildStepsChart, lastDays, stepsText } from "../src/sections/food/stepsChart.ts";

const size = { width: 300, height: 100, padTop: 10, padBottom: 20, gap: 0.2 }; // 30 slots of 10px; plot height 70, baseline y = 80

test("lastDays: the 30 days ending today, oldest first, a gap for a day with nothing entered", () => {
  const days = lastDays([{ date: "2026-10-15", steps: 8000 }, { date: "2026-10-13", steps: 0 }, { date: "2026-08-01", steps: 999 }], "2026-10-15");
  assert.equal(days.length, CHART_DAYS);
  assert.deepEqual([days[0].date, days[29].date], ["2026-09-16", "2026-10-15"]);
  assert.deepEqual(days.filter((d) => d.steps !== null).map((d) => [d.date, d.steps]), [["2026-10-13", 0], ["2026-10-15", 8000]], "0 is a real entry; the old row is outside the window");
  assert.equal(days[28].steps, null, "yesterday has nothing entered: null, not 0");
  assert.equal(lastDays([], "2026-03-01", 3).map((d) => d.date).join(), "2026-02-27,2026-02-28,2026-03-01");
});

test("buildStepsChart: the biggest day fills the height, a missing day has no bar, a tiny day still shows", () => {
  const days = lastDays([{ date: "2026-10-15", steps: 10000 }, { date: "2026-10-14", steps: 5000 }, { date: "2026-10-12", steps: 1 }], "2026-10-15");
  const chart = buildStepsChart(days, size);
  assert.equal(chart.max, 10000);
  assert.equal(chart.baselineY, 80);
  const bar = (date: string) => chart.bars.find((b) => b.date === date)!;
  assert.deepEqual([bar("2026-10-15").height, bar("2026-10-15").y, bar("2026-10-14").height, bar("2026-10-14").y], [70, 10, 35, 45]);
  assert.equal(bar("2026-10-12").height, 1, "1 step is still a visible sliver");
  assert.equal(bar("2026-10-13").height, 0);
  assert.ok(Math.abs(bar("2026-10-15").x - (29 * 10 + 1)) < 1e-9 && Math.abs(bar("2026-10-15").width - 8) < 1e-9);
  assert.deepEqual([chart.startLabel, chart.endLabel], ["Sep 16", "Oct 15"]);
});

test("buildStepsChart: nothing entered at all does not divide by zero", () => {
  const chart = buildStepsChart(lastDays([], "2026-10-15"), size);
  assert.equal(chart.max, 1);
  assert.ok(chart.bars.every((b) => b.height === 0 && Number.isFinite(b.y)));
  assert.equal(buildStepsChart([], size).bars.length, 0);
});

test("the average counts only the days with steps entered, and the sentence says how many", () => {
  const days = lastDays([{ date: "2026-10-15", steps: 9000 }, { date: "2026-10-14", steps: 6000 }, { date: "2026-10-13", steps: 0 }], "2026-10-15");
  assert.equal(averageSteps(days), 5000);
  assert.equal(averageText(days), "Average 5,000 a day over 3 days with steps entered.");
  assert.equal(averageText(lastDays([{ date: "2026-10-15", steps: 7420 }], "2026-10-15")), "Average 7,420 a day over 1 day with steps entered.");
  assert.equal(averageSteps(lastDays([], "2026-10-15")), null);
  assert.equal(averageText(lastDays([], "2026-10-15")), null);
  assert.equal(stepsText(8123), "8,123");
  assert.equal(stepsText(999.6), "1,000");
});
