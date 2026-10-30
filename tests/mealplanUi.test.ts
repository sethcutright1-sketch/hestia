// The Meal Plan screen's pure pieces (phase 5c) and a static render of each small component: calories per person,
// the kiosk's "Log for" buttons, the leftover picker and the Move panel. The full screen is checked in a browser.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { dayRow, hasCalorieRows, kcal, rowsForDate, type PlanCaloriesDay, type PlanCaloriesResponse } from "../src/sections/mealplan/planCaloriesView.ts";
import {
  boardDates, chipLabel, entryMatchesMeal, logChips, logForOptions, loggedKey, type BoardEntry, type KioskBoard,
} from "../src/sections/mealplan/kioskLog.ts";
import { choiceLabel, leftoverChoices, servingsLine } from "../src/sections/mealplan/leftovers.ts";
import PlanCalories from "../src/sections/mealplan/PlanCalories.tsx";
import KioskLogFor from "../src/sections/mealplan/KioskLogFor.tsx";
import LeftoverPicker from "../src/sections/mealplan/LeftoverPicker.tsx";
import MoveMeal from "../src/sections/mealplan/MoveMeal.tsx";

const day = (over: Partial<PlanCaloriesDay> = {}): PlanCaloriesDay => ({
  date: "2026-10-17", calorieBudget: 1800, snackAllowanceKcal: 180, planningTargetKcal: 1620, plannedKcal: 800, loggedKcal: 440,
  plannedPlusLoggedKcal: 1240, roomKcal: 380, missing: [], ...over,
});
const resp = (over: Partial<PlanCaloriesResponse> = {}): PlanCaloriesResponse => ({
  weekStart: "2026-10-12", dates: [], people: [{ userId: "u1", name: "Alex", isMe: true, snackAllowancePct: 10, days: [day()] }], ...over,
});

describe("calories per person", () => {
  test("planned + logged against the planning target, with what is left", () => {
    const r = dayRow({ userId: "u1", name: "Alex", isMe: true }, day());
    assert.deepEqual([r.amount, r.room, r.over, r.hasTarget], ["1,240 of 1,620 kcal", "380 left", false, true]);
    assert.equal(r.detail, "logged 440 · planned 800");
    assert.ok(Math.abs(r.loggedPct - (440 / 1620) * 100) < 1e-9);
    assert.ok(Math.abs(r.plannedPct - (800 / 1620) * 100) < 1e-9);
    assert.match(r.spoken, /^Alex \(you\): 1,240 of 1,620 kcal planned and logged, 380 left; logged 440 · planned 800\. Calorie budget 1,800, with 180 kept for snacks\.$/);
  });

  test("over the target reads 'N over', the bar is full and never longer than the track", () => {
    const r = dayRow({ userId: "u2", name: "Bea", isMe: false }, day({ plannedKcal: 1500, loggedKcal: 500, plannedPlusLoggedKcal: 2000, roomKcal: -380 }));
    assert.deepEqual([r.room, r.over], ["380 over", true]);
    assert.equal(r.loggedPct + r.plannedPct, 100);
    assert.match(r.spoken, /^Bea: /, "only the signed-in person is marked 'you'");
  });

  test("no calorie budget yet: the planned and logged calories and the reason, no bar", () => {
    const r = dayRow({ userId: "u1", name: "Alex", isMe: true }, day({
      calorieBudget: null, snackAllowanceKcal: null, planningTargetKcal: null, roomKcal: null, missing: ["profile", "weight"], plannedKcal: 600, loggedKcal: 0, plannedPlusLoggedKcal: 600,
    }));
    assert.deepEqual([r.amount, r.room, r.hasTarget, r.loggedPct, r.plannedPct], ["600 kcal", "no calorie budget yet", false, 0, 0]);
    assert.match(r.spoken, /No calorie budget yet \(needs a profile and a weigh-in\)\./);
  });

  test("rows are exactly the people the server returned, in its order, for the date asked", () => {
    const two = resp({
      people: [
        { userId: "u1", name: "Alex", isMe: true, snackAllowancePct: 10, days: [day(), day({ date: "2026-10-18", loggedKcal: 0 })] },
        { userId: "u2", name: "Bea", isMe: false, snackAllowancePct: 10, days: [day({ date: "2026-10-18" })] },
      ],
    });
    assert.deepEqual(rowsForDate(two, "2026-10-17").map((r) => r.name), ["Alex"], "Bea has no row for a day the server sent nothing for");
    assert.deepEqual(rowsForDate(two, "2026-10-18").map((r) => [r.name, r.isMe]), [["Alex", true], ["Bea", false]]);
    assert.deepEqual(rowsForDate(null, "2026-10-17"), []);
    assert.deepEqual(rowsForDate(resp({ people: [] }), "2026-10-17"), []);
  });

  test("the block hides when nothing came back", () => {
    assert.equal(hasCalorieRows(null), false);
    assert.equal(hasCalorieRows(resp({ people: [] })), false);
    assert.equal(hasCalorieRows(resp()), true);
  });

  test("kcal is whole numbers with thousands separators", () => {
    assert.deepEqual([kcal(1234.5), kcal(0), kcal(999.4)], ["1,235", "0", "999"]);
  });

  test("the rows render with a 'you' mark, the bar and a spoken sentence, and nothing when empty", () => {
    const rows = rowsForDate(resp({ people: [
      { userId: "u1", name: "Alex", isMe: true, snackAllowancePct: 10, days: [day()] },
      { userId: "u2", name: "Bea", isMe: false, snackAllowancePct: 10, days: [day({ roomKcal: -10 })] },
    ] }), "2026-10-17");
    const html = renderToStaticMarkup(h(PlanCalories, { rows }));
    assert.match(html, /Alex<span[^>]*>you<\/span>/);
    assert.match(html, /1,240 of 1,620 kcal/);
    assert.match(html, /380 left/);
    assert.match(html, /10 over/);
    assert.equal((html.match(/rounded-full bg-slate-200/g) ?? []).length, 2, "one bar per person");
    assert.match(html, /dark:/, "has dark classes");
    assert.equal(renderToStaticMarkup(h(PlanCalories, { rows: [] })), "");
  });
});

const entry = (over: Partial<BoardEntry>): BoardEntry => ({ id: "e1", name: "Spaghetti Bolognese", mealId: "m1", slotKey: "dinner", slotLabel: "Dinner", ...over });
const board = (over: Partial<KioskBoard> = {}): KioskBoard => ({
  kioskAccess: "plan_and_quick_log", canQuickLog: true, date: "2026-10-17",
  meals: [{ id: "m1", name: "Spaghetti Bolognese", slotKey: "dinner", slotLabel: "Dinner", who: "Everyone", leftover: false }],
  people: [
    { userId: "u1", name: "Alex", date: "2026-10-17", planned: [entry({ id: "e-alex" })] },
    { userId: "u2", name: "Bea", date: "2026-10-17", planned: [entry({ id: "e-bea" })] },
    { userId: "u3", name: "Dana", date: "2026-10-17", planned: [] },
  ],
  ...over,
});
const meal = { id: "m1", name: "Spaghetti Bolognese", slot: "dinner", status: "approved" };

describe("the kiosk's Log for buttons", () => {
  test("a button for each person with a planned entry from that meal, in the board's order", () => {
    assert.deepEqual(logForOptions(board(), meal), [
      { userId: "u1", name: "Alex", entryIds: ["e-alex"] },
      { userId: "u2", name: "Bea", entryIds: ["e-bea"] },
    ]);
  });

  test("matching is by the plan meal id; another meal's entry gets nothing", () => {
    const b = board({ people: [{ userId: "u1", name: "Alex", date: "x", planned: [entry({ id: "other", mealId: "m2" })] }] });
    assert.deepEqual(logForOptions(b, meal), []);
    assert.equal(entryMatchesMeal(entry({ mealId: "m1" }), meal), true);
    assert.equal(entryMatchesMeal(entry({ mealId: "m2" }), meal), false);
  });

  test("an entry with no meal id falls back to the same meal slot and dish name, ignoring case", () => {
    assert.equal(entryMatchesMeal(entry({ mealId: null, name: " spaghetti bolognese " }), meal), true);
    assert.equal(entryMatchesMeal(entry({ mealId: null, slotKey: "lunch" }), meal), false);
    assert.equal(entryMatchesMeal(entry({ mealId: undefined, name: "Soup" }), meal), false);
  });

  test("only approved meals that are on the board's approved list, and only when quick logging is on", () => {
    assert.deepEqual(logForOptions(board(), { ...meal, status: "proposed" }), []);
    assert.deepEqual(logForOptions(board(), { ...meal, status: "denied" }), []);
    assert.deepEqual(logForOptions(board({ meals: [] }), meal), [], "not on the board's approved list (changed elsewhere)");
    assert.deepEqual(logForOptions(board({ canQuickLog: false }), meal), [], "plan only");
    assert.deepEqual(logForOptions(undefined, meal), [], "hidden, or a day with no board");
  });

  test("a person this screen already logged keeps a ticked button; a planned entry that comes back makes it live again", () => {
    const afterAlex = board({ people: board().people.map((p) => (p.userId === "u1" ? { ...p, planned: [] } : p)) });
    const done = new Map([[loggedKey("m1", "u1"), "Alex"]]);
    assert.deepEqual(logChips(afterAlex, meal, done).map((c) => [c.name, c.done, c.entryIds]), [["Alex", true, []], ["Bea", false, ["e-bea"]]]);
    assert.deepEqual(logChips(board(), meal, done).map((c) => [c.name, c.done]), [["Alex", false], ["Bea", false]], "the board says it is planned again");
    assert.deepEqual(logChips(afterAlex, { ...meal, id: "m9" }, done), [], "the tick belongs to that meal only");
  });

  test("the words on a button", () => {
    assert.deepEqual([chipLabel("Alex", false), chipLabel("Alex", true)], ["Alex", "✓ Alex logged"]);
    // The user's answer to 5b.R4 (2026-10-15): a live button shows that person's portion calories; a done one doesn't.
    assert.deepEqual([chipLabel("Bea", false, 470.5), chipLabel("Bea", false, 1234.4), chipLabel("Bea", true, 470.5)], ["Bea · 471 kcal", "Bea · 1,234 kcal", "✓ Bea logged"]);
  });

  test("a button's calories are that person's portion: the sum of their matching plan entries", () => {
    const b = board({ people: [
      { userId: "u1", name: "Alex", date: "2026-10-17", planned: [entry({ id: "a", kcal: 300 }), entry({ id: "b", kcal: 171 }), entry({ id: "c", kcal: 999, mealId: "m2" })] },
      { userId: "u2", name: "Bea", date: "2026-10-17", planned: [entry({ id: "d" })] },
    ] });
    assert.deepEqual(logForOptions(b, meal), [
      { userId: "u1", name: "Alex", entryIds: ["a", "b"], kcal: 471 },
      { userId: "u2", name: "Bea", entryIds: ["d"] },
    ], "another meal's entry doesn't count; no kcal on the board means none on the button");
  });

  test("days to ask about: up to today, with an approved meal that day", () => {
    const meals = [
      { day: "Monday", status: "approved" }, { day: "Tuesday", status: "proposed" }, { day: "Wednesday", status: "approved" },
      { day: "Saturday", status: "approved" },
    ];
    assert.deepEqual(boardDates("2026-10-12", meals, "2026-10-15"), ["2026-10-12", "2026-10-14"], "Tuesday is only proposed, Saturday hasn't happened");
    assert.deepEqual(boardDates("2026-10-12", meals, "2026-10-17"), ["2026-10-12", "2026-10-14", "2026-10-17"]);
    assert.deepEqual(boardDates("2026-10-12", meals, "2026-10-11"), [], "a week that hasn't started");
  });

  test("the buttons render with each person's portion calories, a tick when done, and dark classes", () => {
    const withKcal = board({ people: board().people.map((p) => ({ ...p, planned: p.planned.map((e) => ({ ...e, kcal: 470.5 })) })) });
    const chips = logChips(withKcal, meal, new Map());
    const html = renderToStaticMarkup(h(KioskLogFor, { mealName: "Spaghetti Bolognese", chips, isBusy: () => false, onLog: () => {} }));
    assert.match(html, /Log for:/);
    assert.match(html, />Alex · 471 kcal</);
    assert.match(html, />Bea · 471 kcal</);
    const visibleText = html.replace(/<[^>]+>/g, " ");
    assert.equal(/calorie budget|\bleft\b|\bover\b|eaten/i.test(visibleText), false, "a portion's calories only, never totals (5b.R4)");
    assert.match(html, /dark:/);
    const ticked = renderToStaticMarkup(h(KioskLogFor, {
      mealName: "Spaghetti Bolognese", chips: [{ userId: "u1", name: "Alex", done: true, entryIds: [] }], isBusy: () => false, onLog: () => {},
    }));
    assert.match(ticked, /✓ Alex logged/);
    assert.match(ticked, /disabled/);
    assert.equal(renderToStaticMarkup(h(KioskLogFor, { mealName: "x", chips: [], isBusy: () => false, onLog: () => {} })), "");
  });
});

describe("the leftover picker", () => {
  const offer = {
    mealId: "m1", name: "Big pot", recipeId: "r1", yieldServings: 6, yieldAssumed: false, headcount: 2, servingsLeft: 4,
    suggestion: { day: "Tuesday", slot: "lunch" },
    alternatives: [{ day: "Tuesday", slot: "dinner" }, { day: "Wednesday", slot: "lunch" }, { day: "Tuesday", slot: "lunch" }],
  };
  const label = (k: string) => k[0].toUpperCase() + k.slice(1);

  test("the suggestion first, then the alternatives, each cell once", () => {
    assert.deepEqual(leftoverChoices(offer).map((c) => [c.day, c.slot, c.suggested]), [
      ["Tuesday", "lunch", true], ["Tuesday", "dinner", false], ["Wednesday", "lunch", false],
    ]);
    assert.deepEqual(leftoverChoices({ suggestion: null, alternatives: [] }), []);
  });

  test("the words", () => {
    assert.equal(choiceLabel({ day: "Wednesday", slot: "lunch" }, label), "Wed lunch");
    assert.equal(servingsLine({ servingsLeft: 4, yieldAssumed: false }), "4 servings left over.");
    assert.equal(servingsLine({ servingsLeft: 1, yieldAssumed: true }), "1 serving left over (the recipe's servings are assumed).");
  });

  test("renders a chip per free cell with the suggested one marked, and the reason when there is none", () => {
    const html = renderToStaticMarkup(h(LeftoverPicker, { mealName: "Big pot", offer, slotLabel: label, onPick: () => {}, onClose: () => {} }));
    assert.match(html, /4 servings left over\./);
    assert.equal((html.match(/aria-label="Add leftovers on /g) ?? []).length, 3);
    assert.match(html, /Tue lunch<span[^>]*>suggested<\/span>/);
    assert.match(html, /Wed lunch/);
    const none = renderToStaticMarkup(h(LeftoverPicker, {
      mealName: "Big pot", offer: { ...offer, servingsLeft: 0, suggestion: null, alternatives: [], reason: "The recipe makes 2, and 2 are already eating it." }, slotLabel: label, onPick: () => {}, onClose: () => {},
    }));
    assert.match(none, /already eating it/);
    assert.equal(none.includes("Add leftovers on"), false);
  });
});

describe("the Move panel", () => {
  const meals = [
    { id: "a", day: "Monday", slot: "dinner", status: "approved", audience: "family" as const, name: "Chili" },
    { id: "b", day: "Tuesday", slot: "dinner", status: "proposed", audience: "family" as const, name: "Soup" },
  ];
  const slots = [{ key: "lunch", label: "Lunch" }, { key: "dinner", label: "Dinner" }];

  test("starts on the meal's own day and meal with Move off", () => {
    const html = renderToStaticMarkup(h(MoveMeal, { meal: meals[0], meals, slots, onMove: () => {}, onClose: () => {} }));
    assert.match(html, /Move &quot;Chili&quot; to/);
    assert.match(html, /Pick another day or meal\./);
    assert.match(html, /<button[^>]*disabled=""[^>]*>Move<\/button>/);
    assert.match(html, /<option value="Monday" selected="">Monday<\/option>/);
    assert.equal(html.includes('role="alert"'), false);
  });
});
