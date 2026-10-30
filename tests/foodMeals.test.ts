// Logging, copying and saving meals from the Food diary (src/sections/food/meals.ts): the bulk request
// body (client ids, shared groupId), which entries a copy or a saved meal takes, and the wording. The
// bulk body is also run through the real route, including the replay and the undo.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { newApi } from "./helpers/nutritionApi.ts";
import { TODAY, YESTERDAY, customFood } from "./helpers/nutritionWorld.ts";
import {
  amountOf, bulkBody, copyDayHint, itemsFromEntries, loggable, loggedMessage, mealKcal, mealNameProblem, newId, parseYield, previousFor, recipeBody, recipeSavedMessage, suggestName,
} from "../src/sections/food/meals.ts";
import type { DiaryEntry, MealItem, PreviousMeal } from "../src/sections/food/types.ts";

const nut = (kcal: number) => ({ kcal, protein: 0, carbs: 0, fat: 0, satFat: 0, sugars: 0, fiber: 0, cholesterolMg: 0, sodiumMg: 0 });

const item = (over: Partial<MealItem>): MealItem => ({
  foodId: "f1", name: "Oats", quantity: 2, servingId: "s1", grams: null, unit: "1 bar", totalGrams: 100, nutrients: nut(300), kcal: 300,
  isQuickAdd: false, available: true, ...over,
});

const entry = (over: Partial<DiaryEntry>): DiaryEntry => ({
  id: "e1", localDate: TODAY, slotKey: "breakfast", status: "logged", foodId: "f1", isQuickAdd: false, name: "Oats", quantity: 2, unit: "1 bar",
  grams: 100, nutrients: nut(300), source: "manual", groupId: null, mealPlanId: null, planSlotKey: null, pantryUsed: false, loggedAt: "x", updatedAt: "x",
  relog: { foodId: "f1", quantity: 2, servingId: "s1" }, ...over,
});

describe("newId", () => {
  test("is a valid client id: 8 to 64 of A-Z a-z 0-9 _ -", () => {
    for (let i = 0; i < 20; i++) assert.match(newId(), /^[A-Za-z0-9_-]{8,64}$/);
    assert.notEqual(newId(), newId());
  });
});

describe("loggable / amountOf / bulkBody", () => {
  test("only available, food-backed items can be written", () => {
    const items = [item({}), item({ available: false }), item({ isQuickAdd: true, foodId: null }), item({ foodId: null })];
    assert.equal(loggable(items).length, 1);
  });

  test("a gram weight when there is no serving row, else a count of the serving", () => {
    assert.deepEqual(amountOf(item({ servingId: null, grams: 150 })), { grams: 150 });
    assert.deepEqual(amountOf(item({})), { quantity: 2, servingId: "s1" });
    assert.deepEqual(amountOf(item({ servingId: null, grams: null, quantity: 3 })), { quantity: 3 });
  });

  test("one client id per item, one shared groupId, source copy by default", () => {
    const body = bulkBody({ slot: "lunch", items: [item({}), item({ foodId: "f2", servingId: null, grams: 80 })], groupId: "group-0001", ids: ["id-aaaa0001", "id-aaaa0002"] });
    assert.deepEqual(body, {
      slot: "lunch", groupId: "group-0001", source: "copy",
      items: [{ id: "id-aaaa0001", foodId: "f1", quantity: 2, servingId: "s1" }, { id: "id-aaaa0002", foodId: "f2", grams: 80 }],
    });
  });

  test("mealKcal counts only what can be logged", () => {
    assert.equal(mealKcal([item({ kcal: 100.5 }), item({ kcal: 50, available: false }), item({ kcal: 25.25 })]), 125.75);
  });
});

describe("itemsFromEntries", () => {
  test("logged food entries become items from their relog amount", () => {
    const { items, skipped, plannedLeftOut } = itemsFromEntries([entry({}), entry({ id: "e2", name: "Rice", relog: { foodId: "f2", grams: 150 }, foodId: "f2", unit: "g", quantity: 150, grams: 150 })]);
    assert.equal(skipped.length + plannedLeftOut, 0);
    assert.deepEqual(items.map((i) => [i.foodId, i.quantity, i.servingId, i.grams]), [["f1", 2, "s1", null], ["f2", 150, null, 150]]);
    assert.deepEqual(items.map((i) => i.kcal), [300, 300]);
  });

  test("quick adds and foods that are gone are skipped and counted; planned entries are left out (intentions, not meals)", () => {
    const { items, skipped, plannedLeftOut } = itemsFromEntries([
      entry({}),
      entry({ id: "q", isQuickAdd: true, foodId: null, relog: null }),
      entry({ id: "gone", relog: null }),
      entry({ id: "p", status: "planned", source: "plan" }),
    ]);
    assert.equal(items.length, 1);
    assert.deepEqual(skipped.map((e) => e.id), ["q", "gone"]);
    assert.equal(plannedLeftOut, 1);
  });
});

describe("previousFor", () => {
  const prev = (date: string, slotKey: string): PreviousMeal => ({ key: `${date}|${slotKey}`, date, slotKey, slotLabel: slotKey, kcal: 1, items: [], quickAddCount: 0, unavailableCount: 0 });
  test("the meal being added to is not offered as a previous meal, other slots and days are", () => {
    const list = [prev(TODAY, "lunch"), prev(TODAY, "dinner"), prev(YESTERDAY, "lunch")];
    assert.deepEqual(previousFor(list, TODAY, "lunch").map((m) => m.key), [`${TODAY}|dinner`, `${YESTERDAY}|lunch`]);
  });
});

describe("wording", () => {
  test("loggedMessage", () => {
    assert.equal(loggedMessage({ count: 3, where: "Breakfast" }), "Added 3 items to Breakfast.");
    assert.equal(loggedMessage({ count: 1, where: "Dinner, Tomorrow", planned: true }), "Planned 1 item for Dinner, Tomorrow.");
    assert.equal(loggedMessage({ count: 2, where: "Lunch", skippedCount: 1 }), "Added 2 items to Lunch (1 entry without a food wasn't copied).");
    assert.equal(loggedMessage({ count: 2, where: "Lunch", skippedCount: 3 }), "Added 2 items to Lunch (3 entries without a food weren't copied).");
  });
  test("suggestName", () => {
    assert.equal(suggestName([]), "");
    assert.equal(suggestName([{ name: "Rolled oats (Quaker)" }]), "Rolled oats");
    assert.equal(suggestName([{ name: "Oats" }, { name: "Milk" }, { name: "Jam" }]), "Oats + 2 more");
  });
  test("copyDayHint", () => {
    assert.match(copyDayHint("2026-10-16", "2026-10-15"), /planned/);
    assert.match(copyDayHint("2026-10-15", "2026-10-15"), /added to your diary/);
  });
});

describe("through the real bulk route", () => {
  test("a copy built here logs once, replays to nothing new, and one DELETE of the group undoes it", async (t) => {
    const api = await newApi(t);
    const a = (await api.call("ann", "POST", "/foods", customFood("Oat bar", 200))).body;
    const b = (await api.call("ann", "POST", "/foods", { name: "Rice", basis: "per100g", nutrients: { kcal: 130 }, servings: [{ label: "100 g", grams: 100 }] })).body;
    await api.call("ann", "POST", `/diary/${YESTERDAY}`, { slot: "breakfast", foodId: a.id, quantity: 2 });
    await api.call("ann", "POST", `/diary/${YESTERDAY}`, { slot: "breakfast", foodId: b.id, grams: 150 });
    await api.call("ann", "POST", `/diary/${YESTERDAY}`, { slot: "breakfast", kcal: 99, name: "Mystery" });
    const day = (await api.call("ann", "GET", `/diary/${YESTERDAY}`)).body;
    const breakfast = day.slots.find((s: any) => s.key === "breakfast");

    const { items, skipped } = itemsFromEntries(breakfast.entries);
    assert.equal(items.length, 2);
    assert.equal(skipped.length, 1);
    const ids = items.map(() => newId());
    const body = bulkBody({ slot: "lunch", items, groupId: newId(), ids });
    const first = await api.call("ann", "POST", `/diary/${TODAY}/bulk`, body);
    assert.deepEqual([first.status, first.body.created, first.body.entries.map((e: any) => e.nutrients.kcal)], [201, 2, [400, 195]]);
    const replay = await api.call("ann", "POST", `/diary/${TODAY}/bulk`, body);
    assert.deepEqual([replay.status, replay.body.created], [200, 0]);
    assert.equal(replay.body.summary.eaten, 595);

    // to tomorrow: planned, as the copy form says
    const future = await api.call("ann", "POST", "/diary/2026-03-11/bulk", bulkBody({ slot: "dinner", items, groupId: newId(), ids: items.map(() => newId()) }));
    assert.deepEqual(future.body.entries.map((e: any) => e.status), ["planned", "planned"]);

    const undo = await api.call("ann", "DELETE", `/diary/group/${body.groupId}`);
    assert.deepEqual([undo.body.deleted, undo.body.summaries[0].eaten], [2, 0]);
    assert.equal((await api.call("ann", "DELETE", `/diary/group/${body.groupId}`)).body.deleted, 0, "idempotent");
  });
});

describe("Save as recipe (phase 5c)", () => {
  test("the body is the meal's food amounts: shared unless Only me, the name trimmed, servings as typed", () => {
    const items = [item({ foodId: "a", quantity: 2, servingId: "s1" }), item({ foodId: "b", servingId: null, grams: 150, quantity: 150 })];
    assert.deepEqual(recipeBody({ name: "  Bowl ", onlyMe: false, yieldServings: 1, items }), {
      name: "Bowl", scope: "joint", yieldServings: 1,
      items: [{ foodId: "a", quantity: 2, servingId: "s1" }, { foodId: "b", grams: 150 }],
    });
    assert.equal(recipeBody({ name: "x", onlyMe: true, yieldServings: 4, items }).scope, "personal");
  });

  test("the servings box: a number from 0.01 to 1000, else nothing", () => {
    assert.deepEqual(["1", " 2.5 ", "0.01", "1000"].map(parseYield), [1, 2.5, 0.01, 1000]);
    assert.deepEqual(["", " ", "0", "-1", "1001", "two", "NaN"].map(parseYield), [null, null, null, null, null, null, null]);
  });

  test("the saved message names the recipe, its lines, its calories and where it can be used", () => {
    const r = { name: "Bowl", lines: [{}, {}], kcalPerServing: 1234.4 };
    assert.match(recipeSavedMessage(r, "joint"), /^Saved the recipe "Bowl" \(2 lines, 1,234 kcal per serving\)\. It is in the household's recipes, so it can go on the meal plan\.$/);
    assert.match(recipeSavedMessage({ ...r, kcalPerServing: null, lines: [{}] }, "personal"), /\(1 line\)\. Only you can see it, and it can't go on the shared meal plan\./);
  });

  test("the real route accepts exactly the body the screen builds, from a logged meal's entries", async (t) => {
    const api = await newApi(t);
    const bar = (await api.call("ann", "POST", "/foods", customFood("Protein bar", 200))).body;
    await api.call("ann", "POST", `/diary/${TODAY}`, { slot: "breakfast", foodId: bar.id, quantity: 2 });
    const day = (await api.call("ann", "GET", `/diary/${TODAY}`)).body;
    const slot = day.slots.find((s: any) => s.key === "breakfast");
    const { items } = itemsFromEntries(slot.entries);
    const made = await api.call("ann", "POST", "/recipes", recipeBody({ name: "Bar breakfast", onlyMe: false, yieldServings: 1, items }));
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal(made.body.kcalPerServing, 400);
    assert.equal(made.body.lines.length, 1);
  });
});

describe("renaming a saved meal", () => {
  test("a name must be there and at most 120 characters", () => {
    assert.equal(mealNameProblem("Usual breakfast"), null);
    assert.match(mealNameProblem("   ")!, /Give the meal a name/);
    assert.match(mealNameProblem("x".repeat(121))!, /120 characters/);
    assert.equal(mealNameProblem("x".repeat(120)), null);
  });

  test("rename and delete through the real routes: anyone who can see a meal can, a deleted one is gone for everyone", async (t) => {
    const api = await newApi(t);
    const bar = (await api.call("ann", "POST", "/foods", customFood("Protein bar", 200))).body;
    const shared = (await api.call("ann", "POST", "/saved-meals", { name: "Usual", scope: "joint", items: [{ foodId: bar.id }] })).body;
    const mine = (await api.call("ann", "POST", "/saved-meals", { name: "Private", scope: "personal", items: [{ foodId: bar.id }] })).body;

    const renamed = await api.call("ben", "PUT", `/saved-meals/${shared.id}`, { name: "Weekday usual" });
    assert.deepEqual([renamed.status, renamed.body.name, renamed.body.items.length], [200, "Weekday usual", 1], "the other login may rename a shared meal; its items stay");
    assert.equal((await api.call("ben", "PUT", `/saved-meals/${mine.id}`, { name: "Mine now" })).status, 404, "a personal meal doesn't exist for the other login");
    assert.equal((await api.call("ann", "PUT", `/saved-meals/${mine.id}`, { name: "" })).status, 400);

    assert.equal((await api.call("ben", "DELETE", `/saved-meals/${mine.id}`)).status, 404);
    assert.equal((await api.call("ben", "DELETE", `/saved-meals/${shared.id}`)).status, 200);
    assert.deepEqual((await api.call("ann", "GET", "/saved-meals")).body.map((m: any) => m.name), ["Private"]);
  });
});
