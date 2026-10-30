// Claude as a Provider, talking to the Messages API directly over fetch --
// no SDK dependency, matching ollama.ts's existing style and avoiding an npm
// install on a FAT32 drive that can't do workspace links anyway (see PLAN.md
// Stage 0.5/1).
//
// Anthropic's tool loop shape differs from Ollama's: there's no "tool" role.
// A model turn that calls tools comes back as content blocks (text +
// tool_use); the reply goes back as a "user" message carrying tool_result
// blocks keyed by tool_use_id. This function owns that translation and
// exposes the same ChatResult shape everyone else does.

// Must be the first import -- see env.ts. Without this, ANTHROPIC_MODEL/
// API_KEY below can be read before server.ts's dotenv setup has loaded
// .env.local.
import "../../env.ts";

import type { ToolDefinition } from "../../ollama.ts";
import { ProviderUnavailableError, type ChatResult, type Provider, type ToolStep } from "./types.ts";

export const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";
const API_KEY = process.env.ANTHROPIC_API_KEY || "";
const API_URL = "https://api.anthropic.com/v1/messages";
// Raised from 1024 -- too small a budget was the main practical cause of the
// max_tokens truncation this file now has to detect (the project notes bug #1).
const MAX_TOKENS = 2048;

export function anthropicConfigured(): boolean {
  return API_KEY.length > 0;
}

type AnthropicBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, any> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicBlock[];
}

async function anthropicConnect(body: unknown, signal?: AbortSignal, attempt = 1): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err: any) {
    // A caller-initiated abort (Stage 3's Stop button) is not "unreachable" --
    // let it propagate as-is so the caller can tell the two apart.
    if (err?.name === "AbortError") throw err;
    throw new ProviderUnavailableError("anthropic", "Couldn't reach the Anthropic API -- check network connectivity.");
  }

  if (response.status === 401) {
    throw new ProviderUnavailableError("anthropic", "ANTHROPIC_API_KEY looks invalid -- check .env.local.");
  }
  // 429 (rate limited) and 529 (overloaded) are transient -- Ollama's 503 retry
  // already covers its own equivalent; Anthropic and Gemini didn't (the project notes bug #5).
  if ((response.status === 429 || response.status === 529) && attempt <= 3) {
    console.warn(`Anthropic returned ${response.status} (attempt ${attempt}/3). Retrying in ${attempt * 1000}ms...`);
    await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    return anthropicConnect(body, signal, attempt + 1);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    // Out of API credit comes back as a 400 invalid_request_error, not a 402 --
    // match the message so the user sees the fix instead of "something went
    // wrong". A Claude.ai subscription doesn't fund the API; that's billed
    // separately in the Anthropic Console.
    if (response.status === 400 && /credit balance is too low/i.test(text)) {
      throw new ProviderUnavailableError(
        "anthropic",
        "Claude's API account is out of credit -- add credits at console.anthropic.com (Plans & Billing), or pick Ollama for now. A Claude.ai subscription doesn't cover the API."
      );
    }
    throw new Error(`Anthropic request failed with status ${response.status}: ${text.slice(0, 300)}`);
  }
  return response;
}

/**
 * Streams one round of the Messages API (`stream: true`) and returns the same
 * shape the old one-shot JSON response had (`content` blocks, `stop_reason`),
 * so the caller below didn't need to change. Anthropic's SSE stream builds
 * each content block incrementally by index: text blocks arrive as
 * `text_delta` pieces (streamed out via onDelta as they land); tool_use
 * blocks arrive as `input_json_delta` pieces of a partial JSON string that
 * only parses cleanly once complete, at `content_block_stop`.
 */
async function anthropicStream(
  body: Record<string, unknown>,
  signal: AbortSignal | undefined,
  onDelta: ((text: string) => void) | undefined
): Promise<{ content: AnthropicBlock[]; stop_reason: string | null }> {
  const response = await anthropicConnect({ ...body, stream: true }, signal);
  const reader = response.body?.getReader();
  if (!reader) {
    // No streaming body available (e.g. a test double) -- fall back to a
    // single JSON parse of the whole response.
    const data = await response.json();
    for (const block of data.content || []) {
      if (block.type === "text" && block.text) onDelta?.(block.text);
    }
    return { content: data.content || [], stop_reason: data.stop_reason ?? null };
  }

  const decoder = new TextDecoder();
  let buffer = "";
  const blocks: AnthropicBlock[] = [];
  const partialJson: Record<number, string> = {};
  let stopReason: string | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let eventEnd: number;
    while ((eventEnd = buffer.indexOf("\n\n")) !== -1) {
      const rawEvent = buffer.slice(0, eventEnd);
      buffer = buffer.slice(eventEnd + 2);

      let eventType = "";
      let dataStr = "";
      for (const line of rawEvent.split("\n")) {
        if (line.startsWith("event:")) eventType = line.slice(6).trim();
        else if (line.startsWith("data:")) dataStr += line.slice(5).trim();
      }
      if (!dataStr) continue;
      const evt = JSON.parse(dataStr);

      if (eventType === "content_block_start") {
        const block = evt.content_block;
        if (block.type === "text") blocks[evt.index] = { type: "text", text: block.text || "" };
        else if (block.type === "tool_use") {
          blocks[evt.index] = { type: "tool_use", id: block.id, name: block.name, input: {} };
          partialJson[evt.index] = "";
        }
      } else if (eventType === "content_block_delta") {
        const delta = evt.delta;
        if (delta.type === "text_delta") {
          const b = blocks[evt.index] as Extract<AnthropicBlock, { type: "text" }>;
          b.text += delta.text;
          onDelta?.(delta.text);
        } else if (delta.type === "input_json_delta") {
          partialJson[evt.index] = (partialJson[evt.index] || "") + delta.partial_json;
        }
      } else if (eventType === "content_block_stop") {
        if (partialJson[evt.index] !== undefined) {
          const b = blocks[evt.index] as Extract<AnthropicBlock, { type: "tool_use" }>;
          try {
            b.input = partialJson[evt.index] ? JSON.parse(partialJson[evt.index]) : {};
          } catch {
            // Left as {} -- the tool itself reports missing/bad args.
          }
        }
      } else if (eventType === "message_delta") {
        stopReason = evt.delta?.stop_reason ?? stopReason;
      } else if (eventType === "error") {
        throw new Error(evt.error?.message || "Anthropic stream error");
      }
    }
  }

  return { content: blocks.filter(Boolean), stop_reason: stopReason };
}

export const anthropicProvider: Provider = {
  id: "anthropic",
  label: `Claude (${ANTHROPIC_MODEL})`,
  async chat(messages, tools, opts): Promise<ChatResult> {
    if (!anthropicConfigured()) {
      throw new ProviderUnavailableError("anthropic", "ANTHROPIC_API_KEY is not set in .env.local.");
    }

    const maxRounds = opts?.maxRounds ?? 8;
    const system = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    const conversation: AnthropicMessage[] = messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

    const anthropicTools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));

    const steps: ToolStep[] = [];

    for (let round = 0; round < maxRounds; round++) {
      const { content: blocks, stop_reason } = await anthropicStream(
        {
          model: ANTHROPIC_MODEL,
          max_tokens: MAX_TOKENS,
          system,
          messages: conversation,
          tools: anthropicTools,
        },
        opts?.signal,
        opts?.onDelta
      );

      const toolUses = blocks.filter((b) => b.type === "tool_use") as Extract<
        AnthropicBlock,
        { type: "tool_use" }
      >[];
      const text = blocks
        .filter((b): b is Extract<AnthropicBlock, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("");

      if (toolUses.length === 0) {
        // the project notes bug #1: a max_tokens cutoff with no tool call in
        // flight means `text` is a genuinely incomplete answer, not a finished
        // one -- say so rather than returning it as if the model were done.
        // (A tool_use block that itself got cut off is not possible here:
        // Anthropic only emits one once its input is fully-formed JSON.)
        if (stop_reason === "max_tokens") {
          return { reply: text + "\n\n[Response was cut off before finishing.]", steps, exhausted: true };
        }
        return { reply: text, steps, exhausted: false };
      }

      conversation.push({ role: "assistant", content: blocks });

      const resultBlocks: AnthropicBlock[] = [];
      for (const call of toolUses) {
        const tool = findTool(tools, call.name);
        opts?.onToolStart?.({ tool: call.name, args: call.input });
        if (!tool) {
          const error = `No such tool: ${call.name}`;
          const step = { tool: call.name, args: call.input, result: null, error };
          steps.push(step);
          opts?.onToolEnd?.(step);
          resultBlocks.push({ type: "tool_result", tool_use_id: call.id, content: JSON.stringify({ error }), is_error: true });
          continue;
        }
        try {
          const result = await tool.run(call.input || {});
          const step = { tool: tool.name, args: call.input, result };
          steps.push(step);
          opts?.onToolEnd?.(step);
          resultBlocks.push({ type: "tool_result", tool_use_id: call.id, content: JSON.stringify(result) });
        } catch (err: any) {
          const error = err?.message || String(err);
          const step = { tool: tool.name, args: call.input, result: null, error };
          steps.push(step);
          opts?.onToolEnd?.(step);
          resultBlocks.push({ type: "tool_result", tool_use_id: call.id, content: JSON.stringify({ error }), is_error: true });
        }
      }
      conversation.push({ role: "user", content: resultBlocks });
    }

    return {
      reply: "I wasn't able to finish that -- I kept needing more information and ran out of steps.",
      steps,
      exhausted: true,
    };
  },
};

function findTool(tools: ToolDefinition[], name: string): ToolDefinition | undefined {
  return tools.find((t) => t.name === name);
}
