// Replays stored conversation history to a model. Its own module (not inline in server.ts, which calls app.listen() at
// import time) so scripts/eval-assistant.ts sends the model exactly what production sends -- one function, no second
// copy to drift -- and so the shape is unit-testable.
//
// An assistant turn's tool calls and results are replayed as real role:"tool" wire messages, the shape chatWithTools
// already produces and consumes live within one request, now replayed across requests too. That is what makes "add
// that to the list" work: the model can see the tool's real result, not just whatever its prose happened to restate.
// Anthropic/Gemini's adapters filter incoming messages down to user/assistant, so role:"tool" entries are a silent
// no-op there -- a strict improvement for Ollama, not a regression for the other two.
//
// The cost of replaying a result is that the model reads it as current. Asked "what's on the Weekly Groceries list
// right now?" after the list had changed, gemma4:12b answered from the replayed get_shopping_list result without calling
// the tool (eval case #93, 5/5 runs). So every replayed result is wrapped with a note saying it is from earlier and may
// be stale -- the original result stays whole inside it -- and the system prompt carries the matching rule.

import type { ChatMessage } from "../ollama.ts";

/** The note carried by every replayed tool result. Exported so tests and the prompt rule can be checked against it. */
export const EARLIER_RESULT_NOTE =
  "From earlier in this chat -- it may be out of date. Call the tool again before answering about the current state.";

/** The part of a stored message (db.ts's StoredMessage) that replay needs; anything that supplies these can be replayed. */
export interface ReplayableMessage {
  role: "user" | "assistant";
  content: string;
  toolCalls?: { tool: string; args: Record<string, any> }[] | null;
  toolResults?: { tool: string; result?: unknown; error?: string }[] | null;
}

/** The content of one replayed role:"tool" message: the stored result (or {error}) inside the earlier-result note. */
export function earlierToolResult(r: { result?: unknown; error?: string }): string {
  return JSON.stringify({ earlierResult: EARLIER_RESULT_NOTE, result: r.error ? { error: r.error } : r.result });
}

/** Stored messages, oldest first, as the ChatMessage[] that goes to the model between the system prompt and the new question. */
export function replayStoredMessages(messages: ReplayableMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.content });
      continue;
    }
    out.push({
      role: "assistant",
      content: m.content,
      tool_calls: m.toolCalls?.map((c) => ({ function: { name: c.tool, arguments: c.args } })),
    });
    for (const r of m.toolResults || []) out.push({ role: "tool", content: earlierToolResult(r) });
  }
  return out;
}
