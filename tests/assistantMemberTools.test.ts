// The household-roster tools (assistant/tools/members.ts): list_household_members, add_like, remove_like, add_dislike,
// remove_dislike. They had no tests, and saveMember rebuilt each member from id/name/likes/dislikes/color only -- so
// "Alex loves pizza" quietly erased Alex's role (a parent became a kid on Chores), theme and login link.

import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

import { loadDb, cleanupDb } from "./helpers/testdb.ts";

const { createUser, putScopedItem, getScopedItems, deleteScopedItem, newId } = await loadDb();
const { buildTools } = await import("../assistant/registry.ts");

let alice: string;
let bob: string;
let alexId: string;
let samId: string;
const CREATED = "2026-01-01T00:00:00.000Z";

after(cleanupDb);

function callAs(userId: string, name: string, args: Record<string, any> = {}): Promise<any> {
  const tool = buildTools(userId).find((t) => t.name === name);
  assert.ok(tool, name);
  return tool.run(args);
}
const stored = (id: string) => (getScopedItems("household_members", alice) as any[]).find((m) => m.id === id);

before(() => {
  alice = createUser("alice-members", "not-a-real-hash", "Alice");
  bob = createUser("bob-members", "not-a-real-hash", "Bob");
});

beforeEach(() => {
  for (const m of getScopedItems("household_members", alice) as any[]) deleteScopedItem("household_members", alice, m.id);
  alexId = newId("member");
  samId = newId("member");
  // Alex has every optional field set; Sam is a bare, older-style row.
  putScopedItem("household_members", alice, {
    id: alexId, name: "Alex", likes: ["tacos"], dislikes: ["mushrooms"], color: "rose", theme: "bold", role: "parent", userId: bob,
    scope: "joint", createdAt: CREATED, updatedAt: CREATED,
  });
  putScopedItem("household_members", alice, {
    id: samId, name: "Sam", likes: [], dislikes: [], scope: "joint", createdAt: "2026-01-02T00:00:00.000Z", updatedAt: CREATED,
  });
});

describe("list_household_members", () => {
  test("lists each person with their likes and dislikes, oldest first, and nothing else", async () => {
    const r = await callAs(alice, "list_household_members");
    assert.deepEqual(r, [
      { name: "Alex", likes: ["tacos"], dislikes: ["mushrooms"] },
      { name: "Sam", likes: [], dislikes: [] },
    ]);
  });

  test("the roster is shared: another login sees the same people", async () => {
    assert.deepEqual((await callAs(bob, "list_household_members")).map((m: any) => m.name), ["Alex", "Sam"]);
  });
});

describe("likes and dislikes keep everything else on the member", () => {
  // The fields add_like & co. must never touch.
  const untouched = (m: any) => ({ id: m.id, name: m.name, color: m.color, theme: m.theme, role: m.role, userId: m.userId, scope: m.scope, createdAt: m.createdAt });
  const ALEX_FIXED = { id: "", name: "Alex", color: "rose", theme: "bold", role: "parent", userId: "", scope: "joint", createdAt: CREATED };

  test("add_like", async () => {
    const r = await callAs(alice, "add_like", { member: "Alex", item: "pizza" });
    assert.deepEqual(r, { member: "Alex", likes: ["tacos", "pizza"] });
    const m = stored(alexId);
    assert.deepEqual(m.likes, ["tacos", "pizza"]);
    assert.deepEqual(m.dislikes, ["mushrooms"]);
    assert.deepEqual(untouched(m), { ...ALEX_FIXED, id: alexId, userId: bob });
    assert.notEqual(m.updatedAt, CREATED, "updatedAt moves");
  });

  test("remove_like", async () => {
    const r = await callAs(alice, "remove_like", { member: "Alex", item: "Tacos" });
    assert.deepEqual(r, { member: "Alex", likes: [] });
    const m = stored(alexId);
    assert.deepEqual(m.likes, []);
    assert.deepEqual(untouched(m), { ...ALEX_FIXED, id: alexId, userId: bob });
  });

  test("add_dislike", async () => {
    const r = await callAs(alice, "add_dislike", { member: "alex", item: "olives" });
    assert.deepEqual(r, { member: "Alex", dislikes: ["mushrooms", "olives"] });
    const m = stored(alexId);
    assert.deepEqual(m.likes, ["tacos"]);
    assert.deepEqual(untouched(m), { ...ALEX_FIXED, id: alexId, userId: bob });
  });

  test("remove_dislike", async () => {
    const r = await callAs(alice, "remove_dislike", { member: "Alex", item: "mushrooms" });
    assert.deepEqual(r, { member: "Alex", dislikes: [] });
    const m = stored(alexId);
    assert.deepEqual(m.dislikes, []);
    assert.deepEqual(untouched(m), { ...ALEX_FIXED, id: alexId, userId: bob });
  });

  test("a bare older row stays bare: no fields appear that were never there", async () => {
    await callAs(alice, "add_like", { member: "Sam", item: "soup" });
    const m = stored(samId);
    assert.deepEqual(m.likes, ["soup"]);
    assert.equal(m.role, undefined);
    assert.equal(m.userId, undefined);
    assert.equal(m.theme, undefined);
    assert.equal(m.createdAt, "2026-01-02T00:00:00.000Z");
  });

  test("after a like the member is still a parent on the Chores screen's terms", async () => {
    const { isParentMember } = await import("../routes/members.ts");
    await callAs(alice, "add_like", { member: "Alex", item: "pizza" });
    assert.equal(isParentMember(stored(alexId)), true);
  });
});

describe("the roster tools' other answers", () => {
  test("a like already on the list is reported, not duplicated", async () => {
    const r = await callAs(alice, "add_like", { member: "Alex", item: " TACOS " });
    assert.equal(r.action, "already recorded");
    assert.deepEqual(stored(alexId).likes, ["tacos"]);
  });

  test("removing something that was never recorded is an error and changes nothing", async () => {
    const r = await callAs(alice, "remove_dislike", { member: "Alex", item: "olives" });
    assert.match(r.error, /no recorded dislike of "olives"/);
    assert.deepEqual(stored(alexId).dislikes, ["mushrooms"]);
  });

  test("an unknown person gets the did-you-mean, and nothing is saved", async () => {
    const r = await callAs(alice, "add_like", { member: "Alx", item: "pizza" });
    assert.match(r.error, /No family member named "Alx"/);
    assert.deepEqual(r.validValues, ["Alex"]);
    assert.deepEqual(stored(alexId).likes, ["tacos"]);
  });

  test("a blank food is refused", async () => {
    assert.match((await callAs(alice, "add_like", { member: "Alex", item: "  " })).error, /No food given/);
  });
});
