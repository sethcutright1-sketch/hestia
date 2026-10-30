// The goal line and the projection on the weight chart: the rules (src/sections/food/goalLine.ts) and where they put things
// inside buildWeightChart (weightChart.ts). Metric throughout so the numbers stay whole; the small chart has a plot
// of x 10..90 and y 10..60.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { FUTURE_PAD_FRACTION, MIN_FUTURE_PAD_DAYS, MIN_NEAR_SPAN, futureDays, goalOffScaleText, projectionEnd, scaleWithGoal } from "../src/sections/food/goalLine.ts";
import { DEFAULT_CHART_SIZE, buildWeightChart } from "../src/sections/food/weightChart.ts";
import type { TrendPoint } from "../src/sections/food/types.ts";

const pt = (date: string, weightKg: number, trendKg = weightKg): TrendPoint => ({ date, weightKg, trendKg });
const size = { width: 100, height: 80, padLeft: 10, padRight: 10, padTop: 10, padBottom: 20 };
const r1 = (n: number) => Math.round(n * 10) / 10;

describe("scaleWithGoal: the goal joins the weight scale when it is inside or near", () => {
  test("inside the weights: shown, the scale does not move", () => {
    assert.deepEqual(scaleWithGoal(76, 80, 78, "metric"), { lo: 76, hi: 80, goalShown: true });
    assert.deepEqual(scaleWithGoal(76, 80, 76, "metric"), { lo: 76, hi: 80, goalShown: true }, "exactly on an edge");
  });
  test("outside but within one span of the weights (at least 2 kg / 4 lb): shown, and the scale grows to hold it", () => {
    assert.deepEqual(scaleWithGoal(76, 80, 72, "metric"), { lo: 72, hi: 80, goalShown: true }, "4 kg below a 4 kg span");
    assert.deepEqual(scaleWithGoal(76, 80, 84, "metric"), { lo: 76, hi: 84, goalShown: true });
    assert.deepEqual(scaleWithGoal(80, 80.5, 78.5, "metric"), { lo: 78.5, hi: 80.5, goalShown: true }, "a nearly flat chart still reaches 2 kg");
    assert.deepEqual(scaleWithGoal(170, 172, 167, "imperial"), { lo: 167, hi: 172, goalShown: true }, "4 lb floor in pounds");
  });
  test("further away than that: not shown and the scale stays on the weights", () => {
    assert.deepEqual(scaleWithGoal(76, 80, 71.9, "metric"), { lo: 76, hi: 80, goalShown: false });
    assert.deepEqual(scaleWithGoal(76, 80, 90, "metric"), { lo: 76, hi: 80, goalShown: false });
    assert.deepEqual(scaleWithGoal(80, 80.5, 77.4, "metric"), { lo: 80, hi: 80.5, goalShown: false });
    assert.deepEqual(scaleWithGoal(170, 172, 165, "imperial"), { lo: 170, hi: 172, goalShown: false });
  });
  test("no goal weight, no goal line", () => {
    assert.deepEqual(scaleWithGoal(76, 80, null, "metric"), { lo: 76, hi: 80, goalShown: false });
    assert.deepEqual(scaleWithGoal(76, 80, NaN, "metric"), { lo: 76, hi: 80, goalShown: false });
  });
  test("the weigh-ins keep at least half of the height when the scale grows", () => {
    for (const goal of [72, 84, 70.001]) {
      const s = scaleWithGoal(76, 80, goal, "metric");
      if (s.goalShown) assert.ok(4 / (s.hi - s.lo) >= 0.5, String(goal));
    }
  });
  test("the constants the wording promises", () => {
    assert.deepEqual(MIN_NEAR_SPAN, { imperial: 4, metric: 2 });
  });
});

describe("futureDays and projectionEnd: the projection must end inside the chart's future padding", () => {
  test("a quarter of the chart's width in days, never under 14", () => {
    assert.equal(FUTURE_PAD_FRACTION, 0.25);
    assert.equal(MIN_FUTURE_PAD_DAYS, 14);
    assert.deepEqual([0, 30, 56, 90, 365, 2000].map(futureDays), [14, 14, 14, 22, 91, 500]);
  });
  const ok = { date: "2026-10-30", reason: "ok" as const };
  test("drawn when the plan reaches the goal inside the padding", () => {
    assert.equal(projectionEnd({ projection: ok, goalShown: true, chartStart: "2026-07-17", today: "2026-10-15" }), "2026-10-30", "15 days ahead of a 90-day chart (22 allowed)");
  });
  test("not drawn past the padding, in the past, or without a goal line", () => {
    assert.equal(projectionEnd({ projection: { date: "2026-12-01", reason: "ok" }, goalShown: true, chartStart: "2026-07-17", today: "2026-10-15" }), null, "47 days ahead is beyond 22");
    assert.equal(projectionEnd({ projection: { date: "2026-10-01", reason: "ok" }, goalShown: true, chartStart: "2026-07-17", today: "2026-10-15" }), null);
    assert.equal(projectionEnd({ projection: ok, goalShown: false, chartStart: "2026-07-17", today: "2026-10-15" }), null);
    assert.equal(projectionEnd({ projection: null, goalShown: true, chartStart: "2026-07-17", today: "2026-10-15" }), null);
  });
  test("only while the plan points toward the goal: every other server reason gives no line", () => {
    for (const reason of ["no-plan", "reached", "wrong-direction", "too-far"] as const) {
      assert.equal(projectionEnd({ projection: { date: null, reason }, goalShown: true, chartStart: "2026-07-17", today: "2026-10-15" }), null, reason);
      assert.equal(projectionEnd({ projection: { date: "2026-10-30", reason }, goalShown: true, chartStart: "2026-07-17", today: "2026-10-15" }), null, `${reason} even with a date`);
    }
  });
  test("goalOffScaleText says which side", () => {
    assert.equal(goalOffScaleText("60 kg", 60, 76, 80), "Your goal weight, 60 kg, is below this chart.");
    assert.equal(goalOffScaleText("95 kg", 95, 76, 80), "Your goal weight, 95 kg, is above this chart.");
    assert.equal(goalOffScaleText("78 kg", 78, 76, 80), "");
  });
});

describe("buildWeightChart with a goal", () => {
  const two = [pt("2026-10-01", 80), pt("2026-10-15", 76)];

  test("a goal inside the weights: a horizontal line at its height, the scale unchanged", () => {
    const chart = buildWeightChart(two, "metric", size, { today: "2026-10-15", goal: { goalKg: 78, projection: null } })!;
    assert.deepEqual([chart.goalLine!.y, chart.goalLine!.x1, chart.goalLine!.x2, chart.goalLine!.label], [35, 10, 90, "78 kg"]);
    assert.deepEqual([chart.top.label, chart.bottom.label], ["80 kg", "76 kg"]);
    assert.equal(chart.goalNote, "");
    assert.equal(chart.projection, null);
  });

  test("a goal just below: the scale grows to hold it, the weigh-ins move up, the line sits on the bottom edge", () => {
    const chart = buildWeightChart(two, "metric", size, { today: "2026-10-15", goal: { goalKg: 74, projection: null } })!;
    assert.equal(chart.goalLine!.y, 60, "the lowest value on the scale is the goal");
    assert.deepEqual([chart.top.label, chart.bottom.label], ["80 kg", "74 kg"]);
    assert.equal(r1(chart.end.y), 43.3, "76 kg is a third of the way up 74..80, not at the bottom any more");
  });

  test("a goal far away: no line, the scale stays on the weights, and the note says where it is", () => {
    const chart = buildWeightChart(two, "metric", size, { today: "2026-10-15", goal: { goalKg: 60, projection: null } })!;
    assert.equal(chart.goalLine, null);
    assert.deepEqual([chart.top.label, chart.bottom.label], ["80 kg", "76 kg"]);
    assert.equal(chart.goalNote, "Your goal weight, 60 kg, is below this chart.");
  });

  test("no goal weight set: nothing extra", () => {
    const chart = buildWeightChart(two, "metric", size, { today: "2026-10-15", goal: { goalKg: null, projection: null } })!;
    assert.deepEqual([chart.goalLine, chart.goalNote, chart.projection], [null, "", null]);
  });

  test("the goal is shown in the person's units", () => {
    const chart = buildWeightChart([pt("2026-10-01", 80), pt("2026-10-15", 78)], "imperial", size, { goal: { goalKg: 77.11, projection: null } })!;
    assert.equal(chart.goalLine!.label, "170 lb");
    assert.match(chart.description, /The goal weight is 170 lb\./);
  });

  test("without extras it is the plain chart: no goal, no projection, no today tick", () => {
    const chart = buildWeightChart(two, "metric", size)!;
    assert.deepEqual([chart.goalLine, chart.projection, chart.todayMark, chart.goalNote], [null, null, null, ""]);
    assert.deepEqual([chart.startLabel, chart.endLabel], ["Oct 1", "Oct 15"]);
  });
});

describe("buildWeightChart: the projection line", () => {
  // 3M range starting 2026-07-17; weighed from 07-20 (82 kg) to today 10-15 (trend 80); goal 78; the plan reaches it on 10-30.
  const points = [pt("2026-07-20", 82), pt("2026-10-15", 80)];
  const base = { rangeStart: "2026-07-17", today: "2026-10-15" };
  const plan = { goalKg: 78, projection: { date: "2026-10-30", reason: "ok" as const } };

  test("a dotted line from the end of the trend to the goal weight on the day the plan reaches it; the axis runs on to that day", () => {
    const chart = buildWeightChart(points, "metric", size, { ...base, goal: plan })!;
    const p = chart.projection!;
    assert.equal(p.date, "2026-10-30");
    assert.deepEqual([r1(p.x1), r1(p.y1)], [r1(chart.end.x), r1(chart.end.y)], "it starts where the bold trend line ends");
    assert.equal(r1(p.x2), 90, "and ends at the right edge: the last day of the axis");
    assert.equal(p.y2, chart.goalLine!.y, "on the goal line");
    assert.deepEqual([chart.startLabel, chart.endLabel], ["Jul 17", "Oct 30"], "the axis labels are the range's first day and the projected day");
    // 105 days across 80 units: today (day 90) is at 10 + 90/105 x 80.
    assert.equal(r1(chart.end.x), r1(10 + (90 / 105) * 80));
  });

  test("it follows the plan: reaching the goal takes (trend - goal) over the plan's rate, and the slope is that", () => {
    // 2 kg in 15 days from the trend's end (day 90) to the goal (day 105).
    const chart = buildWeightChart(points, "metric", size, { ...base, goal: plan })!;
    const p = chart.projection!;
    const unitsPerDay = (p.x2 - p.x1) / 15;
    assert.equal(r1(unitsPerDay * 105), 80, "x covers the 105-day axis");
    assert.ok(p.y2 > p.y1, "heading down toward a lower goal (SVG y grows downward)");
  });

  test("beyond the future padding: no dotted line at all (and the axis ends today)", () => {
    const far = buildWeightChart(points, "metric", size, { ...base, goal: { goalKg: 78, projection: { date: "2026-12-30", reason: "ok" } } })!;
    assert.equal(far.projection, null);
    assert.equal(far.endLabel, "Oct 15");
    assert.ok(far.goalLine, "the goal line itself stays");
  });

  test("the plan moves away from the goal, the goal is reached, there is no plan, or it is over 5 years out: no line", () => {
    for (const reason of ["wrong-direction", "reached", "no-plan", "too-far"] as const) {
      const chart = buildWeightChart(points, "metric", size, { ...base, goal: { goalKg: 78, projection: { date: null, reason } } })!;
      assert.equal(chart.projection, null, reason);
      assert.equal(chart.endLabel, "Oct 15", reason);
    }
  });

  test("a projection needs today: without it there is nothing to measure the padding from", () => {
    const chart = buildWeightChart(points, "metric", size, { goal: plan })!;
    assert.equal(chart.projection, null);
  });

  test("a goal too far off the scale has no line, so no projection either", () => {
    const chart = buildWeightChart(points, "metric", size, { ...base, goal: { goalKg: 60, projection: { date: "2026-10-30", reason: "ok" } } })!;
    assert.deepEqual([chart.goalLine, chart.projection], [null, null]);
  });

  test("a 'Today' tick appears only when the projection moves today away from the right edge with room on both sides", () => {
    const wide = buildWeightChart([pt("2026-01-02", 82), pt("2026-10-15", 80)], "metric", DEFAULT_CHART_SIZE, {
      rangeStart: "2026-01-01", today: "2026-10-15", goal: { goalKg: 78, projection: { date: "2026-12-20", reason: "ok" } },
    })!;
    assert.ok(wide.projection);
    assert.equal(wide.todayMark!.label, "Today");
    assert.ok(wide.todayMark!.x > 44 && wide.todayMark!.x < DEFAULT_CHART_SIZE.width - 44);
    assert.equal(wide.endLabel, "Dec 20");
    // On the narrow test chart there is no room for it.
    assert.equal(buildWeightChart(points, "metric", size, { ...base, goal: plan })!.todayMark, null);
    // And no tick without a projection.
    assert.equal(buildWeightChart(points, "metric", size, { ...base, goal: null })!.todayMark, null);
  });
});

describe("buildWeightChart: the axis runs from the range's start to today", () => {
  test("weigh-ins that fill the range: the first label is the range's first day, the last is today", () => {
    const chart = buildWeightChart([pt("2026-09-17", 80), pt("2026-10-12", 79)], "metric", size, { rangeStart: "2026-09-15", today: "2026-10-15" })!;
    assert.deepEqual([chart.startLabel, chart.endLabel], ["Sep 15", "Oct 15"]);
    // Sep 17 is 2 of 30 days along, Oct 12 is 27 of 30.
    assert.equal(r1(chart.dots[0].x), r1(10 + (2 / 30) * 80));
    assert.equal(r1(chart.dots[1].x), r1(10 + (27 / 30) * 80));
  });

  test("a history shorter than the range starts at the first weigh-in, so the chart is not mostly empty", () => {
    const chart = buildWeightChart([pt("2026-10-03", 80), pt("2026-10-12", 79)], "metric", size, { rangeStart: "2025-10-15", today: "2026-10-15" })!;
    assert.deepEqual([chart.startLabel, chart.endLabel], ["Oct 3", "Oct 15"]);
  });

  test("All has no range start: the first weigh-in to today", () => {
    const chart = buildWeightChart([pt("2019-03-02", 100), pt("2026-10-12", 79)], "metric", size, { rangeStart: null, today: "2026-10-15" })!;
    // Across years the start label carries its year (review fix: a bare "Mar 2" read as this year's).
    assert.deepEqual([chart.startLabel, chart.endLabel], ["Mar 2, 2019", "Oct 15"]);
  });

  test("the last weigh-in before today leaves room on the right, and a clock behind the data cannot shrink the axis", () => {
    const early = buildWeightChart([pt("2026-10-01", 80), pt("2026-10-05", 79)], "metric", size, { today: "2026-10-15" })!;
    assert.equal(r1(early.end.x), r1(10 + (4 / 14) * 80));
    const behind = buildWeightChart([pt("2026-10-01", 80), pt("2026-10-05", 79)], "metric", size, { today: "2026-09-01" })!;
    assert.equal(behind.endLabel, "Oct 5");
  });
});
