// Bug fix (owner: "if it's a one-off chore and gets removed the kid loses the
// stars for it"): deleting a chore, a chore group, or one member's copy out
// of a group must never take back stars already approved. See
// routes/chores.ts's deleteChoreRow (the one shared deletion path every
// route/tool goes through) and db.ts's earned_points table.
//
// Deliberately its own file rather than folded into choresRoutes.test.ts or
// choreGroups.test.ts -- this is a cross-cutting concern (delete + points)
// that both of those files otherwise treat as separate topics.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import { loadDb, cleanupDb } from "./helpers/testdb.ts";
import { callRoute } from "./helpers/router.ts";

const { createUser, putScopedItem } = await loadDb();
const { choreRoutes, pointsByMember, FAMILY_POINTS_BUCKET } = await import("../routes/chores.ts");
const { rewardRoutes } = await import("../routes/rewards.ts");

function makeMember(userId: string, id: string, name: string, role?: "parent" | "kid") {
  putScopedItem("household_members", userId, {
    id, scope: "joint", name, likes: [], dislikes: [], role,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
}

let alice: string;
const asAlice = () => ({ session: { userId: alice } });

async function balanceFor(memberId: string): Promise<number> {
  const result = await callRoute(rewardRoutes, "GET", "/balances", asAlice());
  return result.body.balances[memberId]?.balance ?? 0;
}

before(() => {
  alice = createUser("alice-earned-points", "not-a-real-hash", "Alice");
  // A distinct kid per test (rather than sharing one "kid-x"/"kid-y" pair)
  // so each test's absolute balance/points assertions can't be thrown off by
  // an earlier test's archived earned_points records for the same member --
  // pointsByMember(userId) with no/wide range, and balancesByMember, are
  // both genuinely all-time/all-member, by design (see the "no range" test
  // in choresRoutes.test.ts).
  for (const id of ["kid-oneoff", "kid-recur", "kid-waiting", "kid-group-a", "kid-group-b", "kid-group-c", "kid-points-edit", "kid-reject"]) {
    makeMember(alice, id, id);
  }
});

after(cleanupDb);

describe("earned points survive chore deletion", () => {
  test("deleting an approved one-off chore leaves the kid's balance unchanged", async () => {
    const created = await callRoute(choreRoutes, "POST", "/", {
      ...asAlice(),
      body: { date: "2027-07-01", title: "Mow the lawn", memberId: "kid-oneoff", points: 5 },
    });
    await callRoute(choreRoutes, "PUT", `/${created.body.chore.id}`, { ...asAlice(), body: { status: "done" } });
    await callRoute(choreRoutes, "POST", `/${created.body.chore.id}/approve`, asAlice());
    assert.equal(await balanceFor("kid-oneoff"), 5);

    const deleted = await callRoute(choreRoutes, "DELETE", `/${created.body.chore.id}`, asAlice());
    assert.equal(deleted.status, 200);

    assert.equal(await balanceFor("kid-oneoff"), 5, "stars survive the chore being deleted");
    const points = pointsByMember(alice);
    assert.equal(points["kid-oneoff"]?.earned, 5);
  });

  test("deleting a recurring chore keeps exactly the approved occurrences, drops the waiting one", async () => {
    const created = await callRoute(choreRoutes, "POST", "/", {
      ...asAlice(),
      body: {
        date: "2027-07-05", title: "Feed the fish", memberId: "kid-recur", points: 2,
        recurrence: { freq: "weekly", byDay: ["MO"] }, // 2027-07-05 is a Monday
      },
    });
    const seriesId = created.body.chore.id;
    const mon1 = `${seriesId}::2027-07-05`;
    const mon2 = `${seriesId}::2027-07-12`;
    const mon3 = `${seriesId}::2027-07-19`;

    await callRoute(choreRoutes, "PUT", `/${mon1}`, { ...asAlice(), body: { status: "done" } });
    await callRoute(choreRoutes, "POST", `/${mon1}/approve`, asAlice());
    await callRoute(choreRoutes, "PUT", `/${mon2}`, { ...asAlice(), body: { status: "done" } });
    await callRoute(choreRoutes, "POST", `/${mon2}/approve`, asAlice());
    await callRoute(choreRoutes, "PUT", `/${mon3}`, { ...asAlice(), body: { status: "done" } }); // left waiting, never approved

    const before_ = pointsByMember(alice, "2027-07-01", "2027-07-31");
    assert.deepEqual(before_["kid-recur"], { earned: 4, completedCount: 2, waitingCount: 1 });

    const deleted = await callRoute(choreRoutes, "DELETE", `/${seriesId}`, asAlice());
    assert.equal(deleted.status, 200);

    const after_ = pointsByMember(alice, "2027-07-01", "2027-07-31");
    assert.deepEqual(
      after_["kid-recur"],
      { earned: 4, completedCount: 2, waitingCount: 0 },
      "the 2 approved occurrences are archived, the still-waiting one earned nothing and is simply gone"
    );
  });

  test("deleting a not-yet-approved (waiting) one-off chore earns nothing", async () => {
    const created = await callRoute(choreRoutes, "POST", "/", {
      ...asAlice(),
      body: { date: "2027-07-06", title: "Never approved", memberId: "kid-waiting", points: 9 },
    });
    await callRoute(choreRoutes, "PUT", `/${created.body.chore.id}`, { ...asAlice(), body: { status: "done" } });
    // No approve call -- still "waiting".

    const balanceBefore = await balanceFor("kid-waiting");
    assert.equal(balanceBefore, 0);
    const deleted = await callRoute(choreRoutes, "DELETE", `/${created.body.chore.id}`, asAlice());
    assert.equal(deleted.status, 200);
    assert.equal(await balanceFor("kid-waiting"), 0, "an unapproved completion never earned anything");
  });

  test("deleting a chore group keeps each kid's already-approved stars", async () => {
    const created = await callRoute(choreRoutes, "POST", "/", {
      ...asAlice(),
      body: { date: "2027-07-08", title: "Clean the garage", memberIds: ["kid-group-a", "kid-group-b"], points: 3 },
    });
    const [choreA, choreB] = created.body.chores;
    const groupId = choreA.groupId;

    // Kid A finishes and gets approved; kid B never touches it.
    await callRoute(choreRoutes, "PUT", `/${choreA.id}`, { ...asAlice(), body: { status: "done" } });
    await callRoute(choreRoutes, "POST", `/${choreA.id}/approve`, asAlice());
    assert.equal(await balanceFor("kid-group-a"), 3);

    const deleted = await callRoute(choreRoutes, "DELETE", `/group/${groupId}`, asAlice());
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.deletedCount, 2);

    assert.equal(await balanceFor("kid-group-a"), 3, "kid A's approved stars survive the group delete");
    assert.equal(await balanceFor("kid-group-b"), 0, "kid B never earned anything, still zero");
  });

  test("removing a kid from a group via PUT /group keeps that kid's already-approved stars", async () => {
    const created = await callRoute(choreRoutes, "POST", "/", {
      ...asAlice(),
      body: { date: "2027-07-09", title: "Rake leaves", memberIds: ["kid-group-c", "kid-group-b"], points: 6 },
    });
    const choreC = created.body.chores.find((c: any) => c.memberId === "kid-group-c");
    const groupId = choreC.groupId;

    await callRoute(choreRoutes, "PUT", `/${choreC.id}`, { ...asAlice(), body: { status: "done" } });
    await callRoute(choreRoutes, "POST", `/${choreC.id}/approve`, asAlice());
    assert.equal(await balanceFor("kid-group-c"), 6);

    // Drop kid-group-c out of the group, keeping only kid-group-b.
    const edited = await callRoute(choreRoutes, "PUT", `/group/${groupId}`, {
      ...asAlice(),
      body: { memberIds: ["kid-group-b"] },
    });
    assert.equal(edited.status, 200);

    assert.equal(await balanceFor("kid-group-c"), 6, "kid C's stars survive being dropped from the group");
  });

  test("changing a chore's points after approval doesn't change the earned total, but new approvals use the new value", async () => {
    const created = await callRoute(choreRoutes, "POST", "/", {
      ...asAlice(),
      body: { date: "2027-07-10", title: "Vacuum", memberId: "kid-points-edit", points: 2 },
    });
    await callRoute(choreRoutes, "PUT", `/${created.body.chore.id}`, { ...asAlice(), body: { status: "done" } });
    await callRoute(choreRoutes, "POST", `/${created.body.chore.id}/approve`, asAlice());

    let points = pointsByMember(alice, "2027-07-10", "2027-07-10");
    assert.equal(points["kid-points-edit"].earned, 2, "approved at 2 points");

    // Parent bumps the chore's points afterward.
    const editedChore = await callRoute(choreRoutes, "PUT", `/${created.body.chore.id}`, {
      ...asAlice(),
      body: { points: 8 },
    });
    assert.equal(editedChore.body.chore.points, 8);

    points = pointsByMember(alice, "2027-07-10", "2027-07-10");
    assert.equal(points["kid-points-edit"].earned, 2, "already-approved stars are unaffected by the later points edit");

    // A fresh chore (or a reopen+reapprove) uses the new value going forward.
    const created2 = await callRoute(choreRoutes, "POST", "/", {
      ...asAlice(),
      body: { date: "2027-07-11", title: "Vacuum again", memberId: "kid-points-edit", points: 8 },
    });
    await callRoute(choreRoutes, "PUT", `/${created2.body.chore.id}`, { ...asAlice(), body: { status: "done" } });
    await callRoute(choreRoutes, "POST", `/${created2.body.chore.id}/approve`, asAlice());
    points = pointsByMember(alice, "2027-07-11", "2027-07-11");
    assert.equal(points["kid-points-edit"].earned, 8, "new approvals use the chore's current points value");
  });

  test("rejecting ('Not done') still removes stars while the chore exists", async () => {
    const created = await callRoute(choreRoutes, "POST", "/", {
      ...asAlice(),
      body: { date: "2027-07-12", title: "Take out recycling", memberId: "kid-reject", points: 3 },
    });
    await callRoute(choreRoutes, "PUT", `/${created.body.chore.id}`, { ...asAlice(), body: { status: "done" } });
    await callRoute(choreRoutes, "POST", `/${created.body.chore.id}/approve`, asAlice());
    assert.equal(pointsByMember(alice, "2027-07-12", "2027-07-12")["kid-reject"].earned, 3);

    const rejected = await callRoute(choreRoutes, "POST", `/${created.body.chore.id}/reject`, asAlice());
    assert.equal(rejected.status, 200);
    assert.equal(rejected.body.chore.approval, "none");

    const points = pointsByMember(alice, "2027-07-12", "2027-07-12");
    assert.equal(points["kid-reject"], undefined, "rejecting an approved chore that still exists removes its stars, unchanged behavior");
  });

  test("deleted unassigned chore's approved stars still credit the family bucket", async () => {
    const created = await callRoute(choreRoutes, "POST", "/", {
      ...asAlice(),
      body: { date: "2027-07-13", title: "Family chore", points: 4 },
    });
    await callRoute(choreRoutes, "PUT", `/${created.body.chore.id}`, { ...asAlice(), body: { status: "done" } });
    await callRoute(choreRoutes, "POST", `/${created.body.chore.id}/approve`, asAlice());

    await callRoute(choreRoutes, "DELETE", `/${created.body.chore.id}`, asAlice());

    const points = pointsByMember(alice, "2027-07-13", "2027-07-13");
    assert.equal(points[FAMILY_POINTS_BUCKET]?.earned, 4, "family bucket credit survives the delete too");
  });
});
