// The household PIN lock (auth.ts / routes/lock.ts) applied to Chores and
// Rewards -- the owner's decision to replace the old Kid/Parent sub-tabs (no real
// protection, just a UI convenience) with one tab and a PIN-gated Manage
// area, using the SAME PIN as Budget. Parents tick their own chores with no
// PIN (same as kids) -- only managing the catalog (add/edit/delete/approve)
// and rewards/points is gated. See routes/chores.ts's passesUnlockCheck and
// the requireUnlocked calls in routes/chores.ts / routes/rewards.ts for what
// this exercises.
//
// Mirrors tests/lockRoutes.test.ts's setPin/freshSession pattern.

import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";

import { loadDb, cleanupDb } from "./helpers/testdb.ts";
import { callRoute, type FakeSession } from "./helpers/router.ts";

const { createUser, putScopedItem, setConfig } = await loadDb();
const { choreRoutes } = await import("../routes/chores.ts");
const { rewardRoutes } = await import("../routes/rewards.ts");
const { buildTools } = await import("../assistant/registry.ts");

const PIN = "1234";
let alice: string;
let kidId: string;
let parentMemberId: string;
let sessionCounter = 0;

function freshSession(overrides: FakeSession = {}): { session: FakeSession; sessionID: string } {
  return { session: { userId: alice, ...overrides }, sessionID: `chore-lock-session-${sessionCounter++}` };
}

/** unlockedUntil far in the future = unlocked; omit for locked. */
function unlockedSession() {
  return freshSession({ unlockedUntil: Date.now() + 60_000 });
}

async function setPin(pin: string | null) {
  setConfig("lock_pin_hash", pin === null ? null : await bcrypt.hash(pin, 4));
}

function member(id: string, name: string, role?: "parent" | "kid") {
  putScopedItem("household_members", alice, {
    id, scope: "joint", name, role, likes: [], dislikes: [],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
}

before(() => {
  alice = createUser("alice-chore-lock", "not-a-real-hash", "Alice");
  kidId = "member-kid";
  parentMemberId = "member-parent";
  member(kidId, "Kiddo", "kid");
  member(parentMemberId, "Mom", "parent");
});

after(cleanupDb);

async function addChore(session: ReturnType<typeof unlockedSession>, overrides: Record<string, any> = {}) {
  return callRoute(choreRoutes, "POST", "/", {
    ...session,
    body: { title: "Test chore", date: "2026-09-28", ...overrides },
  });
}

describe("with a PIN set and the session locked", () => {
  beforeEach(async () => {
    await setPin(PIN);
  });

  test("a kid ticking their own chore succeeds with no PIN", async () => {
    const created = await addChore(unlockedSession(), { memberId: kidId });
    assert.equal(created.status, 200);

    const locked = freshSession();
    const result = await callRoute(choreRoutes, "PUT", `/${created.body.chore.id}`, {
      ...locked,
      body: { status: "done" },
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.chore.status, "done");
  });

  test("an unassigned/family chore also ticks with no PIN", async () => {
    const created = await addChore(unlockedSession());
    const locked = freshSession();
    const result = await callRoute(choreRoutes, "PUT", `/${created.body.chore.id}`, {
      ...locked,
      body: { status: "done" },
    });
    assert.equal(result.status, 200);
  });

  test("ticking a parent-assigned chore also succeeds with no PIN", async () => {
    // the owner's call: parents tick their own chores from the Chores tab with no
    // PIN, same as a kid -- only managing (add/edit/delete/approve) is
    // locked. See routes/chores.ts's PUT /:id status-only branch.
    const created = await addChore(unlockedSession(), { memberId: parentMemberId });
    const locked = freshSession();
    const result = await callRoute(choreRoutes, "PUT", `/${created.body.chore.id}`, {
      ...locked,
      body: { status: "done" },
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.chore.status, "done");
  });

  test("create is locked", async () => {
    const result = await addChore(freshSession());
    assert.equal(result.status, 423);
  });

  test("a non-status edit (retitling a kid's own chore) is locked", async () => {
    const created = await addChore(unlockedSession(), { memberId: kidId });
    const locked = freshSession();
    const result = await callRoute(choreRoutes, "PUT", `/${created.body.chore.id}`, {
      ...locked,
      body: { title: "New title" },
    });
    assert.equal(result.status, 423);
  });

  test("delete is locked", async () => {
    const created = await addChore(unlockedSession());
    const locked = freshSession();
    const result = await callRoute(choreRoutes, "DELETE", `/${created.body.chore.id}`, locked);
    assert.equal(result.status, 423);
  });

  test("group PUT/DELETE are locked", async () => {
    const created = await callRoute(choreRoutes, "POST", "/", {
      ...unlockedSession(),
      body: { title: "Group chore", date: "2026-09-28", memberIds: [kidId, parentMemberId] },
    });
    assert.equal(created.status, 200);
    const groupKey = created.body.chore.groupId;

    const locked = freshSession();
    const putResult = await callRoute(choreRoutes, "PUT", `/group/${groupKey}`, {
      ...locked,
      body: { title: "Renamed", memberIds: [kidId, parentMemberId] },
    });
    assert.equal(putResult.status, 423);

    const delResult = await callRoute(choreRoutes, "DELETE", `/group/${groupKey}`, locked);
    assert.equal(delResult.status, 423);
  });

  test("approve and reject are locked", async () => {
    const created = await addChore(unlockedSession(), { memberId: kidId });
    const doneSession = unlockedSession();
    await callRoute(choreRoutes, "PUT", `/${created.body.chore.id}`, { ...doneSession, body: { status: "done" } });

    const locked = freshSession();
    const approveResult = await callRoute(choreRoutes, "POST", `/${created.body.chore.id}/approve`, locked);
    assert.equal(approveResult.status, 423);
    const rejectResult = await callRoute(choreRoutes, "POST", `/${created.body.chore.id}/reject`, locked);
    assert.equal(rejectResult.status, 423);
  });

  test("reward creation and a point adjustment are locked", async () => {
    const locked = freshSession();
    const rewardResult = await callRoute(rewardRoutes, "POST", "/", { ...locked, body: { title: "Ice cream", cost: 5 } });
    assert.equal(rewardResult.status, 423);

    const adjustResult = await callRoute(rewardRoutes, "POST", "/adjustments", {
      ...locked,
      body: { memberId: kidId, amount: 5, note: "test" },
    });
    assert.equal(adjustResult.status, 423);
  });

  test("redeeming a reward stays open", async () => {
    // Give the kid enough points to afford it, via an unlocked adjustment,
    // then redeem it on a LOCKED session -- redeeming is a kid action.
    const reward = await callRoute(rewardRoutes, "POST", "/", { ...unlockedSession(), body: { title: "Movie night", cost: 3 } });
    assert.equal(reward.status, 200);
    await callRoute(rewardRoutes, "POST", "/adjustments", {
      ...unlockedSession(),
      body: { memberId: kidId, amount: 10, note: "seed" },
    });

    const locked = freshSession();
    const redeemResult = await callRoute(rewardRoutes, "POST", `/${reward.body.reward.id}/redeem`, {
      ...locked,
      body: { memberId: kidId },
    });
    assert.equal(redeemResult.status, 200);
  });
});

describe("with a PIN set and the session unlocked", () => {
  beforeEach(async () => {
    await setPin(PIN);
  });

  test("create, edit, delete, approve/reject, group ops, reward create, and adjustments all succeed", async () => {
    const session = unlockedSession();

    const created = await addChore(session, { memberId: kidId });
    assert.equal(created.status, 200);

    const edited = await callRoute(choreRoutes, "PUT", `/${created.body.chore.id}`, {
      ...session,
      body: { title: "Edited title" },
    });
    assert.equal(edited.status, 200);

    const done = await callRoute(choreRoutes, "PUT", `/${created.body.chore.id}`, { ...session, body: { status: "done" } });
    assert.equal(done.status, 200);

    const approved = await callRoute(choreRoutes, "POST", `/${created.body.chore.id}/approve`, session);
    assert.equal(approved.status, 200);

    const rejected = await callRoute(choreRoutes, "POST", `/${created.body.chore.id}/reject`, session);
    assert.equal(rejected.status, 200);

    const deleted = await callRoute(choreRoutes, "DELETE", `/${created.body.chore.id}`, session);
    assert.equal(deleted.status, 200);

    const reward = await callRoute(rewardRoutes, "POST", "/", { ...session, body: { title: "Book", cost: 4 } });
    assert.equal(reward.status, 200);

    const adjustment = await callRoute(rewardRoutes, "POST", "/adjustments", {
      ...session,
      body: { memberId: kidId, amount: 2, note: "" },
    });
    assert.equal(adjustment.status, 200);
  });
});

describe("with no PIN configured", () => {
  beforeEach(async () => {
    await setPin(null);
  });

  test("everything succeeds even on a session with no unlockedUntil", async () => {
    const session = freshSession();

    const created = await addChore(session, { memberId: parentMemberId });
    assert.equal(created.status, 200);

    const done = await callRoute(choreRoutes, "PUT", `/${created.body.chore.id}`, { ...session, body: { status: "done" } });
    assert.equal(done.status, 200);

    const reward = await callRoute(rewardRoutes, "POST", "/", { ...session, body: { title: "Candy", cost: 1 } });
    assert.equal(reward.status, 200);
  });
});

describe("assistant tool gating (complete_chore stays open)", () => {
  beforeEach(async () => {
    await setPin(PIN);
  });

  test("complete_chore completes a parent-assigned chore even when locked", async () => {
    const created = await addChore(unlockedSession(), { title: "Parent assistant chore", memberId: parentMemberId, date: "2026-10-02" });
    assert.equal(created.status, 200);

    const t = buildTools(alice, false).find((x) => x.name === "complete_chore");
    assert.ok(t);
    const result = await (t as any).run({ title: "Parent assistant chore", date: "2026-10-02" });
    assert.equal(result.status, "done");
  });
});

describe("assistant tool gating (create_chore, delete_chore)", () => {
  beforeEach(async () => {
    await setPin(PIN);
  });

  function tool(name: string, unlocked: boolean): { run(args: Record<string, any>): Promise<any> } {
    const t = buildTools(alice, unlocked).find((x) => x.name === name);
    assert.ok(t, `no such tool: ${name}`);
    return t as any;
  }

  test("create_chore refuses when locked", async () => {
    const result = await tool("create_chore", false).run({ title: "Assistant chore", dueDate: "2026-09-29" });
    assert.match(result.error, /Enter the parent PIN/);
  });

  test("create_chore works when unlocked", async () => {
    const result = await tool("create_chore", true).run({ title: "Assistant chore 2", dueDate: "2026-09-29" });
    assert.equal(result.title, "Assistant chore 2");
  });

  test("delete_chore refuses when locked", async () => {
    await tool("create_chore", true).run({ title: "To delete", dueDate: "2026-09-30" });
    const result = await tool("delete_chore", false).run({ title: "To delete", date: "2026-09-30" });
    assert.match(result.error, /Enter the parent PIN/);
  });

  test("delete_chore works when unlocked", async () => {
    await tool("create_chore", true).run({ title: "To delete 2", dueDate: "2026-10-01" });
    const result = await tool("delete_chore", true).run({ title: "To delete 2", date: "2026-10-01" });
    assert.equal(result.deleted, "To delete 2");
  });
});
