// Shared Ollama client for every app in the suite.
//
// Two calling styles live here:
//   generateJson()   - one-shot prompt -> JSON, lifted from Budget Sync's
//                      generateContentWithRetry (server.ts:291). Used by sub-apps
//                      for their own in-app AI features.
//   chatWithTools()  - multi-turn loop where the model can call functions we
//                      provide. Used by the dashboard orchestrator to reach the
//                      other apps' data endpoints.

// Must be the first import -- see env.ts. Without this, the process.env reads
// just below can run before server.ts's dotenv setup has loaded .env.local
// (ES module imports are fully evaluated before the importing module's own
// later statements, including whichever line happens to import this file).
import "./env.ts";

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3.1";

// Sent with every request rather than left to the Ollama server's own default. A bare `ollama serve` gives a
// model only a few thousand tokens of context, while the assistant's system prompt plus its tool definitions are
// about 8,800 tokens -- Ollama then silently cuts the start of the request ("truncating input prompt"), so the
// model loses its instructions and most of its tools, and can ramble without end (found in the Nutrition phase 6
// review). 16,384 fits the prompt, the tools and a conversation; llama3.1 supports far more. NUM_PREDICT caps one
// reply so a model that starts repeating itself stops instead of generating forever.
const OLLAMA_NUM_CTX = Number(process.env.OLLAMA_NUM_CTX) || 16384;
const OLLAMA_NUM_PREDICT = Number(process.env.OLLAMA_NUM_PREDICT) || 1024;

// Whether the model should "think" before answering. Newer models (qwen3.5, gemma4, bonsai-2) think by default, and
// those thinking tokens are generated before the visible reply, so they eat the OLLAMA_NUM_PREDICT budget above and
// slow every turn. Ollama takes this as a top-level `think` field on the request (NOT inside `options`). Unset or
// empty sends nothing at all, which is today's behavior and what older models like llama3.1 need -- some of them
// reject the field outright. Accepted: false/off/0, true/on/1, or the effort levels low/medium/high. Anything else
// is treated as unset (with one warning) rather than guessed at.
// This applies to the conversational chat tool loop ONLY. The one-shot JSON helper (generateJson) is for structured
// side jobs (recipe parsing, calorie estimates, categorizing) that have short timeouts, and reasoning there only
// costs time and is never shown, so it never thinks no matter what this is set to. See jsonThinkField below.
export type OllamaThink = boolean | "low" | "medium" | "high";

export function parseOllamaThink(raw: string | undefined): OllamaThink | undefined {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "false" || value === "off" || value === "0") return false;
  if (value === "true" || value === "on" || value === "1") return true;
  if (value === "low" || value === "medium" || value === "high") return value;
  return undefined;
}

const OLLAMA_THINK = parseOllamaThink(process.env.OLLAMA_THINK);
// Module load runs once, so this warns once. Empty/unset is the normal "leave it to the model" case, not a typo.
if (OLLAMA_THINK === undefined && (process.env.OLLAMA_THINK ?? "").trim() !== "") {
  console.warn(
    `Ignoring OLLAMA_THINK="${process.env.OLLAMA_THINK}": expected false/off/0, true/on/1, low, medium or high. Not sending \`think\`.`
  );
}
// Spread into a request body so an unset value leaves the key out entirely (undefined would still be dropped by
// JSON.stringify, but spelling it out keeps "no key" obvious).
const thinkField = OLLAMA_THINK === undefined ? {} : { think: OLLAMA_THINK };
// generateJson's version: any valid setting means the operator is running a thinking-capable model, so tell it NOT
// to think; unset/invalid still sends nothing, because older models (llama3.1) reject the field entirely.
const jsonThinkField = OLLAMA_THINK === undefined ? {} : { think: false };

export { OLLAMA_MODEL, OLLAMA_URL, OLLAMA_NUM_CTX, OLLAMA_NUM_PREDICT, OLLAMA_THINK };

// Marks a failure as "Ollama isn't reachable" (not running / not installed) so
// callers can show a setup hint instead of a generic error.
export class OllamaUnavailableError extends Error {
  constructor() {
    super("Ollama is not reachable");
    this.name = "OllamaUnavailableError";
  }
}

// fetch() throws (rather than resolving with a bad status) when the connection
// itself fails, which is what "Ollama isn't installed or running" looks like.
// Everything else -- missing model, server errors -- comes back as a status code.
async function ollamaFetch(endpoint: string, body: unknown, attempt = 1, signal?: AbortSignal): Promise<any> {
  const response = await ollamaFetchRaw(endpoint, body, attempt, signal);
  return response.json();
}

// Shared connection/retry logic between the non-streaming JSON callers
// (generateJson) and chatWithTools' own streaming reader below -- returns the
// raw Response so the streaming caller can read its body incrementally
// instead of buffering the whole thing.
async function ollamaFetchRaw(endpoint: string, body: unknown, attempt = 1, signal?: AbortSignal): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${OLLAMA_URL}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err: any) {
    // A caller-initiated abort (Stage 3's Stop button) is not "Ollama is down" --
    // let it propagate as-is so the caller can tell the two apart.
    if (err?.name === "AbortError") throw err;
    throw new OllamaUnavailableError();
  }

  if (response.status === 404) {
    throw new Error(`Ollama model "${OLLAMA_MODEL}" not found. Run: ollama pull ${OLLAMA_MODEL}`);
  }

  if (!response.ok) {
    // 503 means the model is still loading into memory -- common on the first
    // request after a cold start, and it resolves on its own within seconds.
    if (response.status === 503 && attempt <= 3) {
      console.warn(`Ollama returned 503 (attempt ${attempt}/3). Retrying in ${attempt * 1000}ms...`);
      await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
      return ollamaFetchRaw(endpoint, body, attempt + 1, signal);
    }
    throw new Error(`Ollama request failed with status ${response.status}`);
  }

  return response;
}

/**
 * Reads Ollama's `/api/chat` streaming response -- newline-delimited JSON,
 * one object per line, each carrying an incremental `message.content` piece
 * until the final line (`done: true`) which also carries `message.tool_calls`
 * if the model wants to call anything. A thinking model also streams
 * `message.thinking` chunks; those are deliberately never read, so reasoning
 * text can't leak into the reply or onDelta. Ollama sends the whole tool-call list
 * in that one final chunk rather than building it up incrementally, so only
 * `content` needs streaming out via onDelta -- tool_calls are simply read off
 * the last parsed line.
 */
async function readOllamaChatStream(
  response: Response,
  onDelta?: (text: string) => void
): Promise<OllamaStreamResult> {
  const reader = response.body?.getReader();
  if (!reader) {
    // No streaming body available (e.g. a test double) -- fall back to a
    // single JSON parse of the whole response.
    const data = await response.json();
    const message = data.message || {};
    if (message.content) onDelta?.(message.content);
    return { content: message.content || "", tool_calls: message.tool_calls || [], done_reason: data.done_reason, eval_count: data.eval_count };
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let toolCalls: any[] = [];
  let doneReason: string | undefined;
  let evalCount: number | undefined;

  const consumeLine = (line: string) => {
    if (!line) return;
    const chunk = JSON.parse(line);
    const piece = chunk.message?.content;
    if (piece) {
      content += piece;
      onDelta?.(piece);
    }
    if (chunk.message?.tool_calls?.length) {
      toolCalls = chunk.message.tool_calls;
    }
    // Only the final (`done: true`) chunk carries these.
    if (typeof chunk.done_reason === "string") doneReason = chunk.done_reason;
    if (typeof chunk.eval_count === "number") evalCount = chunk.eval_count;
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      consumeLine(line);
    }
  }

  // The final `done: true` chunk (carrying tool_calls) doesn't always arrive
  // with a trailing newline, so it can still be sitting unparsed in `buffer`
  // here -- flush it instead of silently dropping it.
  buffer += decoder.decode();
  consumeLine(buffer.trim());

  return { content, tool_calls: toolCalls, done_reason: doneReason, eval_count: evalCount };
}

/** What readOllamaChatStream hands back: the turn's text and tool calls, plus how generation ended. */
interface OllamaStreamResult {
  content: string;
  tool_calls: any[];
  /** "stop" or "length" (hit num_predict), from the final chunk. */
  done_reason?: string;
  /** Tokens generated this turn, from the final chunk. */
  eval_count?: number;
}

// A turn that produced real output but nothing we can read. Ollama's gemma4 tool-call parser fails on a long call
// that mixes plain quotes with Gemma's own string tokens ("tool call parsing failed ... repair failed to produce valid
// JSON arguments" in Ollama's log) and then returns an EMPTY message -- no content, no tool_calls -- even though the
// model generated ~1,000 tokens (done_reason "stop"). Replaying a 21-meal create_meal_plan failed 3/3, 9 meals 4/4, one
// day's 3 meals parsed 3/3. Treated as a final answer that reads as an empty reply, which is what the user saw. So
// that is not a final answer: ask once for smaller calls. Below this many tokens an empty turn is just an empty turn.
const SWALLOWED_CALL_MIN_TOKENS = 40;
const UNREADABLE_CALL_NUDGE =
  "(Your last tool call could not be read -- it was probably too long. Make the same change again as several smaller calls, for example one day or a few items per call.)";
const CUT_OFF_NUDGE =
  "(Your last reply was cut off before it finished. Make the same change again as several smaller calls, for example one day or a few items per call.)";
const UNREADABLE_APOLOGY = "Sorry -- I couldn't finish that; my last step came back unreadable. Please try again.";

// One-shot prompt with JSON-constrained output. `signal` lets a caller cancel
// the underlying request (e.g. routes/budget.ts's timeout wrapper aborting the
// in-flight fetch once its own race has already resolved with the fallback).
export async function generateJson(prompt: string, signal?: AbortSignal): Promise<{ text: string }> {
  const data = await ollamaFetch(
    "/api/generate",
    {
      model: OLLAMA_MODEL,
      prompt,
      format: "json",
      stream: false,
      // Never think here, whatever OLLAMA_THINK says: these are structured side jobs with short timeouts (recipeAi's
      // 60 s, budget categorizing), and a model that reasons for thousands of tokens blows the timeout for an answer
      // whose reasoning nobody sees. Only the chat loop (chatWithTools) follows the setting.
      ...jsonThinkField,
      // A JSON answer can be longer than a chat reply (a parsed recipe, a statement's rows), so only the context
      // is set here, not the reply cap.
      options: { num_ctx: OLLAMA_NUM_CTX },
    },
    1,
    signal
  );
  return { text: data.response || "" };
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the arguments the model should supply. */
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  /** Executed when the model calls this tool. Return value is fed back as JSON. */
  run: (args: Record<string, any>) => Promise<unknown>;
  /**
   * True when running this tool changes data. Single source of truth for what
   * counts as a write -- the client reads it from GET /api/assistant/tools rather
   * than keeping its own list, which used to go stale every time a tool was added.
   */
  mutates?: boolean;
  /**
   * Presentation and grouping only: it generates the system prompt's section list
   * and groups tools in the UI. It must never be the thing a security or privacy
   * decision reads -- use `sensitivity` for that.
   */
  domain: string;
  /**
   * The single field every privacy and safety decision reads. Kept separate from
   * `domain` because a tool can be financial without living in the budget section,
   * and a boundary that depends on a string chosen for UI grouping is one that
   * will eventually be crossed by accident.
   */
  sensitivity: "household" | "financial" | "health";
}

/**
 * Repairs arguments that arrive as JSON text instead of structure.
 *
 * llama3.1 reliably hands back nested arrays as strings -- a `meals` array comes
 * through as "[{\"day\":\"Monday\"...}]" rather than a real array -- so calling
 * .map() on it throws. Larger models get this right, so this is a compatibility
 * shim keyed off each tool's own schema rather than a fix belonging in any one
 * tool. Anything that won't parse is passed through untouched for the tool to
 * reject on its own terms.
 */
export function coerceArgs(
  args: Record<string, any>,
  parameters: ToolDefinition["parameters"]
): Record<string, any> {
  const properties = parameters?.properties || {};
  const out: Record<string, any> = { ...args };

  for (const [key, schema] of Object.entries(properties)) {
    const expected = (schema as any)?.type;
    if (expected !== "array" && expected !== "object") continue;
    if (typeof out[key] !== "string") continue;

    try {
      const parsed = JSON.parse(out[key]);
      const actual = Array.isArray(parsed) ? "array" : typeof parsed;
      if (actual === expected) out[key] = parsed;
    } catch {
      // JSON.parse fails on llama3.1's other favorite malformation: a
      // Python-style list with single-quoted elements, e.g.
      // "['2026-09-05', '2026-09-06']". JSON requires double quotes, so this
      // throws every time. Only array-typed params get a fallback here --
      // there's no safe comma-splitting equivalent for an object, so those
      // are left as the string for the tool to reject on its own terms.
      if (expected === "array") {
        const coerced = coerceStringList(out[key]);
        if (coerced) out[key] = coerced;
      }
      // Leave it as the string it was; the tool reports the problem itself.
    }
  }

  return out;
}

/**
 * Turns a Python-style stringified list, e.g. "['a', \"Bob's birthday\"]",
 * into a real string array. Deliberately dumb: no general JSON repair, and
 * no blanket quote-swapping -- a legitimate apostrophe inside an element
 * (like "Bob's birthday") must survive untouched, so we only strip one
 * matching pair of surrounding quotes per element rather than rewriting
 * quote characters anywhere in the string. Returns null if the input
 * doesn't look list-shaped, so the caller leaves the original value alone.
 *
 * The split is quote-aware: a comma inside a quoted element (e.g. an
 * ingredient like "beef, diced") does not end the element -- a naive
 * `split(",")` would silently turn one ingredient into two. We also track
 * bracket/brace nesting depth while walking so a `[` or `{` inside an
 * element doesn't get mis-split before we can reject it below: this is a
 * flat-list-of-scalars coercion only, so any element that turns out to be
 * an object or nested array makes the whole thing return null rather than
 * have us guess at reconstructing it. A clean failure the caller leaves
 * untouched -- and the tool then rejects on its own terms -- is strictly
 * better than silently inventing or dropping data (e.g. every meal in a
 * `create_meal_plan` call going missing with no explanation).
 *
 * A single-quoted element can itself contain an apostrophe -- "'Bob's cake,
 * iced'" -- which is ambiguous with a real closing quote by character alone.
 * We resolve it structurally: a quote char only closes the element if what
 * follows (after whitespace) is a comma or the end of the list; otherwise
 * it's punctuation inside the word and we stay inside the quoted element.
 */
function looksLikeClosingQuote(inner: string, quoteIndex: number): boolean {
  let j = quoteIndex + 1;
  while (j < inner.length && /\s/.test(inner[j])) j++;
  return j >= inner.length || inner[j] === ",";
}

function coerceStringList(value: string): string[] | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return null;

  const inner = trimmed.slice(1, -1).trim();
  if (inner === "") return [];

  const rawElements: string[] = [];
  let current = "";
  let quoteChar: "'" | '"' | null = null;
  let depth = 0;

  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];

    if (quoteChar) {
      current += ch;
      if (ch === quoteChar && looksLikeClosingQuote(inner, i)) quoteChar = null;
      continue;
    }

    if (ch === "'" || ch === '"') {
      quoteChar = ch;
      current += ch;
    } else if (ch === "[" || ch === "{") {
      depth++;
      current += ch;
    } else if (ch === "]" || ch === "}") {
      depth--;
      current += ch;
    } else if (ch === "," && depth === 0) {
      rawElements.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  rawElements.push(current);

  // An unterminated quote or unbalanced bracket means the string isn't the
  // flat list we assumed -- bail rather than emit a bogus split.
  if (quoteChar !== null || depth !== 0) return null;

  const elements = rawElements.map((el) => el.trim()).filter((el) => el !== "");

  for (const e of elements) {
    if (e.startsWith("{") || e.startsWith("[")) return null;
  }

  return elements.map((e) => {
    if (
      (e.startsWith("'") && e.endsWith("'") && e.length >= 2) ||
      (e.startsWith('"') && e.endsWith('"') && e.length >= 2)
    ) {
      return e.slice(1, -1);
    }
    return e;
  });
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: { function: { name: string; arguments: Record<string, any> } }[];
}

/** One tool invocation, surfaced so the UI can show what the assistant actually did. */
export interface ToolStep {
  tool: string;
  args: Record<string, any>;
  result: unknown;
  error?: string;
}

export interface ChatResult {
  reply: string;
  steps: ToolStep[];
  /** True if the loop hit maxRounds with the model still wanting to call tools. */
  exhausted: boolean;
}

/**
 * Runs the model in a loop: it may call tools, we execute them, feed the results
 * back, and repeat until it answers in prose.
 *
 * maxRounds is a hard stop. A local model that gets confused will happily call
 * the same tool forever, and each round is a full generation -- without a cap a
 * single question can hang for minutes.
 */
export async function chatWithTools(
  messages: ChatMessage[],
  tools: ToolDefinition[],
  maxRounds = 8,
  signal?: AbortSignal,
  onDelta?: (text: string) => void,
  onToolStart?: (call: { tool: string; args: Record<string, any> }) => void,
  onToolEnd?: (step: ToolStep) => void
): Promise<ChatResult> {
  const toolsByName = new Map(tools.map((t) => [t.name, t]));
  const wireTools = tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));

  const conversation: ChatMessage[] = [...messages];
  const steps: ToolStep[] = [];
  let askedForSmallerCalls = false;

  for (let round = 0; round < maxRounds; round++) {
    const response = await ollamaFetchRaw(
      "/api/chat",
      {
        model: OLLAMA_MODEL,
        messages: conversation,
        tools: wireTools,
        stream: true,
        ...thinkField,
        // Low temperature: this loop reports tool results as fact, so creative
        // phrasing is fine but inventing details (extra items, numbers) is not.
        // num_ctx / num_predict: see OLLAMA_NUM_CTX at the top of this file.
        options: { temperature: 0.1, num_ctx: OLLAMA_NUM_CTX, num_predict: OLLAMA_NUM_PREDICT },
      },
      1,
      signal
    );
    const { content, tool_calls: toolCalls, done_reason: doneReason, eval_count: evalCount } = await readOllamaChatStream(response, onDelta);

    if (toolCalls.length === 0) {
      // Nothing readable came back. If the model did generate something (a swallowed tool call, see above) or was
      // cut off at the token cap, that is not the answer: ask once for smaller calls rather than return "".
      const empty = content.trim() === "";
      const cutOff = doneReason === "length";
      if (empty && (cutOff || (evalCount ?? 0) > SWALLOWED_CALL_MIN_TOKENS)) {
        if (!askedForSmallerCalls) {
          askedForSmallerCalls = true;
          conversation.push({ role: "user", content: cutOff ? CUT_OFF_NUDGE : UNREADABLE_CALL_NUDGE });
          continue;
        }
        onDelta?.(UNREADABLE_APOLOGY);
        return { reply: UNREADABLE_APOLOGY, steps, exhausted: false };
      }
      // The retry itself came back blank (and not obviously cut off): still never hand back an empty reply.
      if (empty && askedForSmallerCalls) {
        onDelta?.(UNREADABLE_APOLOGY);
        return { reply: UNREADABLE_APOLOGY, steps, exhausted: false };
      }
      return { reply: content, steps, exhausted: false };
    }

    conversation.push({ role: "assistant", content, tool_calls: toolCalls });

    for (const call of toolCalls) {
      const name = call.function?.name;
      // Ollama hands back `arguments` already parsed into an object, unlike the
      // OpenAI wire format where it arrives as a JSON string. Don't JSON.parse it.
      const args = call.function?.arguments || {};
      const tool = name ? toolsByName.get(name) : undefined;
      onToolStart?.({ tool: String(name), args });

      if (!tool) {
        // Models invent tool names. Tell it so plainly rather than throwing --
        // it usually recovers and picks a real one on the next round.
        const error = `No such tool: ${name}`;
        const step = { tool: String(name), args, result: null, error };
        steps.push(step);
        onToolEnd?.(step);
        conversation.push({ role: "tool", content: JSON.stringify({ error }) });
        continue;
      }

      try {
        const result = await tool.run(coerceArgs(args, tool.parameters));
        const step = { tool: tool.name, args, result };
        steps.push(step);
        onToolEnd?.(step);
        conversation.push({ role: "tool", content: JSON.stringify(result) });
      } catch (err: any) {
        const error = err?.message || String(err);
        const step = { tool: tool.name, args, result: null, error };
        steps.push(step);
        onToolEnd?.(step);
        conversation.push({ role: "tool", content: JSON.stringify({ error }) });
      }
    }
  }

  return {
    reply: "I wasn't able to finish that -- I kept needing more information and ran out of steps.",
    steps,
    exhausted: true,
  };
}
