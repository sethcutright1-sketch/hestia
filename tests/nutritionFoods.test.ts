// Foods: who sees what (joint vs personal vs the read-only USDA catalogue), who may edit, and
// how search ranks. The visibility rules are the household-app convention -- owner_user_id NULL
// is joint, a user id is personal -- standing in for the calorie app's household/private.

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";

import { cleanupDb } from "./helpers/testdb.ts";
import { NOW, TODAY, addGeneric, customFood, newWorld, type World } from "./helpers/nutritionWorld.ts";
import { addEntry } from "../nutrition/data/diary.ts";
import {
  canEdit, canSee, createFood, deleteFood, foodJson, foodScope, getFood, parseNewFood, searchFoods, updateFood,
} from "../nutrition/data/foods.ts";
import { get, run } from "../nutrition/data/sql.ts";
import { todayFor } from "../nutrition/data/tracker.ts";

after(cleanupDb);

const status = (fn: () => unknown): number => {
  try {
    fn();
  } catch (err: any) {
    return err.status ?? -1;
  }
  return 0;
};

async function world(t: Parameters<typeof newWorld>[0]) {
  const w = await newWorld(t);
  const who = (name: "ann" | "ben") => w.tracker(w.ids[name]);
  const make = (name: "ann" | "ben", body: Record<string, unknown>) => foodJson(w.db, createFood(w.db, who(name), body));
  const search = (name: "ann" | "ben", q: string, limit = 25) => searchFoods(w.db, w.ids[name], q, limit).map((f) => foodJson(w.db, f));
  return { w, who, make, search };
}

describe("joint, personal and the USDA catalogue", () => {
  test("a food is joint unless made personal; the catalogue is neither", async (t) => {
    const { w, make } = await world(t);
    const joint = make("ann", customFood("Joint bar", 100));
    const personal = make("ann", customFood("Personal bar", 100, { scope: "personal" }));
    const generic = getFood(w.db, addGeneric(w.db, "Banana", 89))!;
    assert.deepEqual([joint.scope, joint.ownerUserId, joint.createdByUserId], ["joint", null, w.ids.ann]);
    assert.deepEqual([personal.scope, personal.ownerUserId], ["personal", w.ids.ann]);
    assert.equal(foodScope(generic), "generic");
    assert.equal(status(() => createFood(w.db, w.ann, customFood("Bad", 1, { scope: "household" }))), 400, "only joint|personal");
    assert.equal(parseNewFood({ name: "x", basis: "per_serving", nutrients: { kcal: 1 } }).scope, "joint", "the default");
  });

  test("everyone sees joint foods and the catalogue; only the owner sees a personal one", async (t) => {
    const { w, make, search } = await world(t);
    const joint = make("ann", customFood("Shared granola", 300));
    const personal = make("ann", customFood("Ann secret stash", 999, { scope: "personal" }));
    const genericId = addGeneric(w.db, "Granola, plain", 470);

    for (const id of [joint.id, genericId]) {
      assert.ok(canSee(getFood(w.db, id)!, w.ids.ann) && canSee(getFood(w.db, id)!, w.ids.ben), id);
    }
    assert.ok(canSee(getFood(w.db, personal.id)!, w.ids.ann));
    assert.ok(!canSee(getFood(w.db, personal.id)!, w.ids.ben));

    assert.deepEqual(search("ann", "secret").map((f) => f.id), [personal.id]);
    assert.deepEqual(search("ben", "secret"), []);
    assert.ok(search("ben", "granola").some((f) => f.id === joint.id));
    // The kiosk (or any id that isn't a tracker) sees joint foods and the catalogue, never anyone's personal food.
    assert.deepEqual(searchFoods(w.db, w.ids.kiosk, "secret", 10), []);
  });

  test("a deleted food is visible to no one", async (t) => {
    const { w, who, make, search } = await world(t);
    const food = make("ann", customFood("Gone bar", 100));
    deleteFood(w.db, who("ben"), food.id); // joint: either of them may delete it
    assert.ok(!canSee(getFood(w.db, food.id)!, w.ids.ann));
    assert.deepEqual(search("ann", "gone"), []);
    assert.equal(status(() => updateFood(w.db, who("ann"), food.id, { name: "x" })), 404);
  });

  test("joint foods are editable by either login; personal ones only by their owner; the catalogue by no one", async (t) => {
    const { w, who, make } = await world(t);
    const joint = make("ann", customFood("Joint bar", 100));
    const personal = make("ann", customFood("Personal bar", 100, { scope: "personal" }));
    const generic = addGeneric(w.db, "Rolled oats", 380);

    assert.equal(updateFood(w.db, who("ben"), joint.id, { name: "Ben's rename" }).name, "Ben's rename");
    assert.equal(status(() => updateFood(w.db, who("ben"), personal.id, { name: "x" })), 404, "not even visible to him");
    assert.equal(status(() => deleteFood(w.db, who("ben"), personal.id)), 404);
    assert.equal(status(() => updateFood(w.db, who("ann"), generic, { name: "x" })), 403);
    assert.equal(status(() => deleteFood(w.db, who("ann"), generic)), 403);
    assert.ok(canEdit(getFood(w.db, joint.id)!, w.ids.ben) && !canEdit(getFood(w.db, generic)!, w.ids.ann));
  });

  test("changing who a food is shared with is the creator's call: personal -> the creator, joint -> no one", async (t) => {
    const { w, who, make } = await world(t);
    const food = make("ann", customFood("Ann's bar", 100));
    // Ben can see and edit a joint food, but can't pull it out of Ann's sight.
    assert.equal(status(() => updateFood(w.db, who("ben"), food.id, { scope: "personal" })), 403);
    assert.equal(foodScope(getFood(w.db, food.id)!), "joint");

    const mine = updateFood(w.db, who("ann"), food.id, { scope: "personal" });
    assert.deepEqual([foodScope(mine), mine.owner_user_id], ["personal", w.ids.ann]);
    assert.ok(!canSee(mine, w.ids.ben), "now invisible to ben");
    const shared = updateFood(w.db, who("ann"), food.id, { scope: "joint" });
    assert.deepEqual([foodScope(shared), shared.owner_user_id], ["joint", null]);
    // Saying the scope it already has is not a change.
    assert.equal(updateFood(w.db, who("ben"), food.id, { scope: "joint", name: "Renamed" }).name, "Renamed");
  });

  test("editing a food never rewrites a diary entry already logged; deleting it keeps the entry's name", async (t) => {
    const { w, who, make } = await world(t);
    const bar = make("ann", customFood("Bar", 210));
    const entry = addEntry(w.db, who("ann"), TODAY, todayFor(who("ann"), NOW), { slot: "snacks", foodId: bar.id }).row;
    updateFood(w.db, who("ann"), bar.id, { name: "Renamed bar", nutrients: { kcal: 999 } });
    deleteFood(w.db, who("ann"), bar.id);
    const kept = get<{ name_snapshot: string; nutrients_total: string }>(w.db, "SELECT name_snapshot, nutrients_total FROM nutrition_diary_entries WHERE id = ?", entry.id)!;
    assert.equal(kept.name_snapshot, "Bar");
    assert.equal(JSON.parse(kept.nutrients_total).kcal, 210);
  });
});

describe("food input", () => {
  test("nutrients, servings and barcodes are validated", async (t) => {
    const { w, who } = await world(t);
    const create = (body: Record<string, unknown>) => status(() => createFood(w.db, who("ann"), body));
    const ok = customFood("Fine", 100);
    assert.equal(create(ok), 0);
    assert.equal(create({ ...ok, name: "" }), 400);
    assert.equal(create({ ...ok, basis: "per_cup" }), 400);
    assert.equal(create({ ...ok, nutrients: { protein: 1 } }), 400, "kcal is required");
    assert.equal(create({ ...ok, nutrients: { kcal: -1 } }), 400);
    assert.equal(create({ ...ok, nutrients: { kcal: 1e6 } }), 400);
    assert.equal(create({ ...ok, servings: [{ label: "a", grams: 1 }, { label: "b", grams: 2 }] }), 400, "per_serving foods have exactly one serving");
    assert.equal(create({ ...ok, gtin14: "012345678900" }), 400, "bad check digit");
    assert.equal(create({ name: "Per 100", basis: "per100g", nutrients: { kcal: 1 }, servings: [{ label: "1 cup" }] }), 400, "per100g servings need grams");
    // Defaults: a per100g food gets a 100 g serving, a per_serving one gets "1 serving".
    const p100 = foodJson(w.db, createFood(w.db, who("ann"), { name: "Plain", basis: "per100g", nutrients: { kcal: 1 } }));
    assert.deepEqual(p100.servings.map((s) => [s.label, s.grams, s.isDefault]), [["100 g", 100, true]]);
    const perServing = foodJson(w.db, createFood(w.db, who("ann"), { name: "Single", basis: "per_serving", nutrients: { kcal: 1 } }));
    assert.deepEqual(perServing.servings.map((s) => [s.label, s.isDefault]), [["1 serving", true]]);
  });

  test("a barcode belongs to one food: a duplicate is a 409, a deleted food frees it", async (t) => {
    const { w, who } = await world(t);
    const code = "012345678905";
    const first = createFood(w.db, who("ann"), customFood("First", 1, { gtin14: code }));
    assert.equal(first.gtin14, `00${code}`);
    assert.equal(status(() => createFood(w.db, who("ben"), customFood("Second", 1, { gtin14: code }))), 409);
    deleteFood(w.db, who("ann"), first.id);
    assert.equal(status(() => createFood(w.db, who("ben"), customFood("Second", 1, { gtin14: code }))), 0);
  });

  test("editing servings keeps the id of one whose label stays, so saved meals don't lose it", async (t) => {
    const { w, who, make } = await world(t);
    const oats = make("ann", {
      name: "Oats", basis: "per100g", nutrients: { kcal: 380 },
      servings: [{ label: "100 g", grams: 100, isDefault: true }, { label: "1 cup", grams: 80 }],
    });
    const cup = oats.servings[1].id;
    const after_ = foodJson(w.db, updateFood(w.db, who("ann"), oats.id, {
      servings: [{ label: "100 g", grams: 100, isDefault: true }, { label: "1 cup", grams: 90 }, { label: "1 scoop", grams: 30 }],
    }));
    assert.equal(after_.servings.length, 3);
    const cupAfter = after_.servings.find((s) => s.label === "1 cup")!;
    assert.deepEqual([cupAfter.id, cupAfter.grams], [cup, 90]);
  });
});

describe("search ranking", () => {
  test("a joint food outranks a generic one with a better text match", async (t) => {
    const { w, make, search } = await world(t);
    addGeneric(w.db, "Banana", 89); // exact, shortest name: bm25 favours it
    addGeneric(w.db, "Bananas, dehydrated, or banana powder", 346);
    const mine = make("ann", customFood("Banana nut protein bar", 200));
    const hits = search("ann", "banan");
    assert.equal(hits[0].id, mine.id, "the household's own food first");
    assert.equal(hits.length, 3);
    assert.equal(hits[1].source, "usda_generic");
    // The other login finds it too: it is joint.
    assert.equal(search("ben", "banana")[0].id, mine.id);
    // Operators in user input are inert.
    assert.doesNotThrow(() => search("ann", 'banana" OR *'));
  });

  test("usage count lifts a food above an otherwise equal one", async (t) => {
    const { w, who, make, search } = await world(t);
    const a = make("ann", customFood("Oat bar plain", 150));
    const b = make("ann", customFood("Oat bar sweet", 150));
    for (let i = 0; i < 4; i++) addEntry(w.db, who("ann"), TODAY, TODAY, { slot: "snacks", foodId: b.id, quantity: 1 });
    const hits = search("ann", "oat");
    assert.deepEqual(hits.map((h) => h.id), [b.id, a.id]);
    assert.equal(hits[0].usageCount, 4);
  });

  test("a food you added outranks the same match added by the other login", async (t) => {
    const { make, search } = await world(t);
    const bens = make("ben", customFood("Cereal bar", 100));
    const anns = make("ann", customFood("Cereal bar", 100));
    assert.deepEqual(search("ann", "cereal").map((f) => f.id), [anns.id, bens.id]);
    assert.deepEqual(search("ben", "cereal").map((f) => f.id), [bens.id, anns.id]);
  });

  test("recently used beats long unused; a short, empty or operator-only query is safe", async (t) => {
    const { w, make, search } = await world(t);
    const stale = make("ann", customFood("Rice cake plain", 100));
    const fresh = make("ann", customFood("Rice cake salted", 100));
    run(w.db, "UPDATE nutrition_foods SET usage_count = 1, last_used_at = ? WHERE id = ?", new Date().toISOString(), fresh.id);
    run(w.db, "UPDATE nutrition_foods SET usage_count = 1, last_used_at = '2020-01-01T00:00:00Z' WHERE id = ?", stale.id);
    assert.deepEqual(search("ann", "rice").map((f) => f.id), [fresh.id, stale.id]);
    assert.deepEqual(search("ann", ""), []);
    assert.deepEqual(search("ann", '"*()'), []);
    assert.equal(search("ann", "ric").length, 2, "prefix matching: typing narrows as you go");
  });

  test("the limit applies after ranking, and the catalogue can't push your own foods off the list", async (t) => {
    const { w, make, search } = await world(t);
    for (let i = 0; i < 70; i++) addGeneric(w.db, `Chicken, part ${i}`, 200);
    const mine = make("ann", customFood("Chicken salad box from the deli with extra words in the name", 400));
    const hits = search("ann", "chicken", 5);
    assert.equal(hits.length, 5);
    assert.equal(hits[0].id, mine.id, "tier outweighs a worse text match");
  });
});

describe("the USDA catalogue's own rules", () => {
  test("a catalogue row can't be owned by anyone (it is read-only by construction)", async (t) => {
    const w: World = await newWorld(t);
    assert.throws(
      () => run(w.db, "INSERT INTO nutrition_foods (id, owner_user_id, name, basis, nutrients, source, created_at) VALUES ('g1', ?, 'x', 'per100g', '{}', 'usda_generic', 'x')", w.ids.ann),
      /CHECK constraint failed/,
    );
  });
});
