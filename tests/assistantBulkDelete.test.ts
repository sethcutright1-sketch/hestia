// The assistant's shopping-list removal tools and the confirmation that guards every BULK delete
// (assistant/confirmations.ts): remove_shopping_item, clear_shopping_list, delete_all_calendar_events, delete_all_chores.
//
// Why: a benchmark found models asked to "get rid of everything on the costco list" wiping every chore (no tool could remove
// a list item), and others wiping the calendar when told it was a mess. The model must not be able to confirm for itself, so
// these tests pin the server's side of it: nothing is deleted on the first call, and a token only works for the same person,
// tool and arguments, within ten minutes, once, and from a LATER chat request.
//
// Turn ids: every buildTools call without ctx.turnId is a turn of its own (registry.ts), so "ask through one set of tools,
// answer through the next" is two buildTools calls. `turn(id)` pins one explicitly where a test needs two sets in the SAME turn.

import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

import { loadDb, cleanupDb } from "./helpers/testdb.ts";
import type { ScopedTable } from "../db.ts";

const { createUser, putScopedItem, getScopedItems, deleteScopedItem } = await loadDb();
const { buildTools, toolManifest } = await import("../assistant/registry.ts");
const { planTurn } = await import("../assistant/turn.ts");
const { clearConfirmations, pendingConfirmations, CONFIRMATION_TTL_MS } = await import("../assistant/confirmations.ts");

let alice: string;
let bob: string;
const NOW = "2026-10-01T00:00:00.000Z";

before(() => {
  alice = createUser("alice-bulk", "not-a-real-hash", "Alice");
  bob = createUser("bob-bulk", "not-a-real-hash", "Bob");
});
after(cleanupDb);
beforeEach(() => {
  clearConfirmations();
  for (const table of ["shopping_lists", "events", "chores"] as ScopedTable[]) {
    for (const row of getScopedItems(table, alice) as any[]) deleteScopedItem(table, alice, row.id);
  }
});

/** A tool set that counts as one chat request: every call through it shares the turn id. */
function turn(turnId: string, opts: { user?: string; unlocked?: boolean; now?: () => Date } = {}) {
  const tools = buildTools(opts.user ?? alice, opts.unlocked ?? true, { turnId, now: opts.now });
  return (name: string, args: Record<string, any> = {}): Promise<any> => {
    const tool = tools.find((t) => t.name === name);
    assert.ok(tool, `no such tool: ${name}`);
    return tool.run(args);
  };
}
/** Each call builds fresh tools, i.e. is a turn of its own -- the seam scripts and older tests use. */
function call(name: string, args: Record<string, any> = {}): Promise<any> {
  const tool = buildTools(alice).find((t) => t.name === name);
  assert.ok(tool, `no such tool: ${name}`);
  return tool.run(args);
}

const item = (name: string, i: number) => ({ id: `item-${name}-${i}`, name, quantity: "", category: "Other", notes: "", checked: false, addedBy: alice });
function seedList(name: string, items: string[]) {
  putScopedItem("shopping_lists", alice, {
    id: `list-${name}`, name, scope: "joint", status: "active", items: items.map(item), createdBy: alice, createdAt: NOW, updatedAt: NOW,
  });
}
const listItems = (name: string): string[] =>
  ((getScopedItems("shopping_lists", alice) as any[]).find((l) => l.name === name)?.items ?? []).map((i: any) => i.name);
const seedEvent = (id: string, date: string, title: string, extra: Record<string, unknown> = {}) =>
  putScopedItem("events", alice, { id, date, title, audience: "family", scope: "joint", createdAt: NOW, updatedAt: NOW, ...extra });
const seedChore = (id: string, date: string, title: string) =>
  putScopedItem("chores", alice, { id, date, title, status: "pending", scope: "joint", createdAt: NOW, updatedAt: NOW });
const eventCount = () => (getScopedItems("events", alice) as any[]).length;
const choreCount = () => (getScopedItems("chores", alice) as any[]).length;

describe("remove_shopping_item", () => {
  beforeEach(() => {
    seedList("Weekly Groceries", ["Eggs", "Milk"]);
    seedList("Costco Run", ["Paper Towels", "Milk"]);
  });

  test("an exact list and item name removes that one item and leaves the other list alone", async () => {
    const r = await call("remove_shopping_item", { list: "Weekly Groceries", item: "milk" });
    assert.equal(r.removed, "Milk");
    assert.equal(r.from, "Weekly Groceries");
    assert.equal(r.remainingItems, 1);
    assert.equal(r.note, undefined);
    assert.deepEqual(listItems("Weekly Groceries"), ["Eggs"]);
    assert.deepEqual(listItems("Costco Run"), ["Paper Towels", "Milk"], "the other list's Milk is untouched");
  });

  test("a partial list name refuses with the real name as a suggestion", async () => {
    const r = await call("remove_shopping_item", { list: "Groceries", item: "Milk" });
    assert.match(r.error, /No shopping list named "Groceries"/);
    assert.deepEqual(r.validValues, ["Weekly Groceries"]);
    assert.deepEqual(listItems("Weekly Groceries"), ["Eggs", "Milk"]);
  });

  test("a partial item name refuses with suggestions instead of removing the first thing containing it", async () => {
    const r = await call("remove_shopping_item", { list: "Costco Run", item: "Paper" });
    assert.match(r.error, /No item on the "Costco Run" list named "Paper"/);
    assert.deepEqual(r.validValues, ["Paper Towels"]);
    assert.deepEqual(listItems("Costco Run"), ["Paper Towels", "Milk"]);
  });

  test("an item that is not on the list changes nothing", async () => {
    const r = await call("remove_shopping_item", { list: "Weekly Groceries", item: "Caviar" });
    assert.match(r.error, /No item on the "Weekly Groceries" list named "Caviar"/);
    assert.equal(r.validValues, undefined, "nothing close enough to suggest");
    assert.deepEqual(listItems("Weekly Groceries"), ["Eggs", "Milk"]);
  });

  test("a name that appears twice loses one row and says how many are left, like the Grocery screen's per-row delete", async () => {
    seedList("Party", ["Chips", "Chips", "Salsa"]);
    const r = await call("remove_shopping_item", { list: "Party", item: "Chips" });
    assert.equal(r.removed, "Chips");
    assert.equal(r.remainingItems, 2);
    assert.match(r.note, /1 more item called "Chips" is still on this list/);
    assert.deepEqual(listItems("Party"), ["Chips", "Salsa"]);
    const again = await call("remove_shopping_item", { list: "Party", item: "Chips" });
    assert.equal(again.note, undefined);
    assert.deepEqual(listItems("Party"), ["Salsa"]);
  });

  test("is a mutating, household tool in the manifest alongside clear_shopping_list", () => {
    const manifest = toolManifest(alice);
    for (const name of ["remove_shopping_item", "clear_shopping_list"]) {
      const entry = manifest.find((t) => t.name === name);
      assert.ok(entry, name);
      assert.equal(entry.mutates, true);
      assert.equal(entry.sensitivity, "household");
      assert.equal(entry.domain, "grocery");
    }
  });
});

describe("clear_shopping_list", () => {
  beforeEach(() => {
    seedList("Weekly Groceries", ["Eggs", "Milk"]);
    seedList("Costco Run", ["Paper Towels", "Rice", "Soap"]);
    seedChore("c1", "2026-10-20", "Take out the trash");
    seedEvent("e1", "2026-10-21", "Dentist");
  });

  test("the first call deletes nothing and returns a token, a concrete summary and an instruction", async () => {
    const r = await call("clear_shopping_list", { list: "Costco Run" });
    assert.equal(r.needsConfirmation, true);
    assert.match(r.summary, /remove all 3 items from the shopping list "Costco Run" \(Paper Towels, Rice, Soap\)/);
    assert.equal(typeof r.confirmation, "string");
    assert.match(r.instruction, /NEXT message/);
    assert.deepEqual(listItems("Costco Run"), ["Paper Towels", "Rice", "Soap"]);
    assert.equal(pendingConfirmations().length, 1);
  });

  test("redeeming in the same turn fails: the model cannot confirm for the person", async () => {
    const t = turn("turn-1");
    const asked = await t("clear_shopping_list", { list: "Costco Run" });
    const same = await t("clear_shopping_list", { list: "Costco Run", confirmation: asked.confirmation });
    assert.equal(same.needsConfirmation, true);
    assert.match(same.error, /Confirmation required: .*not answered yet/);
    assert.notEqual(same.confirmation, asked.confirmation, "a fresh request, not the old token");
    assert.deepEqual(listItems("Costco Run"), ["Paper Towels", "Rice", "Soap"]);
  });

  test("redeeming from a later turn clears ONLY that list; the list stays; chores, calendar and other lists are untouched", async () => {
    const asked = await turn("turn-1")("clear_shopping_list", { list: "Costco Run" });
    const done = await turn("turn-2")("clear_shopping_list", { list: "Costco Run", confirmation: asked.confirmation });
    assert.deepEqual(done, { cleared: "Costco Run", removedCount: 3, remainingItems: 0 });
    assert.deepEqual(listItems("Costco Run"), []);
    assert.equal((getScopedItems("shopping_lists", alice) as any[]).filter((l) => l.name === "Costco Run").length, 1, "the list itself stays");
    assert.deepEqual(listItems("Weekly Groceries"), ["Eggs", "Milk"]);
    assert.equal(choreCount(), 1);
    assert.equal(eventCount(), 1);
  });

  test("a token is single-use", async () => {
    const asked = await turn("turn-1")("clear_shopping_list", { list: "Costco Run" });
    await turn("turn-2")("clear_shopping_list", { list: "Costco Run", confirmation: asked.confirmation });
    seedList("Costco Run", ["Bleach"]);
    const reused = await turn("turn-3")("clear_shopping_list", { list: "Costco Run", confirmation: asked.confirmation });
    assert.equal(reused.needsConfirmation, true);
    assert.match(reused.error, /unknown, already used or expired/);
    assert.deepEqual(listItems("Costco Run"), ["Bleach"]);
  });

  test("a token for one list cannot clear another", async () => {
    const asked = await turn("turn-1")("clear_shopping_list", { list: "Costco Run" });
    const wrong = await turn("turn-2")("clear_shopping_list", { list: "Weekly Groceries", confirmation: asked.confirmation });
    assert.equal(wrong.needsConfirmation, true);
    assert.match(wrong.error, /not what the person was asked about/);
    assert.deepEqual(listItems("Weekly Groceries"), ["Eggs", "Milk"]);
    assert.deepEqual(listItems("Costco Run"), ["Paper Towels", "Rice", "Soap"]);
  });

  test("a token goes stale if the list changed after the person was asked", async () => {
    const asked = await turn("turn-1")("clear_shopping_list", { list: "Costco Run" });
    await turn("turn-1b")("add_shopping_item", { list: "Costco Run", name: "Batteries" });
    const stale = await turn("turn-2")("clear_shopping_list", { list: "Costco Run", confirmation: asked.confirmation });
    assert.equal(stale.needsConfirmation, true);
    assert.match(stale.summary, /all 4 items/);
    assert.equal(listItems("Costco Run").length, 4);
  });

  test("an expired token fails", async () => {
    let clock = Date.parse("2026-10-18T12:00:00Z");
    const now = () => new Date(clock);
    const asked = await turn("turn-1", { now })("clear_shopping_list", { list: "Costco Run" });
    clock += CONFIRMATION_TTL_MS + 1;
    const late = await turn("turn-2", { now })("clear_shopping_list", { list: "Costco Run", confirmation: asked.confirmation });
    assert.equal(late.needsConfirmation, true);
    assert.match(late.error, /unknown, already used or expired/);
    assert.equal(listItems("Costco Run").length, 3);
  });

  test("a token still works just inside the window", async () => {
    let clock = Date.parse("2026-10-18T12:00:00Z");
    const now = () => new Date(clock);
    const asked = await turn("turn-1", { now })("clear_shopping_list", { list: "Costco Run" });
    clock += CONFIRMATION_TTL_MS - 1000;
    const done = await turn("turn-2", { now })("clear_shopping_list", { list: "Costco Run", confirmation: asked.confirmation });
    assert.equal(done.removedCount, 3);
  });

  test("another person's token, or a made-up one, deletes nothing", async () => {
    seedList("Costco Run", ["Paper Towels"]);
    const asked = await turn("turn-1")("clear_shopping_list", { list: "Costco Run" });
    const asBob = await turn("turn-2", { user: bob })("clear_shopping_list", { list: "Costco Run", confirmation: asked.confirmation });
    // Bob can see joint lists too, so this is the tool-level check (not the data scoping) doing the refusing.
    assert.equal(asBob.needsConfirmation, true);
    assert.match(asBob.error, /belongs to someone else/);
    assert.deepEqual(listItems("Costco Run"), ["Paper Towels"]);
    const fake = await turn("turn-3")("clear_shopping_list", { list: "Costco Run", confirmation: "0123456789abcdef" });
    assert.match(fake.error, /unknown, already used or expired/);
    assert.deepEqual(listItems("Costco Run"), ["Paper Towels"]);
  });

  test("a partial list name refuses with suggestions and files no confirmation", async () => {
    const r = await call("clear_shopping_list", { list: "Costco" });
    assert.match(r.error, /No shopping list named "Costco"/);
    assert.deepEqual(r.validValues, ["Costco Run"]);
    assert.equal(pendingConfirmations().length, 0);
  });

  test("an already-empty list needs no confirmation", async () => {
    seedList("Empty", []);
    const r = await call("clear_shopping_list", { list: "Empty" });
    assert.equal(r.removedCount, 0);
    assert.equal(r.needsConfirmation, undefined);
  });

  test("the confirmation parameter and the one-line description are additive on the bulk tools", () => {
    for (const name of ["clear_shopping_list", "delete_all_calendar_events", "delete_all_chores"]) {
      const tool = buildTools(alice).find((t) => t.name === name)!;
      assert.equal((tool.parameters.properties as any).confirmation.type, "string", name);
      assert.ok(!(tool.parameters.required ?? []).includes("confirmation"), `${name}: confirmation must stay optional`);
      assert.match(tool.description, /deletes nothing/, name);
    }
  });
});

describe("delete_all_calendar_events", () => {
  beforeEach(() => {
    seedEvent("e1", "2026-10-20", "Dentist");
    seedEvent("e2", "2026-10-22", "Book club");
    seedEvent("e3", "2026-10-25", "Lunch with Gran", { mealSlot: "lunch" });
    seedList("Costco Run", ["Paper Towels"]);
    seedChore("c1", "2026-10-20", "Take out the trash");
  });

  test("the first call deletes nothing and summarises the count and date range", async () => {
    const r = await call("delete_all_calendar_events", {});
    assert.equal(r.needsConfirmation, true);
    assert.match(r.summary, /This will delete 3 calendar events from 2026-10-20 to 2026-10-25 \(Dentist, Book club, Lunch with Gran\)/);
    assert.equal(eventCount(), 3);
  });

  test("redeeming in the same turn fails; from a later turn it deletes the events and nothing else", async () => {
    const t = turn("turn-1");
    const asked = await t("delete_all_calendar_events", {});
    const same = await t("delete_all_calendar_events", { confirmation: asked.confirmation });
    assert.equal(same.needsConfirmation, true);
    assert.equal(eventCount(), 3);

    const done = await turn("turn-2")("delete_all_calendar_events", { confirmation: same.confirmation });
    assert.equal(done.deletedCount, 3);
    assert.equal(eventCount(), 0);
    assert.deepEqual(listItems("Costco Run"), ["Paper Towels"]);
    assert.equal(choreCount(), 1);
  });

  test("the confirmation is for those arguments: a wider or different range is refused", async () => {
    const asked = await turn("turn-1")("delete_all_calendar_events", { from: "2026-10-20", to: "2026-10-22" });
    assert.match(asked.summary, /delete 2 calendar events from 2026-10-20 to 2026-10-22/);
    const wider = await turn("turn-2")("delete_all_calendar_events", { confirmation: asked.confirmation });
    assert.equal(wider.needsConfirmation, true);
    assert.match(wider.error, /not what the person was asked about/);
    assert.equal(eventCount(), 3);
  });

  test("a mealSlot filter is part of what is confirmed, and an empty argument matches an omitted one", async () => {
    const asked = await turn("turn-1")("delete_all_calendar_events", { mealSlot: "lunch", from: "" });
    assert.match(asked.summary, /1 calendar event at lunch on 2026-10-25/);
    const done = await turn("turn-2")("delete_all_calendar_events", { mealSlot: "Lunch", confirmation: asked.confirmation });
    assert.equal(done.deletedCount, 1);
    assert.equal(eventCount(), 2);
  });

  // Dates far in the future: create_recurring_event clamps a start in the past to today, so a near date would rot.
  test("a recurring series is named as removed in full, and counted once", async () => {
    await call("create_recurring_event", { startDate: "2040-11-05", days: ["monday"], until: "2040-11-30", title: "Swim" });
    const asked = await turn("turn-1")("delete_all_calendar_events", { from: "2040-11-01", to: "2040-11-30" });
    assert.match(asked.summary, /delete 1 calendar event /);
    assert.match(asked.summary, /Repeating events are removed in full/);
    const done = await turn("turn-2")("delete_all_calendar_events", { from: "2040-11-01", to: "2040-11-30", confirmation: asked.confirmation });
    assert.equal(done.deletedCount, 1);
  });

  test("nothing to delete: no confirmation is asked for", async () => {
    const r = await call("delete_all_calendar_events", { from: "2030-01-01", to: "2030-01-31" });
    assert.deepEqual(r, { deletedCount: 0 });
    assert.equal(pendingConfirmations().length, 0);
  });

  test("a single-event delete stays immediate", async () => {
    const r = await call("delete_calendar_event", { date: "2026-10-20", title: "Dentist" });
    assert.equal(r.deleted, "Dentist");
    assert.equal(eventCount(), 2);
  });
});

describe("delete_all_chores", () => {
  beforeEach(() => {
    seedChore("c1", "2026-10-20", "Take out the trash");
    seedChore("c2", "2026-10-21", "Do the dishes");
    seedEvent("e1", "2026-10-20", "Dentist");
    seedList("Costco Run", ["Paper Towels"]);
  });

  test("the first call deletes nothing; a later turn with the token deletes the chores and nothing else", async () => {
    const asked = await turn("turn-1")("delete_all_chores", {});
    assert.equal(asked.needsConfirmation, true);
    assert.match(asked.summary, /This will delete 2 chores due 2026-10-20 to 2026-10-21 \(Take out the trash, Do the dishes\)/);
    assert.equal(choreCount(), 2);

    const same = await turn("turn-1")("delete_all_chores", { confirmation: asked.confirmation });
    assert.equal(same.needsConfirmation, true, "same turn is refused");
    assert.equal(choreCount(), 2);

    const done = await turn("turn-2")("delete_all_chores", { confirmation: same.confirmation });
    assert.equal(done.deletedCount, 2);
    assert.equal(choreCount(), 0);
    assert.equal(eventCount(), 1);
    assert.deepEqual(listItems("Costco Run"), ["Paper Towels"]);
  });

  test("a calendar token cannot be spent on the chores (different tool)", async () => {
    const asked = await turn("turn-1")("delete_all_calendar_events", {});
    const wrong = await turn("turn-2")("delete_all_chores", { confirmation: asked.confirmation });
    assert.equal(wrong.needsConfirmation, true);
    assert.match(wrong.error, /different action/);
    assert.equal(choreCount(), 2);
    assert.equal(eventCount(), 1);
  });

  test("the PIN lock refuses before any confirmation is offered, with or without a token", async () => {
    const locked = turn("turn-1", { unlocked: false });
    const r = await locked("delete_all_chores", {});
    assert.deepEqual(r, { error: "Enter the parent PIN in the app first." });
    assert.equal(pendingConfirmations().length, 0, "a locked session is never even asked to confirm");

    // A token issued while unlocked cannot be spent from a locked session either.
    const asked = await turn("turn-2")("delete_all_chores", {});
    const stillLocked = await turn("turn-3", { unlocked: false })("delete_all_chores", { confirmation: asked.confirmation });
    assert.deepEqual(stillLocked, { error: "Enter the parent PIN in the app first." });
    assert.equal(choreCount(), 2);
  });

  test("a single-chore delete stays immediate", async () => {
    const r = await call("delete_chore", { title: "dishes", date: "2026-10-21" });
    assert.equal(r.deleted, "Do the dishes");
    assert.equal(choreCount(), 1);
  });
});

describe("turn ids reach the tools", () => {
  test("planTurn threads its turnId into the tool set: the same turn cannot confirm, the next can", async () => {
    seedEvent("e1", "2026-10-20", "Dentist");
    const plan = (turnId: string) => planTurn({ userId: alice, message: "clear the calendar", history: [], unlocked: true, turnId });
    const run = (p: ReturnType<typeof planTurn>, args: Record<string, any>): Promise<any> => p.tools.find((t) => t.name === "delete_all_calendar_events")!.run(args);

    const first = plan("request-1");
    assert.ok(first.tools.some((t) => t.name === "clear_shopping_list"), "the new tools are offered to the provider");
    const asked = await run(first, {});
    const same = await run(first, { confirmation: asked.confirmation });
    assert.equal(same.needsConfirmation, true);
    assert.equal(eventCount(), 1);

    const done = await run(plan("request-2"), { confirmation: same.confirmation });
    assert.equal(done.deletedCount, 1);
    assert.equal(eventCount(), 0);
  });

  test("with no turnId given, each planTurn / buildTools is a turn of its own", async () => {
    seedEvent("e1", "2026-10-20", "Dentist");
    const noId = () => planTurn({ userId: alice, message: "clear the calendar", history: [], unlocked: true });
    const asked: any = await noId().tools.find((t) => t.name === "delete_all_calendar_events")!.run({});
    const done: any = await noId().tools.find((t) => t.name === "delete_all_calendar_events")!.run({ confirmation: asked.confirmation });
    assert.equal(done.deletedCount, 1);
  });
});
