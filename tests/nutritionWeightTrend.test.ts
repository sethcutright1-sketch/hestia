import { test } from "node:test";
import assert from "node:assert/strict";
import { KG_PER_LB, currentTrend, goalProjection, projectGoalDate, trendSeries } from "../nutrition/weightTrend.ts";

const near = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} is not within ${eps} of ${b}`);
const kg = (lb: number) => lb * KG_PER_LB;

test("trend: the first reading is the starting trend; nothing means no trend", () => {
  assert.equal(currentTrend([]), null);
  assert.deepEqual(trendSeries([{ date: "2026-03-01", kg: 80 }]), [{ date: "2026-03-01", kg: 80, trendKg: 80 }]);
});

test("trend: daily weigh-ins are the classic 0.1 exponential average", () => {
  const s = trendSeries([
    { date: "2026-03-01", kg: 80 },
    { date: "2026-03-02", kg: 79 },
    { date: "2026-03-03", kg: 81 },
  ]);
  near(s[1].trendKg, 80 + 0.1 * (79 - 80)); // 79.9
  near(s[2].trendKg, 79.9 + 0.1 * (81 - 79.9)); // 80.01
});

test("trend: a longer gap trusts the new reading more (time-aware), so irregular weigh-ins work", () => {
  const weekly = trendSeries([{ date: "2026-03-01", kg: 80 }, { date: "2026-03-08", kg: 78 }]);
  const w = 1 - Math.pow(0.9, 7); // 0.5217...
  near(weekly[1].trendKg, 80 + w * (78 - 80));
  // Seven daily readings of the same value land on the same number as one reading a week later.
  const daily = trendSeries(Array.from({ length: 8 }, (_, i) => ({ date: `2026-03-0${i + 1}`, kg: i === 0 ? 80 : 78 })));
  near(daily[7].trendKg, weekly[1].trendKg);
  // Skipping weeks doesn't throw the trend: it just moves most of the way.
  const gap = trendSeries([{ date: "2026-01-01", kg: 90 }, { date: "2026-03-01", kg: 80 }]);
  assert.ok(gap[1].trendKg < 80.1 && gap[1].trendKg > 80);
});

test("trend: readings of one day are averaged, order doesn't matter, junk is skipped", () => {
  const s = trendSeries([
    { date: "2026-03-02", kg: 79 },
    { date: "2026-03-01", kg: 80.5 },
    { date: "2026-03-01", kg: 79.5 },
    { date: "2026-03-02", kg: 81 },
    { date: "nope", kg: 70 },
    { date: "2026-03-03", kg: Number.NaN },
    { date: "2026-03-04", kg: -5 },
  ]);
  assert.deepEqual(s.map((p) => p.date), ["2026-03-01", "2026-03-02"]);
  assert.equal(s[0].kg, 80);
  assert.equal(s[1].kg, 80); // (79 + 81) / 2
  near(s[1].trendKg, 80);
});

test("trend: smooths a noisy plateau far below the noise", () => {
  const noise = [0.8, -0.9, 1.1, -1.0, 0.7, -0.8, 1.0, -1.1, 0.9, -0.7, 0.8, -0.9, 1.0, -1.0];
  const s = trendSeries(noise.map((n, i) => ({ date: `2026-03-${String(i + 1).padStart(2, "0")}`, kg: 80 + n })));
  assert.ok(Math.abs(s[s.length - 1].trendKg - 80) < 0.4, `trend ${s[s.length - 1].trendKg}`);
});

const today = "2026-03-10";

test("projection: weeks = pounds to go / pounds per week, from today", () => {
  // 180 lb trend, 175 lb goal, 1 lb/week -> 5 weeks -> 35 days.
  assert.equal(projectGoalDate({ trendKg: kg(180), goalKg: kg(175), planLbPerWeek: 1, today }), "2026-04-14");
  // Half a pound a week doubles it.
  assert.equal(projectGoalDate({ trendKg: kg(180), goalKg: kg(175), planLbPerWeek: 0.5, today }), "2026-05-19");
  // A gain plan counts the other way round.
  assert.equal(projectGoalDate({ trendKg: kg(150), goalKg: kg(155), planLbPerWeek: -1, today }), "2026-04-14");
  // A partial week rounds up to a whole day.
  assert.equal(projectGoalDate({ trendKg: kg(176), goalKg: kg(175), planLbPerWeek: 2, today }), addDaysStr(today, 4)); // 0.5 week = 3.5 days -> 4
});

function addDaysStr(d: string, n: number) {
  return new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

test("projection: no date for no plan, a reached goal, a plan pointing away, or more than five years", () => {
  const base = { trendKg: kg(180), goalKg: kg(175), planLbPerWeek: 1, today };
  assert.deepEqual(goalProjection({ ...base, planLbPerWeek: 0 }), { date: null, reason: "no-plan" });
  assert.deepEqual(goalProjection({ ...base, trendKg: kg(175.1) }), { date: null, reason: "reached" }); // within ~0.2 lb
  assert.deepEqual(goalProjection({ ...base, trendKg: kg(175) }), { date: null, reason: "reached" });
  assert.deepEqual(goalProjection({ ...base, trendKg: kg(170) }), { date: null, reason: "wrong-direction" }); // losing, already below the goal
  assert.deepEqual(goalProjection({ ...base, planLbPerWeek: -1 }), { date: null, reason: "wrong-direction" }); // gain plan, goal below
  assert.deepEqual(goalProjection({ ...base, planLbPerWeek: 0.5, trendKg: kg(176 + 5 * 52 * 0.5 + 10) }).reason, "too-far");
  assert.equal(projectGoalDate({ ...base, planLbPerWeek: 0 }), null);
});

test("projection: the five-year line is exact", () => {
  // 5 years = 1825 days = 260.71 weeks. At 0.5 lb/week that is 130.35 lb to go.
  const just = { goalKg: kg(150), planLbPerWeek: 0.5, today };
  assert.equal(goalProjection({ ...just, trendKg: kg(150 + 130.3) }).reason, "ok"); // 1824.2 days -> 1825
  assert.equal(goalProjection({ ...just, trendKg: kg(150 + 130.4) }).reason, "too-far"); // 1825.6 days -> 1826
});
