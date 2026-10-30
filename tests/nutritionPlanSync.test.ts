// nutrition/data/mealPlanSync.ts: approved plan meals -> planned diary entries, and keeping them in step
// (merge plan decisions 1 and 4, ported from the calorie app's Phase 3b). The plan document itself is household-app's
// and is tested through the routes (mealplanDiary.test.ts); here the sync is handed the meal before and after.

import { test, after } from "node:test";
import assert from "node:assert/strict";

import { cleanupDb } from "./helpers/testdb.ts";
import { newWorld } from "./helpers/nutritionWorld.ts";
import { addLogin, kcalOf, mealEntries, siteRecipe, syncMeal } from "./helpers/planWorld.ts";
import { deleteEntry, updateEntry } from "../nutrition/data/diary.ts";
import { NutritionError } from "../nutrition/data/errors.ts";
import { dropMealsEntries, logPlannedSlot, planGroupId, syncMealEntries } from "../nutrition/data/mealPlanSync.ts";
import { createSlot, updateSlot } from "../nutrition/data/slots.ts";
import { saveRecipe } from "../nutrition/data/recipes.ts";
import { get, run } from "../nutrition/data/sql.ts";

after(cleanupDb);

const NOW = new Date("2026-03-10T15:00:00Z");
const TODAY = "2026-03-10";
const sync = (w: Awaited<ReturnType<typeof newWorld>>, prev: any, next: any) => syncMealEntries(w.db, { prev, next, now: NOW });

test("approving a family meal gives every diary login one planned entry at one serving, on the meal's date and slot", async (t) => {
  const w = await newWorld(t);
  const chili = siteRecipe(w, "Chili", 450);
  const meal = syncMeal(chili, [w.ids.ann, w.ids.ben]);
  const r = sync(w, null, meal);
  assert.deepEqual(r.created.map((c) => c.name).sort(), ["Ann", "Ben"]);
  assert.equal(r.removed, 0);

  const rows = mealEntries(w.db, meal.id);
  assert.equal(rows.length, 2);
  for (const e of rows) {
    assert.deepEqual([e.status, e.source, e.local_date, e.slot_key, e.quantity, kcalOf(e), e.food_id, e.plan_slot_key],
      ["planned", "plan", "2026-03-12", "dinner", 1, 450, chili.foodId, null]);
  }
  assert.deepEqual(rows.map((e) => e.group_id).sort(), [planGroupId(meal.id, w.ids.ann), planGroupId(meal.id, w.ids.ben)].sort());
  assert.notEqual(planGroupId(meal.id, w.ids.ann), planGroupId(meal.id, w.ids.ben), "a group per meal + person");
  assert.match(planGroupId(meal.id, w.ids.ann), /^[A-Za-z0-9_-]{8,64}$/, "a valid client group id (so undo-by-group works)");
});

test("a proposed or denied meal gives nobody anything", async (t) => {
  const w = await newWorld(t);
  const chili = siteRecipe(w, "Chili", 450);
  for (const status of ["proposed", "denied"] as const) {
    const meal = syncMeal(chili, [w.ids.ann, w.ids.ben], { status });
    sync(w, null, meal);
    assert.equal(mealEntries(w.db, meal.id).length, 0, status);
  }
});

test("an individual meal reaches only the login it is for; the kiosk never gets an entry, and a login that no longer exists is skipped", async (t) => {
  const w = await newWorld(t);
  const chili = siteRecipe(w, "Chili", 450);

  const mine = syncMeal(chili, [w.ids.ben]);
  sync(w, null, mine);
  assert.deepEqual(mealEntries(w.db, mine.id).map((e) => e.user_id), [w.ids.ben]);

  const withKiosk = syncMeal(chili, [w.ids.ann, w.ids.kiosk]);
  const r = sync(w, null, withKiosk);
  assert.deepEqual(mealEntries(w.db, withKiosk.id).map((e) => e.user_id), [w.ids.ann]);
  assert.deepEqual(r.skipped.map((s) => s.userId), [w.ids.kiosk]);
  assert.match(r.skipped[0].reason, /kiosk/i);
  assert.equal(get<{ n: number }>(w.db, "SELECT COUNT(*) AS n FROM nutrition_diary_entries WHERE user_id = ?", w.ids.kiosk)!.n, 0);

  // A linked login that was removed: skipped, and the others still get theirs (no crash).
  const gone = syncMeal(chili, [w.ids.ann, "user-who-left"]);
  const r2 = sync(w, null, gone);
  assert.deepEqual(r2.created.map((c) => c.userId), [w.ids.ann]);
  assert.match(r2.skipped.find((s) => s.userId === "user-who-left")!.reason, /no longer exists/);

  // Nobody reachable (an unlinked member): nothing written, and the reason the caller supplied is reported.
  const nobody = syncMeal(chili, [], { notTargeted: ["Sam isn't linked to a login."] });
  const r3 = sync(w, null, nobody);
  assert.deepEqual([r3.created.length, r3.skipped.map((s) => s.reason)], [0, ["Sam isn't linked to a login."]]);
});

test("a plan slot a person lacks falls back to the nearest standard slot they have, and the choice is recorded", async (t) => {
  const w = await newWorld(t);
  const chili = siteRecipe(w, "Chili", 450);
  createSlot(w.db, w.ann, { label: "Brunch" }); // only ann has it
  createSlot(w.db, w.ben, { label: "Pre-workout" });
  updateSlot(w.db, w.ben, "snacks", { enabled: false }); // ben has no snacks

  // "brunch" sounds like breakfast: ann has the slot itself; ben falls back to breakfast.
  const brunch = syncMeal(chili, [w.ids.ann, w.ids.ben], { slotKey: "brunch" });
  const r = sync(w, null, brunch);
  const byUser = Object.fromEntries(mealEntries(w.db, brunch.id).map((e) => [e.user_id, e]));
  assert.deepEqual([byUser[w.ids.ann].slot_key, byUser[w.ids.ann].plan_slot_key], ["brunch", null]);
  assert.deepEqual([byUser[w.ids.ben].slot_key, byUser[w.ids.ben].plan_slot_key], ["breakfast", "brunch"]);
  assert.deepEqual(r.slotFallbacks, [{ userId: w.ids.ben, name: "Ben", from: "brunch", to: "breakfast" }]);

  // A custom slot that sounds like nothing in particular is snacks; ben has none, so the next on the ladder: dinner.
  const odd = syncMeal(chili, [w.ids.ann, w.ids.ben], { slotKey: "second-wind" });
  sync(w, null, odd);
  const odds = Object.fromEntries(mealEntries(w.db, odd.id).map((e) => [e.user_id, e]));
  assert.deepEqual([odds[w.ids.ann].slot_key, odds[w.ids.ann].plan_slot_key], ["snacks", "second-wind"]);
  assert.deepEqual([odds[w.ids.ben].slot_key, odds[w.ids.ben].plan_slot_key], ["dinner", "second-wind"]);

  // The standard slot they switched off counts as lacking it too.
  const snack = syncMeal(chili, [w.ids.ben], { slotKey: "snacks" });
  sync(w, null, snack);
  assert.deepEqual(mealEntries(w.db, snack.id).map((e) => [e.slot_key, e.plan_slot_key]), [["dinner", "snacks"]]);
});

test("an edit that changes nothing a diary cares about leaves every entry (and id) alone", async (t) => {
  const w = await newWorld(t);
  const chili = siteRecipe(w, "Chili", 450);
  const meal = syncMeal(chili, [w.ids.ann, w.ids.ben]);
  sync(w, null, meal);
  const before = mealEntries(w.db, meal.id).map((e) => e.id);
  const r = sync(w, meal, { ...meal });
  assert.deepEqual([r.created.length, r.removed, r.kept], [0, 0, 0]);
  assert.deepEqual(mealEntries(w.db, meal.id).map((e) => e.id), before);
});

test("moving the meal moves only entries still planned; what a person logged stays exactly where it is", async (t) => {
  const w = await newWorld(t);
  const chili = siteRecipe(w, "Chili", 450);
  const meal = syncMeal(chili, [w.ids.ann, w.ids.ben]);
  sync(w, null, meal);
  const annEntry = mealEntries(w.db, meal.id, { userId: w.ids.ann })[0];
  updateEntry(w.db, w.ann, "2026-03-12", annEntry.id, { status: "logged" }); // on the meal's day
  const loggedBefore = get<any>(w.db, "SELECT * FROM nutrition_diary_entries WHERE id = ?", annEntry.id)!;

  const moved = { ...meal, date: "2026-03-14", slotKey: "lunch" };
  const r = sync(w, meal, moved);
  assert.deepEqual(r.alreadyLogged, [{ userId: w.ids.ann, name: "Ann" }]);
  assert.equal(r.removed, 1, "only Ben's planned entry");
  assert.deepEqual(r.created.map((c) => c.userId), [w.ids.ben]);

  const annAfter = get<any>(w.db, "SELECT * FROM nutrition_diary_entries WHERE id = ?", annEntry.id)!;
  assert.deepEqual(annAfter, loggedBefore, "Ann's logged entry is byte-for-byte what it was");
  const live = mealEntries(w.db, meal.id);
  assert.equal(live.length, 2, "Ann's logged one and Ben's new planned one -- nothing new for Ann");
  const ben = live.find((e) => e.user_id === w.ids.ben)!;
  assert.deepEqual([ben.local_date, ben.slot_key, ben.status], ["2026-03-14", "lunch", "planned"]);
  assert.equal(mealEntries(w.db, meal.id, { deleted: true, userId: w.ids.ben }).length, 2, "the old planned entry is soft-deleted, not erased");
});

test("changing the recipe re-syncs the planned entries to the new food", async (t) => {
  const w = await newWorld(t);
  const a = siteRecipe(w, "Chili", 450);
  const b = siteRecipe(w, "Salad", 200);
  const meal = syncMeal(a, [w.ids.ann, w.ids.ben]);
  sync(w, null, meal);
  sync(w, meal, { ...meal, recipeId: b.id });
  const live = mealEntries(w.db, meal.id);
  assert.deepEqual(live.map((e) => [e.food_id, kcalOf(e)]), [[b.foodId, 200], [b.foodId, 200]]);
});

test("denying, un-approving or deleting removes the planned entries and keeps the logged ones", async (t) => {
  const w = await newWorld(t);
  const chili = siteRecipe(w, "Chili", 450);
  const meal = syncMeal(chili, [w.ids.ann, w.ids.ben]);
  sync(w, null, meal);
  updateEntry(w.db, w.ann, "2026-03-12", mealEntries(w.db, meal.id, { userId: w.ids.ann })[0].id, { status: "logged" }); // on the meal's day

  const denied = { ...meal, status: "denied" as const };
  const r = sync(w, meal, denied);
  assert.deepEqual([r.removed, r.alreadyLogged], [1, [{ userId: w.ids.ann, name: "Ann" }]]);
  assert.deepEqual(mealEntries(w.db, meal.id).map((e) => [e.user_id, e.status]), [[w.ids.ann, "logged"]]);

  // Back to proposed, then approved again: Ben (nothing logged) gets a fresh entry, Ann (ate it) does not get a second.
  sync(w, denied, { ...meal, status: "proposed" });
  sync(w, { ...meal, status: "proposed" }, meal);
  assert.deepEqual(mealEntries(w.db, meal.id).map((e) => [e.user_id, e.status]).sort(), [[w.ids.ann, "logged"], [w.ids.ben, "planned"]].sort());

  // Deleted outright: the planned one goes, the logged one stays.
  const r2 = sync(w, meal, null);
  assert.equal(r2.removed, 1);
  assert.deepEqual(mealEntries(w.db, meal.id).map((e) => [e.user_id, e.status]), [[w.ids.ann, "logged"]]);
});

test("changing who a meal is for: someone taken off loses their planned entry, someone who ate keeps theirs, someone added gets one", async (t) => {
  const w = await newWorld(t);
  const cat = addLogin(w, "cat");
  const chili = siteRecipe(w, "Chili", 450);
  const meal = syncMeal(chili, [w.ids.ann, w.ids.ben]);
  sync(w, null, meal);
  updateEntry(w.db, w.ben, "2026-03-12", mealEntries(w.db, meal.id, { userId: w.ids.ben })[0].id, { status: "logged" });

  // Now only for ann and cat: ben ate it (kept, and told), cat is new, ann untouched.
  const next = { ...meal, targetUserIds: [w.ids.ann, cat] };
  const annId = mealEntries(w.db, meal.id, { userId: w.ids.ann })[0].id;
  const r = sync(w, meal, next);
  assert.deepEqual(r.alreadyLogged, [{ userId: w.ids.ben, name: "Ben" }]);
  assert.deepEqual(r.created.map((c) => c.userId), [cat]);
  assert.equal(r.kept, 1);
  assert.equal(mealEntries(w.db, meal.id, { userId: w.ids.ann })[0].id, annId, "ann's entry kept its id");
  assert.equal(mealEntries(w.db, meal.id, { userId: w.ids.ben })[0].status, "logged");

  // Ann is taken off: her planned entry goes.
  sync(w, next, { ...meal, targetUserIds: [cat] });
  assert.equal(mealEntries(w.db, meal.id, { userId: w.ids.ann }).length, 0);
});

test("a person's own deleted planned entry stays deleted through an edit that doesn't concern their meal, and comes back if the meal itself changes", async (t) => {
  const w = await newWorld(t);
  const cat = addLogin(w, "cat");
  const chili = siteRecipe(w, "Chili", 450);
  const meal = syncMeal(chili, [w.ids.ann, w.ids.ben]);
  sync(w, null, meal);
  deleteEntry(w.db, w.ann, mealEntries(w.db, meal.id, { userId: w.ids.ann })[0].id);

  // Cat joins the audience; nothing about the meal moved: Ann's stays deleted.
  const withCat = { ...meal, targetUserIds: [w.ids.ann, w.ids.ben, cat] };
  const r = sync(w, meal, withCat);
  assert.deepEqual(r.created.map((c) => c.userId), [cat]);
  assert.equal(mealEntries(w.db, meal.id, { userId: w.ids.ann }).length, 0);
  assert.match(r.skipped.find((s) => s.userId === w.ids.ann)!.reason, /deleted/);

  // Move it: it is a new meal for everyone, so Ann gets a fresh one (decision: kept from the Phase 3b review).
  sync(w, withCat, { ...withCat, date: "2026-03-13" });
  assert.equal(mealEntries(w.db, meal.id, { userId: w.ids.ann }).length, 1);
});

test("all or nothing: a meal that can't be put in a diary changes no one's entries", async (t) => {
  const w = await newWorld(t);
  const chili = siteRecipe(w, "Chili", 450);
  const meal = syncMeal(chili, [w.ids.ann, w.ids.ben]);
  sync(w, null, meal);
  const before = mealEntries(w.db, meal.id, { deleted: true }).map((e) => [e.id, e.deleted_at]);

  // A personal recipe on the shared plan would leak its name: refused, before anything is written.
  const secret = siteRecipe(w, "Secret stew", 300, { scope: "personal" });
  assert.throws(() => sync(w, meal, { ...meal, recipeId: secret.id, date: "2026-03-15" }), (e: unknown) => e instanceof NutritionError && e.status === 400 && /personal recipe/.test(e.message));
  // A recipe that doesn't exist, or none at all.
  assert.throws(() => sync(w, meal, { ...meal, recipeId: "recipe-nope", date: "2026-03-15" }), (e: unknown) => e instanceof NutritionError && e.status === 400);
  assert.throws(() => sync(w, meal, { ...meal, recipeId: null, date: "2026-03-15" }), (e: unknown) => e instanceof NutritionError && /needs a recipe/.test(e.message));
  assert.deepEqual(mealEntries(w.db, meal.id, { deleted: true }).map((e) => [e.id, e.deleted_at]), before, "no one's entries moved");
  // Not approved, so nothing is checked and nothing is wanted.
  assert.doesNotThrow(() => sync(w, meal, { ...meal, status: "proposed", recipeId: null }));
});

test("a recipe with no calories yet can be approved, but puts nothing in any diary, and says so", async (t) => {
  const w = await newWorld(t);
  const legacy = saveRecipe(w.db, w.ids.ann, {
    id: "recipe-legacy", name: "Old stew", ingredients: ["beef"], scope: "joint", createdBy: w.ids.ann, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  });
  const meal = syncMeal(legacy, [w.ids.ann, w.ids.ben]);
  const r = sync(w, null, meal);
  assert.equal(r.created.length, 0);
  assert.match(r.note ?? "", /no calories yet/);
  assert.equal(mealEntries(w.db, meal.id).length, 0);
});

test("dropMealsEntries removes what is still planned for several meals and leaves what was logged", async (t) => {
  const w = await newWorld(t);
  const chili = siteRecipe(w, "Chili", 450);
  const m1 = syncMeal(chili, [w.ids.ann]);
  const m2 = syncMeal(chili, [w.ids.ann], { date: "2026-03-13" });
  sync(w, null, m1);
  sync(w, null, m2);
  updateEntry(w.db, w.ann, "2026-03-12", mealEntries(w.db, m1.id)[0].id, { status: "logged" }); // on the meal's day
  const r = dropMealsEntries(w.db, [m1.id, m2.id], NOW);
  assert.equal(r.removed, 1);
  assert.deepEqual(mealEntries(w.db, m1.id).map((e) => e.status), ["logged"]);
  assert.equal(mealEntries(w.db, m2.id).length, 0);
});

test("log all: a person's planned entries in one meal of one day become logged together, and only theirs", async (t) => {
  const w = await newWorld(t);
  const chili = siteRecipe(w, "Chili", 450);
  const salad = siteRecipe(w, "Salad", 200);
  const m1 = syncMeal(chili, [w.ids.ann, w.ids.ben], { date: TODAY, slotKey: "dinner" });
  const m2 = syncMeal(salad, [w.ids.ann, w.ids.ben], { date: TODAY, slotKey: "dinner" });
  const m3 = syncMeal(salad, [w.ids.ann], { date: TODAY, slotKey: "lunch" });
  for (const m of [m1, m2, m3]) sync(w, null, m);

  const out = logPlannedSlot(w.db, w.ann, TODAY, TODAY, "dinner");
  assert.equal(out.logged.length, 2);
  assert.deepEqual(mealEntries(w.db, m1.id).map((e) => [e.user_id === w.ids.ann, e.status]).sort(), [[false, "planned"], [true, "logged"]]);
  assert.equal(mealEntries(w.db, m3.id)[0].status, "planned", "another meal of the day is untouched");
  assert.deepEqual(logPlannedSlot(w.db, w.ann, TODAY, TODAY, "dinner").logged, [], "nothing planned left there: fine, idempotent");
  // Not ahead of the day.
  assert.throws(() => logPlannedSlot(w.db, w.ann, "2026-03-12", TODAY, "dinner"), (e: unknown) => e instanceof NutritionError && e.status === 400);
  // Not for the kiosk.
  assert.throws(() => logPlannedSlot(w.db, { id: w.ids.kiosk, displayName: "K", role: "kiosk" as any, profile: null }, TODAY, TODAY, "dinner"), (e: unknown) => e instanceof NutritionError && e.status === 403);
});

test("the day's frozen calorie budget follows the plan's writes (a day with a weight gets one)", async (t) => {
  const w = await newWorld(t);
  run(w.db, "INSERT INTO nutrition_weights (id, user_id, measured_on, weight_kg) VALUES ('w1', ?, '2026-03-01', 70)", w.ids.ann);
  const chili = siteRecipe(w, "Chili", 450);
  const meal = syncMeal(chili, [w.ids.ann], { date: "2026-03-12" });
  sync(w, null, meal);
  const log = get<any>(w.db, "SELECT * FROM nutrition_day_logs WHERE user_id = ? AND local_date = '2026-03-12'", w.ids.ann);
  assert.ok(log?.calorie_budget_kcal_snapshot > 0);
});

test("all or nothing, even when a write fails half-way: the first person's entry is rolled back with the second's", async (t) => {
  const w = await newWorld(t);
  const chili = siteRecipe(w, "Chili", 450);
  const meal = syncMeal(chili, [w.ids.ann, w.ids.ben]);
  // Ben's insert blows up (a stand-in for a disk or constraint failure after Ann's row already went in).
  w.db.exec(`CREATE TRIGGER fail_ben BEFORE INSERT ON nutrition_diary_entries
             WHEN NEW.user_id = '${w.ids.ben}' AND NEW.meal_plan_id = '${meal.id}'
             BEGIN SELECT RAISE(ABORT, 'disk on fire'); END`);
  assert.throws(() => sync(w, null, meal), /disk on fire/);
  assert.equal(mealEntries(w.db, meal.id, { deleted: true }).length, 0, "Ann's entry is not left behind");
  assert.equal(w.db.isTransaction, false, "and no transaction is left open");
});
