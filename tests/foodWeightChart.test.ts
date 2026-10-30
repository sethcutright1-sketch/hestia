// The weight chart's scaling and the sentences under it (src/sections/food/weightChart.ts, trendText.ts).

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_CHART_SIZE, MAX_DOTS, buildWeightChart, changeText, dateLabel } from "../src/sections/food/weightChart.ts";
import { projectionText, trendLine } from "../src/sections/food/trendText.ts";
import type { TrendPoint } from "../src/sections/food/types.ts";

const pt = (date: string, weightKg: number, trendKg = weightKg): TrendPoint => ({ date, weightKg, trendKg });
const size = { width: 100, height: 80, padLeft: 10, padRight: 10, padTop: 10, padBottom: 20 }; // plot: x 10..90, y 10..60

describe("buildWeightChart", () => {
  test("needs two weigh-in days; one is not a chart", () => {
    assert.equal(buildWeightChart([], "imperial"), null);
    assert.equal(buildWeightChart([pt("2026-10-01", 80)], "imperial"), null);
  });

  test("x is time to scale, y runs from the lowest to the highest value drawn (weigh-ins and trend)", () => {
    // 10 days: day 0, day 2, day 10. Metric so the numbers stay whole.
    const chart = buildWeightChart([pt("2026-10-01", 80, 80), pt("2026-10-03", 78, 79.5), pt("2026-10-11", 76, 78.5)], "metric", size)!;
    assert.deepEqual(chart.dots.map((d) => [d.date, Math.round(d.x * 10) / 10, Math.round(d.y * 10) / 10]), [
      ["2026-10-01", 10, 10], // highest weigh-in: top of the plot
      ["2026-10-03", 26, 35], // 2 of 10 days across; halfway down 80..76
      ["2026-10-11", 90, 60], // lowest: bottom of the plot
    ]);
    assert.equal(chart.rawLine, "10.0,10.0 26.0,35.0 90.0,60.0");
    // The trend line shares the scale: 80 at the top, 79.5 is 0.875 of the way up from 76, 78.5 is 0.625.
    assert.equal(chart.trendLine, "10.0,10.0 26.0,16.3 90.0,28.8");
    assert.deepEqual([chart.top.label, chart.bottom.label], ["80 kg", "76 kg"]);
    assert.deepEqual([chart.startLabel, chart.endLabel], ["Oct 1", "Oct 11"]);
    assert.deepEqual([Math.round(chart.end.x), Math.round(chart.end.y * 10) / 10], [90, 28.8]);
  });

  test("shown in pounds, the labels and values are pounds", () => {
    const chart = buildWeightChart([pt("2026-10-01", 80), pt("2026-10-08", 79)], "imperial", size)!;
    assert.deepEqual([chart.top.label, chart.bottom.label], ["176.4 lb", "174.2 lb"]);
    assert.match(chart.description, /from 176\.4 to 174\.2 lb between Oct 1 and Oct 8; down 2\.2 lb/);
  });

  test("a flat series still draws (a zero range does not divide by zero), and the same day twice cannot happen", () => {
    const chart = buildWeightChart([pt("2026-10-01", 80), pt("2026-10-02", 80)], "metric", size)!;
    assert.ok(Number.isFinite(chart.end.y) && chart.dots.every((d) => Number.isFinite(d.y)));
    assert.match(chart.description, /no change/);
  });

  test("dots are left out past 40 weigh-ins; the lines stay", () => {
    const days = (n: number) => Array.from({ length: n }, (_, i) => pt(new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10), 80 + (i % 3)));
    assert.equal(buildWeightChart(days(MAX_DOTS), "metric")!.dots.length, MAX_DOTS);
    const over = buildWeightChart(days(MAX_DOTS + 1), "metric", DEFAULT_CHART_SIZE)!;
    assert.equal(over.dots.length, 0);
    assert.equal(over.rawLine.split(" ").length, MAX_DOTS + 1);
    assert.equal(over.trendLine.split(" ").length, MAX_DOTS + 1);
  });

  test("changeText gives the change since the first weigh-in drawn", () => {
    assert.equal(changeText([pt("2026-10-01", 80)], "metric"), null);
    assert.equal(changeText([pt("2026-10-01", 80), pt("2026-10-20", 78.6)], "metric"), "-1.4 kg since Oct 1");
    assert.equal(changeText([pt("2026-10-01", 80), pt("2026-10-20", 81)], "metric"), "+1 kg since Oct 1");
    assert.equal(changeText([pt("2026-10-01", 80), pt("2026-10-20", 80)], "metric"), "0 kg since Oct 1");
    assert.equal(changeText([pt("2026-10-01", 80), pt("2026-10-20", 79)], "imperial"), "-2.2 lb since Oct 1");
  });

  test("across years the date says which year, so it can't be confused with the lost-so-far headline", () => {
    assert.equal(changeText([pt("2024-06-01", 100), pt("2026-10-15", 72.6)], "metric"), "-27.4 kg since Jun 1, 2024");
    assert.equal(dateLabel("2024-06-01", "2026-10-15"), "Jun 1, 2024");
    assert.equal(dateLabel("2026-06-01", "2026-10-15"), "Jun 1");
  });
});

describe("the sentences", () => {
  test("the trend line", () => {
    assert.equal(trendLine(83.15, "imperial"), "Trend weight: 183.3 lb");
    assert.equal(trendLine(83.15, "metric"), "Trend weight: 83.2 kg");
  });

  const base = { trendKg: 83.15, goalKg: 79.38, planLbPerWeek: 1, system: "imperial" as const };
  test("the goal projection in the calorie app's words", () => {
    assert.equal(projectionText({ ...base, projection: { date: "2026-12-11", reason: "ok" } }), "At 1 lb/week you'd reach 175 lb around Dec 11, 2026.");
    assert.equal(
      projectionText({ ...base, system: "metric", planLbPerWeek: 2, goalKg: 70.5, projection: { date: "2027-03-03", reason: "ok" } }),
      "At 0.91 kg/week you'd reach 70.5 kg around Mar 3, 2027.",
    );
  });

  test("and why there is no date", () => {
    assert.equal(projectionText({ ...base, trendKg: null, projection: null }), "");
    assert.match(projectionText({ ...base, goalKg: null, planLbPerWeek: null, projection: null }), /Set a goal weight in Food settings/);
    assert.match(projectionText({ ...base, planLbPerWeek: 0, projection: { date: null, reason: "no-plan" } }), /other than 'Maintain weight'/);
    assert.match(projectionText({ ...base, projection: { date: null, reason: "reached" } }), /at your goal weight/);
    assert.match(projectionText({ ...base, projection: { date: null, reason: "wrong-direction" } }), /moves away from your goal weight/);
    assert.match(projectionText({ ...base, projection: { date: null, reason: "too-far" } }), /more than 5 years away/);
    assert.match(projectionText({ ...base, projection: null }), /other than 'Maintain weight'/, "a plan the server could not project");
  });
});
