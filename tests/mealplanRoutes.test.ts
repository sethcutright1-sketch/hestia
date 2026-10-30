// routes/mealplan.ts -- the last untested router, and the one with the most
// moving parts: a plan is never returned bare, every mutating endpoint returns
// the same full shape, and what's "missing" is recomputed on every read rather
// than stored.
//
// The recomputation is the interesting design choice. A saved plan's missing
// ingredients and dislike conflicts are derived from the CURRENT pantry and
// the CURRENT family preferences every time, so buying something makes it drop
// off the list instead of lingering in a stale snapshot. That only holds if
// every path actually goes through describePlan -- which is what most of these
// tests are really checking.

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { loadDb, cleanupDb } from "./helpers/testdb.ts";
import { callRoute } from "./helpers/router.ts";

const loaded = await loadDb();
const { createUser, putScopedItem, putScopedItemAs, getScopedItems, deleteScopedItem, newId } = loaded;
const { upsertRecipeByName } = await import("../nutrition/data/recipes.ts");
const routes = await import("../routes/mealplan.ts");
const { mealPlanRoutes, buildMealPlan, DAYS, MEAL_SLOTS, currentPlan } = routes;

let alice: string;
let bob: string;

const asAlice = () => ({ session: { userId: alice } });
const asBob = () => ({ session: { userId: bob } });

function meal(overrides: Record<string, any> = {}) {
  return {
    id: newId("meal"),
    day: "Monday",
    slot: "dinner",
    name: "Tacos",
    ingredients: ["beef", "tortillas"],
    status: "proposed",
    audience: "family",
    ...overrides,
  };
}

/** Replaces the current plan with a fresh one, so each test starts clean.
 *  Old plans are removed rather than left behind, so `currentPlan` -- which
 *  picks the most recently updated -- is never ambiguous. */
function seedPlan(meals: any[] = [meal()]) {
  for (const old of getScopedItems("meal_plans", alice) as any[]) {
    deleteScopedItem("meal_plans", alice, old.id);
  }
  const plan = buildMealPlan(alice, "2026-09-07", meals as any);
  putScopedItem("meal_plans", alice, plan);
  return plan;
}

// Approving a meal needs a recipe now (merge plan decision 2): the tests that approve use meals pointing at this one,
// made on first use so the tests about an empty recipe book still see an empty one.
const tacosRecipe = () => upsertRecipeByName(loaded.db as any, alice, { name: "Tacos", ingredients: ["beef", "tortillas"], jointOnly: true }).id;

before(() => {
  alice = createUser("alice-mp", "not-a-real-hash", "Alice");
  bob = createUser("bob-mp", "not-a-real-hash", "Bob");
});

after(cleanupDb);

describe("GET / -- a plan is never returned bare", () => {
  test("with no plan saved, every field is present and empty rather than missing", async () => {
    // MealPlan.tsx sets its state straight from this response; a missing key
    // would be `undefined` where it expects an array.
    const result = await callRoute(mealPlanRoutes, "GET", "/", asAlice());

    assert.equal(result.status, 200);
    assert.equal(result.body.plan, null);
    assert.deepEqual(result.body.missing, []);
    assert.deepEqual(result.body.conflicts, []);
    assert.deepEqual(result.body.recipes, []);
    assert.deepEqual(result.body.requests, []);
  });

  test("returns the plan with missing ingredients computed against the pantry", async () => {
    seedPlan([meal({ ingredients: ["beef", "tortillas"] })]);
    putScopedItem("pantry_items", alice, {
      id: newId("pantry"),
      scope: "joint",
      name: "Tortillas",
      quantity: "1 pack",
    });

    const result = await callRoute(mealPlanRoutes, "GET", "/", asAlice());

    assert.deepEqual(result.body.missing, ["beef"], "what the pantry covers should drop off");
  });

  test("missing is recomputed per read, so buying something updates it with no plan write", async () => {
    const before = (await callRoute(mealPlanRoutes, "GET", "/", asAlice())).body;
    assert.ok(before.missing.includes("beef"));

    putScopedItem("pantry_items", alice, { id: newId("pantry"), scope: "joint", name: "Beef", quantity: "1 lb" });

    const after = (await callRoute(mealPlanRoutes, "GET", "/", asAlice())).body;
    assert.deepEqual(after.missing, [], "the stored plan did not change -- only the pantry did");
    assert.equal(after.plan.updatedAt, before.plan.updatedAt, "and the plan was not rewritten to achieve it");
  });

  test("dislike conflicts are recomputed against the current family too", async () => {
    seedPlan([meal({ name: "Mushroom Risotto", ingredients: ["mushrooms", "rice"] })]);

    const clean = (await callRoute(mealPlanRoutes, "GET", "/", asAlice())).body;
    assert.deepEqual(clean.conflicts, []);

    putScopedItem("household_members", alice, {
      id: "member-sam",
      scope: "joint",
      name: "Sam",
      likes: [],
      dislikes: ["mushrooms"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const conflicted = (await callRoute(mealPlanRoutes, "GET", "/", asAlice())).body;
    assert.equal(conflicted.conflicts.length, 1);
    assert.equal(conflicted.conflicts[0].member, "Sam");
    assert.equal(conflicted.conflicts[0].ingredient, "mushrooms");
  });

  test("the most recently updated plan is the current one", async () => {
    // buildMealPlan always stamps updatedAt with now, so an "older" plan has
    // to be written with an explicitly older timestamp -- otherwise this test
    // would be asserting against the newest plan and pass for the wrong reason.
    const current = seedPlan([meal({ name: "Current Plan Meal" })]);
    const older = {
      ...buildMealPlan(alice, "2026-08-31", [meal({ name: "Old Plan Meal" })] as any),
      updatedAt: "2020-01-01T00:00:00.000Z",
    };
    putScopedItem("meal_plans", alice, older);

    assert.equal(currentPlan(alice)?.id, current.id, "an older plan must not take over");
    const result = await callRoute(mealPlanRoutes, "GET", "/", asAlice());
    assert.equal(result.body.plan.meals.some((m: any) => m.name === "Old Plan Meal"), false);
    assert.ok(result.body.plan.meals.some((m: any) => m.name === "Current Plan Meal"));
  });
});

describe("every mutating endpoint returns the same full shape", () => {
  // The file's own comment records that recipes was missing from the
  // approve/deny response until it was fixed. This is the test that keeps all
  // five keys on every path.
  const REQUIRED_KEYS = ["plan", "missing", "conflicts", "recipes", "requests"];

  function assertFullShape(body: any, label: string) {
    for (const key of REQUIRED_KEYS) {
      assert.ok(key in body, `${label} response is missing "${key}"`);
    }
  }

  let mealId: string;

  beforeEach(() => {
    const plan = seedPlan([meal({ id: "meal-shape", name: "Shape Test", recipeId: tacosRecipe() })]);
    mealId = plan.meals[0].id;
  });

  test("PUT /meals/:id", async () => {
    const result = await callRoute(mealPlanRoutes, "PUT", `/meals/${mealId}`, {
      ...asAlice(),
      body: { status: "approved" },
    });
    assertFullShape(result.body, "PUT /meals/:id");
  });

  test("POST /meals", async () => {
    const result = await callRoute(mealPlanRoutes, "POST", "/meals", {
      ...asAlice(),
      body: { day: "Tuesday", slot: "lunch", name: "Soup" },
    });
    assertFullShape(result.body, "POST /meals");
  });

  test("DELETE /meals/:id", async () => {
    const result = await callRoute(mealPlanRoutes, "DELETE", `/meals/${mealId}`, asAlice());
    assertFullShape(result.body, "DELETE /meals/:id");
  });

  test("POST /requests", async () => {
    const result = await callRoute(mealPlanRoutes, "POST", "/requests", {
      ...asAlice(),
      body: { name: "Lasagne" },
    });
    assertFullShape(result.body, "POST /requests");
  });

  test("DELETE /requests/:id", async () => {
    const created = await callRoute(mealPlanRoutes, "POST", "/requests", {
      ...asAlice(),
      body: { name: "Doomed request" },
    });
    const id = created.body.requests.find((r: any) => r.name === "Doomed request").id;

    const result = await callRoute(mealPlanRoutes, "DELETE", `/requests/${id}`, asAlice());
    assertFullShape(result.body, "DELETE /requests/:id");
  });
});

describe("PUT /meals/:mealId", () => {
  let mealId: string;

  beforeEach(() => {
    mealId = seedPlan([meal({ id: "meal-put", recipeId: tacosRecipe() })]).meals[0].id;
  });

  test("approves and denies a meal", async () => {
    for (const status of ["approved", "denied", "proposed"]) {
      const result = await callRoute(mealPlanRoutes, "PUT", `/meals/${mealId}`, { ...asAlice(), body: { status } });
      assert.equal(result.body.plan.meals[0].status, status);
    }
  });

  test("refuses a status that isn't one of the three", async () => {
    const result = await callRoute(mealPlanRoutes, "PUT", `/meals/${mealId}`, {
      ...asAlice(),
      body: { status: "maybe" },
    });
    assert.equal(result.status, 400);
  });

  test("a denied meal stops driving the shopping list", async () => {
    // You shouldn't shop for a dinner you rejected -- the rule lives in
    // computeMissing, and this is the path that reaches it.
    seedPlan([meal({ id: "meal-denied", ingredients: ["saffron"] })]);
    const id = currentPlan(alice)!.meals[0].id;

    const before = await callRoute(mealPlanRoutes, "GET", "/", asAlice());
    assert.ok(before.body.missing.includes("saffron"));

    const after = await callRoute(mealPlanRoutes, "PUT", `/meals/${id}`, { ...asAlice(), body: { status: "denied" } });
    assert.equal(after.body.missing.includes("saffron"), false);
  });

  test("splitting a meal off to one person requires naming them", async () => {
    const result = await callRoute(mealPlanRoutes, "PUT", `/meals/${mealId}`, {
      ...asAlice(),
      body: { audience: "individual" },
    });

    assert.equal(result.status, 400);
    assert.match(result.body.error, /memberId is required/);
  });

  test("reassigning to individual records the member, and back to family clears it", async () => {
    const individual = await callRoute(mealPlanRoutes, "PUT", `/meals/${mealId}`, {
      ...asAlice(),
      body: { audience: "individual", memberId: "member-sam" },
    });
    assert.equal(individual.body.plan.meals[0].memberId, "member-sam");

    const family = await callRoute(mealPlanRoutes, "PUT", `/meals/${mealId}`, {
      ...asAlice(),
      body: { audience: "family" },
    });
    assert.equal(family.body.plan.meals[0].memberId, undefined, "a family meal must not keep a member id");
  });

  test("refuses an audience that isn't family or individual", async () => {
    const result = await callRoute(mealPlanRoutes, "PUT", `/meals/${mealId}`, {
      ...asAlice(),
      body: { audience: "everyone" },
    });
    assert.equal(result.status, 400);
  });

  test("changing only the status leaves an individual meal's member alone", async () => {
    await callRoute(mealPlanRoutes, "PUT", `/meals/${mealId}`, {
      ...asAlice(),
      body: { audience: "individual", memberId: "member-sam" },
    });

    const result = await callRoute(mealPlanRoutes, "PUT", `/meals/${mealId}`, {
      ...asAlice(),
      body: { status: "approved" },
    });

    assert.equal(result.body.plan.meals[0].memberId, "member-sam");
    assert.equal(result.body.plan.meals[0].audience, "individual");
  });

  test("an unknown meal id is a 404", async () => {
    const result = await callRoute(mealPlanRoutes, "PUT", "/meals/meal-nope", {
      ...asAlice(),
      body: { status: "approved" },
    });
    assert.equal(result.status, 404);
  });

  test("validation runs before the meal is looked up", async () => {
    // A bad status on a nonexistent meal should report the bad status, so the
    // client fixes the real problem rather than chasing a 404.
    const result = await callRoute(mealPlanRoutes, "PUT", "/meals/meal-nope", {
      ...asAlice(),
      body: { status: "maybe" },
    });
    assert.equal(result.status, 400);
  });
});

describe("POST /meals", () => {
  beforeEach(() => {
    seedPlan([meal({ id: "meal-base" })]);
  });

  test("adds a meal, trimming and defaulting", async () => {
    const result = await callRoute(mealPlanRoutes, "POST", "/meals", {
      ...asAlice(),
      body: { day: "  Tuesday  ", slot: "lunch", name: "  Soup  ", ingredients: ["  broth  ", "", "noodles"] },
    });

    const added = result.body.plan.meals.find((m: any) => m.name === "Soup");
    assert.equal(added.day, "Tuesday");
    assert.equal(added.status, "proposed", "a new meal starts unapproved");
    assert.equal(added.audience, "family");
    assert.deepEqual(added.ingredients, ["broth", "noodles"], "blank ingredients are dropped");
  });

  test("requires a name, a day, and a real slot", async () => {
    const bad = [
      { day: "Monday", slot: "dinner" },
      { day: "Monday", slot: "dinner", name: "   " },
      { day: "", slot: "dinner", name: "X" },
      { day: "Monday", slot: "brunch", name: "X" },
      { day: "Monday", name: "X" },
    ];
    for (const body of bad) {
      const result = await callRoute(mealPlanRoutes, "POST", "/meals", { ...asAlice(), body });
      assert.equal(result.status, 400, `${JSON.stringify(body)} should be refused`);
    }
  });

  test("an individual meal must name the member", async () => {
    const result = await callRoute(mealPlanRoutes, "POST", "/meals", {
      ...asAlice(),
      body: { day: "Monday", slot: "dinner", name: "Just for Sam", audience: "individual" },
    });
    assert.equal(result.status, 400);
  });

  test("non-array ingredients become empty rather than throwing", async () => {
    const result = await callRoute(mealPlanRoutes, "POST", "/meals", {
      ...asAlice(),
      body: { day: "Wednesday", slot: "dinner", name: "Mystery", ingredients: "beef, tortillas" },
    });
    assert.deepEqual(result.body.plan.meals.find((m: any) => m.name === "Mystery").ingredients, []);
  });

  test("both members work on the same plan -- meal plans are joint", async () => {
    // Not personal rows: a household plans meals together, so Bob acts on the
    // plan Alice's session created. Worth stating outright, because it is the
    // opposite of how shopping lists can behave.
    const result = await callRoute(mealPlanRoutes, "POST", "/meals", {
      ...asBob(),
      body: { day: "Thursday", slot: "dinner", name: "Bob's addition" },
    });

    assert.equal(result.status, 200);
    const asSeenByAlice = await callRoute(mealPlanRoutes, "GET", "/", asAlice());
    assert.ok(asSeenByAlice.body.plan.meals.some((m: any) => m.name === "Bob's addition"));
  });

  test("refuses a day that is not a day of the week", async () => {
    // slot is checked against MEAL_SLOTS; day is not checked against DAYS.
    // MealPlan.tsx renders the week by iterating DAYS and filtering
    // `m.day === day` -- an exact, case-sensitive match -- so a meal on
    // "Funday" is never drawn. It is still a real row: computeMissing counts
    // its ingredients, so it silently pushes items onto the shopping list for
    // a meal nobody can see, approve, or delete from the UI.
    const result = await callRoute(mealPlanRoutes, "POST", "/meals", {
      ...asAlice(),
      body: { day: "Funday", slot: "dinner", name: "Invisible Meal", ingredients: ["saffron"] },
    });

    assert.equal(result.status, 400, "a day outside DAYS must be refused");
  });

  test("every meal that gets stored is one the week grid can actually draw", async () => {
    // Deliberately fix-strategy-agnostic: rejecting a bad day or normalizing
    // its casing would both satisfy this. What must not happen is a stored
    // meal the UI cannot render.
    await callRoute(mealPlanRoutes, "POST", "/meals", {
      ...asAlice(),
      body: { day: "monday", slot: "dinner", name: "Lowercase Day", ingredients: ["cumin"] },
    });

    for (const m of currentPlan(alice)!.meals) {
      assert.ok(DAYS.includes(m.day), `meal "${m.name}" has day "${m.day}", which the week grid never renders`);
      assert.ok(MEAL_SLOTS.includes(m.slot), `meal "${m.name}" has slot "${m.slot}"`);
    }
  });

  test("a lowercase day is accepted and stored canonically", async () => {
    const result = await callRoute(mealPlanRoutes, "POST", "/meals", {
      ...asAlice(),
      body: { day: "monday", slot: "dinner", name: "Lowercase Monday", ingredients: ["cumin"] },
    });

    assert.equal(result.status, 200);
    const added = result.body.plan.meals.find((m: any) => m.name === "Lowercase Monday");
    assert.equal(added.day, "Monday");
  });

  test("surrounding whitespace and mixed casing are both handled", async () => {
    const result = await callRoute(mealPlanRoutes, "POST", "/meals", {
      ...asAlice(),
      body: { day: "  tUeSdAy  ", slot: "dinner", name: "Messy Tuesday", ingredients: ["cumin"] },
    });

    assert.equal(result.status, 200);
    const added = result.body.plan.meals.find((m: any) => m.name === "Messy Tuesday");
    assert.equal(added.day, "Tuesday");
  });

  test("a refused day does not get written to the plan", async () => {
    const result = await callRoute(mealPlanRoutes, "POST", "/meals", {
      ...asAlice(),
      body: { day: "Funday", slot: "dinner", name: "Never Written", ingredients: ["saffron"] },
    });

    assert.equal(result.status, 400);
    assert.ok(
      !currentPlan(alice)!.meals.some((m: any) => m.name === "Never Written"),
      "a rejected day must not leave a meal behind"
    );
  });
});

describe("DELETE /meals/:mealId", () => {
  test("removes one meal and leaves the rest of the plan", async () => {
    const plan = seedPlan([meal({ name: "Keep" }), meal({ name: "Remove", day: "Tuesday" })]);
    const doomed = plan.meals.find((m: any) => m.name === "Remove")!.id;

    const result = await callRoute(mealPlanRoutes, "DELETE", `/meals/${doomed}`, asAlice());

    assert.equal(result.status, 200);
    assert.deepEqual(result.body.plan.meals.map((m: any) => m.name), ["Keep"]);
  });

  test("an unknown meal id is a 404", async () => {
    seedPlan();
    assert.equal((await callRoute(mealPlanRoutes, "DELETE", "/meals/meal-nope", asAlice())).status, 404);
  });
});

describe("POST /add-missing", () => {
  let listId: string;

  beforeEach(() => {
    // The pantry is joint and persists across tests, so it has to be cleared
    // here -- otherwise an earlier test's "buy everything" leaves nothing
    // missing and every later case short-circuits on that check instead of
    // reaching the one it meant to exercise.
    for (const item of getScopedItems("pantry_items", alice) as any[]) {
      deleteScopedItem("pantry_items", alice, item.id);
    }
    seedPlan([meal({ ingredients: ["saffron", "beef"] })]);
    listId = newId("list");
    putScopedItem("shopping_lists", alice, {
      id: listId,
      name: "Weekly Groceries",
      scope: "joint",
      status: "active",
      items: [],
      createdBy: alice,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  });

  test("adds exactly what the pantry does not cover", async () => {
    putScopedItem("pantry_items", alice, { id: newId("pantry"), scope: "joint", name: "Beef", quantity: "1 lb" });

    const result = await callRoute(mealPlanRoutes, "POST", "/add-missing", { ...asAlice(), body: { listId } });

    assert.equal(result.status, 200);
    assert.deepEqual(result.body.added, ["saffron"]);
    assert.deepEqual(result.body.list.items.map((i: any) => i.name), ["saffron"]);
    assert.equal(result.body.list.items[0].checked, false, "newly added items are not already bought");
  });

  test("refuses when nothing is missing, rather than silently adding nothing", async () => {
    for (const name of ["Saffron", "Beef"]) {
      putScopedItem("pantry_items", alice, { id: newId("pantry"), scope: "joint", name, quantity: "1" });
    }

    const result = await callRoute(mealPlanRoutes, "POST", "/add-missing", { ...asAlice(), body: { listId } });

    assert.equal(result.status, 400);
    assert.match(result.body.error, /Nothing is missing/);
  });

  test("pressing it twice does not add everything a second time", async () => {
    // The bug this guards: every press appended the whole missing list again,
    // so a second tap -- or one after the assistant already did it -- doubled it.
    await callRoute(mealPlanRoutes, "POST", "/add-missing", { ...asAlice(), body: { listId } });
    const second = await callRoute(mealPlanRoutes, "POST", "/add-missing", { ...asAlice(), body: { listId } });

    assert.equal(second.status, 200);
    assert.deepEqual(second.body.added, []);
    assert.deepEqual(second.body.alreadyOnList, ["saffron", "beef"]);
    assert.equal(second.body.list.items.length, 2);
  });

  test("matches what is already on the list loosely, the way the pantry is matched", async () => {
    const list = (getScopedItems("shopping_lists", alice) as any[]).find((l) => l.id === listId);
    list.items.push({ id: newId("item"), name: "Saffron", quantity: "", category: "Other", notes: "", checked: false, addedBy: alice });
    putScopedItem("shopping_lists", alice, list);

    const result = await callRoute(mealPlanRoutes, "POST", "/add-missing", { ...asAlice(), body: { listId } });

    assert.deepEqual(result.body.added, ["beef"]);
    assert.deepEqual(result.body.alreadyOnList, ["saffron"]);
  });

  test("an item already ticked off still gets added -- it was bought for something else", async () => {
    const list = (getScopedItems("shopping_lists", alice) as any[]).find((l) => l.id === listId);
    list.items.push({ id: newId("item"), name: "beef", quantity: "", category: "Other", notes: "", checked: true, addedBy: alice });
    putScopedItem("shopping_lists", alice, list);

    const result = await callRoute(mealPlanRoutes, "POST", "/add-missing", { ...asAlice(), body: { listId } });

    assert.deepEqual(result.body.added, ["saffron", "beef"]);
  });

  test("an unknown list is a 404", async () => {
    const result = await callRoute(mealPlanRoutes, "POST", "/add-missing", {
      ...asAlice(),
      body: { listId: "list-nope" },
    });
    assert.equal(result.status, 404);
  });

  test("cannot add to the other member's personal list", async () => {
    const bobsList = newId("list");
    putScopedItem("shopping_lists", bob, {
      id: bobsList,
      name: "Bob's private list",
      scope: "personal",
      status: "active",
      items: [],
      createdBy: bob,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const result = await callRoute(mealPlanRoutes, "POST", "/add-missing", {
      ...asAlice(),
      body: { listId: bobsList },
    });

    assert.equal(result.status, 404, "another member's list must read as absent");
    const stored = (getScopedItems("shopping_lists", bob) as any[]).find((l) => l.id === bobsList);
    assert.deepEqual(stored.items, []);
  });

  test("says so plainly when there is no plan at all", async () => {
    for (const old of getScopedItems("meal_plans", alice) as any[]) {
      deleteScopedItem("meal_plans", alice, old.id);
    }

    const result = await callRoute(mealPlanRoutes, "POST", "/add-missing", { ...asAlice(), body: { listId } });

    assert.equal(result.status, 404);
    assert.match(result.body.error, /No meal plan saved yet/);
  });
});

describe("with no plan saved at all", () => {
  beforeEach(() => {
    for (const old of getScopedItems("meal_plans", alice) as any[]) {
      deleteScopedItem("meal_plans", alice, old.id);
    }
  });

  test("POST /meals explains that a plan has to exist first", async () => {
    const result = await callRoute(mealPlanRoutes, "POST", "/meals", {
      ...asAlice(),
      body: { day: "Monday", slot: "dinner", name: "Orphan" },
    });

    assert.equal(result.status, 404);
    assert.match(result.body.error, /No meal plan saved yet/);
  });

  test("PUT and DELETE on a meal report it as not found", async () => {
    assert.equal(
      (await callRoute(mealPlanRoutes, "PUT", "/meals/meal-x", { ...asAlice(), body: { status: "approved" } })).status,
      404
    );
    assert.equal((await callRoute(mealPlanRoutes, "DELETE", "/meals/meal-x", asAlice())).status, 404);
  });
});

describe("meal requests", () => {
  test("records a request with notes, oldest first", async () => {
    // Names unique to this test -- requests are joint and persist, so earlier
    // suites have already added some.
    await callRoute(mealPlanRoutes, "POST", "/requests", {
      ...asAlice(),
      body: { name: "  Moussaka  ", notes: "  extra cheese  " },
    });
    const result = await callRoute(mealPlanRoutes, "POST", "/requests", { ...asAlice(), body: { name: "Katsu" } });

    const names = result.body.requests.map((r: any) => r.name);
    assert.deepEqual(names.slice(-2), ["Moussaka", "Katsu"], "oldest first");

    const moussaka = result.body.requests.find((r: any) => r.name === "Moussaka");
    assert.equal(moussaka.notes, "extra cheese", "notes are trimmed");
  });

  test("requires a name", async () => {
    for (const body of [{}, { name: "   " }, { name: 42 }]) {
      assert.equal((await callRoute(mealPlanRoutes, "POST", "/requests", { ...asAlice(), body })).status, 400);
    }
  });

  test("a memberId must be a real household member", async () => {
    // Worth noting as the counter-example to the calendar's PUT: this route
    // checks the id against the roster rather than trusting it.
    const bad = await callRoute(mealPlanRoutes, "POST", "/requests", {
      ...asAlice(),
      body: { name: "For nobody", memberId: "member-does-not-exist" },
    });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /No household member with that id/);

    const good = await callRoute(mealPlanRoutes, "POST", "/requests", {
      ...asAlice(),
      body: { name: "For Sam", memberId: "member-sam" },
    });
    assert.equal(good.status, 200);
  });

  test("notes default to an empty string, never undefined", async () => {
    const result = await callRoute(mealPlanRoutes, "POST", "/requests", { ...asAlice(), body: { name: "No notes" } });
    assert.equal(result.body.requests.find((r: any) => r.name === "No notes").notes, "");
  });

  test("an unknown request id is a 404 on delete", async () => {
    assert.equal((await callRoute(mealPlanRoutes, "DELETE", "/requests/req-nope", asAlice())).status, 404);
  });
});

describe("route ordering", () => {
  test("DELETE /recipes/:id is not swallowed by DELETE /:id", async () => {
    // Same registration-order hazard budget.ts documents for store-config:
    // "/recipes/abc" must reach the recipes handler, not be read as a meal
    // plan id. The distinct error message is what proves which one ran.
    const result = await callRoute(mealPlanRoutes, "DELETE", "/recipes/recipe-nope", asAlice());

    assert.equal(result.status, 404);
    assert.equal(result.body.error, "Recipe not found", "reached the recipes handler");
  });

  test("DELETE /requests/:id is not swallowed either", async () => {
    const result = await callRoute(mealPlanRoutes, "DELETE", "/requests/req-nope", asAlice());
    assert.equal(result.body.error, "Meal request not found");
  });

  test("DELETE /:id still reaches the meal-plan handler", async () => {
    const result = await callRoute(mealPlanRoutes, "DELETE", "/mealplan-nope", asAlice());
    assert.equal(result.body.error, "Meal plan not found");
  });

  test("deleting a real recipe works", async () => {
    const id = newId("recipe");
    putScopedItem("recipes", alice, {
      id,
      name: "Tacos",
      ingredients: ["beef"],
      scope: "joint",
      createdBy: alice,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    assert.equal((await callRoute(mealPlanRoutes, "DELETE", `/recipes/${id}`, asAlice())).status, 200);
    assert.equal((getScopedItems("recipes", alice) as any[]).some((r) => r.id === id), false);
  });
});

describe("recipes: saving and importing", () => {
  function clearRecipes() {
    for (const r of getScopedItems("recipes", alice) as any[]) {
      deleteScopedItem("recipes", alice, r.id);
    }
  }

  beforeEach(clearRecipes);

  test("POST /recipes saves one typed in by hand", async () => {
    const res = await callRoute(mealPlanRoutes, "POST", "/recipes", {
      ...asAlice(),
      body: { name: "Chicken fajitas", ingredients: "chicken, peppers, tortillas" },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.recipe.ingredients, ["chicken", "peppers", "tortillas"]);
  });

  test("saving the same name twice updates rather than duplicating", async () => {
    // Matches what the assistant's save_recipe tool does, so a recipe typed in
    // and then refined by the assistant stays one row.
    await callRoute(mealPlanRoutes, "POST", "/recipes", {
      ...asAlice(), body: { name: "Chilli", ingredients: ["beef"] },
    });
    await callRoute(mealPlanRoutes, "POST", "/recipes", {
      ...asAlice(), body: { name: "chilli", ingredients: ["beef", "beans"] },
    });

    const stored = getScopedItems("recipes", alice) as any[];
    assert.equal(stored.length, 1);
    assert.deepEqual(stored[0].ingredients, ["beef", "beans"]);
  });

  test("a recipe needs a name and at least one ingredient", async () => {
    for (const body of [{ ingredients: ["beef"] }, { name: "  ", ingredients: ["beef"] }, { name: "Stew" }, { name: "Stew", ingredients: "  " }]) {
      const res = await callRoute(mealPlanRoutes, "POST", "/recipes", { ...asAlice(), body });
      assert.equal(res.status, 400, `${JSON.stringify(body)} should have been rejected`);
    }
  });

  test("recipes are joint, so Bob sees what Alice saved", async () => {
    await callRoute(mealPlanRoutes, "POST", "/recipes", {
      ...asAlice(), body: { name: "Katsu curry", ingredients: ["chicken"] },
    });
    const res = await callRoute(mealPlanRoutes, "GET", "/", asBob());
    assert.ok(res.body.recipes.some((r: any) => r.name === "Katsu curry"));
  });

  test("POST /recipes/parse reads pasted text without saving anything", async () => {
    // Nothing is written until the user has looked at the preview.
    const res = await callRoute(mealPlanRoutes, "POST", "/recipes/parse", {
      ...asAlice(),
      body: { text: "Lasagne\n\nIngredients:\n- 500g beef mince\n- 1 onion" },
    });
    assert.equal(res.status, 200);
    // Pantry names as always; the pasted lines (with their quantities) now come along for calories.
    assert.deepEqual(res.body.recipes, [{
      name: "Lasagne",
      ingredients: ["beef mince", "onion"],
      lines: [{ text: "500g beef mince", pantryName: "beef mince" }, { text: "1 onion", pantryName: "onion" }],
    }]);
    assert.equal((getScopedItems("recipes", alice) as any[]).length, 0);
  });

  test("parse reads an uploaded file's contents", async () => {
    const res = await callRoute(mealPlanRoutes, "POST", "/recipes/parse", {
      ...asAlice(),
      body: { filename: "mine.csv", content: 'name,ingredients\nPie,"beef, pastry"' },
    });
    assert.equal(res.body.recipes[0].name, "Pie");
  });

  test("parse explains what's wrong instead of returning an empty list", async () => {
    const unreadable = await callRoute(mealPlanRoutes, "POST", "/recipes/parse", {
      ...asAlice(), body: { text: "just one line" },
    });
    assert.equal(unreadable.status, 422);
    assert.match(unreadable.body.error, /first line/i);

    const badFile = await callRoute(mealPlanRoutes, "POST", "/recipes/parse", {
      ...asAlice(), body: { filename: "x.csv", content: "name,method\nPie,bake" },
    });
    assert.equal(badFile.status, 422);
    assert.match(badFile.body.error, /ingredients/i);

    const nothing = await callRoute(mealPlanRoutes, "POST", "/recipes/parse", { ...asAlice(), body: {} });
    assert.equal(nothing.status, 400);
  });

  test("POST /recipes/import saves the confirmed preview", async () => {
    const res = await callRoute(mealPlanRoutes, "POST", "/recipes/import", {
      ...asAlice(),
      body: {
        recipes: [
          { name: "Pie", ingredients: ["beef", "pastry"] },
          { name: "Soup", ingredients: ["carrot"] },
        ],
      },
    });
    assert.equal(res.body.imported, 2);
    assert.equal((getScopedItems("recipes", alice) as any[]).length, 2);
  });

  test("import reports what it skipped rather than dropping it silently", async () => {
    const res = await callRoute(mealPlanRoutes, "POST", "/recipes/import", {
      ...asAlice(),
      body: { recipes: [{ name: "Good", ingredients: ["beef"] }, { name: "No ingredients" }, {}] },
    });
    assert.equal(res.body.imported, 1);
    assert.equal(res.body.skipped.length, 2);
  });

  test("import refuses a batch big enough to be a mistake", async () => {
    const many = Array.from({ length: 201 }, (_, i) => ({ name: `Dish ${i}`, ingredients: ["x"] }));
    const res = await callRoute(mealPlanRoutes, "POST", "/recipes/import", { ...asAlice(), body: { recipes: many } });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /smaller batches/i);
  });

  test("import needs an actual list", async () => {
    for (const body of [{}, { recipes: "Pie" }, { recipes: null }]) {
      const res = await callRoute(mealPlanRoutes, "POST", "/recipes/import", { ...asAlice(), body });
      assert.equal(res.status, 400);
    }
  });

  test("from-url refuses a private address before making any request", async () => {
    // The guard has its own tests in recipeImport.test.ts; this checks the
    // route is actually wired to it and answers 400 rather than 500.
    const res = await callRoute(mealPlanRoutes, "POST", "/recipes/from-url", {
      ...asAlice(), body: { url: "http://127.0.0.1:3200/api/budget" },
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /private network/i);
  });

  test("from-url needs a link", async () => {
    const res = await callRoute(mealPlanRoutes, "POST", "/recipes/from-url", { ...asAlice(), body: {} });
    assert.equal(res.status, 400);
  });
});

describe("the grocery budget meal planning may see", () => {
  // One number crosses from Budget into meal planning, and only when an admin
  // has said so. Everything else about the budget stays behind the financial
  // boundary -- these tests pin that the figure is the LIMIT, never spending.
  const { setConfig } = loaded;
  const { groceryBudget, SHARE_GROCERY_BUDGET_KEY } = routes;
  const october = new Date("2026-10-15T12:00:00Z");

  function setGroceries(row: Record<string, any> | null) {
    deleteScopedItem("budgets", alice, "Groceries");
    if (row) putScopedItemAs("budgets", alice, "Groceries", { category: "Groceries", spent: 999, scope: "joint", ...row });
  }

  beforeEach(() => setConfig(SHARE_GROCERY_BUDGET_KEY, true));
  after(() => {
    setConfig(SHARE_GROCERY_BUDGET_KEY, false);
    setGroceries(null);
  });

  test("is hidden until an admin shares it", () => {
    setGroceries({ limit: 600 });
    setConfig(SHARE_GROCERY_BUDGET_KEY, false);
    assert.equal(groceryBudget(alice, october), null);
  });

  test("is null when there is no Groceries category", () => {
    setGroceries(null);
    assert.equal(groceryBudget(alice, october), null);
  });

  test("gives the monthly limit and a 12/52 weekly figure, never the amount spent", () => {
    setGroceries({ limit: 650 });
    const budget = groceryBudget(alice, october);
    assert.deepEqual(budget, { month: "2026-10", monthly: 650, weekly: 150 });
    assert.equal(JSON.stringify(budget).includes("999"), false, "spent must never leak through");
  });

  test("uses this month's one-off override when there is one", () => {
    setGroceries({ limit: 650, monthlyLimits: { "2026-10": 520, "2026-11": 900 } });
    assert.equal(groceryBudget(alice, october)?.monthly, 520);
  });

  test("a zero limit counts as no budget, not a budget of nothing", () => {
    setGroceries({ limit: 0 });
    assert.equal(groceryBudget(alice, october), null);
  });

  test("comes back on GET so the Plan view can show it", async () => {
    setGroceries({ limit: 650 });
    const res = await callRoute(mealPlanRoutes, "GET", "/", asAlice());
    assert.equal(res.body.groceryBudget.monthly, 650);
  });
});

describe("snack requests", () => {
  test("a snack request lands in its own list, not among meal requests", async () => {
    const result = await callRoute(mealPlanRoutes, "POST", "/snack-requests", { ...asAlice(), body: { name: "Apple slices" } });
    assert.equal(result.status, 200);
    assert.ok(result.body.snackRequests.some((r: any) => r.name === "Apple slices"));
    assert.ok(!result.body.requests.some((r: any) => r.name === "Apple slices"));
  });

  test("needs a name and a real member, and can be removed", async () => {
    assert.equal((await callRoute(mealPlanRoutes, "POST", "/snack-requests", { ...asAlice(), body: { name: " " } })).status, 400);
    assert.equal((await callRoute(mealPlanRoutes, "POST", "/snack-requests", { ...asAlice(), body: { name: "Chips", memberId: "nobody" } })).status, 400);
    const created = await callRoute(mealPlanRoutes, "POST", "/snack-requests", { ...asAlice(), body: { name: "Doomed snack" } });
    const id = created.body.snackRequests.find((r: any) => r.name === "Doomed snack").id;
    const removed = await callRoute(mealPlanRoutes, "DELETE", `/snack-requests/${id}`, asAlice());
    assert.ok(!removed.body.snackRequests.some((r: any) => r.id === id));
    assert.equal((await callRoute(mealPlanRoutes, "DELETE", `/snack-requests/${id}`, asAlice())).status, 404);
  });
});
