// The household meal plan wired to the food diaries (merge plan phase 4), through the real routes and tools against
// the real (throwaway) household database: recipe links and joint-only, roster <-> login links, approved meals ->
// planned entries, re-sync that never touches what was logged, household slots, leftovers, and the assistant.
//
//   dad  admin    bea  parent    fridge  kiosk
// The week is 2026-09-07 (a Monday), so "Wednesday" is 2026-09-09.

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { loadDb, cleanupDb } from "./helpers/testdb.ts";
import { callRoute } from "./helpers/router.ts";
import { kcalOf, mealEntries, siteRecipeFor } from "./helpers/planWorld.ts";
import { setRecipeModel, type RecipeModel } from "../nutrition/recipeAi.ts";

const loaded = await loadDb();
const { createUser, putScopedItem, getScopedItems, deleteScopedItem, newId } = loaded;
const db = loaded.db as any;
const { mealPlanRoutes, buildMealPlan, currentPlan } = await import("../routes/mealplan.ts");
const { memberRoutes } = await import("../routes/members.ts");
const { buildTools } = await import("../assistant/registry.ts");
const { getTracker } = await import("../nutrition/data/tracker.ts");
const { createSlot, updateSlot } = await import("../nutrition/data/slots.ts");
const { updateEntry } = await import("../nutrition/data/diary.ts");
const { computeMissing } = await import("../ingredients.ts");

let dad: string, bea: string, kiosk: string;
const as = (id: string) => ({ session: { userId: id } });
const call = (who: string, method: string, url: string, body?: unknown) => callRoute(mealPlanRoutes, method, url, { ...as(who), body });
const members = (who: string, method: string, url: string, body?: unknown) => callRoute(memberRoutes, method, url, { ...as(who), body });
const tool = (who: string, name: string, args: Record<string, any> = {}): Promise<any> => buildTools(who).find((t) => t.name === name)!.run(args);

const WEEK = "2026-09-07";
const meal = (o: Record<string, any> = {}) => ({
  id: newId("meal"), day: "Monday", slot: "dinner", name: "Chili", ingredients: ["beans", "beef"], status: "proposed", audience: "family", ...o,
});
function seedPlan(meals: any[]) {
  for (const old of getScopedItems("meal_plans", dad) as any[]) deleteScopedItem("meal_plans", dad, old.id);
  const plan = buildMealPlan(dad, WEEK, meals as any);
  putScopedItem("meal_plans", dad, plan);
  return plan;
}
const clearMembers = () => { for (const m of getScopedItems("household_members", dad) as any[]) deleteScopedItem("household_members", dad, m.id); };
const addMember = (name: string, extra: Record<string, any> = {}) => {
  const m = { id: newId("member"), name, likes: [], dislikes: [], scope: "joint", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...extra };
  putScopedItem("household_members", dad, m);
  return m;
};
const recipe = (name: string, kcal = 450, over: Record<string, any> = {}) => siteRecipeFor(db, dad, name, kcal, over);
const entriesOf = (mealId: string, opts: any = {}) => mealEntries(db, mealId, opts);

before(() => {
  dad = createUser("dad-md", "x", "Dad", "admin");
  bea = createUser("bea-md", "x", "Bea", "parent");
  kiosk = createUser("fridge-md", "x", "Fridge", "kiosk");
});
after(() => {
  setRecipeModel(undefined);
  cleanupDb();
});
beforeEach(() => {
  setRecipeModel(undefined);
  clearMembers();
});

describe("approving a meal", () => {
  test("a family meal puts one planned entry at one serving in both diaries, and never in the kiosk's", async () => {
    const chili = recipe("Chili A");
    const plan = seedPlan([meal({ id: "m-fam", day: "Wednesday", recipeId: chili.id })]);
    const r = await call(bea, "PUT", "/meals/m-fam", { status: "approved" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.sync.created.map((c: any) => c.name).sort(), ["Bea", "Dad"]);
    const rows = entriesOf("m-fam");
    assert.deepEqual(rows.map((e) => e.user_id).sort(), [dad, bea].sort());
    for (const e of rows) assert.deepEqual([e.status, e.source, e.local_date, e.slot_key, e.quantity, kcalOf(e), e.food_id], ["planned", "plan", "2026-09-09", "dinner", 1, 450, chili.foodId]);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM nutrition_diary_entries WHERE user_id = ?").get(kiosk).n, 0);
    assert.equal(plan.weekStart, WEEK);

    // The kiosk may approve a meal (the plan is open to it) and still has no diary entry of its own.
    seedPlan([meal({ id: "m-kiosk", recipeId: chili.id })]);
    const k = await call(kiosk, "PUT", "/meals/m-kiosk", { status: "approved" });
    assert.equal(k.status, 200);
    assert.deepEqual(entriesOf("m-kiosk").map((e) => e.user_id).sort(), [dad, bea].sort());
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM nutrition_diary_entries WHERE user_id = ?").get(kiosk).n, 0);
  });

  test("approving twice, or editing only the name's neighbours, doesn't duplicate anything", async () => {
    const chili = recipe("Chili B");
    seedPlan([meal({ id: "m-twice", recipeId: chili.id })]);
    await call(dad, "PUT", "/meals/m-twice", { status: "approved" });
    const before = entriesOf("m-twice").map((e) => e.id);
    await call(dad, "PUT", "/meals/m-twice", { status: "approved" });
    assert.deepEqual(entriesOf("m-twice").map((e) => e.id), before);
  });

  test("a meal with no recipe (one saved before recipes were linked) loads and can be denied, but can't be approved until it has one", async () => {
    seedPlan([meal({ id: "m-old" })]);
    const view = await call(dad, "GET", "/");
    assert.equal(view.body.plan.meals[0].recipeId, undefined, "loads as it was stored");
    assert.deepEqual(view.body.missing, ["beans", "beef"], "and still drives the shopping list");

    const refused = await call(dad, "PUT", "/meals/m-old", { status: "approved" });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /no recipe yet/);
    assert.equal(currentPlan(dad)!.meals[0].status, "proposed");
    assert.equal((await call(dad, "PUT", "/meals/m-old", { status: "denied" })).status, 200);
    await call(dad, "PUT", "/meals/m-old", { status: "proposed" });

    // Creating one from the name (and ingredient names) in the same request approves it.
    const ok = await call(dad, "PUT", "/meals/m-old", { createRecipe: true, status: "approved" });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const m = ok.body.plan.meals[0];
    assert.ok(m.recipeId);
    const made = (getScopedItems("recipes", dad) as any[]).find((r) => r.id === m.recipeId);
    assert.deepEqual([made.name, made.scope, made.ingredients], ["Chili", "joint", ["beans", "beef"]]);
    assert.equal(m.status, "approved");
  });

  test("a proposed meal changes no diary; neither does one whose recipe has no calories yet (and the answer says so)", async () => {
    const legacy = getScopedItems("recipes", dad).find((r: any) => r.name === "Old stew") ?? null;
    const { upsertRecipeByName } = await import("../nutrition/data/recipes.ts");
    const noCal = legacy ?? upsertRecipeByName(db, dad, { name: "Old stew", ingredients: ["beef"], jointOnly: true });
    seedPlan([meal({ id: "m-nocal", recipeId: noCal.id })]);
    const r = await call(dad, "PUT", "/meals/m-nocal", { status: "approved" });
    assert.equal(r.status, 200);
    assert.equal(r.body.sync.created.length, 0);
    assert.match(r.body.sync.note, /no calories yet/);
    assert.equal(entriesOf("m-nocal").length, 0);
  });
});

describe("recipes on the plan", () => {
  test("only a joint recipe can be named: a personal one is refused on create and on edit, and nothing leaks", async () => {
    const mine = siteRecipeFor(db, dad, "Dad's secret stew", 300, { scope: "personal" });
    seedPlan([meal({ id: "m-priv" })]);
    const post = await call(dad, "POST", "/meals", { day: "Tuesday", slot: "dinner", recipeId: mine.id });
    assert.equal(post.status, 400);
    assert.match(post.body.error, /personal recipe/);
    const put = await call(dad, "PUT", "/meals/m-priv", { recipeId: mine.id });
    assert.equal(put.status, 400);
    assert.equal(currentPlan(dad)!.meals.length, 1);
    assert.equal(currentPlan(dad)!.meals[0].recipeId, undefined);
    // Bea can't even see Dad's personal recipe: 404, not a hint that it exists.
    assert.equal((await call(bea, "POST", "/meals", { day: "Tuesday", slot: "dinner", recipeId: mine.id })).status, 404);
    assert.equal((await call(dad, "POST", "/meals", { day: "Tuesday", slot: "dinner", recipeId: "recipe-nope" })).status, 404);
  });

  test("creating a meal by name makes a joint recipe through the recipe flow: lines, auto-link, a flagged estimate", async () => {
    const { createFood } = await import("../nutrition/data/foods.ts");
    createFood(db, { id: dad, displayName: "Dad", role: "admin", profile: null }, { name: "Chicken breast", basis: "per100g", nutrients: { kcal: 165 }, scope: "joint" });
    const asked: string[][] = [];
    const model: RecipeModel = {
      async parseLines(texts) { return texts.map(() => null); },
      async estimateKcal(input) { asked.push(input.ingredients.map((i) => i.text)); return Object.fromEntries(input.ingredients.map((i) => [i.index, 100])); },
    };
    setRecipeModel(model);
    seedPlan([meal({ id: "m-base" })]);
    const r = await call(dad, "POST", "/meals", { day: "Tuesday", slot: "lunch", name: "Chicken bowl", ingredients: ["200 g chicken breast", "mystery sauce"] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const added = r.body.plan.meals.find((m: any) => m.name === "Chicken bowl");
    assert.deepEqual([added.status, added.audience, !!added.recipeId], ["proposed", "family", true]);
    const rec = (getScopedItems("recipes", dad) as any[]).find((x) => x.id === added.recipeId);
    assert.equal(rec.scope, "joint");
    assert.deepEqual(rec.lines.map((l: any) => [!!l.foodId, l.estimated ?? false]), [[true, false], [false, true]]);
    assert.equal(rec.nutrition.complete, false, "partly estimated, and it says so");
    assert.ok(rec.foodId, "so the meal has calories");
    assert.deepEqual(added.ingredients, ["chicken breast", "mystery sauce"], "the shopping list reads names, not amounts");
    assert.deepEqual(asked, [["mystery sauce"]]);

    // The same name again uses the recipe that is there, as it is (no second recipe, nothing rewritten).
    const again = await call(dad, "POST", "/meals", { day: "Thursday", slot: "lunch", name: "chicken BOWL", ingredients: ["different", "stuff"] });
    const second = again.body.plan.meals.find((m: any) => m.day === "Thursday");
    assert.equal(second.recipeId, added.recipeId);
    assert.deepEqual(second.ingredients, ["chicken breast", "mystery sauce"]);
    assert.equal((getScopedItems("recipes", dad) as any[]).filter((x) => x.name === "Chicken bowl").length, 1);
  });

  test("a name-only meal gets a recipe without ingredients or calories; it still counts as having a recipe", async () => {
    seedPlan([meal({ id: "m-base2" })]);
    const r = await call(dad, "POST", "/meals", { day: "Friday", slot: "snacks", name: "Pizza night" });
    const added = r.body.plan.meals.find((m: any) => m.name === "Pizza night");
    assert.ok(added.recipeId);
    assert.deepEqual(added.ingredients, []);
    const rec = (getScopedItems("recipes", dad) as any[]).find((x) => x.id === added.recipeId);
    assert.equal(rec.nutrition, undefined);
  });

  test("picking another recipe renames the meal and refreshes its ingredients; its diary entries follow", async () => {
    const a = recipe("Dish A", 300, { ingredients: ["a"], lines: [{ text: "a", pantryName: "a" }] });
    const b = recipe("Dish B", 600, { ingredients: ["b1", "b2"], lines: [{ text: "b1", pantryName: "b1" }, { text: "b2", pantryName: "b2" }] });
    seedPlan([meal({ id: "m-swap", recipeId: a.id, name: "Dish A", ingredients: ["a"] })]);
    await call(dad, "PUT", "/meals/m-swap", { status: "approved" });
    const r = await call(dad, "PUT", "/meals/m-swap", { recipeId: b.id });
    assert.equal(r.status, 200);
    const m = r.body.plan.meals[0];
    assert.deepEqual([m.name, m.ingredients, m.recipeId], ["Dish B", ["b1", "b2"], b.id]);
    assert.deepEqual(entriesOf("m-swap").map((e) => [e.food_id, kcalOf(e)]), [[b.foodId, 600], [b.foodId, 600]]);
  });
});

describe("who a meal is for: roster members linked to logins", () => {
  test("an individual meal reaches only the linked login; an unlinked member's meal reaches nobody, and the answer says so", async () => {
    const chili = recipe("Chili C");
    const sam = addMember("Sam", { userId: bea });
    const kid = addMember("Kid");
    seedPlan([
      meal({ id: "m-sam", recipeId: chili.id, audience: "individual", memberId: sam.id }),
      meal({ id: "m-kid", recipeId: chili.id, slot: "lunch", audience: "individual", memberId: kid.id }),
    ]);
    const a = await call(dad, "PUT", "/meals/m-sam", { status: "approved" });
    assert.deepEqual(entriesOf("m-sam").map((e) => e.user_id), [bea]);
    assert.deepEqual(a.body.sync.created.map((c: any) => c.name), ["Bea"]);

    const b = await call(dad, "PUT", "/meals/m-kid", { status: "approved" });
    assert.equal(b.status, 200, "approving still works");
    assert.equal(entriesOf("m-kid").length, 0);
    assert.match(b.body.sync.skipped[0].reason, /Kid isn't linked to a login/);
    assert.equal(b.body.sync.skipped[0].userId, null);
  });

  test("a linked login that no longer exists is skipped, not a crash; a member that no longer exists is too", async () => {
    const chili = recipe("Chili D");
    const ghost = addMember("Ghost", { userId: "user-who-left" });
    seedPlan([
      meal({ id: "m-ghost", recipeId: chili.id, audience: "individual", memberId: ghost.id }),
      meal({ id: "m-gone", recipeId: chili.id, slot: "lunch", audience: "individual", memberId: "member-deleted" }),
    ]);
    const r = await call(dad, "PUT", "/meals/m-ghost", { status: "approved" });
    assert.equal(r.status, 200);
    assert.match(r.body.sync.skipped[0].reason, /no longer exists/);
    const g = await call(dad, "PUT", "/meals/m-gone", { status: "approved" });
    assert.equal(g.status, 200);
    assert.match(g.body.sync.skipped[0].reason, /isn't on the Family list/);
    assert.equal(entriesOf("m-ghost").length + entriesOf("m-gone").length, 0);
  });

  test("linking and unlinking an approved individual meal's member moves it into and out of that diary", async () => {
    const chili = recipe("Chili E");
    const sam = addMember("Sam");
    seedPlan([meal({ id: "m-link", recipeId: chili.id, audience: "individual", memberId: sam.id, status: "proposed" })]);
    await call(dad, "PUT", "/meals/m-link", { status: "approved" });
    assert.equal(entriesOf("m-link").length, 0, "not linked yet");

    const link = await members(dad, "PUT", `/${sam.id}`, { userId: bea });
    assert.equal(link.status, 200, JSON.stringify(link.body));
    assert.deepEqual(entriesOf("m-link").map((e) => e.user_id), [bea], "linking brings the approved meal into Bea's diary");

    updateEntry(db, getTracker(db, bea), "2026-09-07", entriesOf("m-link")[0].id, { status: "logged" });
    await members(dad, "PUT", `/${sam.id}`, { userId: null });
    assert.deepEqual(entriesOf("m-link").map((e) => [e.user_id, e.status]), [[bea, "logged"]], "unlinking never removes what she logged");

    // Link again and move to a person who hasn't: removing the member drops only what is still planned.
    seedPlan([meal({ id: "m-link2", recipeId: chili.id, audience: "individual", memberId: sam.id })]);
    await members(dad, "PUT", `/${sam.id}`, { userId: dad });
    await call(dad, "PUT", "/meals/m-link2", { status: "approved" });
    assert.deepEqual(entriesOf("m-link2").map((e) => e.user_id), [dad]);
    assert.equal((await members(dad, "DELETE", `/${sam.id}`)).status, 200);
    assert.equal(entriesOf("m-link2").length, 0);
  });
});

describe("the login link on a family member", () => {
  test("only an admin can set, change or clear it; the login must be an admin or parent, and used once", async () => {
    const add = await members(dad, "POST", "/", { name: "Sam" });
    const sam = add.body.member;
    assert.equal(sam.userId, undefined);
    const other = addMember("Alex");

    assert.equal((await members(bea, "PUT", `/${sam.id}`, { userId: bea })).status, 403, "a parent may not link anyone, even themselves");
    assert.equal((await members(kiosk, "PUT", `/${sam.id}`, { userId: bea })).status, 403);
    assert.equal((await members(dad, "PUT", `/${sam.id}`, { userId: kiosk })).status, 400, "the kiosk never keeps a diary");
    assert.equal((await members(dad, "PUT", `/${sam.id}`, { userId: "user-nope" })).status, 400);
    assert.equal((await members(dad, "PUT", `/${sam.id}`, { userId: 7 })).status, 400);

    const ok = await members(dad, "PUT", `/${sam.id}`, { userId: bea });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.member.userId, bea);
    const dupe = await members(dad, "PUT", `/${other.id}`, { userId: bea });
    assert.equal(dupe.status, 409, "one member per login");
    assert.match(dupe.body.error, /already linked to Sam/);
    assert.equal(getScopedItems("household_members", dad).find((m: any) => m.id === other.id).userId, undefined);

    // A parent may rename the member (and even resend the same link: not a change), but not move it.
    assert.equal((await members(bea, "PUT", `/${sam.id}`, { name: "Samuel", userId: bea })).status, 200);
    assert.equal((await members(bea, "PUT", `/${sam.id}`, { userId: dad })).status, 403);
    assert.equal((await members(bea, "PUT", `/${sam.id}`, { userId: null })).status, 403);
    assert.equal(getScopedItems("household_members", dad).find((m: any) => m.id === sam.id).userId, bea);

    // Other edits leave the link alone; an admin can clear it, and move it to someone else.
    assert.equal((await members(dad, "PUT", `/${sam.id}`, { color: "rose" })).body.member.userId, bea);
    assert.equal((await members(dad, "PUT", `/${sam.id}`, { userId: null })).body.member.userId, undefined);
    assert.equal((await members(dad, "PUT", `/${sam.id}`, { userId: "" })).status, 200);
    assert.equal((await members(dad, "PUT", `/${other.id}`, { userId: bea })).status, 200, "free again once cleared");
  });

  test("an admin can link when adding; a non-admin can't; GET lists the logins that can be linked (never the kiosk)", async () => {
    assert.equal((await members(bea, "POST", "/", { name: "Nope", userId: bea })).status, 403);
    assert.equal(getScopedItems("household_members", dad).length, 0, "and nothing was added");
    const ok = await members(dad, "POST", "/", { name: "Dana", userId: dad });
    assert.equal(ok.body.member.userId, dad);
    const list = await members(bea, "GET", "/");
    assert.deepEqual(list.body.logins.map((l: any) => l.name).sort(), ["Bea", "Dad"]);
    assert.ok(list.body.logins.every((l: any) => !("password_hash" in l) && l.id !== kiosk));
  });
});

describe("re-sync: only what is still planned changes; what was logged never does", () => {
  async function approvedWithLoggedDad(id: string, over: Record<string, any> = {}) {
    const chili = recipe(`Chili ${id}`);
    seedPlan([meal({ id, recipeId: chili.id, ...over })]);
    await call(dad, "PUT", `/meals/${id}`, { status: "approved" });
    const dadEntry = entriesOf(id, { userId: dad })[0];
    updateEntry(db, getTracker(db, dad), "2026-09-07", dadEntry.id, { status: "logged" });
    return { chili, dadEntry: db.prepare("SELECT * FROM nutrition_diary_entries WHERE id = ?").get(dadEntry.id) };
  }

  test("moving the meal to another day and slot moves Bea's planned entry and leaves Dad's logged one where it is", async () => {
    const { dadEntry } = await approvedWithLoggedDad("m-move");
    const r = await call(bea, "PUT", "/meals/m-move", { day: "Thursday", slot: "lunch" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.sync.alreadyLogged, [{ userId: dad, name: "Dad" }]);
    assert.deepEqual(db.prepare("SELECT * FROM nutrition_diary_entries WHERE id = ?").get(dadEntry.id), dadEntry, "Dad's logged entry is untouched");
    const live = entriesOf("m-move");
    assert.equal(live.length, 2);
    const breNow = live.find((e) => e.user_id === bea)!;
    assert.deepEqual([breNow.local_date, breNow.slot_key, breNow.status], ["2026-09-10", "lunch", "planned"]);
    assert.ok(entriesOf("m-move", { userId: bea }).every((e) => e.local_date === "2026-09-10"), "nothing of this meal is left on the old day for Bea");
  });

  test("changing the recipe, the audience, denying and deleting each re-sync the planned entries only", async () => {
    const { chili, dadEntry } = await approvedWithLoggedDad("m-edit");
    const other = recipe("Other dish", 200);
    const sam = addMember("Sam", { userId: bea });

    await call(dad, "PUT", "/meals/m-edit", { recipeId: other.id });
    assert.deepEqual(entriesOf("m-edit").map((e) => [e.user_id === dad, e.food_id === chili.foodId]).sort(), [[false, false], [true, true]], "Bea's planned entry follows the new recipe; Dad's logged one keeps the old");

    await call(dad, "PUT", "/meals/m-edit", { audience: "individual", memberId: sam.id });
    assert.deepEqual(entriesOf("m-edit").map((e) => [e.user_id, e.status]).sort(), [[bea, "planned"], [dad, "logged"]].sort(), "now for Sam (Bea) only; Dad ate it, so his stays");

    await call(dad, "PUT", "/meals/m-edit", { status: "denied" });
    assert.deepEqual(entriesOf("m-edit").map((e) => [e.user_id, e.status]), [[dad, "logged"]]);

    await call(dad, "PUT", "/meals/m-edit", { status: "proposed" });
    await call(dad, "PUT", "/meals/m-edit", { status: "approved" });
    assert.equal(entriesOf("m-edit", { userId: bea }).length, 1, "approved again: a fresh entry for Bea");

    const del = await call(dad, "DELETE", "/meals/m-edit");
    assert.equal(del.status, 200);
    assert.deepEqual(entriesOf("m-edit").map((e) => [e.user_id, e.status]), [[dad, "logged"]]);
    assert.equal(db.prepare("SELECT status FROM nutrition_diary_entries WHERE id = ?").get(dadEntry.id).status, "logged");
  });

  test("deleting the whole plan removes the planned entries and keeps the logged ones", async () => {
    const chili = recipe("Chili Z");
    const plan = seedPlan([meal({ id: "m-plan-a", recipeId: chili.id }), meal({ id: "m-plan-b", day: "Friday", recipeId: chili.id })]);
    await call(dad, "PUT", "/meals/m-plan-a", { status: "approved" });
    await call(dad, "PUT", "/meals/m-plan-b", { status: "approved" });
    updateEntry(db, getTracker(db, bea), "2026-09-07", entriesOf("m-plan-a", { userId: bea })[0].id, { status: "logged" });
    const r = await call(dad, "DELETE", `/${plan.id}`);
    assert.equal(r.status, 200);
    assert.deepEqual(entriesOf("m-plan-a").map((e) => [e.user_id, e.status]), [[bea, "logged"]]);
    assert.equal(entriesOf("m-plan-b").length, 0);
    assert.equal((await call(dad, "DELETE", `/${plan.id}`)).status, 404);
  });

  test("a plan change that can't reach the diaries is refused whole: the plan is not saved either", async () => {
    const chili = recipe("Chili Y");
    seedPlan([meal({ id: "m-atomic", recipeId: chili.id })]);
    await call(dad, "PUT", "/meals/m-atomic", { status: "approved" });
    // The recipe is deleted out from under an approved meal; moving the meal can no longer be mirrored.
    const { deleteRecipeDoc } = await import("../nutrition/data/recipes.ts");
    deleteRecipeDoc(db, dad, chili.id);
    const before = entriesOf("m-atomic").map((e) => e.id);
    const r = await call(dad, "PUT", "/meals/m-atomic", { day: "Friday" });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /recipe/i);
    assert.equal(currentPlan(dad)!.meals[0].day, "Monday", "the day did not change in the plan either");
    assert.deepEqual(entriesOf("m-atomic").map((e) => e.id), before);
    assert.equal(db.isTransaction, false);
  });
});

describe("household slots: snacks and custom meals", () => {
  test("a slot a diary login has is valid on the plan, an unknown one is refused, and a login without it gets the nearest standard slot", async () => {
    const chili = recipe("Chili S");
    createSlot(db, getTracker(db, dad), { label: "Second breakfast" }); // only Dad has it
    seedPlan([meal({ id: "m-base3" })]);

    const unknown = await call(dad, "POST", "/meals", { day: "Tuesday", slot: "elevenses", recipeId: chili.id });
    assert.equal(unknown.status, 400);
    const slots = (await call(dad, "GET", "/slots")).body.slots;
    assert.deepEqual(slots.slice(0, 4).map((s: any) => s.key), ["breakfast", "lunch", "dinner", "snacks"]);
    assert.deepEqual(slots.find((s: any) => s.key === "second-breakfast"), { key: "second-breakfast", label: "Second breakfast", standard: false });
    assert.ok((await call(bea, "GET", "/")).body.slots.some((s: any) => s.key === "second-breakfast"));

    const ok = await call(dad, "POST", "/meals", { day: "Tuesday", slot: "Second-Breakfast", recipeId: chili.id });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const added = ok.body.plan.meals.find((m: any) => m.day === "Tuesday");
    assert.equal(added.slot, "second-breakfast");
    const snack = await call(dad, "POST", "/meals", { day: "Tuesday", slot: "snacks", recipeId: chili.id });
    assert.equal(snack.status, 200, "snacks is a standard slot");

    const approved = await call(dad, "PUT", `/meals/${added.id}`, { status: "approved" });
    assert.deepEqual(approved.body.sync.slotFallbacks, [{ userId: bea, name: "Bea", from: "second-breakfast", to: "breakfast" }]);
    const rows = entriesOf(added.id);
    const byUser = Object.fromEntries(rows.map((e) => [e.user_id, e]));
    assert.deepEqual([byUser[dad].slot_key, byUser[dad].plan_slot_key], ["second-breakfast", null]);
    assert.deepEqual([byUser[bea].slot_key, byUser[bea].plan_slot_key], ["breakfast", "second-breakfast"]);

    // Moving a meal into a slot is validated like creating one.
    assert.equal((await call(dad, "PUT", `/meals/${added.id}`, { slot: "nonsense" })).status, 400);
    assert.equal((await call(dad, "PUT", `/meals/${added.id}`, { slot: "snacks" })).status, 409, "Tuesday snacks already has the snack meal added above (phase 5c: a cell holds one meal per audience)");
    assert.equal((await call(dad, "PUT", `/meals/${added.id}`, { slot: "lunch" })).status, 200);
    updateSlot(db, getTracker(db, dad), "second-breakfast", { enabled: false });
    assert.equal((await call(dad, "POST", "/meals", { day: "Tuesday", slot: "second-breakfast", recipeId: chili.id })).status, 400, "a switched-off meal is no longer offered");
  });
});

describe("leftovers", () => {
  async function dinnerFor(servings: number, over: Record<string, any> = {}) {
    addMember("Sam");
    addMember("Kid");
    const r = recipe(`Big pot ${servings}-${Math.random().toString(36).slice(2, 6)}`, 400, { yieldServings: servings, ingredients: ["beans"], lines: [{ text: "beans", pantryName: "beans" }] });
    const plan = seedPlan([meal({ id: "m-pot", name: r.name, recipeId: r.id, ingredients: ["beans"], ...over })]);
    return { r, plan };
  }

  test("a recipe that makes more than the household eats offers a later lunch or dinner with the servings left", async () => {
    const { r } = await dinnerFor(6);
    const offer = (await call(dad, "GET", "/meals/m-pot/leftover-offer")).body.offer;
    assert.deepEqual([offer.yieldServings, offer.yieldAssumed, offer.headcount, offer.servingsLeft], [6, false, 2, 4]);
    assert.deepEqual(offer.suggestion, { day: "Tuesday", slot: "lunch" });
    assert.deepEqual(offer.alternatives.slice(0, 2), [{ day: "Tuesday", slot: "dinner" }, { day: "Wednesday", slot: "lunch" }]);
    assert.equal(offer.recipeId, r.id);

    // An offer writes nothing.
    assert.equal(currentPlan(dad)!.meals.length, 1);
  });

  test("a recipe that makes exactly what is eaten, or less, offers nothing; an assumed yield is flagged", async () => {
    await dinnerFor(2);
    const none = (await call(dad, "GET", "/meals/m-pot/leftover-offer")).body.offer;
    assert.deepEqual([none.servingsLeft, none.suggestion], [0, null]);
    assert.match(none.reason, /already eating it|makes 2/);
    assert.equal((await call(dad, "POST", "/meals/m-pot/leftovers")).status, 409);

    const noYield = recipe("No yield stated", 300);
    const { upsertRecipeByName } = await import("../nutrition/data/recipes.ts");
    const legacy = upsertRecipeByName(db, dad, { name: "Assumed", ingredients: ["x"], jointOnly: true });
    seedPlan([meal({ id: "m-pot", recipeId: legacy.id })]);
    const assumed = (await call(dad, "GET", "/meals/m-pot/leftover-offer")).body.offer;
    assert.deepEqual([assumed.yieldServings, assumed.yieldAssumed, assumed.servingsLeft], [4, true, 2]);
    assert.ok(noYield);
  });

  test("an individual meal is eaten by one; with no roster, the diary logins are the headcount", async () => {
    const { r } = await dinnerFor(3, { audience: "individual", memberId: "member-x" });
    assert.equal((await call(dad, "GET", "/meals/m-pot/leftover-offer")).body.offer.headcount, 1);
    clearMembers();
    seedPlan([meal({ id: "m-pot", recipeId: r.id })]);
    assert.equal((await call(dad, "GET", "/meals/m-pot/leftover-offer")).body.offer.headcount, 2, "dad and bea");
  });

  test("creating the leftover meal adds no shopping ingredients, shares the recipe, and uses the same rules as any meal", async () => {
    const { r } = await dinnerFor(6);
    const before = (await call(dad, "GET", "/")).body.missing;
    const made = await call(dad, "POST", "/meals/m-pot/leftovers");
    assert.equal(made.status, 200, JSON.stringify(made.body));
    const left = made.body.meal;
    assert.deepEqual([left.name, left.day, left.slot, left.ingredients, left.recipeId, left.leftoverOf, left.status, left.audience],
      [`Leftover ${r.name}`, "Tuesday", "lunch", [], r.id, "m-pot", "proposed", "family"]);
    assert.deepEqual(made.body.missing, before, "no new ingredients to buy");
    assert.deepEqual(computeMissing(made.body.plan.meals, []), ["beans"], "the leftover adds nothing of its own");

    // Approving it puts a planned entry pointing at the SAME recipe food in each diary, on its own day.
    await call(dad, "PUT", `/meals/${left.id}`, { status: "approved" });
    assert.deepEqual(entriesOf(left.id).map((e) => [e.local_date, e.slot_key, e.food_id]), [["2026-09-08", "lunch", r.foodId], ["2026-09-08", "lunch", r.foodId]]);
    // Denying follows the same rules.
    await call(dad, "PUT", `/meals/${left.id}`, { status: "denied" });
    assert.equal(entriesOf(left.id).length, 0);

    // Servings are counted down: a denied leftover frees its servings, a live one holds them.
    assert.equal((await call(dad, "GET", "/meals/m-pot/leftover-offer")).body.offer.servingsLeft, 4);
    await call(dad, "POST", "/meals/m-pot/leftovers", { day: "Wednesday", slot: "dinner" });
    await call(dad, "POST", "/meals/m-pot/leftovers", { day: "Thursday", slot: "lunch" });
    assert.equal((await call(dad, "GET", "/meals/m-pot/leftover-offer")).body.offer.servingsLeft, 0);
    const over = await call(dad, "POST", "/meals/m-pot/leftovers", { day: "Friday", slot: "lunch" });
    assert.equal(over.status, 409);
  });

  test("a chosen cell must be a free, later lunch or dinner this week; a leftover can't have leftovers", async () => {
    await dinnerFor(8, { day: "Wednesday" });
    const bad = async (body: any, status: number) => assert.equal((await call(dad, "POST", "/meals/m-pot/leftovers", body)).status, status, JSON.stringify(body));
    await bad({ day: "Tuesday", slot: "lunch" }, 400); // earlier
    await bad({ day: "Wednesday", slot: "dinner" }, 400); // the meal's own cell
    await bad({ day: "Thursday", slot: "snacks" }, 400);
    await bad({ day: "Thursday", slot: "breakfast" }, 400);
    await bad({ day: "Someday", slot: "lunch" }, 400);
    await bad({ day: "Thursday" }, 400);
    assert.equal(currentPlan(dad)!.meals.length, 1, "refusals wrote nothing");

    const made = (await call(dad, "POST", "/meals/m-pot/leftovers", { day: "thursday", slot: "Lunch" }));
    assert.equal(made.status, 200);
    const occupied = await call(dad, "POST", "/meals/m-pot/leftovers", { day: "Thursday", slot: "lunch" });
    assert.equal(occupied.status, 409);
    assert.match(occupied.body.error, /already has a meal/);
    const offerOfLeftover = (await call(dad, "GET", `/meals/${made.body.meal.id}/leftover-offer`)).body.offer;
    assert.deepEqual([offerOfLeftover.suggestion, offerOfLeftover.reason], [null, "This is already a leftover meal."]);
    assert.equal((await call(dad, "POST", `/meals/${made.body.meal.id}/leftovers`)).status, 409);
  });

  test("deleting the original removes its leftovers and their planned entries; the recipe can't change under existing leftovers", async () => {
    const { r } = await dinnerFor(6);
    const made = await call(dad, "POST", "/meals/m-pot/leftovers");
    const leftId = made.body.meal.id;
    await call(dad, "PUT", `/meals/${leftId}`, { status: "approved" });
    assert.equal(entriesOf(leftId).length, 2);

    const other = recipe("Another pot", 100);
    assert.equal((await call(dad, "PUT", "/meals/m-pot", { recipeId: other.id })).status, 409, "leftovers are of this dish");
    assert.equal((await call(dad, "PUT", `/meals/${leftId}`, { recipeId: other.id })).status, 400, "and follow its recipe");

    const del = await call(dad, "DELETE", "/meals/m-pot");
    assert.equal(del.body.plan.meals.length, 0, "the original and its leftovers are gone");
    assert.equal(entriesOf(leftId).length, 0);
    assert.ok(r);
  });

  test("a leftover without a recipe to count servings from is refused plainly", async () => {
    seedPlan([meal({ id: "m-pot" })]);
    assert.equal((await call(dad, "GET", "/meals/m-pot/leftover-offer")).status, 409);
    assert.equal((await call(dad, "POST", "/meals/m-pot/leftovers")).status, 409);
    assert.equal((await call(dad, "GET", "/meals/nope/leftover-offer")).status, 404);
  });
});

describe("the assistant", () => {
  test("create_meal_plan saves each dish as a joint recipe once and sets recipeId; the week's meals start proposed", async () => {
    const asked: string[] = [];
    setRecipeModel({
      async parseLines(texts) { return texts.map(() => null); },
      async estimateKcal(input) { asked.push(input.recipeName); return Object.fromEntries(input.ingredients.map((i) => [i.index, 150])); },
    });
    const res = await tool(dad, "create_meal_plan", {
      weekStart: WEEK,
      meals: [
        { day: "Monday", slot: "dinner", name: "Veggie curry", ingredients: ["chickpeas", "coconut milk"], servings: 4 },
        { day: "Tuesday", slot: "lunch", name: "veggie curry", ingredients: ["chickpeas", "coconut milk"] },
        { day: "Tuesday", slot: "snacks", name: "Apple slices", ingredients: ["apple"] },
        { day: "Friday", slot: "nonsense-slot", name: "Fish tacos", ingredients: ["fish", "tortillas"] },
      ],
    });
    assert.equal(res.error, undefined, JSON.stringify(res));
    const plan = currentPlan(dad)!;
    assert.equal(plan.meals.length, 4);
    assert.ok(plan.meals.every((m) => m.recipeId && m.status === "proposed"));
    assert.equal(plan.meals[0].recipeId, plan.meals[1].recipeId, "one recipe for the dish, however many days");
    assert.deepEqual(plan.meals.map((m) => m.slot), ["dinner", "lunch", "snacks", "dinner"], "snacks is a slot now; an unknown one falls back to dinner");
    const recipes = getScopedItems("recipes", dad) as any[];
    const curry = recipes.find((r) => r.id === plan.meals[0].recipeId);
    assert.deepEqual([curry.name, curry.scope, curry.yieldServings, !!curry.foodId, curry.nutrition.complete], ["Veggie curry", "joint", 4, true, false]);
    assert.equal(recipes.filter((r) => /curry/i.test(r.name)).length, 1);
    assert.deepEqual(asked.filter((n) => /curry/i.test(n)).length, 1, "the model was asked once for the dish");
    assert.deepEqual(res.missingIngredients.sort(), ["apple", "chickpeas", "coconut milk", "fish", "tortillas"].sort());
  });

  test("a dish the household already has a recipe for is used as it is, not rewritten from the model's ingredient guess", async () => {
    const real = recipe("Grandma's lasagne", 520, { ingredients: ["pasta", "ricotta", "beef"], lines: [{ text: "300 g pasta", pantryName: "pasta" }, { text: "ricotta", pantryName: "ricotta" }, { text: "beef", pantryName: "beef" }] });
    await tool(dad, "create_meal_plan", { weekStart: WEEK, meals: [{ day: "Monday", slot: "dinner", name: "grandma's lasagne", ingredients: ["noodles", "cheese"] }] });
    const plan = currentPlan(dad)!;
    assert.equal(plan.meals[0].recipeId, real.id);
    assert.deepEqual(plan.meals[0].ingredients, ["pasta", "ricotta", "beef"], "the plan shops for the real recipe");
    const after = (getScopedItems("recipes", dad) as any[]).find((r) => r.id === real.id);
    assert.equal(after.nutrition.perServing.kcal, 520);
    assert.equal(after.lines.length, 3);
  });

  test("a personal recipe of the same name is never put on the shared plan", async () => {
    siteRecipeFor(db, bea, "Bea's private bowl", 250, { scope: "personal" });
    await tool(dad, "create_meal_plan", { weekStart: WEEK, meals: [{ day: "Monday", slot: "dinner", name: "Bea's private bowl", ingredients: ["rice"] }] });
    const plan = currentPlan(dad)!;
    const rec = (getScopedItems("recipes", dad) as any[]).find((r) => r.id === plan.meals[0].recipeId);
    assert.equal(rec.scope, "joint", "a new joint recipe, not Bea's personal one");
    assert.notEqual(rec.createdBy, bea);
  });

  test("set_meal_status approves into the diaries and says whose; replacing the week removes what was only planned", async () => {
    await tool(dad, "create_meal_plan", { weekStart: WEEK, meals: [{ day: "Wednesday", slot: "dinner", name: "Stir fry", ingredients: ["200 g chicken"] }] });
    const plannedId = currentPlan(dad)!.meals[0].id;
    // No calories without a model: approved, but nothing in the diaries, and it says so.
    const first = await tool(dad, "set_meal_status", { day: "Wednesday", slot: "dinner", status: "approved", week: WEEK });
    assert.equal(first.error, undefined);
    assert.match(first.diaryNote, /no calories yet/);

    const rec = recipe("Stir fry 2", 380);
    const m = currentPlan(dad)!.meals[0];
    await call(dad, "PUT", `/meals/${m.id}`, { status: "proposed" });
    await call(dad, "PUT", `/meals/${m.id}`, { recipeId: rec.id });
    const ok = await tool(dad, "set_meal_status", { day: "Wednesday", slot: "dinner", status: "approved", week: WEEK });
    assert.deepEqual(ok.inFoodDiariesOf.sort(), ["Bea", "Dad"]);
    assert.equal(entriesOf(m.id).length, 2);
    assert.equal(plannedId, m.id);

    // The assistant replaces the week: the old meal's planned entries go (nothing was logged).
    await tool(dad, "create_meal_plan", { weekStart: WEEK, meals: [{ day: "Thursday", slot: "dinner", name: "Soup", ingredients: ["stock"] }] });
    assert.equal(entriesOf(m.id).length, 0);
  });

  test("a recipe-less meal can't be approved by the assistant either; the tool descriptions are honest about it", async () => {
    seedPlan([meal({ id: "m-tool-old", day: "Monday", slot: "dinner" })]);
    const r = await tool(dad, "set_meal_status", { day: "Monday", slot: "dinner", status: "approved", week: WEEK });
    assert.match(r.error, /no recipe yet/);
    const tools = buildTools(dad);
    assert.match(tools.find((t) => t.name === "create_meal_plan")!.description, /joint recipe/);
    assert.match(tools.find((t) => t.name === "set_meal_status")!.description, /food diary/);
    assert.match(JSON.stringify(tools.find((t) => t.name === "create_meal_plan")!.parameters), /snacks/);
  });
});

// create_meal_plan's keepOtherDays: "Plan the week" saves one day per call, because Ollama's gemma4 tool-call parser
// drops a call as long as a whole week's meals but reads a day's three every time. A call then has to add its day to
// the week, not replace the week.
describe("create_meal_plan with keepOtherDays", () => {
  const day = (d: string, name: string) => ({ day: d, slot: "dinner", name, ingredients: [`${name} ingredient`] });
  const planMeals = () => currentPlan(dad)!.meals;

  test("only the named days are replaced; kept days keep their meals, ids, statuses and planned diary entries", async () => {
    const stew = recipe("Keep stew", 400);
    const oldFri = recipe("Old friday pie", 300);
    seedPlan([
      meal({ id: "m-mon", day: "Monday", name: "Keep stew", recipeId: stew.id }),
      meal({ id: "m-fri", day: "Friday", name: "Old friday pie", recipeId: oldFri.id }),
    ]);
    // Approve both: each puts a planned entry in both diaries.
    for (const id of ["m-mon", "m-fri"]) assert.equal((await call(dad, "PUT", `/meals/${id}`, { status: "approved" })).status, 200);
    assert.equal(entriesOf("m-mon").length, 2);
    assert.equal(entriesOf("m-fri").length, 2);
    const monBefore = JSON.stringify(planMeals().find((m) => m.id === "m-mon"));
    const monEntriesBefore = JSON.stringify(entriesOf("m-mon"));

    const res = await tool(dad, "create_meal_plan", { weekStart: WEEK, keepOtherDays: true, meals: [day("Friday", "New friday curry"), day("Wednesday", "Wed soup")] });
    assert.equal(res.error, undefined, JSON.stringify(res));
    assert.deepEqual(res.daysSaved, ["Wednesday", "Friday"]);
    assert.deepEqual(res.daysWithMeals, ["Monday", "Wednesday", "Friday"]);
    assert.equal(res.mealCount, 3);

    const now = planMeals();
    assert.deepEqual(now.map((m) => m.day), ["Monday", "Wednesday", "Friday"], "kept and new days in week order");
    assert.equal(JSON.stringify(now.find((m) => m.id === "m-mon")), monBefore, "Monday is the very same meal, still approved");
    assert.equal(now.find((m) => m.id === "m-mon")!.status, "approved");
    assert.equal(JSON.stringify(entriesOf("m-mon")), monEntriesBefore, "Monday's planned diary entries are untouched");
    // Friday was replaced exactly as a full replace would: old meal gone, its planned entries gone, new one proposed.
    assert.ok(!now.some((m) => m.id === "m-fri"));
    assert.equal(entriesOf("m-fri").length, 0);
    const newFri = now.find((m) => m.day === "Friday")!;
    assert.deepEqual([newFri.name, newFri.status], ["New friday curry", "proposed"]);
  });

  test("a day saved on top of a plan keeps what was logged for the replaced day", async () => {
    const pie = recipe("Logged pie", 300);
    seedPlan([meal({ id: "m-logged", day: "Tuesday", name: "Logged pie", recipeId: pie.id })]);
    await call(dad, "PUT", "/meals/m-logged", { status: "approved" });
    const [dadEntry] = entriesOf("m-logged").filter((e) => e.user_id === dad);
    updateEntry(db, getTracker(db, dad), "2026-09-08", dadEntry.id, { status: "logged" });
    await tool(dad, "create_meal_plan", { weekStart: WEEK, keepOtherDays: true, meals: [day("Tuesday", "Something else")] });
    assert.deepEqual(entriesOf("m-logged").map((e) => [e.user_id === dad, e.status]), [[true, "logged"]], "Bea's planned entry went, Dad's logged one stayed");
  });

  test("with no plan for the week yet, one is created", async () => {
    for (const old of getScopedItems("meal_plans", dad) as any[]) deleteScopedItem("meal_plans", dad, old.id);
    const res = await tool(dad, "create_meal_plan", { weekStart: WEEK, keepOtherDays: true, meals: [day("Thursday", "Thursday chili")] });
    assert.equal(res.error, undefined, JSON.stringify(res));
    assert.deepEqual(res.daysWithMeals, ["Thursday"]);
    assert.deepEqual(planMeals().map((m) => m.name), ["Thursday chili"]);
  });

  test("seven one-day calls build the week, each adding to the last", async () => {
    for (const old of getScopedItems("meal_plans", dad) as any[]) deleteScopedItem("meal_plans", dad, old.id);
    const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
    let last: any;
    for (const [i, d] of days.entries()) last = await tool(dad, "create_meal_plan", { weekStart: WEEK, keepOtherDays: true, meals: [day(d, `Dinner number ${["one", "two", "three", "four", "five", "six", "seven"][i]}`)] });
    assert.deepEqual(last.daysWithMeals, days);
    assert.equal(planMeals().length, 7);
    assert.equal((getScopedItems("meal_plans", dad) as any[]).length, 1, "one plan for the week, not seven");
  });

  test("leaving it out, or false, replaces the whole week exactly as before", async () => {
    for (const keep of [undefined, false]) {
      seedPlan([meal({ id: "m-a", day: "Monday", name: "Old A" }), meal({ id: "m-b", day: "Sunday", name: "Old B" })]);
      const res = await tool(dad, "create_meal_plan", { weekStart: WEEK, ...(keep === undefined ? {} : { keepOtherDays: keep }), meals: [day("Wednesday", "Only wednesday")] });
      assert.equal(res.error, undefined);
      assert.deepEqual(planMeals().map((m) => m.name), ["Only wednesday"], `keepOtherDays ${keep}: the old week is gone`);
    }
  });

  test("a leftover on a kept day goes with its original when the original's day is replaced", async () => {
    seedPlan([
      meal({ id: "m-orig", day: "Monday", name: "Big roast" }),
      meal({ id: "m-left", day: "Tuesday", name: "Big roast", leftoverOf: "m-orig" }),
      meal({ id: "m-other", day: "Thursday", name: "Other dinner" }),
    ]);
    await tool(dad, "create_meal_plan", { weekStart: WEEK, keepOtherDays: true, meals: [day("Monday", "Monday pasta")] });
    assert.deepEqual(planMeals().map((m) => m.name).sort(), ["Monday pasta", "Other dinner"]);
  });

  test("the parameter is optional and described", () => {
    const params = buildTools(dad).find((t) => t.name === "create_meal_plan")!.parameters as any;
    assert.equal(params.properties.keepOtherDays.type, "boolean");
    assert.match(params.properties.keepOtherDays.description, /only the days present in meals are replaced/);
    assert.deepEqual(params.required, ["weekStart", "meals"]);
  });
});
