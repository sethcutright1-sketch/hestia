// Render smoke tests for the Weight & progress pieces that are pure of the network: the charts, the person
// switcher and the top card's "what is missing" buttons are rendered to static HTML on the server, so a crash or a
// wrong sentence shows up without a browser. (The full screens are checked in the browser by the reviewer.)

import { test } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import SlotCard from "../src/sections/food/SlotCard.tsx";
import PersonSwitcher from "../src/sections/food/PersonSwitcher.tsx";
import SummaryCard from "../src/sections/food/SummaryCard.tsx";
import { lastDays } from "../src/sections/food/stepsChart.ts";
import { RangeButtons, StepsChartView, WeightChartView } from "../src/sections/food/WeightChartView.tsx";
import LossHeadline from "../src/sections/food/LossHeadline.tsx";
import { lossSummary } from "../src/sections/food/weightLoss.ts";
import type { DaySlot, DaySummary, Sharer, TrendPoint } from "../src/sections/food/types.ts";

const points: TrendPoint[] = [
  { date: "2026-10-01", weightKg: 84, trendKg: 84 },
  { date: "2026-10-08", weightKg: 83.2, trendKg: 83.6 },
  { date: "2026-10-15", weightKg: 83, trendKg: 83.15 },
];

test("the weight chart prints its lines, the trend sentence in the person's units, and the goal sentence", () => {
  const html = renderToStaticMarkup(h(WeightChartView, {
    points, trendKg: 83.15, system: "imperial",
    goal: { goalKg: 79.38, planLbPerWeek: 1, projection: { date: "2026-12-11", reason: "ok" } },
  }));
  assert.match(html, /<svg[^>]*role="img"/);
  assert.equal((html.match(/<polyline/g) ?? []).length, 2, "the thin weigh-in line and the bold trend line");
  assert.equal((html.match(/<circle/g) ?? []).length, 4, "three weigh-in dots and the trend's end");
  assert.match(html, /Trend weight: <strong>183\.3 lb<\/strong>/);
  assert.match(html, /At 1 lb\/week you&#x27;d reach 175 lb around Dec 11, 2026\./);
  assert.match(html, /-2\.2 lb since Oct 1/);
});

test("someone else's weight chart has no goal sentence (their goal is a setting, not a weigh-in)", () => {
  const html = renderToStaticMarkup(h(WeightChartView, { points, trendKg: 83.15, system: "metric" }));
  assert.match(html, /Trend weight: <strong>83\.2 kg<\/strong>/);
  assert.equal(/reach|goal weight/i.test(html), false);
});

test("one weigh-in is not a chart, but the trend weight still shows", () => {
  const html = renderToStaticMarkup(h(WeightChartView, { points: points.slice(0, 1), trendKg: 84, system: "metric" }));
  assert.equal(html.includes("<svg"), false);
  assert.match(html, /Trend weight/);
});

test("the steps chart draws a bar per entered day and none for a day with nothing entered", () => {
  const days = lastDays([{ date: "2026-10-15", steps: 8123 }, { date: "2026-10-14", steps: 4000 }], "2026-10-15");
  const html = renderToStaticMarkup(h(StepsChartView, { days }));
  assert.equal((html.match(/<rect/g) ?? []).length, 2);
  assert.match(html, /2026-10-15: 8,123 steps/);
  assert.match(html, /most is 8,123/);
});

test("the person switcher says Me and each name, and marks who is being looked at", () => {
  const people: Sharer[] = [{ userId: "u1", name: "Bea", level: "totals" }, { userId: "u2", name: "Dad", level: "everything" }];
  const html = renderToStaticMarkup(h(PersonSwitcher, { people, value: "u1", onChange: () => {} }));
  const buttons = [...html.matchAll(/<button[^>]*aria-pressed="(true|false)"[^>]*>([^<]*)<\/button>/g)].map((m) => [m[2], m[1]]);
  assert.deepEqual(buttons, [["Me", "false"], ["Bea", "true"], ["Dad", "false"]]);
  assert.match(html, /Dad shares everything with you/);
});

const emptySummary: DaySummary = {
  date: "2026-10-15", calorieBudget: null, maintenance: null, belowFloor: false, missing: ["profile", "weight"], eaten: 0, exercise: 0, exerciseExcluded: 0, remaining: null,
  macros: { protein: { eaten: 0, goal: null }, carbs: { eaten: 0, goal: null }, fat: { eaten: 0, goal: null } },
  nutrients: { kcal: 0, protein: 0, carbs: 0, fat: 0, satFat: 0, sugars: 0, fiber: 0, cholesterolMg: 0, sodiumMg: 0 },
  perSlot: {}, plannedKcal: 0, plannedCount: 0, doneLoggingAt: null,
};

test("the top card points at the gear and the weigh-in when the calorie budget needs them", () => {
  const html = renderToStaticMarkup(h(SummaryCard, { summary: emptySummary, onOpenSettings: () => {}, onOpenWeight: () => {} }));
  assert.match(html, /needs a profile \(sex, birth date, height\) and a weigh-in/);
  assert.match(html, />Set up your profile</);
  assert.match(html, />Add a weigh-in</);
  assert.equal(html.includes("next part of the Food section"), false);
  const goalOnly = renderToStaticMarkup(h(SummaryCard, { summary: { ...emptySummary, missing: ["goal"] }, onOpenSettings: () => {}, onOpenWeight: () => {} }));
  assert.match(goalOnly, />Set a weight goal</);
  assert.equal(goalOnly.includes("Add a weigh-in"), false);
});

const plannedSlot: DaySlot = {
  key: "dinner", label: "Dinner", enabled: true, kcal: 0, targetKcal: null, targetPct: null,
  entries: [{
    id: "e1", localDate: "2026-10-16", slotKey: "dinner", status: "planned", foodId: "f1", isQuickAdd: false, name: "Chili", quantity: 1, unit: "serving", grams: null,
    nutrients: { kcal: 450, protein: 0, carbs: 0, fat: 0, satFat: 0, sugars: 0, fiber: 0, cholesterolMg: 0, sodiumMg: 0 },
    source: "plan", groupId: null, mealPlanId: "m1", planSlotKey: null, pantryUsed: false, loggedAt: "x", updatedAt: "x", relog: null,
  }],
};

test("a planned entry on a future day has no Log or Log all, and says to log it on the day; on today it has both", () => {
  const props = { slot: plannedSlot, busyIds: new Set<string>(), onAdd: () => {}, onMenu: () => {}, onOpenEntry: () => {}, onLog: () => {}, onLogAll: () => {} };
  const future = renderToStaticMarkup(h(SlotCard, { ...props, canLog: false }));
  assert.equal(/aria-label="Log /.test(future), false);
  assert.equal(future.includes("Log all"), false);
  assert.match(future, /Log it on the day/);
  assert.match(future, /from plan/);
  const today = renderToStaticMarkup(h(SlotCard, { ...props, canLog: true }));
  assert.match(today, /aria-label="Log Chili"/);
  assert.match(today, /Log all planned in Dinner/);
  assert.equal(today.includes("Log it on the day"), false);
});

// ---- range buttons, goal line, "lost so far" ---------------------------------------------------------------

const buttonsOf = (html: string) => [...html.matchAll(/<button[^>]*aria-pressed="(true|false)"[^>]*>([^<]*)<\/button>/g)].map((m) => [m[2], m[1]]);

test("the range buttons read 1M 3M 6M 1Y All and mark the chosen one", () => {
  const html = renderToStaticMarkup(h(RangeButtons, { value: "3m", onChange: () => {} }));
  assert.deepEqual(buttonsOf(html), [["1M", "false"], ["3M", "true"], ["6M", "false"], ["1Y", "false"], ["All", "false"]]);
  assert.match(html, /role="group"[^>]*aria-label="Chart range"|aria-label="Chart range"[^>]*role="group"/);
});

test("the chart shows the buttons when it is given a range, and not otherwise", () => {
  const withRange = renderToStaticMarkup(h(WeightChartView, { points, trendKg: 83.15, system: "metric", range: "1y", onRangeChange: () => {}, today: "2026-10-15" }));
  assert.deepEqual(buttonsOf(withRange).map((b) => b[0]), ["1M", "3M", "6M", "1Y", "All"]);
  assert.equal(buttonsOf(renderToStaticMarkup(h(WeightChartView, { points, trendKg: 83.15, system: "metric" }))).length, 0);
});

test("a range with fewer than two weigh-ins says so instead of drawing, and keeps the buttons and the trend weight", () => {
  const html = renderToStaticMarkup(h(WeightChartView, { points: points.slice(0, 1), trendKg: 84, system: "metric", range: "1m", onRangeChange: () => {}, today: "2026-10-15" }));
  assert.equal(html.includes("<svg"), false);
  assert.match(html, /Fewer than two weigh-ins in the last month\. Try a longer range\./);
  assert.equal(buttonsOf(html).length, 5);
  assert.match(html, /Trend weight/);
});

test("the person's own chart draws the dashed goal line and the dotted projection, with a legend for each", () => {
  const html = renderToStaticMarkup(h(WeightChartView, {
    points, trendKg: 83.15, system: "metric", range: "1y", onRangeChange: () => {}, today: "2026-10-15",
    goal: { goalKg: 82, planLbPerWeek: 1, projection: { date: "2026-10-25", reason: "ok" } },
  }));
  assert.match(html, /stroke-dasharray="6 4"/, "the dashed goal line");
  assert.match(html, /stroke-dasharray="0\.1 6"/, "the dotted projection");
  assert.match(html, /goal 82 kg/);
  assert.match(html, /on plan/);
  assert.match(html, /The goal weight is 82 kg\./);
});

test("someone else's chart has the range buttons but no goal line, no projection and no goal text, whatever the data", () => {
  const html = renderToStaticMarkup(h(WeightChartView, { points, trendKg: 83.15, system: "metric", range: "all", onRangeChange: () => {}, today: "2026-10-15" }));
  assert.equal(buttonsOf(html).length, 5);
  assert.equal(/stroke-dasharray|goal|on plan|lost|since Jan/i.test(html.replace(/ since Oct 1/, "")), false);
});

test("the shared view never imports the pieces that carry the goal, the plan or the start day", () => {
  const source = readFileSync(new URL("../src/sections/food/SharedViews.tsx", import.meta.url), "utf8")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "") // JSX comments
    .replace(/^\s*\/\/.*$/gm, ""); // line comments
  for (const banned of ["LossHeadline", "lossSummary", "weightStart", "goal=", "goalKg", "planLbPerWeek", "projection"]) {
    assert.equal(source.includes(banned), false, banned);
  }
});

test("'lost so far' above the chart: the headline and the goal line, or a link to set the start day", () => {
  const lost = lossSummary({ date: "2026-01-03", trendKg: 85, weighedOn: "2026-01-03", later: false }, 79.37, 79.38, "imperial");
  const html = renderToStaticMarkup(h(LossHeadline, { summary: lost, onSetStart: () => {} }));
  assert.match(html, /Lost 12\.4 lb since Jan 3, 2026/);
  assert.match(html, /Goal reached/);

  const toGo = renderToStaticMarkup(h(LossHeadline, { summary: lossSummary({ date: "2026-01-03", trendKg: 85, weighedOn: "2026-01-03", later: false }, 83.2, 79.38, "imperial"), onSetStart: () => {} }));
  assert.match(toGo, /8\.4 lb to go to 175 lb/);

  const unset = renderToStaticMarkup(h(LossHeadline, { summary: lossSummary(null, 80, 70, "imperial"), onSetStart: () => {} }));
  assert.match(unset, /Set your start date to see how much you(&#x27;|')ve lost/);
  assert.match(unset, /<button/);
  assert.equal(/Lost|Up \d/.test(unset), false, "no number without a start day");

  const later = renderToStaticMarkup(h(LossHeadline, { summary: lossSummary({ date: "2026-01-03", trendKg: 90, weighedOn: "2026-01-09", later: true }, 85, null, "metric"), onSetStart: () => {} }));
  assert.match(later, /first one, on Jan 9, 2026/);
});
