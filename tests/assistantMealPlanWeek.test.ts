// The meal-plan tools used to act on the MOST RECENTLY EDITED plan. The Meal Plan screen now pages between weeks, so
// after editing next week "deny tonight's dinner" denied next week's dinner. get_meal_plan, set_meal_status and
// add_missing_ingredients_to_list now mean the week containing today unless `week` (any date in a week) says otherwise,
// and a week with no plan is an error that lists the weeks that do have one.

import { test, describe, before, beforeEach, after, mock } from "node:test";
import assert from "node:assert/strict";

import { loadDb, cleanupDb } from "./helpers/testdb.ts";
import { serverToday, mondayOf, addDays } from "../nutrition/dates.ts";

// Pinned to a Monday: set_meal_status refuses a day name already past in this week (see "past-day guard" below), and
// these tests name Tuesday/Friday without a week.
mock.timers.enable({ apis: ["Date"], now: new Date(2026, 9, 12, 9, 0) });

const { createUser, putScopedItem, getScopedItems, deleteScopedItem } = await loadDb();
const { buildTools } = await import("../assistant/registry.ts");

let alice: string;
const THIS_WEEK = mondayOf(serverToday());
const NEXT_WEEK = addDays(THIS_WEEK, 7);
const LAST_WEEK = addDays(THIS_WEEK, -7);
const FAR_WEEK = addDays(THIS_WEEK, 28);

after(cleanupDb);

function callAs(name: string, args: Record<string, any> = {}): Promise<any> {
  const tool = buildTools(alice).find((t) => t.name === name);
  assert.ok(tool, name);
  return tool.run(args);
}

const meal = (id: string, name: string, ingredients: string[], extra: Record<string, unknown> = {}) => ({
  id, day: "Tuesday", slot: "dinner", name, ingredients, status: "proposed", audience: "family", ...extra,
});
function savePlan(weekStart: string, meals: any[], updatedAt: string) {
  putScopedItem("meal_plans", alice, {
    id: `plan-${weekStart}`, weekStart, meals, scope: "joint", createdBy: alice, createdAt: updatedAt, updatedAt,
  });
}
const mealStatus = (weekStart: string, id: string) =>
  (getScopedItems("meal_plans", alice) as any[]).find((p) => p.weekStart === weekStart).meals.find((m: any) => m.id === id).status;

before(() => {
  alice = createUser("alice-weeks", "not-a-real-hash", "Alice");
});

beforeEach(() => {
  for (const p of getScopedItems("meal_plans", alice) as any[]) deleteScopedItem("meal_plans", alice, p.id);
  for (const l of getScopedItems("shopping_lists", alice) as any[]) deleteScopedItem("shopping_lists", alice, l.id);
  // Both weeks have a Tuesday dinner. NEXT week was edited last, so it is the "current" plan to currentPlan().
  savePlan(THIS_WEEK, [meal("m-this", "Lasagna", ["pasta", "mince"])], "2026-10-01T00:00:00.000Z");
  savePlan(NEXT_WEEK, [meal("m-next", "Fish pie", ["haddock", "potatoes"])], "2026-10-02T00:00:00.000Z");
});

describe("get_meal_plan", () => {
  test("defaults to this week even when next week was edited last", async () => {
    const r = await callAs("get_meal_plan");
    assert.equal(r.weekStart, THIS_WEEK);
    assert.deepEqual(r.meals.map((m: any) => m.name), ["Lasagna"]);
  });

  test("week picks any week, and any date inside it works", async () => {
    assert.equal((await callAs("get_meal_plan", { week: NEXT_WEEK })).weekStart, NEXT_WEEK);
    // Sunday is the last day of the Monday-first week.
    const sunday = addDays(NEXT_WEEK, 6);
    const r = await callAs("get_meal_plan", { week: sunday });
    assert.equal(r.weekStart, NEXT_WEEK);
    assert.deepEqual(r.meals.map((m: any) => m.name), ["Fish pie"]);
  });

  test("a week with no plan is an error that names it and lists the weeks that do have one", async () => {
    const r = await callAs("get_meal_plan", { week: FAR_WEEK });
    assert.match(r.error, new RegExp(`week of ${FAR_WEEK}`));
    assert.deepEqual(r.weeksWithPlans, [THIS_WEEK, NEXT_WEEK]);
    assert.match(r.hint, /week/);
    assert.equal(r.meals, undefined, "no other week's meals leak in");
  });

  test("with no plan for THIS week it does not quietly use another one", async () => {
    deleteScopedItem("meal_plans", alice, `plan-${THIS_WEEK}`);
    const r = await callAs("get_meal_plan");
    assert.match(r.error, new RegExp(`week of ${THIS_WEEK} \\(this week\\)`));
    assert.deepEqual(r.weeksWithPlans, [NEXT_WEEK]);
  });

  test("no plans at all keeps the plain message", async () => {
    deleteScopedItem("meal_plans", alice, `plan-${THIS_WEEK}`);
    deleteScopedItem("meal_plans", alice, `plan-${NEXT_WEEK}`);
    assert.deepEqual(await callAs("get_meal_plan"), { error: "No meal plan saved yet." });
  });

  test("a malformed week is refused clearly", async () => {
    const r = await callAs("get_meal_plan", { week: "next week" });
    assert.match(r.error, /week must be a date like/);
  });

  test("the week parameter is optional and described", () => {
    const tool = buildTools(alice).find((t) => t.name === "get_meal_plan")!;
    assert.deepEqual((tool.parameters as any).required ?? [], []);
    assert.match((tool.parameters as any).properties.week.description, /defaults to this week/);
  });
});

describe("set_meal_status", () => {
  test("defaults to this week: denying Tuesday dinner leaves next week's alone", async () => {
    const r = await callAs("set_meal_status", { day: "Tuesday", slot: "dinner", status: "denied" });
    assert.equal(r.error, undefined);
    assert.equal(r.name, "Lasagna");
    assert.equal(r.weekStart, THIS_WEEK);
    assert.equal(mealStatus(THIS_WEEK, "m-this"), "denied");
    assert.equal(mealStatus(NEXT_WEEK, "m-next"), "proposed");
  });

  test("week selects next week", async () => {
    const r = await callAs("set_meal_status", { day: "Tuesday", slot: "dinner", status: "denied", week: NEXT_WEEK });
    assert.equal(r.name, "Fish pie");
    assert.equal(mealStatus(NEXT_WEEK, "m-next"), "denied");
    assert.equal(mealStatus(THIS_WEEK, "m-this"), "proposed");
  });

  test("a date for day picks that date's week, and its weekday", async () => {
    const nextTuesday = addDays(NEXT_WEEK, 1);
    const r = await callAs("set_meal_status", { day: nextTuesday, slot: "dinner", status: "denied" });
    assert.equal(r.name, "Fish pie");
    assert.equal(r.day, "Tuesday");
    assert.equal(mealStatus(NEXT_WEEK, "m-next"), "denied");
    assert.equal(mealStatus(THIS_WEEK, "m-this"), "proposed");
  });

  test("an id from another week's get_meal_plan finds its own plan without repeating week", async () => {
    const r = await callAs("set_meal_status", { day: "Tuesday", slot: "dinner", status: "denied", id: "m-next" });
    assert.equal(r.name, "Fish pie");
    assert.equal(mealStatus(NEXT_WEEK, "m-next"), "denied");
    assert.equal(mealStatus(THIS_WEEK, "m-this"), "proposed");
  });

  test("a week with no plan changes nothing and lists the weeks that have one", async () => {
    const r = await callAs("set_meal_status", { day: "Tuesday", slot: "dinner", status: "denied", week: LAST_WEEK });
    assert.match(r.error, new RegExp(`week of ${LAST_WEEK}`));
    assert.deepEqual(r.weeksWithPlans, [THIS_WEEK, NEXT_WEEK]);
    assert.equal(mealStatus(THIS_WEEK, "m-this"), "proposed");
    assert.equal(mealStatus(NEXT_WEEK, "m-next"), "proposed");
  });

  test("an empty day in the right week still says so", async () => {
    const r = await callAs("set_meal_status", { day: "Friday", slot: "dinner", status: "denied" });
    assert.match(r.error, /No dinner planned for Friday/);
  });
});

// Alex's weeks run Monday-Sunday and on a Sunday "this week" is the one ending today, so a day NAME with no week can
// land on a day that is already over. gemma4:12b denied last Monday's dinner for "deny tomorrow's" that way. With no
// week given the tool refuses a day earlier than today and says which date to retry with; a week, a date or today go on.
describe("set_meal_status past-day guard", () => {
  const SUNDAY = new Date(2026, 9, 18, 12, 0); // THIS_WEEK is 2026-10-12 (pinned clock): Monday is six days past
  const NEXT_MONDAY = "2026-10-19";
  const pastMeal = () =>
    savePlan(THIS_WEEK, [meal("m-mon", "Old stew", ["beef"], { day: "Monday" }), meal("m-sun", "Sunday roast", ["beef"], { day: "Sunday" })], "2026-10-01T00:00:00.000Z");
  after(() => mock.timers.setTime(new Date(2026, 9, 12, 9, 0).getTime()));

  test("a day earlier this week, week omitted: refused, nothing changed, hint names the coming date and week", async () => {
    mock.timers.setTime(SUNDAY.getTime());
    pastMeal();
    const r = await callAs("set_meal_status", { day: "Monday", slot: "dinner", status: "denied" });
    assert.equal(r.error, `Monday 2026-10-12 is already past, so nothing was changed. If you meant the coming Monday (${NEXT_MONDAY}), call again with week ${NEXT_MONDAY}.`);
    assert.equal(r.hint, "For the past Monday, pass week 2026-10-12.");
    assert.equal(mealStatus(THIS_WEEK, "m-mon"), "proposed");
  });

  test("the retry with week set to next Monday works on next week's plan", async () => {
    mock.timers.setTime(SUNDAY.getTime());
    savePlan(NEXT_WEEK, [meal("m-nmon", "Tacos", ["tortillas"], { day: "Monday" })], "2026-10-02T00:00:00.000Z");
    const r = await callAs("set_meal_status", { day: "Monday", slot: "dinner", status: "denied", week: NEXT_MONDAY });
    assert.equal(r.error, undefined);
    assert.equal(r.name, "Tacos");
    assert.equal(mealStatus(NEXT_WEEK, "m-nmon"), "denied");
  });

  test("an explicit week is a deliberate choice: the past day can still be changed", async () => {
    mock.timers.setTime(SUNDAY.getTime());
    pastMeal();
    const r = await callAs("set_meal_status", { day: "Monday", slot: "dinner", status: "denied", week: THIS_WEEK });
    assert.equal(r.error, undefined);
    assert.equal(mealStatus(THIS_WEEK, "m-mon"), "denied");
  });

  test("a date for day, or an id, is also deliberate", async () => {
    mock.timers.setTime(SUNDAY.getTime());
    pastMeal();
    assert.equal((await callAs("set_meal_status", { day: "2026-10-12", slot: "dinner", status: "denied" })).error, undefined);
    assert.equal(mealStatus(THIS_WEEK, "m-mon"), "denied");
    const byId = await callAs("set_meal_status", { day: "Monday", slot: "dinner", status: "proposed", id: "m-mon" });
    assert.equal(byId.error, undefined);
  });

  test("today itself is not past: the Sunday dinner changes with no week", async () => {
    mock.timers.setTime(SUNDAY.getTime());
    pastMeal();
    const r = await callAs("set_meal_status", { day: "Sunday", slot: "dinner", status: "denied" });
    assert.equal(r.error, undefined);
    assert.equal(r.name, "Sunday roast");
    assert.equal(mealStatus(THIS_WEEK, "m-sun"), "denied");
  });

  test("on a Monday nothing in the week is past", async () => {
    mock.timers.setTime(new Date(2026, 9, 12, 9, 0).getTime());
    pastMeal();
    const r = await callAs("set_meal_status", { day: "Monday", slot: "dinner", status: "denied" });
    assert.equal(r.error, undefined);
  });
});

// Eval #53: "deny tonight's dinner" came through as day:"today", which the tool did not understand. Those words now
// resolve to a date and behave exactly as if the date had been passed.
describe("set_meal_status accepts today / tonight / tomorrow / yesterday", () => {
  const SUNDAY = new Date(2026, 9, 18, 12, 0); // THIS_WEEK is 2026-10-12 (pinned clock)
  after(() => mock.timers.setTime(new Date(2026, 9, 12, 9, 0).getTime()));
  const seedWeeks = () => {
    savePlan(THIS_WEEK, [meal("m-sun", "Sunday roast", ["beef"], { day: "Sunday" }), meal("m-sat", "Saturday pie", ["beef"], { day: "Saturday" })], "2026-10-01T00:00:00.000Z");
    savePlan(NEXT_WEEK, [meal("m-nmon", "Tacos", ["tortillas"], { day: "Monday" })], "2026-10-02T00:00:00.000Z");
  };

  test("today and tonight are today's date: allowed on a Sunday, never 'already past'", async () => {
    mock.timers.setTime(SUNDAY.getTime());
    seedWeeks();
    const r = await callAs("set_meal_status", { day: "today", slot: "dinner", status: "denied" });
    assert.equal(r.error, undefined);
    assert.equal(r.name, "Sunday roast");
    assert.equal(mealStatus(THIS_WEEK, "m-sun"), "denied");
    const t = await callAs("set_meal_status", { day: "tonight", slot: "dinner", status: "proposed" });
    assert.equal(t.name, "Sunday roast");
    assert.equal(mealStatus(THIS_WEEK, "m-sun"), "proposed");
  });

  test("tomorrow on a Sunday lands in next week's Monday with no week given", async () => {
    mock.timers.setTime(SUNDAY.getTime());
    seedWeeks();
    const r = await callAs("set_meal_status", { day: "tomorrow", slot: "dinner", status: "denied" });
    assert.equal(r.error, undefined);
    assert.equal(r.name, "Tacos");
    assert.equal(r.weekStart, NEXT_WEEK);
    assert.equal(mealStatus(NEXT_WEEK, "m-nmon"), "denied");
  });

  test("yesterday is the previous day's date", async () => {
    mock.timers.setTime(SUNDAY.getTime());
    seedWeeks();
    const r = await callAs("set_meal_status", { day: "yesterday", slot: "dinner", status: "denied" });
    assert.equal(r.name, "Saturday pie");
  });

  test("case and spaces do not matter", async () => {
    mock.timers.setTime(SUNDAY.getTime());
    seedWeeks();
    const r = await callAs("set_meal_status", { day: "  ToMoRRoW ", slot: "dinner", status: "denied" });
    assert.equal(r.name, "Tacos");
  });

  test("a contradicting week is ignored, with a note", async () => {
    mock.timers.setTime(SUNDAY.getTime());
    seedWeeks();
    const r = await callAs("set_meal_status", { day: "tomorrow", slot: "dinner", status: "denied", week: THIS_WEEK });
    assert.equal(r.name, "Tacos");
    assert.match(r.note, new RegExp(`week ${THIS_WEEK} was ignored: tomorrow is 2026-10-19, in the week of ${NEXT_WEEK}`));
    // A week that agrees adds no note.
    assert.equal((await callAs("set_meal_status", { day: "tomorrow", slot: "dinner", status: "proposed", week: NEXT_WEEK })).note, undefined);
  });

  test("a word that is not a day is an error that lists what works, and changes nothing", async () => {
    mock.timers.setTime(SUNDAY.getTime());
    seedWeeks();
    const r = await callAs("set_meal_status", { day: "someday", slot: "dinner", status: "denied" });
    assert.match(r.error, /day must be a weekday name.*today, tonight, tomorrow or yesterday -- not "someday"/);
    assert.equal(mealStatus(THIS_WEEK, "m-sun"), "proposed");
  });

  test("an empty slot says which date it looked at", async () => {
    mock.timers.setTime(SUNDAY.getTime());
    seedWeeks();
    const r = await callAs("set_meal_status", { day: "today", slot: "lunch", status: "denied" });
    assert.match(r.error, /No lunch planned for today \(2026-10-18\)/);
  });
});

describe("add_missing_ingredients_to_list", () => {
  const listItems = (name: string) =>
    (getScopedItems("shopping_lists", alice) as any[]).find((l) => l.name === name).items.map((i: any) => i.name).sort();
  beforeEach(async () => {
    await callAs("create_shopping_list", { name: "Groceries" });
  });

  test("defaults to this week's plan even when next week was edited last", async () => {
    const r = await callAs("add_missing_ingredients_to_list", { list: "Groceries" });
    assert.deepEqual(r.added.sort(), ["mince", "pasta"]);
    assert.deepEqual(listItems("Groceries"), ["mince", "pasta"]);
  });

  test("week selects next week's plan", async () => {
    const r = await callAs("add_missing_ingredients_to_list", { list: "Groceries", week: NEXT_WEEK });
    assert.deepEqual(r.added.sort(), ["haddock", "potatoes"]);
    assert.deepEqual(listItems("Groceries"), ["haddock", "potatoes"]);
  });

  test("a week with no plan adds nothing and lists the weeks that have one", async () => {
    const r = await callAs("add_missing_ingredients_to_list", { list: "Groceries", week: FAR_WEEK });
    assert.match(r.error, new RegExp(`week of ${FAR_WEEK}`));
    assert.deepEqual(r.weeksWithPlans, [THIS_WEEK, NEXT_WEEK]);
    assert.deepEqual(listItems("Groceries"), []);
  });

  test("the list name must be exact: a partial one is refused with suggestions", async () => {
    const r = await callAs("add_missing_ingredients_to_list", { list: "Grocer" });
    assert.match(r.error, /No shopping list named "Grocer"/);
    assert.deepEqual(r.validValues, ["Groceries"]);
    assert.deepEqual(listItems("Groceries"), []);
  });
});
