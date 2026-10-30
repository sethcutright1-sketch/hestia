// Which section opens first, and when a hash counts. A phone opens the Food diary, a tablet or PC
// the Calendar, the kiosk always the Calendar, and a hash that names a section always wins.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { hashSegment, isPhoneWidth, resolveSection, PHONE_BREAKPOINT_PX } from "../src/startSection.ts";

const ALL = ["grocery", "pantry", "mealplan", "family", "budget", "calendar", "chores", "fridge", "food"];
const NO_FOOD = ALL.filter((s) => s !== "food");
const base = { hash: "", available: ALL, role: "parent", kioskDevice: false, widthPx: 1280 };

describe("isPhoneWidth", () => {
  test("is narrower than the md breakpoint (768px)", () => {
    assert.equal(PHONE_BREAKPOINT_PX, 768);
    assert.equal(isPhoneWidth(375), true);
    assert.equal(isPhoneWidth(767), true);
    assert.equal(isPhoneWidth(768), false);
    assert.equal(isPhoneWidth(1280), false);
  });
});

describe("hashSegment", () => {
  test("only the first segment names the section", () => {
    assert.equal(hashSegment("#chores/parent"), "chores");
    assert.equal(hashSegment("#food"), "food");
    assert.equal(hashSegment("#"), "");
    assert.equal(hashSegment(""), "");
  });
});

describe("resolveSection with no hash", () => {
  test("a phone opens the Food diary", () => {
    assert.equal(resolveSection({ ...base, widthPx: 375 }), "food");
    assert.equal(resolveSection({ ...base, role: "admin", widthPx: 767 }), "food");
  });
  test("a tablet or PC opens the Calendar", () => {
    assert.equal(resolveSection({ ...base, widthPx: 768 }), "calendar");
    assert.equal(resolveSection({ ...base, widthPx: 1920 }), "calendar");
  });
  test("the kiosk login always opens the Calendar, even on a narrow screen", () => {
    assert.equal(resolveSection({ ...base, role: "kiosk", available: NO_FOOD, widthPx: 375 }), "calendar");
    assert.equal(resolveSection({ ...base, role: "kiosk", available: NO_FOOD, widthPx: 1280 }), "calendar");
  });
  test("a device in kiosk mode opens the Calendar too", () => {
    assert.equal(resolveSection({ ...base, kioskDevice: true, widthPx: 375 }), "calendar");
  });
  test("a bare # counts as no hash", () => {
    assert.equal(resolveSection({ ...base, hash: "#", widthPx: 375 }), "food");
  });
});

describe("resolveSection with a hash", () => {
  test("a named section wins on every kind of screen", () => {
    assert.equal(resolveSection({ ...base, hash: "#grocery", widthPx: 375 }), "grocery");
    assert.equal(resolveSection({ ...base, hash: "#food", widthPx: 1920 }), "food");
    assert.equal(resolveSection({ ...base, hash: "#chores/parent", widthPx: 1920 }), "chores");
  });
  test("a section the login can't reach (Food for the kiosk) falls back to the start page", () => {
    assert.equal(resolveSection({ ...base, hash: "#food", role: "kiosk", available: NO_FOOD, widthPx: 375 }), "calendar");
  });
  test("an unknown hash falls back to the start page", () => {
    assert.equal(resolveSection({ ...base, hash: "#nonsense", widthPx: 375 }), "food");
    assert.equal(resolveSection({ ...base, hash: "#nonsense", widthPx: 1280 }), "calendar");
  });
});
