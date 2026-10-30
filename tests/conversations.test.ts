// Stage 4's persisted assistant conversations.
//
// Two things matter here and neither is visible when it breaks. First, one
// member must never be able to read, rename, or delete the other's
// conversations -- an assistant transcript quotes real transaction amounts,
// calendar entries, and whatever else was asked that day. Second, tool calls
// and results have to survive a round trip intact, because server.ts replays
// them as real wire messages so "add that to the list" knows what "that" was.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import { loadDb, cleanupDb } from "./helpers/testdb.ts";

const {
  createUser,
  listConversations,
  getConversation,
  createConversation,
  renameConversation,
  deleteConversation,
  touchConversation,
  listMessages,
  addMessage,
} = await loadDb();

let alice: string;
let bob: string;

before(() => {
  alice = createUser("alice-conv", "not-a-real-hash", "Alice");
  bob = createUser("bob-conv", "not-a-real-hash", "Bob");
});

after(cleanupDb);

describe("conversations are scoped to their owner", () => {
  test("one member cannot read the other's conversation", () => {
    const conv = createConversation(alice, "What did we spend at Costco");

    assert.equal(getConversation(alice, conv.id)?.id, conv.id);
    assert.equal(
      getConversation(bob, conv.id),
      undefined,
      "Bob must not be able to read Alice's transcript by id"
    );
  });

  test("listing only ever returns your own", () => {
    const mine = createConversation(bob, "Dinner ideas");
    createConversation(alice, "Alice's private question");

    const ids = listConversations(bob).map((c) => c.id);
    assert.ok(ids.includes(mine.id));
    assert.equal(ids.length, listConversations(bob).length);
    for (const c of listConversations(bob)) {
      assert.notEqual(c.title, "Alice's private question");
    }
  });

  test("one member cannot rename the other's conversation", () => {
    const conv = createConversation(alice, "Original title");

    assert.equal(renameConversation(bob, conv.id, "Hijacked"), false);
    assert.equal(getConversation(alice, conv.id)?.title, "Original title");

    assert.equal(renameConversation(alice, conv.id, "Renamed by owner"), true);
    assert.equal(getConversation(alice, conv.id)?.title, "Renamed by owner");
  });

  test("one member cannot delete the other's conversation", () => {
    const conv = createConversation(alice, "Keep me");
    addMessage(conv.id, "user", "hello");

    assert.equal(deleteConversation(bob, conv.id), false);
    assert.ok(getConversation(alice, conv.id), "still there after a refused delete");
    assert.equal(listMessages(conv.id).length, 1, "and its messages are untouched");
  });

  test("acting on an id that doesn't exist reports false rather than throwing", () => {
    assert.equal(renameConversation(alice, "conv-nope", "x"), false);
    assert.equal(deleteConversation(alice, "conv-nope"), false);
    assert.equal(getConversation(alice, "conv-nope"), undefined);
  });
});

describe("deleting a conversation takes its messages with it", () => {
  test("messages are removed, not orphaned", () => {
    // Orphaned message rows would keep the transcript's contents in the file
    // (and in every daily backup) after the user believed they deleted it.
    const conv = createConversation(alice, "Delete me");
    addMessage(conv.id, "user", "how much did we spend at Costco");
    addMessage(conv.id, "assistant", "You spent $214.86 at Costco.");
    assert.equal(listMessages(conv.id).length, 2);

    assert.equal(deleteConversation(alice, conv.id), true);
    assert.equal(listMessages(conv.id).length, 0);
    assert.equal(getConversation(alice, conv.id), undefined);
  });
});

describe("messages round-trip", () => {
  test("returns messages oldest-first, which is replay order", () => {
    const conv = createConversation(alice, "Ordering");
    addMessage(conv.id, "user", "first");
    addMessage(conv.id, "assistant", "second");
    addMessage(conv.id, "user", "third");

    assert.deepEqual(
      listMessages(conv.id).map((m) => m.content),
      ["first", "second", "third"]
    );
  });

  test("tool calls and results survive the JSON round trip", () => {
    // server.ts replays these as real role:"tool" wire messages, so the shape
    // has to come back exactly as stored -- not stringified twice, not null.
    const conv = createConversation(alice, "Tools");
    const calls = [{ tool: "get_shopping_list", args: { list: "Weekly Groceries" } }];
    const results = [{ tool: "get_shopping_list", result: { name: "Weekly Groceries", items: [{ name: "Milk" }] } }];

    addMessage(conv.id, "assistant", "You need milk.", calls, results);

    const [stored] = listMessages(conv.id);
    assert.deepEqual(stored.toolCalls, calls);
    assert.deepEqual(stored.toolResults, results);
    assert.equal(stored.role, "assistant");
  });

  test("a tool error is preserved distinctly from a result", () => {
    const conv = createConversation(alice, "Tool error");
    addMessage(conv.id, "assistant", "That list doesn't exist.", [{ tool: "get_shopping_list", args: { list: "nope" } }], [
      { tool: "get_shopping_list", error: 'No shopping list named "nope".' },
    ]);

    const [stored] = listMessages(conv.id);
    assert.equal(stored.toolResults?.[0].error, 'No shopping list named "nope".');
    assert.equal(stored.toolResults?.[0].result, undefined);
  });

  test("a message with no tools stores null, not an empty array", () => {
    // server.ts's replay checks `m.toolCalls?.map(...)`, so the absence has to
    // be a real absence rather than something that maps to an empty list.
    const conv = createConversation(alice, "No tools");
    addMessage(conv.id, "user", "just prose");

    const [stored] = listMessages(conv.id);
    assert.equal(stored.toolCalls, null);
    assert.equal(stored.toolResults, null);
  });

  test("content with quotes and newlines is not mangled", () => {
    const conv = createConversation(alice, "Escaping");
    const gnarly = 'She said "it\'s $4.50" \\ then\nnewline\ttab';
    addMessage(conv.id, "user", gnarly);
    assert.equal(listMessages(conv.id)[0].content, gnarly);
  });

  test("messages belong to exactly one conversation", () => {
    const a = createConversation(alice, "A");
    const b = createConversation(alice, "B");
    addMessage(a.id, "user", "in A");
    addMessage(b.id, "user", "in B");

    assert.deepEqual(listMessages(a.id).map((m) => m.content), ["in A"]);
    assert.deepEqual(listMessages(b.id).map((m) => m.content), ["in B"]);
  });
});

describe("recency ordering", () => {
  test("touchConversation moves a conversation to the front of the list", async () => {
    // listConversations orders by updated_at, so the dropdown shows what was
    // actually used last rather than what was created last.
    const older = createConversation(bob, "Older");
    await new Promise((r) => setTimeout(r, 5));
    const newer = createConversation(bob, "Newer");

    assert.equal(listConversations(bob)[0].id, newer.id);

    await new Promise((r) => setTimeout(r, 5));
    addMessage(older.id, "user", "still talking about this one");
    touchConversation(older.id);

    assert.equal(listConversations(bob)[0].id, older.id, "the touched conversation should sort first");
  });
});

describe("createConversation", () => {
  test("hands back a usable row with matching timestamps", () => {
    const conv = createConversation(alice, "Fresh");
    assert.ok(conv.id.startsWith("conv-"));
    assert.equal(conv.createdAt, conv.updatedAt);
    assert.deepEqual(getConversation(alice, conv.id), conv);
  });

  test("two conversations never share an id", () => {
    const ids = new Set(Array.from({ length: 50 }, () => createConversation(alice, "dupe check").id));
    assert.equal(ids.size, 50);
  });
});
