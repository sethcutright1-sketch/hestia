// The four straightforward section routers: grocery, pantry, calendar, members.
//
// They all follow the same REST convention (see routes/pantry.ts's header
// comment), so the interesting cases are the ones where they differ from it or
// from each other -- particularly where PUT validates less than POST, which is
// where two real bugs live.
//
// All four are mounted behind requireAuth in server.ts; driving the routers
// directly tests them as if that gate had passed, which is the right unit --
// requireAuth has its own tests in auth.test.ts.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import { loadDb, cleanupDb } from "./helpers/testdb.ts";
import { callRoute } from "./helpers/router.ts";

const { createUser, getScopedItems } = await loadDb();
const { groceryRoutes } = await import("../routes/grocery.ts");
const { pantryRoutes } = await import("../routes/pantry.ts");
const { calendarRoutes } = await import("../routes/calendar.ts");
const { memberRoutes, isParentMember, memberRole } = await import("../routes/members.ts");

let alice: string;
let bob: string;

const asAlice = () => ({ session: { userId: alice } });
const asBob = () => ({ session: { userId: bob } });

before(() => {
  alice = createUser("alice-sections", "not-a-real-hash", "Alice");
  bob = createUser("bob-sections", "not-a-real-hash", "Bob");
});

after(cleanupDb);

// ---- Grocery ---------------------------------------------------------------

describe("grocery: lists", () => {
  test("creates a list, defaulting to joint and active", async () => {
    const result = await callRoute(groceryRoutes, "POST", "/lists", {
      ...asAlice(),
      body: { name: "  Weekly Groceries  " },
    });

    assert.equal(result.status, 200);
    assert.equal(result.body.list.name, "Weekly Groceries", "the name is trimmed");
    assert.equal(result.body.list.scope, "joint");
    assert.equal(result.body.list.status, "active");
    assert.deepEqual(result.body.list.items, []);
  });

  test("requires a name", async () => {
    for (const body of [{}, { name: "" }, { name: 42 }]) {
      const result = await callRoute(groceryRoutes, "POST", "/lists", { ...asAlice(), body });
      assert.equal(result.status, 400, `${JSON.stringify(body)} should be refused`);
    }
  });

  test("an unrecognized scope defaults to joint rather than hiding the list", async () => {
    const result = await callRoute(groceryRoutes, "POST", "/lists", {
      ...asAlice(),
      body: { name: "Scope Typo", scope: "shared" },
    });
    assert.equal(result.body.list.scope, "joint");
  });

  test("lists come back most-recently-updated first", async () => {
    const lists = (await callRoute(groceryRoutes, "GET", "/lists", asAlice())).body.lists;
    const updatedAts = lists.map((l: any) => l.updatedAt);
    assert.deepEqual(updatedAts, [...updatedAts].sort().reverse());
  });

  test("another member's personal list reads as 404, not 403", async () => {
    // A 403 would confirm the list exists, which is itself the leak -- see the
    // loadList comment in routes/grocery.ts.
    const created = await callRoute(groceryRoutes, "POST", "/lists", {
      ...asAlice(),
      body: { name: "Birthday Surprise", scope: "personal" },
    });
    const id = created.body.list.id;

    assert.equal((await callRoute(groceryRoutes, "GET", `/lists/${id}`, asBob())).status, 404);
    assert.equal((await callRoute(groceryRoutes, "PUT", `/lists/${id}`, { ...asBob(), body: { name: "x" } })).status, 404);
    assert.equal((await callRoute(groceryRoutes, "DELETE", `/lists/${id}`, asBob())).status, 404);
    assert.equal((await callRoute(groceryRoutes, "GET", `/lists/${id}`, asAlice())).status, 200, "still Alice's");
  });

  test("PUT updates only the fields it recognizes", async () => {
    const created = await callRoute(groceryRoutes, "POST", "/lists", { ...asAlice(), body: { name: "Editable" } });
    const id = created.body.list.id;

    const result = await callRoute(groceryRoutes, "PUT", `/lists/${id}`, {
      ...asAlice(),
      body: { name: "Renamed", status: "archived", scope: "bogus", items: [{ id: "injected" }] },
    });

    assert.equal(result.body.list.name, "Renamed");
    assert.equal(result.body.list.status, "archived");
    assert.equal(result.body.list.scope, "joint", "a bogus scope is ignored, not stored");
    assert.equal(result.body.list.items.length, 0, "items are not settable through the list PUT");
  });

  test("PUT ignores a blank name rather than blanking the list", async () => {
    const created = await callRoute(groceryRoutes, "POST", "/lists", { ...asAlice(), body: { name: "Keep My Name" } });
    const id = created.body.list.id;

    const result = await callRoute(groceryRoutes, "PUT", `/lists/${id}`, { ...asAlice(), body: { name: "   " } });
    assert.equal(result.body.list.name, "Keep My Name");
  });
});

describe("grocery: items", () => {
  let listId: string;

  before(async () => {
    const created = await callRoute(groceryRoutes, "POST", "/lists", { ...asAlice(), body: { name: "Item Tests" } });
    listId = created.body.list.id;
  });

  test("adds an item with sensible defaults", async () => {
    const result = await callRoute(groceryRoutes, "POST", `/lists/${listId}/items`, {
      ...asAlice(),
      body: { name: "  Milk  " },
    });

    assert.equal(result.status, 200);
    assert.equal(result.body.item.name, "Milk");
    assert.equal(result.body.item.quantity, "");
    assert.equal(result.body.item.category, "Other");
    assert.equal(result.body.item.checked, false, "a new item is not already bought");
    assert.equal(result.body.item.addedBy, alice);
  });

  test("requires a name", async () => {
    const result = await callRoute(groceryRoutes, "POST", `/lists/${listId}/items`, { ...asAlice(), body: {} });
    assert.equal(result.status, 400);
  });

  test("ticking an item off persists", async () => {
    const added = await callRoute(groceryRoutes, "POST", `/lists/${listId}/items`, {
      ...asAlice(),
      body: { name: "Bread" },
    });
    const itemId = added.body.item.id;

    const result = await callRoute(groceryRoutes, "PUT", `/lists/${listId}/items/${itemId}`, {
      ...asAlice(),
      body: { checked: true },
    });

    assert.equal(result.body.item.checked, true);
    const reread = await callRoute(groceryRoutes, "GET", `/lists/${listId}`, asAlice());
    assert.equal(reread.body.list.items.find((i: any) => i.id === itemId).checked, true);
  });

  test("only a real boolean flips `checked`", async () => {
    // "false" and 0 are the shapes a loose client sends; treating them as
    // truthy would tick items off nobody bought.
    const added = await callRoute(groceryRoutes, "POST", `/lists/${listId}/items`, {
      ...asAlice(),
      body: { name: "Eggs" },
    });
    const itemId = added.body.item.id;

    const result = await callRoute(groceryRoutes, "PUT", `/lists/${listId}/items/${itemId}`, {
      ...asAlice(),
      body: { checked: "true" },
    });
    assert.equal(result.body.item.checked, false);
  });

  test("an unknown item id is a 404", async () => {
    assert.equal(
      (await callRoute(groceryRoutes, "PUT", `/lists/${listId}/items/item-nope`, { ...asAlice(), body: {} })).status,
      404
    );
    assert.equal(
      (await callRoute(groceryRoutes, "DELETE", `/lists/${listId}/items/item-nope`, asAlice())).status,
      404
    );
  });

  test("deleting an item leaves the rest of the list alone", async () => {
    const added = await callRoute(groceryRoutes, "POST", `/lists/${listId}/items`, {
      ...asAlice(),
      body: { name: "Doomed" },
    });
    const before = added.body.list.items.length;

    const result = await callRoute(
      groceryRoutes,
      "DELETE",
      `/lists/${listId}/items/${added.body.item.id}`,
      asAlice()
    );

    assert.equal(result.body.list.items.length, before - 1);
    assert.equal(result.body.list.items.some((i: any) => i.name === "Doomed"), false);
  });
});

// ---- Pantry ----------------------------------------------------------------

describe("pantry", () => {
  test("adds an item, trimming and defaulting", async () => {
    const result = await callRoute(pantryRoutes, "POST", "/", {
      ...asAlice(),
      body: { name: "  Rice  ", quantity: "  2 boxes  " },
    });

    assert.equal(result.body.item.name, "Rice");
    assert.equal(result.body.item.quantity, "2 boxes");
    assert.equal(result.body.item.scope, "joint");
    assert.equal(result.body.item.updatedBy, alice);
  });

  test("requires a name", async () => {
    for (const body of [{}, { name: "   " }, { name: 42 }]) {
      assert.equal((await callRoute(pantryRoutes, "POST", "/", { ...asAlice(), body })).status, 400);
    }
  });

  test("drops an expiration date that isn't YYYY-MM-DD", async () => {
    // Expiring-soon comparisons are string comparisons, so a free-text date
    // would silently corrupt them.
    const bad = await callRoute(pantryRoutes, "POST", "/", {
      ...asAlice(),
      body: { name: "Yogurt", expirationDate: "next Tuesday" },
    });
    assert.equal(bad.body.item.expirationDate, undefined);

    const good = await callRoute(pantryRoutes, "POST", "/", {
      ...asAlice(),
      body: { name: "Milk", expirationDate: "2026-10-01" },
    });
    assert.equal(good.body.item.expirationDate, "2026-10-01");
  });

  test("never lets a client set scope -- the pantry is always joint", async () => {
    // buildPantryItem is built field by field precisely so a stray
    // "scope":"personal" can't hide an item from the other member.
    const result = await callRoute(pantryRoutes, "POST", "/", {
      ...asAlice(),
      body: { name: "Shared Flour", scope: "personal" },
    });

    assert.equal(result.body.item.scope, "joint");
    const bobSees = await callRoute(pantryRoutes, "GET", "/", asBob());
    assert.ok(bobSees.body.items.some((i: any) => i.name === "Shared Flour"));
  });

  test("items come back sorted by name", async () => {
    const items = (await callRoute(pantryRoutes, "GET", "/", asAlice())).body.items.map((i: any) => i.name);
    assert.deepEqual(items, [...items].sort((a: string, b: string) => a.localeCompare(b)));
  });

  test('an explicit "" clears the expiration date, but omitting it leaves it alone', async () => {
    const created = await callRoute(pantryRoutes, "POST", "/", {
      ...asAlice(),
      body: { name: "Cheese", expirationDate: "2026-11-01" },
    });
    const id = created.body.item.id;

    const untouched = await callRoute(pantryRoutes, "PUT", `/${id}`, {
      ...asAlice(),
      body: { quantity: "1 block" },
    });
    assert.equal(untouched.body.item.expirationDate, "2026-11-01", "omitting the field must not clear it");

    const cleared = await callRoute(pantryRoutes, "PUT", `/${id}`, {
      ...asAlice(),
      body: { expirationDate: "" },
    });
    assert.equal(cleared.body.item.expirationDate, undefined);
  });

  test("PUT keeps the id and ignores a blank name", async () => {
    const created = await callRoute(pantryRoutes, "POST", "/", { ...asAlice(), body: { name: "Beans" } });
    const id = created.body.item.id;

    const result = await callRoute(pantryRoutes, "PUT", `/${id}`, { ...asAlice(), body: { name: "  " } });

    assert.equal(result.body.item.id, id);
    assert.equal(result.body.item.name, "Beans");
  });

  test("an unknown id is a 404 on both PUT and DELETE", async () => {
    assert.equal((await callRoute(pantryRoutes, "PUT", "/pantry-nope", { ...asAlice(), body: {} })).status, 404);
    assert.equal((await callRoute(pantryRoutes, "DELETE", "/pantry-nope", asAlice())).status, 404);
  });
});

// ---- Members ---------------------------------------------------------------

describe("members", () => {
  let memberId: string;

  test("creates a member with cleaned likes and dislikes", async () => {
    const result = await callRoute(memberRoutes, "POST", "/", {
      ...asAlice(),
      body: { name: "  Sam  ", likes: ["tacos", " tacos ", "TACOS", ""], dislikes: ["mushrooms"] },
    });

    assert.equal(result.body.member.name, "Sam");
    assert.deepEqual(result.body.member.likes, ["tacos"], "deduped case-insensitively, blanks dropped");
    assert.deepEqual(result.body.member.dislikes, ["mushrooms"]);
    memberId = result.body.member.id;
  });

  test("requires a name", async () => {
    for (const body of [{}, { name: "  " }, { name: null }]) {
      assert.equal((await callRoute(memberRoutes, "POST", "/", { ...asAlice(), body })).status, 400);
    }
  });

  test("non-array likes/dislikes become empty rather than throwing", async () => {
    const result = await callRoute(memberRoutes, "POST", "/", {
      ...asAlice(),
      body: { name: "Rae", likes: "tacos, pizza", dislikes: null },
    });

    assert.deepEqual(result.body.member.likes, []);
    assert.deepEqual(result.body.member.dislikes, []);
  });

  test("members are joint, so both accounts see the whole family", async () => {
    const bobSees = await callRoute(memberRoutes, "GET", "/", asBob());
    assert.ok(bobSees.body.members.some((m: any) => m.name === "Sam"));
  });

  test("renaming keeps the id, the createdAt, and the untouched lists", async () => {
    // Members.tsx's inline rename sends only `name`; dropping the dislikes on
    // such a request would quietly un-restrict someone's diet.
    const result = await callRoute(memberRoutes, "PUT", `/${memberId}`, {
      ...asAlice(),
      body: { name: "Samantha" },
    });

    assert.equal(result.body.member.id, memberId);
    assert.equal(result.body.member.name, "Samantha");
    assert.deepEqual(result.body.member.dislikes, ["mushrooms"], "dislikes must survive a rename");
    assert.deepEqual(result.body.member.likes, ["tacos"]);
  });

  test("an explicit empty array does clear a list", async () => {
    const result = await callRoute(memberRoutes, "PUT", `/${memberId}`, { ...asAlice(), body: { dislikes: [] } });
    assert.deepEqual(result.body.member.dislikes, []);
  });

  test("accepts a real palette color and rejects an unrecognized one", async () => {
    const good = await callRoute(memberRoutes, "PUT", `/${memberId}`, { ...asAlice(), body: { color: "rose" } });
    assert.equal(good.body.member.color, "rose");

    const bad = await callRoute(memberRoutes, "PUT", `/${memberId}`, { ...asAlice(), body: { color: "chartreuse" } });
    assert.equal(bad.body.member.color, undefined, "an unrecognized color is dropped, not stored");
  });

  test("a color survives an unrelated edit, the same way likes/dislikes do", async () => {
    await callRoute(memberRoutes, "PUT", `/${memberId}`, { ...asAlice(), body: { color: "blue" } });
    const result = await callRoute(memberRoutes, "PUT", `/${memberId}`, { ...asAlice(), body: { name: "Sam again" } });
    assert.equal(result.body.member.color, "blue");
  });

  test("accepts a real theme and rejects an unrecognized one", async () => {
    const good = await callRoute(memberRoutes, "PUT", `/${memberId}`, { ...asAlice(), body: { theme: "bold" } });
    assert.equal(good.body.member.theme, "bold");

    const bad = await callRoute(memberRoutes, "PUT", `/${memberId}`, { ...asAlice(), body: { theme: "sparkly" } });
    assert.equal(bad.body.member.theme, undefined, "an unrecognized theme is dropped, not stored");
  });

  test("a theme survives an unrelated edit, the same way color does", async () => {
    await callRoute(memberRoutes, "PUT", `/${memberId}`, { ...asAlice(), body: { theme: "gradient" } });
    const result = await callRoute(memberRoutes, "PUT", `/${memberId}`, { ...asAlice(), body: { name: "Sam once more" } });
    assert.equal(result.body.member.theme, "gradient");
  });

  // Stage 6.5 (PLAN.md): role drives Chores' Kid/Parent split. Same validate/
  // merge convention as color and theme above.
  test("accepts a real role and rejects an unrecognized one", async () => {
    const good = await callRoute(memberRoutes, "PUT", `/${memberId}`, { ...asAlice(), body: { role: "parent" } });
    assert.equal(good.body.member.role, "parent");

    const bad = await callRoute(memberRoutes, "PUT", `/${memberId}`, { ...asAlice(), body: { role: "grandparent" } });
    assert.equal(bad.body.member.role, undefined, "an unrecognized role is dropped, not stored");
  });

  test("a role survives an unrelated edit, the same way color/theme do", async () => {
    await callRoute(memberRoutes, "PUT", `/${memberId}`, { ...asAlice(), body: { role: "kid" } });
    const result = await callRoute(memberRoutes, "PUT", `/${memberId}`, { ...asAlice(), body: { name: "Sam yet again" } });
    assert.equal(result.body.member.role, "kid");
  });

  test("role can be created on POST too, not just set via PUT", async () => {
    const result = await callRoute(memberRoutes, "POST", "/", {
      ...asAlice(),
      body: { name: "Parent Pat", role: "parent" },
    });
    assert.equal(result.body.member.role, "parent");
  });

  test("isParentMember/memberRole: unset role counts as kid, not undefined", () => {
    assert.equal(memberRole({ role: undefined }), "kid");
    assert.equal(isParentMember({ role: undefined }), false);
    assert.equal(memberRole({ role: "parent" }), "parent");
    assert.equal(isParentMember({ role: "parent" }), true);
    assert.equal(isParentMember({ role: "kid" }), false);
  });

  test("listing is ordered oldest-first, so the roster is stable", async () => {
    const members = (await callRoute(memberRoutes, "GET", "/", asAlice())).body.members;
    const created = members.map((m: any) => m.createdAt);
    assert.deepEqual(created, [...created].sort());
  });

  test("deleting removes the member; an unknown id is a 404", async () => {
    assert.equal((await callRoute(memberRoutes, "DELETE", `/${memberId}`, asAlice())).status, 200);
    assert.equal((await callRoute(memberRoutes, "DELETE", `/${memberId}`, asAlice())).status, 404);
  });
});

// ---- Calendar --------------------------------------------------------------

describe("calendar: POST validation", () => {
  test("creates a family event", async () => {
    const result = await callRoute(calendarRoutes, "POST", "/", {
      ...asAlice(),
      body: { date: "2026-09-10", title: "  Taco night  " },
    });

    assert.equal(result.body.event.title, "Taco night");
    assert.equal(result.body.event.audience, "family", "family is the default");
    assert.equal(result.body.event.memberId, undefined);
    assert.equal(result.body.event.scope, "joint");
  });

  test("requires a YYYY-MM-DD date", async () => {
    for (const date of ["next tuesday", "2026-9-10", "09/10/2026", "", undefined, 20260910]) {
      const result = await callRoute(calendarRoutes, "POST", "/", {
        ...asAlice(),
        body: { date, title: "X" },
      });
      assert.equal(result.status, 400, `${String(date)} should be refused`);
    }
  });

  test("requires a title", async () => {
    for (const title of ["", "   ", undefined, 42]) {
      const result = await callRoute(calendarRoutes, "POST", "/", {
        ...asAlice(),
        body: { date: "2026-09-10", title },
      });
      assert.equal(result.status, 400, `${String(title)} should be refused`);
    }
  });

  test("an individual event must name the member it is for", async () => {
    const result = await callRoute(calendarRoutes, "POST", "/", {
      ...asAlice(),
      body: { date: "2026-09-10", title: "Sam eats late", audience: "individual" },
    });
    assert.equal(result.status, 400);
    assert.match(result.body.error, /memberId is required/);
  });

  test("only the three real meal slots are stored", async () => {
    const good = await callRoute(calendarRoutes, "POST", "/", {
      ...asAlice(),
      body: { date: "2026-09-10", title: "Lunch out", mealSlot: "lunch" },
    });
    assert.equal(good.body.event.mealSlot, "lunch");

    const bad = await callRoute(calendarRoutes, "POST", "/", {
      ...asAlice(),
      body: { date: "2026-09-10", title: "Brunch", mealSlot: "brunch" },
    });
    assert.equal(bad.body.event.mealSlot, undefined, "an unknown slot is dropped, not stored");
  });

  test("accepts a valid time/endTime and rejects a malformed one", async () => {
    const good = await callRoute(calendarRoutes, "POST", "/", {
      ...asAlice(),
      body: { date: "2026-09-10", title: "Practice", time: "18:00", endTime: "19:00" },
    });
    assert.equal(good.body.event.time, "18:00");
    assert.equal(good.body.event.endTime, "19:00");

    for (const time of ["6pm", "18:0", "25:00"]) {
      const result = await callRoute(calendarRoutes, "POST", "/", {
        ...asAlice(),
        body: { date: "2026-09-10", title: "X", time },
      });
      assert.equal(result.status, 400, `${time} should be refused`);
    }
  });

  test("rejects an endTime that is not after time", async () => {
    const result = await callRoute(calendarRoutes, "POST", "/", {
      ...asAlice(),
      body: { date: "2026-09-10", title: "Backwards", time: "19:00", endTime: "18:00" },
    });
    assert.equal(result.status, 400);
    assert.match(result.body.error, /endTime must be after time/);
  });

  test("accepts a valid weekly recurrence rule", async () => {
    const result = await callRoute(calendarRoutes, "POST", "/", {
      ...asAlice(),
      body: { date: "2026-09-07", title: "School", recurrence: { freq: "weekly", byDay: ["MO", "TU", "WE", "TH", "FR"] } },
    });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.event.recurrence, { freq: "weekly", byDay: ["MO", "TU", "WE", "TH", "FR"] });
    assert.equal(result.body.event.seriesId, result.body.event.id, "the master event's own id is its seriesId");
  });

  test("rejects a malformed recurrence rule", async () => {
    for (const recurrence of [{ freq: "monthly", byDay: ["MO"] }, { freq: "weekly", byDay: [] }, { freq: "weekly", byDay: ["Monday"] }]) {
      const result = await callRoute(calendarRoutes, "POST", "/", {
        ...asAlice(),
        body: { date: "2026-09-07", title: "X", recurrence },
      });
      assert.equal(result.status, 400, `${JSON.stringify(recurrence)} should be refused`);
    }
  });

  test("rejects a recurrence.until before the anchor date", async () => {
    const result = await callRoute(calendarRoutes, "POST", "/", {
      ...asAlice(),
      body: { date: "2026-09-07", title: "X", recurrence: { freq: "weekly", byDay: ["MO"], until: "2026-09-01" } },
    });
    assert.equal(result.status, 400);
    assert.match(result.body.error, /until cannot be before date/);
  });
});

describe("calendar: reading", () => {
  test("filters by an inclusive from/to range and sorts by date", async () => {
    const events = (
      await callRoute(calendarRoutes, "GET", "/", {
        ...asAlice(),
        query: { from: "2026-09-01", to: "2026-09-30" },
      })
    ).body.events;

    assert.ok(events.length > 0);
    assert.ok(events.every((e: any) => e.date >= "2026-09-01" && e.date <= "2026-09-30"));
    assert.deepEqual(
      events.map((e: any) => e.date),
      [...events.map((e: any) => e.date)].sort()
    );
  });

  test("an out-of-range window is empty, not an error", async () => {
    const events = (
      await callRoute(calendarRoutes, "GET", "/", { ...asAlice(), query: { from: "1999-01-01", to: "1999-12-31" } })
    ).body.events;
    assert.deepEqual(events, []);
  });

  test("an unknown id is a 404 on PUT and DELETE", async () => {
    assert.equal((await callRoute(calendarRoutes, "PUT", "/event-nope", { ...asAlice(), body: {} })).status, 404);
    assert.equal((await callRoute(calendarRoutes, "DELETE", "/event-nope", asAlice())).status, 404);
  });
});

describe("calendar: recurring series", () => {
  let seriesId: string;

  before(async () => {
    const created = await callRoute(calendarRoutes, "POST", "/", {
      ...asAlice(),
      body: {
        date: "2026-10-05", // a Monday
        title: "Standing practice",
        recurrence: { freq: "weekly", byDay: ["MO"] },
      },
    });
    seriesId = created.body.event.id;
  });

  test("GET expands one stored row into an occurrence per matching week in range", async () => {
    const events = (
      await callRoute(calendarRoutes, "GET", "/", { ...asAlice(), query: { from: "2026-10-05", to: "2026-10-26" } })
    ).body.events.filter((e: any) => e.seriesId === seriesId);

    assert.deepEqual(
      events.map((e: any) => e.date),
      ["2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26"]
    );
    assert.ok(events.every((e: any) => e.id === `${seriesId}::${e.date}`));
  });

  test("PUT against one occurrence's synthetic id edits the whole series", async () => {
    const occurrenceId = `${seriesId}::2026-10-12`;
    const result = await callRoute(calendarRoutes, "PUT", `/${occurrenceId}`, {
      ...asAlice(),
      body: { title: "Renamed practice" },
    });

    assert.equal(result.status, 200);
    assert.equal(result.body.event.id, seriesId, "the master row, not a phantom per-occurrence row");
    assert.equal(result.body.event.title, "Renamed practice");

    const events = (
      await callRoute(calendarRoutes, "GET", "/", { ...asAlice(), query: { from: "2026-10-05", to: "2026-10-26" } })
    ).body.events.filter((e: any) => e.seriesId === seriesId);
    assert.ok(events.every((e: any) => e.title === "Renamed practice"), "every occurrence reflects the edit");
  });

  test("DELETE against one occurrence's synthetic id removes the whole series", async () => {
    const occurrenceId = `${seriesId}::2026-10-19`;
    const result = await callRoute(calendarRoutes, "DELETE", `/${occurrenceId}`, asAlice());
    assert.equal(result.status, 200);

    const events = (
      await callRoute(calendarRoutes, "GET", "/", { ...asAlice(), query: { from: "2026-10-05", to: "2026-10-26" } })
    ).body.events.filter((e: any) => e.seriesId === seriesId);
    assert.deepEqual(events, [], "no occurrence remains -- deleting one occurrence deletes the series");
  });
});

describe("calendar: PUT must validate what POST validates", () => {
  let eventId: string;

  before(async () => {
    const created = await callRoute(calendarRoutes, "POST", "/", {
      ...asAlice(),
      body: { date: "2026-09-15", title: "Editable event" },
    });
    eventId = created.body.event.id;
  });

  test("PUT keeps the id and createdAt while updating the title", async () => {
    const result = await callRoute(calendarRoutes, "PUT", `/${eventId}`, {
      ...asAlice(),
      body: { title: "Renamed event" },
    });

    assert.equal(result.body.event.id, eventId);
    assert.equal(result.body.event.title, "Renamed event");
    assert.equal(result.body.event.date, "2026-09-15", "an omitted date leaves the existing one alone");
  });

  test("PUT rejects a date POST would have rejected", async () => {
    // POST enforces YYYY-MM-DD; PUT accepts any non-empty string. listEvents
    // filters and sorts by string comparison on `date`, so a free-text date
    // falls outside every from/to window -- the event vanishes from the
    // calendar while still sitting in the database.
    const result = await callRoute(calendarRoutes, "PUT", `/${eventId}`, {
      ...asAlice(),
      body: { date: "next tuesday" },
    });

    assert.equal(result.status, 400, "an invalid date must be refused on update, not just on create");
  });

  test("PUT to individual without a memberId is refused, not stored as \"undefined\"", async () => {
    // buildEvent does `String(fields.memberId)` whenever audience is
    // individual. POST guards that with a required-memberId check; PUT has no
    // such guard, so switching an event to individual with no member stores
    // the literal string "undefined" -- an id that matches no member, which
    // silently breaks the per-member meal and dislike logic that filters on it.
    const created = await callRoute(calendarRoutes, "POST", "/", {
      ...asAlice(),
      body: { date: "2026-09-16", title: "Becomes individual" },
    });

    const result = await callRoute(calendarRoutes, "PUT", `/${created.body.event.id}`, {
      ...asAlice(),
      body: { audience: "individual" },
    });

    assert.notEqual(result.body?.event?.memberId, "undefined", 'must never store the string "undefined"');
    assert.equal(result.status, 400, "should be refused the same way POST refuses it");
  });

  test("no event in the database has a malformed date", async () => {
    // The consequence check for the two gaps above: anything stored here
    // should still be readable by the range filter the UI uses.
    for (const event of getScopedItems("events", alice) as any[]) {
      assert.match(event.date, /^\d{4}-\d{2}-\d{2}$/, `event "${event.title}" has date "${event.date}"`);
    }
  });
});
