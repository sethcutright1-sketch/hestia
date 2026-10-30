// The bulk diary write, undo-by-group, the re-log amounts on a day's entries, and previous meals.
// Ported from the calorie app's meals.test.ts onto the data layer.

import { test, after } from "node:test";
import assert from "node:assert/strict";

import { cleanupDb } from "./helpers/testdb.ts";
import { NOW, TODAY, YESTERDAY, customFood, newWorld, type World } from "./helpers/nutritionWorld.ts";
import { addEntries, addEntry, deleteGroup, getDay } from "../nutrition/data/diary.ts";
import { daySummary, entryJson } from "../nutrition/data/days.ts";
import { createFood, foodJson, updateFood, deleteFood } from "../nutrition/data/foods.ts";
import { previousMeals } from "../nutrition/data/mealItems.ts";
import { all, get, run } from "../nutrition/data/sql.ts";
import { todayFor } from "../nutrition/data/tracker.ts";
import { addWeight } from "../nutrition/data/weights.ts";

after(cleanupDb);

const status = (fn: () => unknown): number => {
  try {
    fn();
  } catch (err: any) {
    return err.status ?? -1;
  }
  return 0;
};

const n = (kcal: number, protein = 0) => ({ kcal, protein, carbs: 0, fat: 0 });
const item = (i: number, rest: Record<string, unknown>) => ({ id: `bulk-item-${String(i).padStart(4, "0")}`, ...rest });
const rows = (w: World) => all<any>(w.db, "SELECT * FROM nutrition_diary_entries ORDER BY rowid");
const usage = (w: World, id: string) => get<{ usage_count: number }>(w.db, "SELECT usage_count FROM nutrition_foods WHERE id = ?", id)!.usage_count;

async function setup(t: Parameters<typeof newWorld>[0]) {
  const w = await newWorld(t);
  const who = (name: "ann" | "ben") => w.tracker(w.ids[name]);
  const bulk = (name: "ann" | "ben", date: string, body: Record<string, unknown>) => {
    const user = who(name);
    return addEntries(w.db, user, date, todayFor(user, NOW), body);
  };
  const single = (name: "ann" | "ben", date: string, body: Record<string, unknown>) => {
    const user = who(name);
    return addEntry(w.db, user, date, todayFor(user, NOW), body).row;
  };
  const summary = (name: "ann" | "ben", date: string) => daySummary(w.db, who(name), date, todayFor(who(name), NOW));
  const oats = foodJson(w.db, createFood(w.db, who("ann"), {
    name: "Rolled oats", basis: "per100g", nutrients: n(380, 13),
    servings: [{ label: "100 g", grams: 100, isDefault: true }, { label: "1 cup", grams: 80 }],
  }));
  const bar = foodJson(w.db, createFood(w.db, who("ann"), customFood("Protein bar", 210)));
  return { w, who, bulk, single, summary, oats, bar, cup: oats.servings[1].id };
}

test("bulk: every entry is built like a single add -- snapshots, source, group, one transaction", async (t) => {
  const { w, who, bulk, single, summary, oats, bar, cup } = await setup(t);
  addWeight(w.db, who("ann"), NOW, { weightKg: 80, measuredOn: "2026-03-01" });

  // The same food amount logged the old way, for comparison.
  const one = entryJson(single("ann", TODAY, { slot: "snacks", foodId: bar.id, quantity: 2 }));

  const r = bulk("ann", TODAY, {
    slot: "lunch", groupId: "group-aaaa-0001",
    items: [
      item(1, { foodId: bar.id, quantity: 2 }),
      item(2, { food_id: oats.id, grams: 80, source: "plan" }), // snake_case works inside items too
      item(3, { foodId: oats.id, quantity: 1, servingId: cup }),
    ],
  });
  assert.equal(r.created, 3);
  const [a, b2, cc] = r.entries.map(entryJson);
  for (const k of ["name", "quantity", "unit", "grams", "nutrients", "foodId", "status", "isQuickAdd"] as const) assert.deepEqual(a[k], one[k], k);
  assert.equal(a.slotKey, "lunch");
  assert.deepEqual([a.source, b2.source, cc.source], ["copy", "plan", "copy"], "item source, else the request's, else 'copy'");
  assert.deepEqual([a, b2, cc].map((e) => e.groupId), Array(3).fill("group-aaaa-0001"));
  assert.deepEqual([a, b2, cc].map((e) => e.id), ["bulk-item-0001", "bulk-item-0002", "bulk-item-0003"]);
  assert.deepEqual([b2.unit, b2.quantity, b2.grams, b2.nutrients.kcal], ["g", 80, 80, 304]);
  assert.deepEqual([cc.unit, cc.quantity, cc.grams, cc.nutrients.kcal], ["1 cup", 1, 80, 304]);
  const s = summary("ann", TODAY);
  assert.equal(s.eaten, 420 + 420 + 304 + 304);
  assert.equal(s.perSlot.lunch, 1028);
  assert.equal(one.groupId, null);

  // Rows are real diary rows; usage counts moved once per logged entry; the day's budget was frozen once.
  assert.equal(rows(w).length, 4);
  assert.equal(usage(w, bar.id), 2);
  assert.equal(usage(w, oats.id), 2);
  assert.equal(getDay(w.db, who("ann"), TODAY, TODAY).slots.find((x) => x.key === "lunch")!.entries[0].groupId, "group-aaaa-0001");

  // Editing the food afterwards leaves the entries alone (snapshots).
  updateFood(w.db, who("ann"), bar.id, { nutrients: n(999) });
  assert.equal(summary("ann", TODAY).eaten, 1448);
});

test("bulk: future days default to planned (and don't count as use); an explicit status is honoured", async (t) => {
  const { bulk, summary, oats, bar, w } = await setup(t);
  const r = bulk("ann", "2026-03-12", { slot: "dinner", items: [item(1, { foodId: bar.id }), item(2, { foodId: oats.id, grams: 50 })] });
  assert.deepEqual(r.entries.map((e) => e.status), ["planned", "planned"]);
  const s = summary("ann", "2026-03-12");
  assert.deepEqual([s.eaten, s.plannedKcal, s.plannedCount], [0, 210 + 190, 2]);
  assert.equal(usage(w, bar.id), 0);

  assert.equal(bulk("ann", "2026-03-13", { slot: "dinner", status: "logged", items: [item(3, { foodId: bar.id })] }).entries[0].status, "logged");
  assert.equal(bulk("ann", TODAY, { slot: "dinner", status: "planned", items: [item(4, { foodId: bar.id })] }).entries[0].status, "planned");
  assert.equal(bulk("ann", YESTERDAY, { slot: "dinner", items: [item(5, { foodId: bar.id })] }).entries[0].status, "logged");
});

test("bulk: replaying the request creates nothing new; an id that is someone else's refuses the whole request", async (t) => {
  const { w, bulk, single, summary, oats, bar } = await setup(t);
  const body = { slot: "lunch", groupId: "group-aaaa-0002", items: [item(1, { foodId: bar.id }), item(2, { foodId: oats.id, grams: 40 })] };

  const first = bulk("ann", TODAY, body);
  const second = bulk("ann", TODAY, body);
  assert.deepEqual([first.created, second.created], [2, 0]);
  assert.deepEqual(second.entries.map((e) => e.id), ["bulk-item-0001", "bulk-item-0002"]);
  assert.deepEqual(second.entries.map(entryJson), first.entries.map(entryJson));
  assert.equal(summary("ann", TODAY).eaten, 210 + 152);
  assert.equal(rows(w).length, 2);
  assert.equal(usage(w, bar.id), 1, "a replay must not double-count popularity");

  // A request that is half known: only the new item is created.
  const mixed = bulk("ann", TODAY, { slot: "lunch", items: [item(2, { foodId: oats.id, grams: 40 }), item(3, { foodId: bar.id })] });
  assert.equal(mixed.created, 1);
  assert.equal(rows(w).length, 3);

  // Ben sends Ann's id (after a fresh id of his own): 409 and nothing of his lands.
  assert.equal(status(() => bulk("ben", "2026-03-11", { slot: "lunch", items: [item(9, { foodId: bar.id }), item(1, { foodId: bar.id })] })), 409);
  assert.equal(rows(w).length, 3);
  assert.equal(rows(w).filter((r) => r.user_id === w.ids.ben).length, 0);
  // ...and the single add agrees about the same id.
  assert.equal(status(() => single("ben", TODAY, { id: "bulk-item-0001", slot: "lunch", kcal: 1 })), 409);
});

test("bulk: bad requests write nothing", async (t) => {
  const { w, bulk, bar } = await setup(t);
  const ok = item(1, { foodId: bar.id });
  const cases: Array<[string, number, Record<string, unknown>]> = [
    ["no items", 400, { slot: "lunch", items: [] }],
    ["items missing", 400, { slot: "lunch" }],
    ["unknown slot", 400, { slot: "elevenses", items: [ok] }],
    ["slot missing", 400, { items: [ok] }],
    ["no item id", 400, { slot: "lunch", items: [{ foodId: bar.id }] }],
    ["short item id", 400, { slot: "lunch", items: [{ id: "x", foodId: bar.id }] }],
    ["repeated id", 400, { slot: "lunch", items: [ok, { ...ok }] }],
    ["no foodId", 400, { slot: "lunch", items: [{ id: "bulk-item-0002" }] }],
    ["bad group id", 400, { slot: "lunch", groupId: "no", items: [ok] }],
    ["bad source", 400, { slot: "lunch", items: [{ ...ok, source: "magic" }] }],
    ["bad status", 400, { slot: "lunch", status: "eaten", items: [ok] }],
    ["grams on a per-serving food", 400, { slot: "lunch", items: [ok, item(2, { foodId: bar.id, grams: 40 })] }],
    ["unknown food after a good item", 404, { slot: "lunch", items: [ok, item(2, { foodId: "nope" })] }],
    ["too many", 400, { slot: "lunch", items: Array.from({ length: 101 }, (_, i) => item(i + 10, { foodId: bar.id })) }],
  ];
  for (const [name, code, body] of cases) assert.equal(status(() => bulk("ann", TODAY, body)), code, name);
  assert.equal(status(() => bulk("ann", "2026-02-30", { slot: "lunch", items: [ok] })), 400);
  assert.equal(rows(w).length, 0, "a failed bulk leaves no entry behind");
  assert.equal(usage(w, bar.id), 0);
});

test("group undo: removes exactly one person's group, can be repeated, and says which days it touched", async (t) => {
  const { w, who, bulk, single, summary, bar } = await setup(t);
  single("ann", TODAY, { slot: "snacks", foodId: bar.id });
  bulk("ann", TODAY, { slot: "lunch", groupId: "group-aaaa-0003", items: [item(1, { foodId: bar.id }), item(2, { foodId: bar.id, quantity: 2 })] });
  bulk("ann", TODAY, { slot: "dinner", groupId: "group-aaaa-0004", items: [item(3, { foodId: bar.id })] });

  // Ben holding Ann's group id changes nothing of hers.
  assert.deepEqual(deleteGroup(w.db, who("ben"), "group-aaaa-0003"), { dates: [], deleted: 0 });
  assert.equal(rows(w).filter((r) => r.deleted_at).length, 0);

  const undo = deleteGroup(w.db, who("ann"), "group-aaaa-0003");
  assert.deepEqual(undo, { dates: [TODAY], deleted: 2 });
  assert.equal(summary("ann", TODAY).eaten, 420, "the single add and the other group remain");
  assert.deepEqual(deleteGroup(w.db, who("ann"), "group-aaaa-0003"), { dates: [], deleted: 0 });
  assert.deepEqual(rows(w).filter((r) => r.deleted_at).map((r) => r.id).sort(), ["bulk-item-0001", "bulk-item-0002"]);
  assert.equal(status(() => deleteGroup(w.db, who("ann"), "x")), 400);
});

test("a day's entries say how to log them again, and bulk-logging that reproduces them", async (t) => {
  const { w, who, bulk, single, oats, bar, cup } = await setup(t);
  const log = (body: Record<string, unknown>) => single("ann", YESTERDAY, { slot: "breakfast", ...body });
  log({ food_id: oats.id, grams: 60 });
  log({ food_id: oats.id, quantity: 1.5, serving_id: cup });
  log({ food_id: oats.id, quantity: 2 }); // default serving = "100 g"
  log({ food_id: bar.id, quantity: 3 });
  log({ name: "Muffin", kcal: 300 });

  const entries = getDay(w.db, who("ann"), YESTERDAY, TODAY).slots.find((s) => s.key === "breakfast")!.entries;
  assert.deepEqual(entries.map((e) => e.relog), [
    { foodId: oats.id, grams: 60 },
    { foodId: oats.id, quantity: 1.5, servingId: cup },
    { foodId: oats.id, quantity: 2, servingId: oats.servings[0].id },
    { foodId: bar.id, quantity: 3 },
    null,
  ]);

  const items = entries.filter((e) => e.relog).map((e, i) => item(i + 1, { ...e.relog! }));
  const copy = bulk("ann", "2026-03-12", { slot: "snacks", items });
  assert.deepEqual(copy.entries.map(entryJson).map((e) => [e.nutrients.kcal, e.unit, e.quantity]),
    entries.filter((e) => e.relog).map((e) => [e.nutrients.kcal, e.unit, e.quantity]));
  assert.deepEqual(copy.entries.map((e) => e.status), Array(4).fill("planned"));

  // A food that is gone has no relog (it can't be logged), but its entry still shows.
  deleteFood(w.db, who("ann"), bar.id);
  const later = getDay(w.db, who("ann"), YESTERDAY, TODAY).slots.find((s) => s.key === "breakfast")!.entries;
  assert.equal(later[3].relog, null);
  assert.equal(later[3].name, "Protein bar");
});

// ---- previous meals -------------------------------------------------------------------------

/** Pin logged_at so same-day order is a function of the slot, not of the clock. */
const pin = (w: World) => run(w.db,
  `UPDATE nutrition_diary_entries SET logged_at = local_date || 'T' ||
     CASE slot_key WHEN 'breakfast' THEN '08' WHEN 'lunch' THEN '12' WHEN 'snacks' THEN '15' ELSE '18' END || ':00:00.000Z'`);

test("previous meals: logged slots of the last 21 days, deduped, newest first, quick adds as display only", async (t) => {
  const { w, who, bulk, single, oats, bar } = await setup(t);
  const old1 = foodJson(w.db, createFood(w.db, who("ann"), customFood("Old food", 100)));
  const old2 = foodJson(w.db, createFood(w.db, who("ann"), customFood("Too old food", 100)));
  const log = (date: string, slot: string, body: Record<string, unknown>) => single("ann", date, { slot, ...body });

  log("2026-03-10", "breakfast", { food_id: oats.id, grams: 40 });                          // today
  log("2026-03-09", "breakfast", { food_id: oats.id, grams: 80 });
  log("2026-03-09", "breakfast", { food_id: bar.id, quantity: 1 });
  log("2026-03-09", "lunch", { food_id: bar.id, quantity: 1 });
  log("2026-03-09", "lunch", { name: "Side salad", kcal: 80 });
  log("2026-03-09", "dinner", { name: "Takeout", kcal: 900 });                               // quick add only: not a meal
  log("2026-03-08", "breakfast", { food_id: bar.id, quantity: 1 });                         // same set as 03-09 breakfast, shuffled
  log("2026-03-08", "breakfast", { food_id: oats.id, grams: 80 });
  log("2026-03-07", "breakfast", { food_id: oats.id, grams: 80 });
  log("2026-03-07", "breakfast", { food_id: bar.id, quantity: 2 });                         // different amount: its own meal
  log("2026-03-10", "snacks", { food_id: bar.id, quantity: 4, status: "planned" });         // planned: not eaten
  log("2026-02-17", "breakfast", { food_id: old1.id });                                      // 21 days back: inside
  log("2026-02-16", "breakfast", { food_id: old2.id });                                      // 22 days back: outside
  pin(w);

  const meals = previousMeals(w.db, who("ann"), TODAY);
  assert.deepEqual(meals.map((m) => [m.date, m.slotKey]), [
    ["2026-03-10", "breakfast"], ["2026-03-09", "lunch"], ["2026-03-09", "breakfast"], ["2026-03-07", "breakfast"], ["2026-02-17", "breakfast"],
  ]);
  const [today, lunch, breakfast, seven] = meals;
  assert.equal(today.slotLabel, "Breakfast");
  assert.equal(today.kcal, 152);

  // Breakfast of the 9th stands for the 8th as well; items carry names, amounts and per-item kcal.
  assert.equal(breakfast.kcal, 304 + 210);
  assert.deepEqual(breakfast.items.map((i) => [i.name, i.kcal, i.available, i.isQuickAdd]), [["Rolled oats", 304, true, false], ["Protein bar", 210, true, false]]);
  assert.deepEqual([breakfast.items[0].grams, breakfast.items[0].quantity, breakfast.items[0].foodId], [80, 80, oats.id]);
  assert.equal(seven.kcal, 304 + 420);

  // The quick add is listed, but isn't part of what re-logging adds.
  assert.equal(lunch.items.length, 2);
  assert.deepEqual(lunch.items.map((i) => i.isQuickAdd), [false, true]);
  assert.equal(lunch.items[1].name, "Side salad");
  assert.equal(lunch.items[1].available, false);
  assert.equal(lunch.quickAddCount, 1);
  assert.equal(lunch.kcal, 210);

  assert.equal(previousMeals(w.db, who("ann"), TODAY, 2).length, 2);
  assert.equal(previousMeals(w.db, who("ann"), TODAY, 0).length, 5, "a nonsense limit falls back to the default");

  // Re-logging a previous meal is exactly a bulk write of its items.
  const again = bulk("ann", "2026-03-11", {
    slot: "snacks", groupId: "group-aaaa-0005",
    items: breakfast.items.filter((i) => i.available).map((i, k) =>
      item(k + 1, { foodId: i.foodId, ...(i.grams != null && i.servingId === null ? { grams: i.grams } : { quantity: i.quantity, servingId: i.servingId }) })),
  });
  assert.equal(again.entries.reduce((a, e) => a + entryJson(e).nutrients.kcal, 0), breakfast.kcal);
});

test("previous meals: values are current, gone foods are shown but not loggable, and each person sees only their own", async (t) => {
  const { w, who, single, summary, oats, bar } = await setup(t);
  const log = (date: string, slot: string, body: Record<string, unknown>) => single("ann", date, { slot, ...body });
  log(YESTERDAY, "breakfast", { food_id: oats.id, grams: 100 });
  log(YESTERDAY, "breakfast", { food_id: bar.id });
  log(YESTERDAY, "dinner", { food_id: bar.id, quantity: 2 });
  pin(w);

  // Editing the oats after the fact changes what re-logging would add, not what was eaten.
  updateFood(w.db, who("ann"), oats.id, { nutrients: n(400) });
  let meals = previousMeals(w.db, who("ann"), TODAY);
  assert.equal(meals.find((m) => m.slotKey === "breakfast")!.kcal, 400 + 210);
  assert.equal(summary("ann", YESTERDAY).eaten, 380 + 210 + 420);

  deleteFood(w.db, who("ann"), bar.id);
  meals = previousMeals(w.db, who("ann"), TODAY);
  assert.equal(meals.length, 1, "the dinner had nothing left to log");
  assert.equal(meals[0].slotKey, "breakfast");
  assert.equal(meals[0].unavailableCount, 1);
  assert.deepEqual(meals[0].items.map((i) => i.available), [true, false]);
  assert.equal(meals[0].kcal, 400);

  assert.deepEqual(previousMeals(w.db, who("ben"), TODAY), []);
});
