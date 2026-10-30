// The food diary: how an entry is built and frozen, planned vs logged, idempotent replays, the
// frozen per-day calorie budget, weigh-ins, and that one person's diary is theirs alone.
//
// Ported from the calorie app's HTTP tests (apps/calories/app.test.ts) onto the data layer:
// the same numbers and the same cases, minus the HTTP, with TEXT user ids, joint/personal
// foods in place of the old household/private, and "calorie budget" wherever it said "budget".

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { cleanupDb } from "./helpers/testdb.ts";
import { LONG_AGO, NOW, TODAY, YESTERDAY, addGeneric, customFood, newWorld, rowCount, type World } from "./helpers/nutritionWorld.ts";
import { addEntry, deleteEntry, getDay, updateEntry } from "../nutrition/data/diary.ts";
import { daySummary, entryJson, markDayDone } from "../nutrition/data/days.ts";
import { createFood, foodJson, recentFoods, updateFood } from "../nutrition/data/foods.ts";
import { addGoal } from "../nutrition/data/goals.ts";
import { all, get, run } from "../nutrition/data/sql.ts";
import { todayFor } from "../nutrition/data/tracker.ts";
import { addWeight, deleteWeight, listWeights, weightJson } from "../nutrition/data/weights.ts";

after(cleanupDb);

const status = (fn: () => unknown): number => {
  try {
    fn();
  } catch (err: any) {
    return err.status ?? -1;
  }
  return 0;
};

/** A world plus the shorthand every test below wants. `who` is "ann" or "ben"; today is each person's own. */
async function world(t: Parameters<typeof newWorld>[0]) {
  const w = await newWorld(t);
  const who = (name: "ann" | "ben") => w.tracker(w.ids[name]);
  const log = (name: "ann" | "ben", date: string, body: Record<string, unknown>) => {
    const user = who(name);
    return addEntry(w.db, user, date, todayFor(user, NOW), body);
  };
  const summary = (name: "ann" | "ben", date: string) => {
    const user = who(name);
    return daySummary(w.db, user, date, todayFor(user, NOW));
  };
  const weigh = (name: "ann" | "ben", body: Record<string, unknown>) => addWeight(w.db, who(name), NOW, body);
  const food = (name: "ann" | "ben", body: Record<string, unknown>) => foodJson(w.db, createFood(w.db, who(name), body));
  return { w, who, log, summary, weigh, food };
}

describe("entries are snapshots", () => {
  test("quick adds and food entries are computed on the server, and the day sums them", async (t) => {
    const { w, who, log, summary, weigh, food } = await world(t);
    weigh("ann", { weightKg: 80, measuredOn: "2026-03-01" });

    const quick = log("ann", TODAY, { slot: "lunch", name: "Restaurant salad", kcal: 450, protein: 20 });
    assert.equal(quick.created, true);
    const q = entryJson(quick.row);
    assert.deepEqual([q.isQuickAdd, q.nutrients.kcal, q.status], [true, 450, "logged"]);

    const oats = addGeneric(w.db, "Oats, dry", 380);
    const byGrams = entryJson(log("ann", TODAY, { slot: "breakfast", foodId: oats, grams: 40 }).row);
    assert.equal(byGrams.nutrients.kcal, 152); // 380 * 40 / 100
    assert.equal(byGrams.unit, "g");
    const bar = food("ann", customFood("Bar", 210));
    const two = entryJson(log("ann", TODAY, { slot: "snacks", foodId: bar.id, quantity: 2 }).row);
    assert.equal(two.nutrients.kcal, 420);
    assert.equal(two.grams, 100); // 2 x 50 g bar

    assert.equal(status(() => log("ann", TODAY, { slot: "nope", kcal: 1 })), 400);
    assert.equal(status(() => log("ann", "2026-02-30", { slot: "lunch", kcal: 1 })), 400);

    const day = getDay(w.db, who("ann"), TODAY, TODAY);
    assert.equal(day.slots.find((s) => s.key === "lunch")!.entries.length, 1);
    const s = day.summary;
    assert.equal(s.eaten, 450 + 152 + 420);
    assert.equal(s.calorieBudget, 2098.94);
    assert.equal(s.remaining, 2098.94 - 1022);
    assert.deepEqual(s.perSlot, { lunch: 450, breakfast: 152, snacks: 420 });
    assert.equal(s.macros.protein.goal, 104.95); // 20% of 2098.94 / 4

    // Editing the food later doesn't rewrite the logged entry.
    updateFood(w.db, who("ann"), bar.id, { nutrients: { kcal: 999 } });
    assert.equal(summary("ann", TODAY).eaten, 1022);

    // Quantity edit scales the snapshot.
    const patched = updateEntry(w.db, who("ann"), TODAY, two.id, { quantity: 1 });
    assert.equal(entryJson(patched).nutrients.kcal, 210);
    assert.equal(summary("ann", TODAY).eaten, 812);
    deleteEntry(w.db, who("ann"), two.id);
    assert.equal(summary("ann", TODAY).eaten, 602);
  });

  test("a client-supplied id makes a repeat a no-op that doesn't double-count popularity; someone else's id is a 409", async (t) => {
    const { w, log, summary, food } = await world(t);
    const bar = food("ann", customFood("Bar", 210));
    const body = { id: "offline-uuid-0001", slot: "snacks", foodId: bar.id, quantity: 1 };
    const first = log("ann", TODAY, body);
    const second = log("ann", TODAY, body);
    assert.deepEqual([first.created, second.created], [true, false]);
    assert.equal(second.row.id, "offline-uuid-0001");
    assert.equal(rowCount(w.db, "nutrition_diary_entries"), 1);
    assert.equal(summary("ann", TODAY).eaten, 210);
    assert.equal(get<{ usage_count: number }>(w.db, "SELECT usage_count FROM nutrition_foods WHERE id = ?", bar.id)!.usage_count, 1);
    assert.equal(status(() => log("ben", TODAY, body)), 409);
    assert.equal(rowCount(w.db, "nutrition_diary_entries"), 1);
  });
});

describe("planned entries", () => {
  test("they are left out of eaten, block Done, and count once activated", async (t) => {
    const { w, who, log, summary, weigh } = await world(t);
    weigh("ann", { weightLb: 176, measuredOn: "2026-03-01" });

    log("ann", TODAY, { slot: "breakfast", kcal: 300 });
    // Explicitly planned for today, and implicitly planned (future date).
    const planned = log("ann", TODAY, { slot: "dinner", kcal: 700, status: "planned" });
    assert.equal(planned.row.status, "planned");
    assert.equal(log("ann", "2026-03-11", { slot: "dinner", kcal: 500 }).row.status, "planned");

    let s = summary("ann", TODAY);
    assert.deepEqual([s.eaten, s.plannedKcal, s.remaining], [300, 700, s.calorieBudget! - 300]);

    let blocked: any;
    try {
      markDayDone(w.db, who("ann"), TODAY, TODAY);
    } catch (err) {
      blocked = err;
    }
    assert.equal(blocked.status, 409);
    assert.equal(blocked.extra.plannedCount, 1);

    const act = updateEntry(w.db, who("ann"), TODAY, planned.row.id, { status: "logged" });
    assert.equal(act.status, "logged");
    s = summary("ann", TODAY);
    assert.deepEqual([s.eaten, s.plannedKcal], [1000, 0]);

    assert.ok(markDayDone(w.db, who("ann"), TODAY, TODAY).doneLoggingAt);
  });

  test("logging counts toward a food's popularity; planning it does not, until the plan is activated", async (t) => {
    const { w, who, log, food } = await world(t);
    const bar = food("ann", customFood("Bar", 210));
    const usage = () => get<{ usage_count: number }>(w.db, "SELECT usage_count FROM nutrition_foods WHERE id = ?", bar.id)!.usage_count;
    const planned = log("ann", "2026-03-12", { slot: "snacks", foodId: bar.id });
    assert.equal(usage(), 0);
    assert.throws(() => updateEntry(w.db, who("ann"), TODAY, planned.row.id, { status: "logged" }), /hasn't happened yet/, "not before its day");
    assert.equal(usage(), 0);
    updateEntry(w.db, who("ann"), "2026-03-12", planned.row.id, { status: "logged" }); // on its day
    assert.equal(usage(), 1);
  });
});

describe("the calorie budget of a day", () => {
  test("a past day's calorie budget is frozen; today's follows the new goal", async (t) => {
    const { w, who, log, summary, weigh } = await world(t);
    weigh("ann", { weightKg: 80, measuredOn: "2026-03-01" });
    log("ann", LONG_AGO, { slot: "lunch", kcal: 500 });
    const before = summary("ann", LONG_AGO);
    assert.equal(before.calorieBudget, 2098.94); // the starting goal: maintain weight, light activity

    addGoal(w.db, who("ann"), TODAY, {
      effectiveFrom: "2026-03-01", planLbPerWeek: 1, activityLevel: "light",
      macroMode: "percent", macroProtein: 30, macroCarbs: 40, macroFat: 30,
    });
    // Same-day edit of "today" applies immediately...
    assert.equal(summary("ann", TODAY).calorieBudget, 1598.94);
    // ...but the already-lived day is untouched, even though the new goal covers its date.
    const after = summary("ann", LONG_AGO);
    assert.deepEqual([after.calorieBudget, after.maintenance], [before.calorieBudget, before.maintenance]);

    // A past day nobody opened has no snapshot yet, so it takes the goal then in effect.
    assert.equal(summary("ann", YESTERDAY).calorieBudget, 1598.94);

    assert.equal(status(() => addGoal(w.db, who("ann"), TODAY, { planLbPerWeek: 0.7, activityLevel: "light", macroProtein: 30, macroCarbs: 40, macroFat: 30 })), 400);
    // No weight on file -> explicit "missing", not a made-up calorie budget.
    const ben = summary("ben", TODAY);
    assert.equal(ben.calorieBudget, null);
    assert.deepEqual(ben.missing, ["weight"]);
  });

  test("without a profile there is no calorie budget, and it says so; the diary still works", async (t) => {
    const w = await newWorld(t, { profiles: false });
    const user = w.tracker(w.ids.ann);
    const today = todayFor(user, NOW);
    assert.deepEqual(daySummary(w.db, user, today, today).missing, ["profile", "goal", "weight"]);
    addEntry(w.db, user, today, today, { slot: "lunch", kcal: 400 });
    const s = daySummary(w.db, user, today, today);
    assert.deepEqual([s.eaten, s.calorieBudget, s.remaining], [400, null, null]);
  });

  test("a past day imported with a calorie budget of its own keeps it: viewing it and a later goal edit don't recompute", async (t) => {
    const { w, who, summary, weigh } = await world(t);
    weigh("ann", { weightKg: 80, measuredOn: "2026-03-01" });
    // What the Lose It! importer (phase 7) leaves behind: entries plus a day log carrying
    // Lose It!'s own calorie budget and no maintenance figure. Written by hand here.
    const ann = w.ids.ann;
    run(w.db, `INSERT INTO nutrition_diary_entries (id, user_id, local_date, slot_key, name_snapshot, quantity, unit_snapshot, nutrients_total, source, logged_at, updated_at)
               VALUES ('imp-1', ?, ?, 'breakfast', 'Oatmeal', 1, 'Cup', '{"kcal":414,"protein":0,"carbs":0,"fat":0,"satFat":0,"sugars":0,"fiber":0,"cholesterolMg":0,"sodiumMg":0}', 'import_loseit', 'x', 'x')`, ann, LONG_AGO);
    run(w.db, "INSERT INTO nutrition_day_logs (user_id, local_date, calorie_budget_kcal_snapshot) VALUES (?, ?, 2100), (?, '2026-03-06', 1900)", ann, LONG_AGO, ann);

    // This app would have said 2098.94 for Ann at 80 kg; Lose It! said 2100, and that is what the past shows.
    const view = summary("ann", LONG_AGO);
    assert.deepEqual([view.calorieBudget, view.maintenance, view.eaten, view.remaining], [2100, null, 414, 1686]);
    assert.equal(summary("ann", LONG_AGO).calorieBudget, 2100, "viewing it did not recompute and overwrite it");
    assert.equal(summary("ann", "2026-03-06").calorieBudget, 1900, "a day with a calorie budget but no entries is frozen too");

    addGoal(w.db, who("ann"), TODAY, {
      effectiveFrom: "2026-03-01", planLbPerWeek: 1, activityLevel: "light", macroMode: "percent", macroProtein: 30, macroCarbs: 40, macroFat: 30,
    });
    assert.equal(summary("ann", LONG_AGO).calorieBudget, 2100, "a goal edit doesn't rewrite imported history");
    assert.equal(getDay(w.db, who("ann"), LONG_AGO, TODAY).summary.calorieBudget, 2100);
    assert.equal(summary("ann", TODAY).calorieBudget, 1598.94, "today still follows the new goal");
    assert.equal(get<{ b: number }>(w.db, "SELECT calorie_budget_kcal_snapshot AS b FROM nutrition_day_logs WHERE local_date = ? AND user_id = ?", LONG_AGO, ann)!.b, 2100);
  });

  test("'today' is the person's local date, not UTC", async (t) => {
    const { w, who } = await world(t);
    // 01:30 UTC on Jan 15: still Jan 14 evening in New York, already Jan 15 afternoon in Auckland.
    const now = new Date("2026-01-15T01:30:00Z");
    const [ann, ben] = [who("ann"), who("ben")];
    const [annToday, benToday] = [todayFor(ann, now), todayFor(ben, now)];
    assert.deepEqual([annToday, benToday], ["2026-01-14", "2026-01-15"]);
    const body = { slot: "snacks", kcal: 100 };
    assert.equal(addEntry(w.db, ann, "2026-01-14", annToday, body).row.status, "logged");
    assert.equal(addEntry(w.db, ann, "2026-01-15", annToday, body).row.status, "planned");
    assert.equal(addEntry(w.db, ben, "2026-01-15", benToday, body).row.status, "logged");
    assert.equal(addWeight(w.db, ann, now, { weightKg: 80 }).measuredOn, "2026-01-14");
    assert.equal(addWeight(w.db, ben, now, { weightKg: 90 }).measuredOn, "2026-01-15");
  });
});

describe("weigh-ins", () => {
  test("pounds convert to kg, list by range, soft delete, and drive the calorie budget", async (t) => {
    const { w, who, summary, weigh } = await world(t);
    assert.equal(weigh("ann", { weightLb: 176.37, measuredOn: "2026-03-01" }).weightKg, 80);
    weigh("ann", { weightKg: 79, measuredOn: "2026-03-08" });
    assert.equal(listWeights(w.db, who("ann"), { from: "2026-03-05" }).length, 1);
    assert.equal(listWeights(w.db, who("ann")).length, 2);
    // Latest weight (79 kg) drives today's BMR: 10*79 + 1062.5 - 175 - 161 = 1516.5 -> x1.375.
    assert.equal(summary("ann", TODAY).maintenance, 2085.19);
    const del = listWeights(w.db, who("ann"))[1];
    deleteWeight(w.db, who("ann"), del.id);
    assert.equal(status(() => deleteWeight(w.db, who("ann"), del.id)), 404);
    assert.equal(summary("ann", TODAY).maintenance, 2098.94);
    assert.equal(status(() => weigh("ann", { weightKg: 5 })), 400);
    assert.deepEqual(weightJson(listWeights(w.db, who("ann"))[0]).measuredOn, "2026-03-01");
  });

  test("a client id makes a repeat a no-op and refuses another person's id; deleting twice is a 404", async (t) => {
    const { w, who, weigh } = await world(t);
    const body = { id: "weight-uuid-0001", weightLb: 176, measuredOn: "2026-03-01" };
    assert.equal(weigh("ann", body).created, true);
    assert.equal(weigh("ann", body).created, false);
    assert.equal(listWeights(w.db, who("ann")).length, 1);
    assert.equal(status(() => weigh("ben", body)), 409);
    deleteWeight(w.db, who("ann"), "weight-uuid-0001");
    assert.equal(status(() => deleteWeight(w.db, who("ann"), "weight-uuid-0001")), 404);
  });
});

describe("one person's diary is theirs alone", () => {
  test("the other login can't read, change, delete or replay it, and can't see a personal food", async (t) => {
    const { w, who, log, food } = await world(t);
    const priv = food("ann", customFood("Ann secret bar", 200, { scope: "personal" }));
    const shared = food("ann", customFood("Shared granola", 300));

    // The personal food is invisible to ben everywhere -- including logging it by id.
    assert.equal(status(() => log("ben", TODAY, { slot: "lunch", foodId: priv.id })), 404);
    assert.equal(status(() => updateFood(w.db, who("ben"), priv.id, { name: "x" })), 404);
    // The joint food is his to log.
    assert.equal(log("ben", TODAY, { slot: "lunch", foodId: shared.id }).created, true);

    // Ann's entry: ben can't edit it, delete it, or see it on the same date.
    const id = crypto.randomUUID();
    log("ann", TODAY, { id, slot: "lunch", kcal: 500 });
    assert.equal(status(() => updateEntry(w.db, who("ben"), TODAY, id, { quantity: 3 })), 404);
    assert.equal(status(() => deleteEntry(w.db, who("ben"), id)), 404);
    const benDay = getDay(w.db, who("ben"), TODAY, TODAY);
    assert.ok(!benDay.slots.some((s) => s.entries.some((e) => e.id === id)));
    // Replaying ann's client id as ben must not return or overwrite her entry.
    assert.equal(status(() => log("ben", TODAY, { id, slot: "lunch", kcal: 1 })), 409);
    const row = get<any>(w.db, "SELECT user_id, nutrients_total, deleted_at FROM nutrition_diary_entries WHERE id = ?", id);
    assert.equal(row.user_id, w.ids.ann);
    assert.equal(JSON.parse(row.nutrients_total).kcal, 500);
    assert.equal(row.deleted_at, null);
  });
});

describe("recent foods", () => {
  test("own logged foods from the last 60 days, newest first, only the ones still visible", async (t) => {
    const { w, who, log, food } = await world(t);
    const mk = (name: string, by: "ann" | "ben" = "ann") => food(by, customFood(name, 100)).id;
    const [older, newer, planned, ancient, removed, bens, hidden] = [
      mk("Older bar"), mk("Newer bar"), mk("Planned bar"), mk("Ancient bar"), mk("Removed bar"), mk("Ben bar", "ben"), mk("Later hidden bar"),
    ];
    const at = (who_: "ann" | "ben", date: string, foodId: string, loggedAt: string) => {
      const row = log(who_, date, { slot: "snacks", foodId, quantity: 1 }).row;
      run(w.db, "UPDATE nutrition_diary_entries SET logged_at = ? WHERE id = ?", loggedAt, row.id);
      return row.id;
    };
    at("ann", "2026-03-01", older, "2026-03-01T10:00:00Z");
    at("ann", "2026-03-01", older, "2026-03-01T11:00:00Z"); // logged twice, still one row
    at("ann", TODAY, newer, "2026-03-10T09:00:00Z");
    at("ann", "2026-03-20", planned, "2026-03-10T12:00:00Z"); // future date -> planned, never eaten
    at("ann", "2025-12-01", ancient, "2025-12-01T10:00:00Z"); // > 60 days before 2026-03-10
    const gone = at("ann", TODAY, removed, "2026-03-10T08:00:00Z");
    deleteEntry(w.db, who("ann"), gone);
    at("ben", TODAY, bens, "2026-03-10T13:00:00Z");
    at("ann", TODAY, hidden, "2026-03-10T07:00:00Z");
    run(w.db, "UPDATE nutrition_foods SET deleted_at = ? WHERE id = ?", "2026-03-10T14:00:00Z", hidden);

    const names = (name: "ann" | "ben", limit?: number) => recentFoods(w.db, who(name), TODAY, limit).map((f) => f.name);
    assert.deepEqual(names("ann"), ["Newer bar", "Older bar"]);
    assert.equal(names("ann", 1).length, 1);
    assert.deepEqual(names("ben"), ["Ben bar"]);
    assert.equal(all<{ x: number }>(w.db, "SELECT 1 AS x FROM nutrition_diary_entries").length, 8);
  });
});

describe("meals that are switched off or gone", () => {
  test("an entry in a disabled slot shows under that slot's real label and place; a slot with no row at all falls back to its key", async (t) => {
    const { w, who } = await world(t);
    const ann = w.ids.ann;
    // Order: breakfast, (disabled) brunch, lunch, dinner, snacks.
    run(w.db, "UPDATE nutrition_meal_slots SET sort = sort + 1 WHERE user_id = ? AND key IN ('lunch', 'dinner', 'snacks')", ann);
    run(w.db, "INSERT INTO nutrition_meal_slots (user_id, key, label, sort, enabled) VALUES (?, 'brunch', 'Brunch', 1, 0)", ann);
    const entry = (id: string, date: string, slot: string) => run(w.db,
      `INSERT INTO nutrition_diary_entries (id, user_id, local_date, slot_key, name_snapshot, quantity, unit_snapshot, nutrients_total, source, logged_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, 'serving', '{"kcal":100,"protein":0,"carbs":0,"fat":0,"satFat":0,"sugars":0,"fiber":0,"cholesterolMg":0,"sodiumMg":0}', 'manual', 'x', 'x')`,
      id, ann, date, slot, `in ${slot}`);
    entry("e1", LONG_AGO, "brunch");
    entry("e2", LONG_AGO, "ghost");

    const day = getDay(w.db, who("ann"), LONG_AGO, TODAY);
    assert.deepEqual(day.slots.map((s) => [s.key, s.label, s.enabled, s.entries.length]), [
      ["breakfast", "Breakfast", true, 0], ["brunch", "Brunch", false, 1], ["lunch", "Lunch", true, 0],
      ["dinner", "Dinner", true, 0], ["snacks", "Snacks", true, 0], ["ghost", "ghost", false, 1],
    ]);
    assert.equal(day.summary.perSlot.brunch, 100);
    // Days where it holds nothing don't list it, and it still can't be logged into.
    assert.deepEqual(getDay(w.db, who("ann"), YESTERDAY, TODAY).slots.map((s) => s.key), ["breakfast", "lunch", "dinner", "snacks"]);
    assert.equal(status(() => addEntry(w.db, who("ann"), YESTERDAY, TODAY, { slot: "brunch", kcal: 1 })), 400);
    // ...but an entry already in it can be edited in place.
    assert.equal(entryJson(updateEntry(w.db, who("ann"), TODAY, "e1", { quantity: 2 })).nutrients.kcal, 200);
  });
});
