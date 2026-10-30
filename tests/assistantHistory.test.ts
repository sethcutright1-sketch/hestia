// assistant/history.ts -- how a stored conversation is replayed to the model, shared by server.ts and the eval.
//
// The point of the wrapper: a replayed tool result used to look current, and the local model answered "what's on the
// list right now?" from it without calling the tool (eval case #93). The tests pin that every replayed result carries
// the earlier-result note while the original result stays whole inside it ("add that to the list" still needs it).

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { replayStoredMessages, earlierToolResult, EARLIER_RESULT_NOTE, type ReplayableMessage } from "../assistant/history.ts";

const LIST = { name: "Weekly Groceries", items: [{ name: "Bananas" }, { name: "Greek yogurt" }] };

const chat: ReplayableMessage[] = [
  { role: "user", content: "add bananas and greek yogurt to Weekly Groceries" },
  {
    role: "assistant",
    content: "Added both. The list has bananas and Greek yogurt.",
    toolCalls: [
      { tool: "add_shopping_item", args: { list: "Weekly Groceries", name: "Bananas" } },
      { tool: "get_shopping_list", args: { list: "Weekly Groceries" } },
    ],
    toolResults: [
      { tool: "add_shopping_item", result: { added: "Bananas" } },
      { tool: "get_shopping_list", result: LIST },
    ],
  },
];

describe("replayStoredMessages", () => {
  test("replays the user turn, then the assistant turn with its tool calls, then one tool message per result, in order", () => {
    const out = replayStoredMessages(chat);
    assert.deepEqual(
      out.map((m) => m.role),
      ["user", "assistant", "tool", "tool"]
    );
    assert.deepEqual(out[1].tool_calls, [
      { function: { name: "add_shopping_item", arguments: { list: "Weekly Groceries", name: "Bananas" } } },
      { function: { name: "get_shopping_list", arguments: { list: "Weekly Groceries" } } },
    ]);
  });

  test("user and assistant prose come through unchanged", () => {
    const out = replayStoredMessages(chat);
    assert.equal(out[0].content, "add bananas and greek yogurt to Weekly Groceries");
    assert.equal(out[1].content, "Added both. The list has bananas and Greek yogurt.");
  });

  test("a tool result is wrapped with the earlier-result note and keeps the whole original result", () => {
    const out = replayStoredMessages(chat);
    assert.deepEqual(JSON.parse(out[2].content), { earlierResult: EARLIER_RESULT_NOTE, result: { added: "Bananas" } });
    assert.deepEqual(JSON.parse(out[3].content), { earlierResult: EARLIER_RESULT_NOTE, result: LIST });
  });

  test("an error result is wrapped too, as {error}", () => {
    const out = replayStoredMessages([
      { role: "user", content: "show the list" },
      {
        role: "assistant",
        content: "That list doesn't exist.",
        toolCalls: [{ tool: "get_shopping_list", args: { list: "nope" } }],
        toolResults: [{ tool: "get_shopping_list", error: 'No shopping list named "nope".' }],
      },
    ]);
    assert.deepEqual(JSON.parse(out[2].content), {
      earlierResult: EARLIER_RESULT_NOTE,
      result: { error: 'No shopping list named "nope".' },
    });
  });

  test("the note tells the model the result may be out of date and to call the tool again", () => {
    assert.match(EARLIER_RESULT_NOTE, /earlier in this chat/i);
    assert.match(EARLIER_RESULT_NOTE, /out of date/i);
    assert.match(EARLIER_RESULT_NOTE, /call the tool again/i);
  });

  test("an assistant turn with no tools adds no tool messages and no tool_calls", () => {
    const out = replayStoredMessages([
      { role: "user", content: "hi" },
      { role: "assistant", content: "Hello!", toolCalls: null, toolResults: null },
    ]);
    assert.deepEqual(out, [
      { role: "user", content: "hi" },
      { role: "assistant", content: "Hello!", tool_calls: undefined },
    ]);
  });

  test("several turns keep their order, each result following its own assistant message", () => {
    const out = replayStoredMessages([
      ...chat,
      { role: "user", content: "thanks" },
      { role: "assistant", content: "Anytime." },
    ]);
    assert.deepEqual(
      out.map((m) => m.role),
      ["user", "assistant", "tool", "tool", "user", "assistant"]
    );
    assert.equal(out[5].content, "Anytime.");
  });

  test("an empty history replays to nothing", () => {
    assert.deepEqual(replayStoredMessages([]), []);
  });

  test("earlierToolResult wraps a result and an error the same way", () => {
    assert.deepEqual(JSON.parse(earlierToolResult({ result: [1, 2] })), { earlierResult: EARLIER_RESULT_NOTE, result: [1, 2] });
    assert.deepEqual(JSON.parse(earlierToolResult({ error: "boom" })), { earlierResult: EARLIER_RESULT_NOTE, result: { error: "boom" } });
  });
});
