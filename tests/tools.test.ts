// The assistant's tools, exercised the way a provider actually calls them:
// `tool.run(args)` as a plain function against the real data layer. No HTTP,
// no model.
//
// This is where the registry's promise ("the assistant can never see more than
// the person talking to it can") stops being a comment and becomes something
// checked -- tools are built per-request with a user bound in, and a bug in
// that binding would hand one member's private rows to the other member's
// assistant with no error anywhere.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import { loadDb, cleanupDb } from "./helpers/testdb.ts";

const { createUser, putScopedItem, getScopedItems, newId } = await loadDb();
const { buildTools } = await import("../assistant/registry.ts");

let alice: string;
let bob: string;

/** Calls a tool by name as its owner's assistant would. */
function callAs(userId: string, name: string, args: Record<string, any> = {}): Promise<any> {
  const tool = buildTools(userId).find((t) => t.name === name);
  assert.ok(tool, `no such tool: ${name}`);
  return tool.run(args);
}

before(() => {
  alice = createUser("alice-tools", "not-a-real-hash", "Alice");
  bob = createUser("bob-tools", "not-a-real-hash", "Bob");
});

after(cleanupDb);

describe("grocery tools", () => {
  test("create_shopping_list then get_shopping_list round-trips", async () => {
    await callAs(alice, "create_shopping_list", { name: "Weekly Groceries" });
    const got = await callAs(alice, "get_shopping_list", { list: "Weekly Groceries" });
    assert.equal(got.name, "Weekly Groceries");
    assert.deepEqual(got.items, []);
  });

  test("add_shopping_item appends and reports the new total", async () => {
    await callAs(alice, "create_shopping_list", { name: "Hardware Run" });
    const added = await callAs(alice, "add_shopping_item", { list: "Hardware Run", name: "  Duct tape  ", quantity: "2" });

    assert.equal(added.to, "Hardware Run");
    assert.equal(added.totalItems, 1);

    const list = await callAs(alice, "get_shopping_list", { list: "Hardware Run" });
    assert.equal(list.items[0].name, "Duct tape", "the name should be trimmed");
    assert.equal(list.items[0].quantity, "2");
    assert.equal(list.items[0].checked, false, "a new item is not already bought");
    assert.equal(list.items[0].category, "Other", "an unspecified aisle defaults rather than going undefined");
  });

  test("adding to a list that doesn't exist errors instead of silently creating one", async () => {
    // The failure mode this prevents: the model asks for "Groceries", a new
    // empty list quietly appears, and the item never shows up where the person
    // is looking.
    const result = await callAs(alice, "add_shopping_item", { list: "Nonexistent List", name: "milk" });
    assert.match(result.error, /No shopping list named "Nonexistent List"/);

    const lists = await callAs(alice, "list_shopping_lists");
    assert.equal(lists.some((l: any) => l.name === "Nonexistent List"), false);
  });

  test("a near-miss name comes back with real suggestions to retry", async () => {
    const result = await callAs(alice, "get_shopping_list", { list: "Weekly Grocerys" });
    assert.deepEqual(result.validValues, ["Weekly Groceries"]);
    assert.match(result.hint, /Did you mean "Weekly Groceries"\?/);
  });

  test("a wildly wrong name gets an honest dead end, not a wrong guess", async () => {
    const result = await callAs(alice, "get_shopping_list", { list: "lawnmower parts" });
    assert.ok(result.error);
    assert.equal("validValues" in result, false);
  });

  test("list_shopping_lists counts remaining vs total", async () => {
    await callAs(alice, "create_shopping_list", { name: "Counting" });
    await callAs(alice, "add_shopping_item", { list: "Counting", name: "one" });
    await callAs(alice, "add_shopping_item", { list: "Counting", name: "two" });

    // Tick one off the way the UI would, through the same data layer.
    const [stored] = (getScopedItems("shopping_lists", alice) as any[]).filter((l) => l.name === "Counting");
    stored.items[0].checked = true;
    putScopedItem("shopping_lists", alice, stored);

    const summary = (await callAs(alice, "list_shopping_lists")).find((l: any) => l.name === "Counting");
    assert.equal(summary.totalItems, 2);
    assert.equal(summary.remaining, 1);
  });

  test("archived lists are hidden from the assistant", async () => {
    // Only `status: "active"` lists are offered -- an archived list is done
    // with, and suggesting items be added to it would be wrong.
    putScopedItem("shopping_lists", alice, {
      id: newId("list"),
      name: "Last Christmas",
      scope: "joint",
      status: "archived",
      items: [],
      createdBy: alice,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const names = (await callAs(alice, "list_shopping_lists")).map((l: any) => l.name);
    assert.equal(names.includes("Last Christmas"), false);

    const result = await callAs(alice, "get_shopping_list", { list: "Last Christmas" });
    assert.ok(result.error, "an archived list should not be readable either");
  });
});

describe("pantry tools", () => {
  test("add_pantry_item adds, then updates rather than duplicating", async () => {
    const first = await callAs(alice, "add_pantry_item", { name: "Rice", quantity: "1 box" });
    assert.equal(first.action, "added");

    const second = await callAs(alice, "add_pantry_item", { name: "rice", quantity: "2 boxes" });
    assert.equal(second.action, "updated", "a case-different name is the same item");
    assert.equal(second.quantity, "2 boxes");
    assert.equal(second.name, "Rice", "the original spelling is kept");

    const pantry = await callAs(alice, "list_pantry_items");
    assert.equal(pantry.filter((i: any) => i.name === "Rice").length, 1);
  });

  test("an invalid expiration date is dropped rather than stored as garbage", async () => {
    // Expiring-soon comparisons are string comparisons on YYYY-MM-DD, so
    // "next Tuesday" in that field would silently corrupt them.
    const result = await callAs(alice, "add_pantry_item", { name: "Yogurt", expirationDate: "next Tuesday" });
    assert.equal(result.expirationDate, undefined);

    const valid = await callAs(alice, "add_pantry_item", { name: "Milk", expirationDate: "2026-10-01" });
    assert.equal(valid.expirationDate, "2026-10-01");
  });

  test("list_pantry_items omits expirationDate entirely when there isn't one", async () => {
    await callAs(alice, "add_pantry_item", { name: "Salt" });
    const salt = (await callAs(alice, "list_pantry_items")).find((i: any) => i.name === "Salt");
    assert.equal("expirationDate" in salt, false, "an absent date should be absent, not null");
  });

  test("remove_pantry_item removes a real item and reports a missing one", async () => {
    await callAs(alice, "add_pantry_item", { name: "Paprika" });
    assert.deepEqual(await callAs(alice, "remove_pantry_item", { name: "paprika" }), { removed: "Paprika" });

    const gone = await callAs(alice, "list_pantry_items");
    assert.equal(gone.some((i: any) => i.name === "Paprika"), false);

    const missing = await callAs(alice, "remove_pantry_item", { name: "Saffron" });
    assert.match(missing.error, /No item in the pantry named "Saffron"/);
  });

  test("an updating add does not resurrect a removed item under a new id", async () => {
    await callAs(alice, "add_pantry_item", { name: "Cumin", quantity: "1 jar" });
    await callAs(alice, "remove_pantry_item", { name: "Cumin" });
    const readded = await callAs(alice, "add_pantry_item", { name: "Cumin", quantity: "1 jar" });
    assert.equal(readded.action, "added");
    assert.equal((await callAs(alice, "list_pantry_items")).filter((i: any) => i.name === "Cumin").length, 1);
  });

  test("list_pantry_items reports stockCount for a barcode-tracked item, and omits it for a hand-added one", async () => {
    // stockCount is only ever written by routes/pantry.ts's scan/in and
    // scan/out (see barcode scan in/out) -- written directly here rather than
    // through a tool, since no assistant tool sets it.
    putScopedItem("pantry_items", alice, {
      id: newId("pantry"), name: "Scanned Soda", quantity: "3", stockCount: 3, barcode: "1234567890123",
      scope: "joint", updatedAt: new Date().toISOString(), updatedBy: alice,
    });
    await callAs(alice, "add_pantry_item", { name: "Hand-Added Item" });

    const items = await callAs(alice, "list_pantry_items");
    const scanned = items.find((i: any) => i.name === "Scanned Soda");
    const handAdded = items.find((i: any) => i.name === "Hand-Added Item");

    assert.equal(scanned.stockCount, 3);
    assert.equal("stockCount" in handAdded, false, "an item never scanned should not report a count");
  });
});

describe("member tools", () => {
  test("a member's calendar color survives an unrelated edit through the assistant", async () => {
    // saveMember (assistant/tools/members.ts) builds the updated row field by
    // field, same as routes/members.ts's buildMember -- adding `color` to the
    // HouseholdMember shape without threading it through here would silently
    // erase it the next time the assistant touched a like or dislike.
    putScopedItem("household_members", alice, {
      id: "member-color-test", scope: "joint", name: "Casey", likes: [], dislikes: [],
      color: "violet", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });

    await callAs(alice, "add_dislike", { member: "Casey", item: "olives" });

    const stored = (getScopedItems("household_members", alice) as any[]).find((m) => m.id === "member-color-test");
    assert.equal(stored.color, "violet");
  });
});

describe("tools are bound to the user who is talking", () => {
  test("Bob's assistant cannot see Alice's personal list", async () => {
    await callAs(alice, "create_shopping_list", { name: "Birthday Surprise", scope: "personal" });

    const bobSees = (await callAs(bob, "list_shopping_lists")).map((l: any) => l.name);
    assert.equal(bobSees.includes("Birthday Surprise"), false);

    const direct = await callAs(bob, "get_shopping_list", { list: "Birthday Surprise" });
    assert.ok(direct.error, "asking for it by exact name must not work either");
  });

  test("a personal list is not even offered as a spelling suggestion", async () => {
    // closestNames runs over the caller's own visible rows, so a near-miss
    // must not leak the existence of the other member's private list.
    const result = await callAs(bob, "get_shopping_list", { list: "Birthday Surprize" });
    assert.equal(JSON.stringify(result).includes("Birthday Surprise"), false);
  });

  test("Bob cannot add an item to Alice's personal list", async () => {
    const result = await callAs(bob, "add_shopping_item", { list: "Birthday Surprise", name: "cake" });
    assert.ok(result.error);

    const alicesList = await callAs(alice, "get_shopping_list", { list: "Birthday Surprise" });
    assert.deepEqual(alicesList.items, [], "Alice's list is untouched");
  });

  test("both members see a joint list", async () => {
    await callAs(alice, "create_shopping_list", { name: "Shared Errands", scope: "joint" });
    await callAs(bob, "add_shopping_item", { list: "Shared Errands", name: "stamps" });

    const asAlice = await callAs(alice, "get_shopping_list", { list: "Shared Errands" });
    assert.deepEqual(asAlice.items.map((i: any) => i.name), ["stamps"]);
  });

  test("an unrecognized scope defaults to joint rather than going personal", async () => {
    // Defaulting the other way would silently hide a list from the household.
    await callAs(alice, "create_shopping_list", { name: "Scope Typo", scope: "shared" });
    const bobSees = (await callAs(bob, "list_shopping_lists")).map((l: any) => l.name);
    assert.ok(bobSees.includes("Scope Typo"));
  });

  test("the pantry is joint, so both assistants see the same shelf", async () => {
    await callAs(alice, "add_pantry_item", { name: "Olive Oil" });
    const bobSees = (await callAs(bob, "list_pantry_items")).map((i: any) => i.name);
    assert.ok(bobSees.includes("Olive Oil"));
  });
});

describe("every tool tolerates being called with nothing", () => {
  test("no read-only tool throws on empty args", async () => {
    // Models omit optional arguments, and sometimes required ones. A tool that
    // throws produces a raw stack trace where a useful error should be.
    const readOnly = buildTools(alice).filter((t) => !t.mutates);
    assert.ok(readOnly.length > 0);

    for (const tool of readOnly) {
      await assert.doesNotReject(
        async () => tool.run({}),
        `${tool.name} threw on empty args`
      );
    }
  });
});

describe("the assistant has to actually name the dish", () => {
  // Regression: asked to "keep it random", the model saved seven recipes all
  // called "Random Meal" -- ingredients fine, names useless. It named the
  // instruction instead of the food. The prompt and the tool schemas both tell
  // it not to; these cover the backstop that makes it impossible.

  test("save_recipe refuses a placeholder name", async () => {
    const res = await callAs(alice, "save_recipe", {
      name: "Random Meal",
      ingredients: ["chicken", "rice", "peppers"],
    });
    assert.match(res.error, /not a dish/i);
  });

  test("the refusal tells the model what to do instead, not just that it failed", async () => {
    // A bare "invalid name" would leave a local model retrying the same thing.
    const res = await callAs(alice, "save_recipe", { name: "dinner", ingredients: ["beef"] });
    assert.match(res.error, /pick an actual meal/i);
    assert.match(res.error, /chicken fajitas/i);
  });

  test("placeholders are caught regardless of casing, padding, articles or a trailing number", async () => {
    for (const name of ["RANDOM", " random meal ", "A Meal", "Meal 1", "dish", "TBD"]) {
      const res = await callAs(alice, "save_recipe", { name, ingredients: ["beef"] });
      assert.ok(res.error, `"${name}" was accepted as a dish name`);
    }
  });

  test("a real dish that merely contains a placeholder word still saves", async () => {
    // The check is anchored to the whole name on purpose -- "Random" appearing
    // inside a real dish name must not cost the user the recipe.
    for (const name of ["Dinner rolls", "Random Harvest Stew", "Breakfast burrito"]) {
      const res = await callAs(alice, "save_recipe", { name, ingredients: ["flour"] });
      assert.equal(res.error, undefined, `"${name}" was wrongly rejected`);
    }
  });

  test("create_meal_plan rejects the whole week rather than saving nameless meals", async () => {
    const res = await callAs(alice, "create_meal_plan", {
      weekStart: "2026-09-07",
      meals: [
        { day: "Monday", slot: "dinner", name: "Chicken fajitas", ingredients: ["chicken"] },
        { day: "Tuesday", slot: "dinner", name: "Random Meal", ingredients: ["beef"] },
      ],
    });
    assert.match(res.error, /not a dish/i);
  });

  test("a rejected plan leaves the previous week's plan untouched", async () => {
    // The point of erroring instead of skipping rows: the user does not lose a
    // good plan because the model got lazy on the retry.
    await callAs(alice, "create_meal_plan", {
      weekStart: "2026-09-14",
      meals: [{ day: "Monday", slot: "dinner", name: "Beef stroganoff", ingredients: ["beef"] }],
    });

    await callAs(alice, "create_meal_plan", {
      weekStart: "2026-09-14",
      meals: [{ day: "Monday", slot: "dinner", name: "Random Meal", ingredients: ["beef"] }],
    });

    // The plan is for a fixed past week, so ask for it: with no week the tool means THIS week.
    const plan = await callAs(alice, "get_meal_plan", { week: "2026-09-14" });
    assert.equal(plan.meals[0].name, "Beef stroganoff");
  });
});

describe("planning a week actually produces a plan", () => {
  // Every failure here was seen in one real conversation: asked for a plan
  // Monday to Friday, the assistant called create_meal_plan with an empty
  // meals list three times, asked the user which meals to cook, then put the
  // five dinners it had proposed onto the wish-list instead of the plan -- and
  // described the week back to the user as though it had been saved.

  test("an empty meals list says whose job it is to fill it", async () => {
    const res = await callAs(alice, "create_meal_plan", { weekStart: "2026-09-07", meals: [] });
    assert.match(res.error, /choosing the dishes is your job/i);
    assert.match(res.error, /do not ask them/i);
    // An example to copy beats a description of the shape, for a local model.
    assert.match(res.error, /"day":"Monday"/);
  });

  test("a mid-week date is snapped to that week's Monday", async () => {
    // It sent 2026-09-05 -- a Saturday -- for "this week". Two plans for one
    // week means currentPlan returns whichever was touched last, and the grid
    // appears to lose meals.
    const res = await callAs(alice, "create_meal_plan", {
      weekStart: "2026-09-05",
      meals: [{ day: "Monday", slot: "dinner", name: "Chicken fajitas", ingredients: ["chicken"] }],
    });
    assert.equal(res.error, undefined);
    assert.equal(res.weekStart, "2026-08-31");
  });

  test("every day of a week maps to the same plan, not seven of them", async () => {
    for (const day of ["2026-09-07", "2026-09-09", "2026-09-13"]) {
      await callAs(alice, "create_meal_plan", {
        weekStart: day,
        meals: [{ day: "Monday", slot: "dinner", name: "Beef stroganoff", ingredients: ["beef"] }],
      });
    }
    const plans = (getScopedItems("meal_plans", alice) as any[]).filter((p) => p.weekStart === "2026-09-07");
    assert.equal(plans.length, 1, "should have updated one plan, not created several");
  });

  test("Sunday belongs to the week that already started, not tomorrow's", async () => {
    const res = await callAs(alice, "create_meal_plan", {
      weekStart: "2026-09-13", // a Sunday
      meals: [{ day: "Sunday", slot: "dinner", name: "Roast chicken", ingredients: ["chicken"] }],
    });
    assert.equal(res.weekStart, "2026-09-07");
  });

  test("a junk date is still refused rather than snapped to nonsense", async () => {
    for (const weekStart of [undefined, "", "next monday", "2026-9-7", "not-a-date"]) {
      const res = await callAs(alice, "create_meal_plan", {
        weekStart,
        meals: [{ day: "Monday", slot: "dinner", name: "Pie", ingredients: ["beef"] }],
      });
      assert.match(res.error, /weekStart must be a date/i, `${weekStart} should have been refused`);
    }
  });

  test("add_meal_request says plainly that it is not the meal plan", async () => {
    // "Add these to the meal plan" sent five dinners here instead of to
    // create_meal_plan. The tool names are close enough that the description
    // has to draw the line.
    const tool = buildTools(alice).find((t) => t.name === "add_meal_request");
    assert.ok(tool);
    assert.match(tool.description, /does not put anything on the meal plan/i);
    assert.match(tool.description, /use create_meal_plan instead/i);
  });
});
