// assistant/tools/chores.ts -- list_chores, create_chore, complete_chore,
// delete_chore, delete_all_chores. New for Stage 10.3 (PLAN.md).

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import { loadDb, cleanupDb } from "./helpers/testdb.ts";

const { createUser, putScopedItem, getScopedItems } = await loadDb();
const { buildTools } = await import("../assistant/registry.ts");
const { setChoreOccurrenceApproval } = await import("../routes/chores.ts");

let userId: string;

function call(name: string, args: Record<string, any> = {}): Promise<any> {
  const tool = buildTools(userId).find((t) => t.name === name);
  assert.ok(tool, `no such tool: ${name}`);
  return tool.run(args);
}

before(() => {
  userId = createUser("alice-tools-chores", "not-a-real-hash", "Alice");
  putScopedItem("household_members", userId, {
    id: "member-sam", scope: "joint", name: "Sam", likes: [], dislikes: [],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
});

after(cleanupDb);

describe("create_chore", () => {
  test("creates a family/unassigned, pending, one-time chore", async () => {
    const result = await call("create_chore", { title: "Empty the dishwasher", dueDate: "2026-09-10" });
    assert.equal(result.title, "Empty the dishwasher");
    assert.equal(result.member, undefined);
    assert.equal(result.recurring, false);
  });

  test("assigns to a named member", async () => {
    const result = await call("create_chore", { title: "Take out trash", dueDate: "2026-09-10", member: "Sam" });
    assert.equal(result.member, "member-sam");
  });

  test("an unmatched member name returns a not-found error, not a crash", async () => {
    const result = await call("create_chore", { title: "X", dueDate: "2026-09-10", member: "Nobody" });
    assert.match(result.error, /No family member named/);
  });

  test("requires a real dueDate", async () => {
    const result = await call("create_chore", { title: "X", dueDate: "whenever" });
    assert.match(result.error, /dueDate must be a date/);
  });

  test("days makes it a real recurring rule, stored as one row", async () => {
    const result = await call("create_chore", {
      title: "Water plants",
      dueDate: "2026-09-07", // a Monday
      days: ["monday"],
      until: "2026-09-07",
    });
    assert.equal(result.recurring, true);

    const rows = (getScopedItems("chores", userId) as any[]).filter((c) => c.title === "Water plants");
    assert.equal(rows.length, 1, "one stored row for the whole series");
    assert.deepEqual(rows[0].recurrence, { freq: "weekly", byDay: ["MO"], until: "2026-09-07" });
  });

  test("rejects until before dueDate", async () => {
    const result = await call("create_chore", {
      title: "X", dueDate: "2026-09-07", days: ["monday"], until: "2026-09-01",
    });
    assert.match(result.error, /until cannot be before dueDate/);
  });
});

describe("list_chores", () => {
  test("filters by an inclusive from/to range", async () => {
    const chores = await call("list_chores", { from: "2026-09-01", to: "2026-09-30" });
    assert.ok(chores.length > 0);
    assert.ok(chores.every((c: any) => c.date >= "2026-09-01" && c.date <= "2026-09-30"));
  });

  test("reports the assigned member's name, not their id", async () => {
    const chores = await call("list_chores", { from: "2026-09-10", to: "2026-09-10" });
    const assigned = chores.find((c: any) => c.title === "Take out trash");
    assert.equal(assigned.member, "Sam");
  });
});

describe("complete_chore", () => {
  test("marks a matching pending chore done", async () => {
    await call("create_chore", { title: "Fold laundry", dueDate: "2026-09-12" });
    const result = await call("complete_chore", { title: "Fold laundry" });
    assert.equal(result.status, "done");
  });

  test("a completed chore's status persists on read", async () => {
    const chores = await call("list_chores", { from: "2026-09-12", to: "2026-09-12" });
    assert.equal(chores.find((c: any) => c.title === "Fold laundry").status, "done");
  });

  test("completing one occurrence of a recurring chore leaves the rest pending", async () => {
    await call("create_chore", {
      title: "Take out recycling",
      dueDate: "2026-10-05", // a Monday
      days: ["monday"],
      until: "2026-10-19",
    });

    const result = await call("complete_chore", { title: "Take out recycling", date: "2026-10-12" });
    assert.equal(result.status, "done");
    assert.equal(result.date, "2026-10-12");

    // Still one stored master row -- the completion lives in its
    // `completions` map, not a phantom per-occurrence row.
    const rows = (getScopedItems("chores", userId) as any[]).filter((c) => c.title === "Take out recycling");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "pending", "the master row's own status field is untouched");
    assert.deepEqual(Object.keys(rows[0].completions), ["2026-10-12"]);

    const chores = await call("list_chores", { from: "2026-10-05", to: "2026-10-19" });
    const occurrences = chores.filter((c: any) => c.title === "Take out recycling");
    assert.equal(occurrences.find((c: any) => c.date === "2026-10-05").status, "pending");
    assert.equal(occurrences.find((c: any) => c.date === "2026-10-12").status, "done");
    assert.equal(occurrences.find((c: any) => c.date === "2026-10-19").status, "pending");
  });

  test("no matching chore is a clear error, not a crash", async () => {
    const result = await call("complete_chore", { title: "Nothing like this exists" });
    assert.match(result.error, /No chore matching/);
  });
});

describe("delete_chore", () => {
  test("deleting one occurrence of a recurring chore removes the whole series", async () => {
    await call("create_chore", {
      title: "Mow the lawn",
      dueDate: "2026-11-02", // a Monday
      days: ["monday"],
      until: "2026-11-16",
    });

    const result = await call("delete_chore", { title: "Mow the lawn", date: "2026-11-09" });
    assert.match(result.note, /entire series was removed/);

    const remaining = (getScopedItems("chores", userId) as any[]).filter((c) => c.title === "Mow the lawn");
    assert.equal(remaining.length, 0);
  });

  test("deleting a plain one-time chore carries no series note", async () => {
    await call("create_chore", { title: "Wash the car", dueDate: "2026-11-20" });
    const result = await call("delete_chore", { title: "Wash the car", date: "2026-11-20" });
    assert.equal(result.deleted, "Wash the car");
    assert.equal(result.note, undefined);
  });
});

describe("get_chore_points", () => {
  // Stage 6.5 (PLAN.md): completing a chore alone no longer earns points --
  // it waits for a parent's approval (setChoreOccurrenceApproval, the same
  // helper routes/chores.ts's POST /:id/approve calls).
  test("reports each member's earned points and completed count only once approved", async () => {
    await call("create_chore", { title: "Points chore", dueDate: "2028-01-05", member: "Sam" });
    const before = (await call("get_chore_points")).find((r: any) => r.member === "Sam");
    assert.equal(before.earned, 0);
    assert.equal(before.completedCount, 0);
    assert.equal(before.waitingCount, 0);

    await call("complete_chore", { title: "Points chore", date: "2028-01-05" });
    const waiting = (await call("get_chore_points")).find((r: any) => r.member === "Sam");
    assert.equal(waiting.earned, 0, "done but not yet approved -- not earned");
    assert.equal(waiting.waitingCount, 1);

    // create_chore's tool result carries no id, so find the stored row
    // directly to approve it -- same lookup the route's PUT /:id relies on
    // getScopedItems for.
    const choreId = (getScopedItems("chores", userId) as any[]).find((c) => c.title === "Points chore").id;
    const approval = setChoreOccurrenceApproval(userId, choreId, true, userId);
    assert.ok(!("error" in approval), "approval should succeed");

    const after = (await call("get_chore_points")).find((r: any) => r.member === "Sam");
    assert.equal(after.earned, 1, "default point value when the chore has no points field");
    assert.equal(after.completedCount, 1);
    assert.equal(after.waitingCount, 0);
  });

  test("is read-only and household-sensitivity", async () => {
    const tool = buildTools(userId).find((t) => t.name === "get_chore_points");
    assert.equal(tool?.mutates, false);
    assert.equal(tool?.sensitivity, "household");
  });
});

describe("delete_all_chores", () => {
  test("counts and removes each series once, not once per occurrence", async () => {
    await call("create_chore", {
      title: "Bulk recurring chore", dueDate: "2027-02-01", days: ["monday"], until: "2027-02-22", // a Monday
    });
    await call("create_chore", { title: "Bulk one-off chore", dueDate: "2027-02-03" });

    // Bulk deletes ask first (assistant/confirmations.ts); see assistantBulkDelete.test.ts for the whole flow.
    const args = { from: "2027-02-01", to: "2027-02-28" };
    const asked = await call("delete_all_chores", args);
    assert.equal(asked.needsConfirmation, true);
    const result = await call("delete_all_chores", { ...args, confirmation: asked.confirmation });
    assert.equal(result.deletedCount, 2, "one series + one one-off, not one row per occurrence");
    assert.match(result.note, /removed in full/);

    const remaining = (getScopedItems("chores", userId) as any[]).filter(
      (c) => c.title === "Bulk recurring chore" || c.title === "Bulk one-off chore"
    );
    assert.equal(remaining.length, 0);
  });
});
