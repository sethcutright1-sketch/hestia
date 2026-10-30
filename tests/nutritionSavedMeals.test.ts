// Saved meals: create from items or from a logged slot, joint vs personal, update, delete.
// Ported from the calorie app's recipes.test.ts (its saved-meal cases; recipes are phase 3).

import { test, after } from "node:test";
import assert from "node:assert/strict";

import { cleanupDb } from "./helpers/testdb.ts";
import { NOW, TODAY, YESTERDAY, customFood, newWorld } from "./helpers/nutritionWorld.ts";
import { addEntry } from "../nutrition/data/diary.ts";
import { createFood, deleteFood, foodJson, updateFood } from "../nutrition/data/foods.ts";
import {
  createSavedMeal, deleteSavedMeal, listSavedMeals, requireSavedMeal, savedMealItems, savedMealJson, updateSavedMeal,
} from "../nutrition/data/savedMeals.ts";
import { all } from "../nutrition/data/sql.ts";
import { todayFor } from "../nutrition/data/tracker.ts";

after(cleanupDb);

const n = (kcal: number, protein = 0, carbs = 0, fat = 0) => ({ kcal, protein, carbs, fat });
const status = (fn: () => unknown): number => {
  try {
    fn();
  } catch (err: any) {
    return err.status ?? -1;
  }
  return 0;
};

async function setup(t: Parameters<typeof newWorld>[0]) {
  const w = await newWorld(t);
  const who = (name: "ann" | "ben") => w.tracker(w.ids[name]);
  const food = (body: Record<string, unknown>, by: "ann" | "ben" = "ann") => foodJson(w.db, createFood(w.db, who(by), body));
  const oats = food({
    name: "Rolled oats", basis: "per100g", nutrients: n(380, 13, 68, 7),
    servings: [{ label: "100 g", grams: 100, isDefault: true }, { label: "1 cup", grams: 80 }],
  });
  const bar = food(customFood("Protein bar", 210));
  const personalBar = food(customFood("Personal bar", 300, { scope: "personal" }));
  const create = (body: Record<string, unknown>, by: "ann" | "ben" = "ann") => createSavedMeal(w.db, who(by), body);
  const json = (id: string, by: "ann" | "ben" = "ann") => savedMealJson(w.db, who(by), requireSavedMeal(w.db, who(by), id));
  const names = (by: "ann" | "ben") => listSavedMeals(w.db, who(by)).map((m) => m.name);
  return { w, who, food, oats, bar, personalBar, create, json, names };
}

test("saved meals: create from items, list with totals, joint vs personal, update, delete", async (t) => {
  const { w, who, oats, bar, personalBar, create, json, names } = await setup(t);

  const { meal } = create({ name: "Usual breakfast", defaultSlotKey: "breakfast", items: [{ foodId: oats.id, grams: 80 }, { foodId: bar.id, quantity: 2 }] });
  const m = json(meal.id);
  assert.equal(m.kcal, 304 + 420);
  assert.equal(m.defaultSlotKey, "breakfast");
  assert.deepEqual([m.scope, m.ownerUserId, m.createdByUserId], ["joint", null, w.ids.ann]);
  assert.deepEqual(m.items.map((i) => [i.foodId, i.quantity, i.grams, i.unit, i.kcal, i.available]), [
    [oats.id, 80, 80, "g", 304, true], [bar.id, 2, null, "1 bar", 420, true],
  ]);
  assert.equal(m.items[1].servingId, bar.servings[0].id);
  assert.equal(m.items[1].totalGrams, 100);

  // Validation.
  const bad = (body: Record<string, unknown>, by: "ann" | "ben" = "ann") => status(() => create(body, by));
  assert.equal(bad({ items: [{ foodId: bar.id }] }), 400, "no name");
  assert.equal(bad({ name: "x", items: [] }), 400);
  assert.equal(bad({ name: "x" }), 400);
  assert.equal(bad({ name: "x", items: [{ foodId: "nope" }] }), 404);
  assert.equal(bad({ name: "x", defaultSlotKey: "elevenses", items: [{ foodId: bar.id }] }), 400);
  assert.equal(bad({ name: "x", items: [{ foodId: bar.id, grams: 10 }] }), 400);
  assert.equal(bad({ name: "x", items: [{ foodId: bar.id }], fromDate: TODAY, fromSlot: "lunch" }), 400);
  assert.equal(bad({ name: "x", scope: "household", items: [{ foodId: bar.id }] }), 400);
  // A joint meal can't hold a personal food; a personal meal can.
  assert.throws(() => create({ name: "Shared", items: [{ foodId: personalBar.id }] }), (e: any) => e.status === 400 && /personal food/.test(e.message));
  const mine = create({ name: "Just mine", scope: "personal", items: [{ foodId: personalBar.id }] }).meal;
  assert.equal(mine.owner_user_id, w.ids.ann);
  // Someone else's personal food isn't even visible to build with.
  assert.equal(bad({ name: "y", scope: "personal", items: [{ foodId: personalBar.id }] }, "ben"), 404);

  // Ben sees the joint one only.
  assert.deepEqual(names("ann"), ["Just mine", "Usual breakfast"]);
  assert.deepEqual(names("ben"), ["Usual breakfast"]);
  assert.equal(status(() => requireSavedMeal(w.db, who("ben"), mine.id)), 404);
  assert.equal(status(() => updateSavedMeal(w.db, who("ben"), mine.id, { name: "z" })), 404);
  assert.equal(status(() => deleteSavedMeal(w.db, who("ben"), mine.id)), 404);
  assert.equal(json(m.id, "ben").mine, false);
  assert.equal(json(m.id, "ann").mine, true);
  // Sharing a personal meal that holds a personal food is refused.
  assert.equal(status(() => updateSavedMeal(w.db, who("ann"), mine.id, { scope: "joint" })), 400);

  // Update: rename + replace items, by the other login (it is joint).
  const upd = updateSavedMeal(w.db, who("ben"), m.id, { name: "Ben's breakfast", items: [{ foodId: bar.id, quantity: 1 }] });
  assert.equal(upd.name, "Ben's breakfast");
  assert.equal(json(m.id).kcal, 210);
  assert.equal(upd.default_slot_key, "breakfast", "untouched fields keep their value");
  assert.equal(savedMealItems(w.db, m.id).length, 1);
  // Only the creator changes who it is shared with.
  assert.equal(status(() => updateSavedMeal(w.db, who("ben"), m.id, { scope: "personal" })), 403);

  // A food that disappears turns its item unavailable (listed, not counted) rather than failing the list.
  deleteFood(w.db, who("ann"), bar.id);
  const after_ = json(m.id);
  assert.deepEqual([after_.items[0].available, after_.items[0].name, after_.kcal], [false, "Protein bar", 0]);

  // A food its owner makes personal later is unavailable to the other login, and not even named.
  const shared = create({ name: "Shared shake", items: [{ foodId: oats.id, grams: 30 }] }).meal;
  updateFood(w.db, who("ann"), oats.id, { scope: "personal" });
  const view = json(shared.id, "ben");
  assert.deepEqual([view.items[0].available, view.items[0].name, view.kcal], [false, "Unavailable food", 0]);
  assert.equal(json(shared.id, "ann").items[0].available, true);

  deleteSavedMeal(w.db, who("ann"), m.id);
  assert.equal(status(() => requireSavedMeal(w.db, who("ann"), m.id)), 404);
  assert.deepEqual(names("ben"), ["Shared shake"]);
});

test("a personal meal can be shared once its foods are joint, and the creator can take a joint one back", async (t) => {
  const { w, who, food, create, json, names } = await setup(t);
  const jointFood = food(customFood("Joint bar", 100));
  const personalMeal = create({ name: "Mine", scope: "personal", items: [{ foodId: jointFood.id }] }).meal;
  assert.deepEqual(names("ben"), []);
  updateSavedMeal(w.db, who("ann"), personalMeal.id, { scope: "joint" });
  assert.deepEqual(names("ben"), ["Mine"]);
  assert.equal(json(personalMeal.id, "ben").scope, "joint");
  const back = updateSavedMeal(w.db, who("ann"), personalMeal.id, { scope: "personal" });
  assert.equal(back.owner_user_id, w.ids.ann);
  assert.deepEqual(names("ben"), []);
});

test("saved meal from a logged slot keeps its foods and amounts, notes the skipped quick add and remembers the slot", async (t) => {
  const { w, who, oats, bar, create } = await setup(t);
  const today = todayFor(who("ann"), NOW);
  const log = (date: string, body: Record<string, unknown>) => addEntry(w.db, who("ann"), date, today, body);
  log(YESTERDAY, { slot: "lunch", foodId: oats.id, grams: 50 });
  log(YESTERDAY, { slot: "lunch", foodId: bar.id, quantity: 3 });
  log(YESTERDAY, { slot: "lunch", name: "Side salad", kcal: 80 });

  const r = create({ name: "Lunch combo", fromDate: YESTERDAY, fromSlot: "lunch" });
  const json = savedMealJson(w.db, who("ann"), r.meal, r.skipped);
  assert.equal(json.defaultSlotKey, "lunch");
  assert.equal(json.items.length, 2);
  assert.equal(json.kcal, 190 + 630);
  assert.deepEqual(json.skipped!.map((s) => s.name), ["Side salad"]);

  assert.equal(status(() => create({ name: "x", fromDate: YESTERDAY, fromSlot: "dinner" })), 404);
  assert.equal(status(() => create({ name: "x", fromDate: "not-a-date", fromSlot: "lunch" })), 400);
  assert.equal(all(w.db, "SELECT * FROM nutrition_saved_meals").length, 1);

  // Planned entries can be saved too (a planned dinner is still a meal).
  log("2026-03-12", { slot: "dinner", foodId: bar.id, quantity: 1 });
  assert.ok(create({ name: "Planned dinner", fromDate: "2026-03-12", fromSlot: "dinner" }).meal.id);
});
