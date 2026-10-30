// the project notes 10.15: `set_meal_status` used to change whichever meal came FIRST in a slot. With split meals
// (a family dinner plus one person's own) and leftovers that is a wrong-meal bug waiting to happen, so the tool now
// points at exactly one meal -- by id, or by day + slot narrowed by dish name and/or whose it is -- and when it still
// can't tell, it changes NOTHING and lists the candidates.

import { test, describe, before, beforeEach, after, mock } from "node:test";
import assert from "node:assert/strict";

import { loadDb, cleanupDb } from "./helpers/testdb.ts";
import { serverToday, mondayOf } from "../nutrition/dates.ts";

// These tests name days ("Tuesday") without a week, which means that day of THIS week; set_meal_status refuses a day
// already past in this week, so pin the clock to a Monday (nothing in the week is past) instead of the real date.
mock.timers.enable({ apis: ["Date"], now: new Date(2026, 9, 12, 9, 0) });

const { createUser, putScopedItem, getScopedItems, newId } = await loadDb();
const { buildTools } = await import("../assistant/registry.ts");

let alice: string;
let samId: string;
let jordanId: string;
const NOW = new Date().toISOString();

after(cleanupDb);

function callAs(name: string, args: Record<string, any>): Promise<any> {
  const tool = buildTools(alice).find((t) => t.name === name);
  assert.ok(tool, name);
  return tool.run(args);
}

// This week: the tool works on the week containing today unless told otherwise, and these tests never say otherwise.
const WEEK = mondayOf(serverToday());
let ids: Record<string, string>;
const meal = (key: string, m: Record<string, unknown>) => {
  ids[key] = newId("meal");
  return { id: ids[key], ingredients: ["x"], status: "proposed", audience: "family", ...m };
};

/** Saves the week. `reverse` flips the array order, to prove the answer never depends on which meal is first. */
function savePlan(reverse = false) {
  ids = {};
  const meals = [
    meal("family", { day: "Tuesday", slot: "dinner", name: "Lasagna" }),
    meal("sam", { day: "Tuesday", slot: "dinner", name: "Salad", audience: "individual", memberId: samId }),
    meal("jordan", { day: "Tuesday", slot: "dinner", name: "Salad", audience: "individual", memberId: jordanId }),
    meal("solo", { day: "Wednesday", slot: "lunch", name: "Tacos" }),
    meal("leftover", { day: "Thursday", slot: "dinner", name: "Leftover Lasagna", leftoverOf: "x" }),
    meal("sameDay", { day: "Thursday", slot: "dinner", name: "Pizza" }),
  ];
  putScopedItem("meal_plans", alice, {
    id: "plan-fixed",
    weekStart: WEEK,
    meals: reverse ? meals.reverse() : meals,
    scope: "joint",
    createdBy: alice,
    createdAt: NOW,
    updatedAt: NOW,
  });
}
const statuses = () => {
  const plan = (getScopedItems("meal_plans", alice) as any[]).find((p) => p.id === "plan-fixed");
  return Object.fromEntries(Object.entries(ids).map(([key, id]) => [key, plan.meals.find((m: any) => m.id === id).status]));
};
const ALL_PROPOSED = { family: "proposed", sam: "proposed", jordan: "proposed", solo: "proposed", leftover: "proposed", sameDay: "proposed" };

before(() => {
  alice = createUser("alice-status", "not-a-real-hash", "Alice");
  samId = newId("member");
  jordanId = newId("member");
  for (const [id, name] of [[samId, "Sam"], [jordanId, "Jordan"]] as const) {
    putScopedItem("household_members", alice, { id, name, likes: [], dislikes: [], scope: "joint", createdAt: NOW, updatedAt: NOW });
  }
});

for (const reverse of [false, true]) {
  describe(`set_meal_status with split meals (plan stored ${reverse ? "reversed" : "in order"})`, () => {
    beforeEach(() => savePlan(reverse));

    test("a slot holding several meals and no way to tell which: nothing changes and the candidates are listed", async () => {
      const r = await callAs("set_meal_status", { day: "Tuesday", slot: "dinner", status: "denied" });
      assert.match(r.error, /More than one meal is planned for Tuesday dinner/);
      assert.deepEqual(r.candidates.map((c: any) => [c.name, c.for]).sort(), [["Lasagna", "family"], ["Salad", "Jordan"], ["Salad", "Sam"]]);
      assert.ok(r.candidates.every((c: any) => typeof c.id === "string"));
      assert.deepEqual(statuses(), ALL_PROPOSED);
    });

    test("by dish name: the one meal with that name", async () => {
      const r = await callAs("set_meal_status", { day: "Tuesday", slot: "dinner", status: "denied", meal: "Lasagna" });
      assert.equal(r.status, "denied");
      assert.deepEqual(statuses(), { ...ALL_PROPOSED, family: "denied" });
    });

    test("a dish name shared by two people's own meals is still ambiguous -- until you say whose", async () => {
      const still = await callAs("set_meal_status", { day: "Tuesday", slot: "dinner", status: "denied", meal: "Salad" });
      assert.match(still.error, /More than one meal/);
      assert.equal(still.candidates.length, 2);
      assert.deepEqual(statuses(), ALL_PROPOSED);
      const r = await callAs("set_meal_status", { day: "Tuesday", slot: "dinner", status: "denied", meal: "salad", member: "Jordan" });
      assert.equal(r.name, "Salad");
      assert.deepEqual(statuses(), { ...ALL_PROPOSED, jordan: "denied" });
    });

    test("by whose it is: a person's own meal, or the family's", async () => {
      await callAs("set_meal_status", { day: "Tuesday", slot: "dinner", status: "denied", member: "sam" });
      assert.deepEqual(statuses(), { ...ALL_PROPOSED, sam: "denied" });
      await callAs("set_meal_status", { day: "Tuesday", slot: "dinner", status: "denied", member: "family" });
      assert.deepEqual(statuses(), { ...ALL_PROPOSED, sam: "denied", family: "denied" });
    });

    test("by id: exactly that meal", async () => {
      const r = await callAs("set_meal_status", { day: "Tuesday", slot: "dinner", status: "denied", id: ids.jordan });
      assert.equal(r.status, "denied");
      assert.deepEqual(statuses(), { ...ALL_PROPOSED, jordan: "denied" });
    });

    test("an id for a different day or slot, or one that doesn't exist, changes nothing", async () => {
      const wrongSlot = await callAs("set_meal_status", { day: "Tuesday", slot: "dinner", status: "denied", id: ids.solo });
      assert.match(wrongSlot.error, /not the dinner on Tuesday/);
      const unknown = await callAs("set_meal_status", { day: "Tuesday", slot: "dinner", status: "denied", id: "meal-nope" });
      assert.match(unknown.error, /No meal in the plan has the id/);
      assert.deepEqual(statuses(), ALL_PROPOSED);
    });

    test("a dish name that matches nothing there is an error, not a quiet fallback to whichever is first", async () => {
      const r = await callAs("set_meal_status", { day: "Tuesday", slot: "dinner", status: "denied", meal: "Pizza" });
      assert.match(r.error, /No meal called "Pizza" is planned for Tuesday dinner/);
      assert.equal(r.candidates.length, 3);
      assert.deepEqual(statuses(), ALL_PROPOSED);
    });

    test("a name and a person that contradict each other change nothing", async () => {
      const r = await callAs("set_meal_status", { day: "Tuesday", slot: "dinner", status: "denied", meal: "Lasagna", member: "Sam" });
      assert.match(r.error, /No Sam meal is planned/);
      assert.deepEqual(statuses(), ALL_PROPOSED);
    });

    test("an unknown family member gets the usual did-you-mean", async () => {
      const r = await callAs("set_meal_status", { day: "Tuesday", slot: "dinner", status: "denied", member: "Jordon" });
      assert.deepEqual(r.validValues, ["Jordan"]);
      assert.deepEqual(statuses(), ALL_PROPOSED);
    });

    test("a leftover and a fresh meal sharing a slot are told apart by name", async () => {
      const bare = await callAs("set_meal_status", { day: "Thursday", slot: "dinner", status: "denied" });
      assert.match(bare.error, /More than one meal/);
      assert.ok(bare.candidates.some((c: any) => c.leftover === true));
      await callAs("set_meal_status", { day: "Thursday", slot: "dinner", status: "denied", meal: "Leftover Lasagna" });
      assert.deepEqual(statuses(), { ...ALL_PROPOSED, leftover: "denied" });
    });

    test("a slot with one meal works exactly as before -- no extra arguments needed", async () => {
      const r = await callAs("set_meal_status", { day: "wednesday", slot: "Lunch", status: "denied" });
      assert.deepEqual([r.day, r.name, r.status], ["Wednesday", "Tacos", "denied"]);
      assert.deepEqual(statuses(), { ...ALL_PROPOSED, solo: "denied" });
    });

    test("a single meal with a wrong dish name is refused, not applied", async () => {
      const r = await callAs("set_meal_status", { day: "Wednesday", slot: "lunch", status: "denied", meal: "Soup" });
      assert.match(r.error, /No meal called "Soup"/);
      assert.deepEqual(statuses(), ALL_PROPOSED);
    });

    test("approving the picked meal reports ITS missing recipe, not another meal's", async () => {
      const r = await callAs("set_meal_status", { day: "Tuesday", slot: "dinner", status: "approved", meal: "Lasagna" });
      assert.match(r.error, /"Lasagna" has no recipe yet/);
      assert.deepEqual(statuses(), ALL_PROPOSED);
    });

    test("an empty day still says so", async () => {
      assert.match((await callAs("set_meal_status", { day: "Sunday", slot: "dinner", status: "denied" })).error, /No dinner planned for Sunday/);
    });

    test("get_meal_plan lists each meal's id so it can be pointed at", async () => {
      const plan = await callAs("get_meal_plan", {});
      assert.deepEqual(plan.meals.map((m: any) => m.id).sort(), Object.values(ids).sort());
    });
  });
}
