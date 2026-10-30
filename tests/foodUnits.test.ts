// Weight and height in the person's own units (src/sections/food/units.ts).

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  cmToFtIn, displayWeight, formatWeight, ftInToCm, goalWeightKg, heightBoxes, heightFromBoxes, kgToLb, lbToKg, weightBody, weightUnit,
} from "../src/sections/food/units.ts";

describe("weights", () => {
  test("kilograms and pounds convert both ways and display to one decimal", () => {
    assert.equal(weightUnit("imperial"), "lb");
    assert.equal(weightUnit("metric"), "kg");
    assert.ok(Math.abs(kgToLb(100) - 220.46) < 0.01);
    assert.ok(Math.abs(lbToKg(220.46226218) - 100) < 1e-6);
    assert.equal(displayWeight(83.2, "metric"), 83.2);
    assert.equal(displayWeight(83.2, "imperial"), 183.4);
    assert.equal(formatWeight(83.15, "imperial"), "183.3 lb");
    assert.equal(formatWeight(83.15, "metric"), "83.2 kg");
  });

  test("a typed weight is sent in the unit it was typed in, within the server's limits", () => {
    assert.deepEqual(weightBody("183.5", "imperial"), { ok: true, body: { weightLb: 183.5 } });
    assert.deepEqual(weightBody(" 83 ", "metric"), { ok: true, body: { weightKg: 83 } });
    for (const [text, system] of [["", "imperial"], ["abc", "metric"], ["43.9", "imperial"], ["1100.1", "imperial"], ["19", "metric"], ["501", "metric"], ["-5", "metric"]] as const) {
      const r = weightBody(text, system);
      assert.equal(r.ok, false, `${text} ${system}`);
    }
    const lo = weightBody("20", "imperial");
    assert.deepEqual(lo.ok ? null : lo.error, "Enter a weight between 44 and 1100 lb.");
    assert.equal(weightBody("44", "imperial").ok, true);
    assert.equal(weightBody("1100", "imperial").ok, true);
    assert.equal(weightBody("20", "metric").ok, true);
  });

  test("a goal weight is kilograms to the hundredth, empty means none, junk is refused", () => {
    assert.deepEqual(goalWeightKg("", "imperial"), { ok: true, body: null });
    assert.deepEqual(goalWeightKg("175", "imperial"), { ok: true, body: 79.38 });
    assert.deepEqual(goalWeightKg("70.5", "metric"), { ok: true, body: 70.5 });
    assert.equal(goalWeightKg("10", "imperial").ok, false);
    assert.equal(goalWeightKg("x", "metric").ok, false);
  });
});

describe("heights", () => {
  test("centimetres and feet/inches convert, and 11.97 in rolls over to the next foot", () => {
    assert.deepEqual(cmToFtIn(180), { ft: 5, inch: 10.9 });
    assert.deepEqual(cmToFtIn(182.88), { ft: 6, inch: 0 });
    assert.deepEqual(cmToFtIn(182.8), { ft: 6, inch: 0 }, "5 ft 11.97 in reads as 6 ft, not 5 ft 12 in");
    assert.deepEqual(cmToFtIn(60.9), { ft: 2, inch: 0 });
    assert.equal(ftInToCm(5, 10.9), 180.1);
    assert.equal(ftInToCm(6, 0), 182.9);
  });

  test("the height boxes are read in the units chosen, validated, and the same height shows in either", () => {
    assert.deepEqual(heightBoxes(null), { ft: "", inch: "", cm: "" });
    assert.deepEqual(heightBoxes(170), { ft: "5", inch: "6.9", cm: "170" });
    assert.deepEqual(heightFromBoxes("imperial", { ft: "5", inch: "10", cm: "" }), { ok: true, body: 177.8 });
    assert.deepEqual(heightFromBoxes("imperial", { ft: "6", inch: "", cm: "" }), { ok: true, body: 182.9 }, "no inches = 0");
    assert.deepEqual(heightFromBoxes("metric", { ft: "", inch: "", cm: "170.5" }), { ok: true, body: 170.5 });
    for (const [system, boxes] of [
      ["imperial", { ft: "", inch: "5", cm: "" }], ["metric", { ft: "5", inch: "5", cm: "" }], ["imperial", { ft: "1", inch: "0", cm: "" }],
      ["metric", { ft: "", inch: "", cm: "49" }], ["metric", { ft: "", inch: "", cm: "261" }], ["imperial", { ft: "x", inch: "", cm: "" }], ["metric", { ft: "", inch: "", cm: "tall" }],
    ] as const) {
      assert.equal(heightFromBoxes(system, boxes).ok, false, JSON.stringify([system, boxes]));
    }
  });
});
