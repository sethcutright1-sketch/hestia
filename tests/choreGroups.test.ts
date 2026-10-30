// Multi-assignee chores ("chores assigned to more than one kid", each kid
// completing independently) -- see routes/chores.ts's Chore.groupId comment
// for the design: N ordinary single-assignee rows sharing a groupId, so
// completion/approval/points/recurrence all keep working unchanged per row.
// This file only tests the new surface (multi-create, group edit/delete,
// per-kid independence); occurrence/approval/points mechanics themselves are
// already covered by tests/choresRoutes.test.ts.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import { loadDb, cleanupDb } from "./helpers/testdb.ts";
import { callRoute } from "./helpers/router.ts";

const { createUser, putScopedItem } = await loadDb();
const { choreRoutes } = await import("../routes/chores.ts");

function makeMember(userId: string, id: string, name: string, role?: "parent" | "kid") {
  putScopedItem("household_members", userId, {
    id, scope: "joint", name, likes: [], dislikes: [], role,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
}

let alice: string;
const asAlice = () => ({ session: { userId: alice } });

before(() => {
  alice = createUser("alice-chore-groups", "not-a-real-hash", "Alice");
  makeMember(alice, "kid-a", "Kid A");
  makeMember(alice, "kid-b", "Kid B");
  makeMember(alice, "kid-c", "Kid C");
});

after(cleanupDb);

describe("chores: multi-assignee create", () => {
  test("memberIds with 2+ members creates one row per member sharing a groupId", async () => {
    const result = await callRoute(choreRoutes, "POST", "/", {
      ...asAlice(),
      body: { date: "2027-06-01", title: "Clean the garage", memberIds: ["kid-a", "kid-b"] },
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.chores.length, 2);
    const [a, b] = result.body.chores;
    assert.ok(a.groupId, "each copy has a groupId");
    assert.equal(a.groupId, b.groupId, "copies share the same groupId");
    assert.notEqual(a.id, b.id, "copies have distinct ids");
    assert.deepEqual(new Set([a.memberId, b.memberId]), new Set(["kid-a", "kid-b"]));
    assert.equal(result.body.chore.id, a.id, "chore is the first of the created copies");
  });

  test("dedupes repeated ids in memberIds", async () => {
    const result = await callRoute(choreRoutes, "POST", "/", {
      ...asAlice(),
      body: { date: "2027-06-02", title: "Rake leaves", memberIds: ["kid-a", "kid-b", "kid-a"] },
    });
    assert.equal(result.body.chores.length, 2);
  });

  test("memberIds with a single id behaves exactly like memberId", async () => {
    const viaMemberIds = await callRoute(choreRoutes, "POST", "/", {
      ...asAlice(),
      body: { date: "2027-06-03", title: "Single via memberIds", memberIds: ["kid-a"] },
    });
    assert.equal(viaMemberIds.body.chore.memberId, "kid-a");
    assert.equal(viaMemberIds.body.chore.groupId, undefined, "a lone member is an ungrouped chore");
  });

  test("plain memberId create is unchanged", async () => {
    const result = await callRoute(choreRoutes, "POST", "/", {
      ...asAlice(),
      body: { date: "2027-06-04", title: "Plain single chore", memberId: "kid-a" },
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.chore.memberId, "kid-a");
    assert.equal(result.body.chore.groupId, undefined);
    assert.equal(result.body.chores, undefined, "single memberId response shape unchanged, no chores array");
  });

  test("an invalid member id in memberIds is a 400", async () => {
    const result = await callRoute(choreRoutes, "POST", "/", {
      ...asAlice(),
      body: { date: "2027-06-05", title: "Bad member", memberIds: ["kid-a", "not-a-real-member"] },
    });
    assert.equal(result.status, 400);
  });

  test("an invalid single member id (via memberIds) is also a 400", async () => {
    const result = await callRoute(choreRoutes, "POST", "/", {
      ...asAlice(),
      body: { date: "2027-06-05", title: "Bad member", memberIds: ["not-a-real-member"] },
    });
    assert.equal(result.status, 400);
  });
});

describe("chores: independent per-kid completion", () => {
  test("kid A marking a one-off group chore done doesn't affect kid B's copy", async () => {
    const created = await callRoute(choreRoutes, "POST", "/", {
      ...asAlice(),
      body: { date: "2027-06-10", title: "Vacuum living room", memberIds: ["kid-a", "kid-b"] },
    });
    const [choreA, choreB] = created.body.chores;

    const done = await callRoute(choreRoutes, "PUT", `/${choreA.id}`, { ...asAlice(), body: { status: "done" } });
    assert.equal(done.body.chore.status, "done");

    const list = (await callRoute(choreRoutes, "GET", "/", {
      ...asAlice(), query: { from: "2027-06-10", to: "2027-06-10" },
    })).body.chores;
    const rowA = list.find((c: any) => c.id === choreA.id);
    const rowB = list.find((c: any) => c.id === choreB.id);
    assert.equal(rowA.status, "done");
    assert.equal(rowB.status, "pending", "kid B's copy is untouched");
  });

  test("recurring group chore: each kid's occurrence status is independent", async () => {
    const created = await callRoute(choreRoutes, "POST", "/", {
      ...asAlice(),
      body: {
        date: "2027-06-07", title: "Feed the dog", memberIds: ["kid-a", "kid-b"],
        recurrence: { freq: "weekly", byDay: ["MO"] }, // 2027-06-07 is a Monday
      },
    });
    const [choreA, choreB] = created.body.chores;
    const occA = `${choreA.id}::2027-06-07`;

    await callRoute(choreRoutes, "PUT", `/${occA}`, { ...asAlice(), body: { status: "done" } });

    const list = (await callRoute(choreRoutes, "GET", "/", {
      ...asAlice(), query: { from: "2027-06-07", to: "2027-06-07" },
    })).body.chores;
    const rowA = list.find((c: any) => c.seriesId === choreA.id);
    const rowB = list.find((c: any) => c.seriesId === choreB.id);
    assert.equal(rowA.status, "done");
    assert.equal(rowB.status, "pending", "kid B's occurrence is untouched");
  });

  test("approval and points are per-kid, not shared across the group", async () => {
    const created = await callRoute(choreRoutes, "POST", "/", {
      ...asAlice(),
      body: { date: "2027-06-11", title: "Wash dishes", memberIds: ["kid-a", "kid-b"], points: 4 },
    });
    const [choreA, choreB] = created.body.chores;

    await callRoute(choreRoutes, "PUT", `/${choreA.id}`, { ...asAlice(), body: { status: "done" } });
    const approved = await callRoute(choreRoutes, "POST", `/${choreA.id}/approve`, asAlice());
    assert.equal(approved.body.chore.approval, "approved");

    const list = (await callRoute(choreRoutes, "GET", "/", {
      ...asAlice(), query: { from: "2027-06-11", to: "2027-06-11" },
    })).body.chores;
    const rowB = list.find((c: any) => c.id === choreB.id);
    assert.equal(rowB.approval, "none", "kid B hasn't done it yet, so nothing to approve");
    assert.equal(rowB.status, "pending");
  });
});

describe("chores: group edit", () => {
  test("editing title/points updates every copy in the group", async () => {
    const created = await callRoute(choreRoutes, "POST", "/", {
      ...asAlice(),
      body: { date: "2027-06-15", title: "Old title", memberIds: ["kid-a", "kid-b"], points: 2 },
    });
    const groupId = created.body.chore.groupId;

    const edited = await callRoute(choreRoutes, "PUT", `/group/${groupId}`, {
      ...asAlice(),
      body: { title: "New title", points: 6, memberIds: ["kid-a", "kid-b"] },
    });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.chores.length, 2);
    for (const c of edited.body.chores) {
      assert.equal(c.title, "New title");
      assert.equal(c.points, 6);
    }
  });

  test("editing memberIds adds a new member's copy and removes a dropped member's copy", async () => {
    const created = await callRoute(choreRoutes, "POST", "/", {
      ...asAlice(),
      body: { date: "2027-06-16", title: "Set the table", memberIds: ["kid-a", "kid-b"] },
    });
    const groupId = created.body.chore.groupId;
    const choreAId = created.body.chores.find((c: any) => c.memberId === "kid-a").id;

    // Mark kid A's copy done+approved first, to prove keeping a member
    // preserves their history.
    await callRoute(choreRoutes, "PUT", `/${choreAId}`, { ...asAlice(), body: { status: "done" } });
    await callRoute(choreRoutes, "POST", `/${choreAId}/approve`, asAlice());

    const edited = await callRoute(choreRoutes, "PUT", `/group/${groupId}`, {
      ...asAlice(),
      body: { memberIds: ["kid-a", "kid-c"] }, // drop kid-b, add kid-c
    });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.chores.length, 2);
    const members = edited.body.chores.map((c: any) => c.memberId).sort();
    assert.deepEqual(members, ["kid-a", "kid-c"]);

    const keptA = edited.body.chores.find((c: any) => c.memberId === "kid-a");
    assert.equal(keptA.id, choreAId, "kid A's copy (and its history) is preserved, not recreated");
    assert.equal(keptA.status, "done", "kid A's completion survives the edit");

    const newC = edited.body.chores.find((c: any) => c.memberId === "kid-c");
    assert.equal(newC.status, "pending", "kid C's new copy starts fresh");

    // kid B's copy is gone from the group's series list.
    const series = (await callRoute(choreRoutes, "GET", "/series", asAlice())).body.chores;
    assert.equal(series.find((c: any) => c.groupId === groupId && c.memberId === "kid-b"), undefined);
  });

  test("editing memberIds down to empty is a 400", async () => {
    const created = await callRoute(choreRoutes, "POST", "/", {
      ...asAlice(),
      body: { date: "2027-06-17", title: "Empty group edit", memberIds: ["kid-a", "kid-b"] },
    });
    const groupId = created.body.chore.groupId;

    const result = await callRoute(choreRoutes, "PUT", `/group/${groupId}`, {
      ...asAlice(),
      body: { memberIds: [] },
    });
    assert.equal(result.status, 400);
  });

  test("editing an ungrouped (single-member) chore's group route with 2+ memberIds grows it into a group", async () => {
    const created = await callRoute(choreRoutes, "POST", "/", {
      ...asAlice(),
      body: { date: "2027-06-18", title: "Was solo", memberId: "kid-a" },
    });
    assert.equal(created.body.chore.groupId, undefined);
    const groupKey = created.body.chore.id; // ungrouped: own id is the group key

    const edited = await callRoute(choreRoutes, "PUT", `/group/${groupKey}`, {
      ...asAlice(),
      body: { memberIds: ["kid-a", "kid-b"] },
    });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.chores.length, 2);
    assert.ok(edited.body.chores[0].groupId, "now a real group");
    const keptA = edited.body.chores.find((c: any) => c.memberId === "kid-a");
    assert.equal(keptA.id, created.body.chore.id, "the original row is reused, not recreated");
  });

  test("invalid member id in group edit is a 400", async () => {
    const created = await callRoute(choreRoutes, "POST", "/", {
      ...asAlice(),
      body: { date: "2027-06-19", title: "Group for bad edit", memberIds: ["kid-a", "kid-b"] },
    });
    const groupId = created.body.chore.groupId;

    const result = await callRoute(choreRoutes, "PUT", `/group/${groupId}`, {
      ...asAlice(),
      body: { memberIds: ["kid-a", "nope"] },
    });
    assert.equal(result.status, 400);
  });

  test("group edit 404s for an unknown group", async () => {
    const result = await callRoute(choreRoutes, "PUT", "/group/not-a-real-group", {
      ...asAlice(),
      body: { memberIds: ["kid-a"] },
    });
    assert.equal(result.status, 404);
  });

  test("status is not editable through the group route", async () => {
    const created = await callRoute(choreRoutes, "POST", "/", {
      ...asAlice(),
      body: { date: "2027-06-20", title: "No status via group", memberIds: ["kid-a", "kid-b"] },
    });
    const groupId = created.body.chore.groupId;

    const edited = await callRoute(choreRoutes, "PUT", `/group/${groupId}`, {
      ...asAlice(),
      body: { memberIds: ["kid-a", "kid-b"], status: "done" },
    });
    assert.equal(edited.status, 200);
    for (const c of edited.body.chores) {
      assert.equal(c.status, "pending", "status field is ignored by the group route");
    }
  });
});

describe("chores: group delete", () => {
  test("deletes every copy in the group", async () => {
    const created = await callRoute(choreRoutes, "POST", "/", {
      ...asAlice(),
      body: { date: "2027-06-25", title: "Delete me", memberIds: ["kid-a", "kid-b"] },
    });
    const groupId = created.body.chore.groupId;

    const deleted = await callRoute(choreRoutes, "DELETE", `/group/${groupId}`, asAlice());
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.deletedCount, 2);

    const series = (await callRoute(choreRoutes, "GET", "/series", asAlice())).body.chores;
    assert.equal(series.some((c: any) => c.groupId === groupId), false);
  });

  test("group delete 404s for an unknown group", async () => {
    const result = await callRoute(choreRoutes, "DELETE", "/group/not-a-real-group", asAlice());
    assert.equal(result.status, 404);
  });
});

describe("chores: switching between Whole family and members", () => {
  test("group-editing a family chore into 2 kids leaves no orphaned family row", async () => {
    const created = await callRoute(choreRoutes, "POST", "/", {
      ...asAlice(),
      body: { date: "2027-06-26", title: "Family to kids" },
    });
    const familyId = created.body.chore.id;
    assert.equal(created.body.chore.memberId, undefined);

    const edited = await callRoute(choreRoutes, "PUT", `/group/${familyId}`, {
      ...asAlice(),
      body: { memberIds: ["kid-a", "kid-b"] },
    });
    assert.equal(edited.status, 200);

    const series = (await callRoute(choreRoutes, "GET", "/series", asAlice())).body.chores
      .filter((c: any) => c.title === "Family to kids");
    assert.equal(series.length, 2, "exactly the two kid copies, no leftover family row");
    assert.ok(series.every((c: any) => c.memberId), "every remaining row has an assignee");
  });

  test('PUT /:id with memberId "" turns a kid chore into a family chore', async () => {
    const created = await callRoute(choreRoutes, "POST", "/", {
      ...asAlice(),
      body: { date: "2027-06-27", title: "Kid to family", memberIds: ["kid-a"] },
    });
    const edited = await callRoute(choreRoutes, "PUT", `/${created.body.chore.id}`, {
      ...asAlice(),
      body: { memberId: "" },
    });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.chore.memberId, undefined);
  });
});
