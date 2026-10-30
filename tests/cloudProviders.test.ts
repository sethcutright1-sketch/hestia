// The Anthropic and Gemini adapters, against a stubbed fetch.
//
// These two were the subject of the 2026-09-02 provider-adapter review, and
// three of its five findings were fixed with nothing to hold the fix in place
// (the project notes items #1, #4, #5). This file is that hold: the
// max_tokens cutoff detection, the transient-error retry, and the abort
// passthrough are each asserted here rather than being taken on faith.
//
// Both adapters also have to translate the app's single ChatMessage shape into
// their own wire format -- Anthropic's tool_use/tool_result blocks, Gemini's
// functionCall/functionResponse parts. That translation is the part most
// likely to rot quietly, since it only shows up as the model losing track of
// what a tool said.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import type { ChatMessage, ToolDefinition } from "../ollama.ts";

// env.ts first, then the keys -- dotenv loads .env.local with override: true,
// and this checkout deliberately leaves both keys blank (they live on the D:
// instance), so an assignment made before that load would be wiped.
import "../env.ts";

process.env.ANTHROPIC_API_KEY = "test-key-anthropic";
process.env.GEMINI_API_KEY = "test-key-gemini";

// Dynamic, so the assignments above land before each module's top-level
// `const API_KEY = process.env...` runs. A static import would capture "".
const { anthropicProvider, anthropicConfigured } = await import("../assistant/providers/anthropic.ts");
const { geminiProvider, geminiConfigured } = await import("../assistant/providers/gemini.ts");
const { ProviderUnavailableError } = await import("../assistant/providers/types.ts");

const realFetch = globalThis.fetch;
let requests: { url: string; body: any; headers: any; signal?: AbortSignal | null }[] = [];

function sse(events: { event?: string; data: unknown }[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const e of events) {
        const prefix = e.event ? `event: ${e.event}\n` : "";
        controller.enqueue(new TextEncoder().encode(`${prefix}data: ${JSON.stringify(e.data)}\n\n`));
      }
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

function stubFetch(responses: (Response | (() => Response | Promise<Response>))[]): void {
  let i = 0;
  globalThis.fetch = (async (url: any, init: any) => {
    requests.push({
      url: String(url),
      body: init?.body ? JSON.parse(init.body) : undefined,
      headers: init?.headers,
      signal: init?.signal,
    });
    const next = responses[Math.min(i, responses.length - 1)];
    i++;
    return typeof next === "function" ? next() : next;
  }) as typeof fetch;
}

function tool(name: string, run: ToolDefinition["run"]): ToolDefinition {
  return {
    name,
    description: `${name} (test fixture)`,
    parameters: { type: "object", properties: { q: { type: "string" } } },
    run,
    domain: "test",
    sensitivity: "household",
  };
}

const ask: ChatMessage[] = [
  { role: "system", content: "You are the household assistant." },
  { role: "user", content: "what's on the list" },
];

beforeEach(() => {
  requests = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

// ---- Anthropic -------------------------------------------------------------

/** A finished Anthropic turn: streamed text, then a stop reason. */
function claudeText(text: string, stopReason = "end_turn"): Response {
  return sse([
    { event: "content_block_start", data: { index: 0, content_block: { type: "text", text: "" } } },
    { event: "content_block_delta", data: { index: 0, delta: { type: "text_delta", text } } },
    { event: "content_block_stop", data: { index: 0 } },
    { event: "message_delta", data: { delta: { stop_reason: stopReason } } },
  ]);
}

/** An Anthropic turn that calls one tool, with its input streamed as partial JSON. */
function claudeToolUse(name: string, input: Record<string, any>, id = "toolu_01"): Response {
  const json = JSON.stringify(input);
  return sse([
    { event: "content_block_start", data: { index: 0, content_block: { type: "tool_use", id, name } } },
    { event: "content_block_delta", data: { index: 0, delta: { type: "input_json_delta", partial_json: json.slice(0, 4) } } },
    { event: "content_block_delta", data: { index: 0, delta: { type: "input_json_delta", partial_json: json.slice(4) } } },
    { event: "content_block_stop", data: { index: 0 } },
    { event: "message_delta", data: { delta: { stop_reason: "tool_use" } } },
  ]);
}

describe("anthropic: configuration and request shape", () => {
  test("reports itself configured once a key is present", () => {
    assert.equal(anthropicConfigured(), true);
  });

  test("sends the key and API version as headers, never in the URL", () => {
    // A key in a query string lands in proxy and server access logs.
    stubFetch([claudeText("hi")]);
    return anthropicProvider.chat(ask, []).then(() => {
      assert.equal(requests[0].headers["x-api-key"], "test-key-anthropic");
      assert.equal(requests[0].headers["anthropic-version"], "2023-06-01");
      assert.equal(requests[0].url.includes("test-key-anthropic"), false);
    });
  });

  test("hoists system messages into the top-level `system` field", async () => {
    // Anthropic has no system role inside `messages`; leaving it there would
    // make the prompt arrive as an ordinary user turn.
    stubFetch([claudeText("hi")]);
    await anthropicProvider.chat(ask, []);

    assert.equal(requests[0].body.system, "You are the household assistant.");
    assert.deepEqual(requests[0].body.messages, [{ role: "user", content: "what's on the list" }]);
  });

  test("drops replayed role:\"tool\" history rather than sending it", async () => {
    // server.ts replays Ollama-shaped tool turns into every provider's history.
    // Anthropic has no such role, so these must be filtered out -- sending one
    // is a 400 from the API.
    stubFetch([claudeText("hi")]);
    await anthropicProvider.chat(
      [...ask, { role: "tool", content: '{"items":["milk"]}' }, { role: "assistant", content: "You need milk." }],
      []
    );

    const roles = requests[0].body.messages.map((m: any) => m.role);
    assert.deepEqual(roles, ["user", "assistant"]);
  });

  test("maps tool schemas to input_schema and sends a real token budget", async () => {
    stubFetch([claudeText("hi")]);
    await anthropicProvider.chat(ask, [tool("get_list", async () => [])]);

    assert.deepEqual(requests[0].body.tools, [
      {
        name: "get_list",
        description: "get_list (test fixture)",
        input_schema: { type: "object", properties: { q: { type: "string" } } },
      },
    ]);
    assert.equal(requests[0].body.max_tokens, 2048, "1024 was the practical cause of the truncation bug");
  });

  test("refuses up front when no key is configured", async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "";
    // API_KEY is captured at module load, so re-import under a cleared env.
    const fresh = await import(`../assistant/providers/anthropic.ts?nokey=${Date.now()}`);
    try {
      await assert.rejects(() => fresh.anthropicProvider.chat(ask, []), ProviderUnavailableError);
      assert.equal(fresh.anthropicConfigured(), false);
    } finally {
      process.env.ANTHROPIC_API_KEY = saved;
    }
  });
});

describe("anthropic: the streaming translation", () => {
  test("assembles streamed text and reports it as a finished answer", async () => {
    stubFetch([claudeText("You need milk.")]);
    const deltas: string[] = [];

    const result = await anthropicProvider.chat(ask, [], { onDelta: (t) => deltas.push(t) });

    assert.equal(result.reply, "You need milk.");
    assert.equal(result.exhausted, false);
    assert.deepEqual(deltas, ["You need milk."]);
  });

  test("reassembles a tool's input from partial_json fragments", async () => {
    // The input only parses once complete, at content_block_stop -- parsing a
    // fragment early would silently hand the tool {}.
    stubFetch([claudeToolUse("get_list", { q: "Weekly Groceries" }), claudeText("You need milk.")]);
    let received: any;

    const result = await anthropicProvider.chat(ask, [tool("get_list", async (a) => ((received = a), { items: ["milk"] }))]);

    assert.deepEqual(received, { q: "Weekly Groceries" });
    assert.deepEqual(result.steps, [{ tool: "get_list", args: { q: "Weekly Groceries" }, result: { items: ["milk"] } }]);
  });

  test("replies with tool_result blocks keyed by the call's own id", async () => {
    // Anthropic matches results to calls by tool_use_id, so a wrong or missing
    // id is how a two-tool round gets its answers swapped.
    stubFetch([claudeToolUse("get_list", { q: "x" }, "toolu_abc"), claudeText("done")]);

    await anthropicProvider.chat(ask, [tool("get_list", async () => ({ items: [] }))]);

    const followUp = requests[1].body.messages.at(-1);
    assert.equal(followUp.role, "user");
    assert.equal(followUp.content[0].type, "tool_result");
    assert.equal(followUp.content[0].tool_use_id, "toolu_abc");
  });

  test("a failing tool comes back flagged is_error", async () => {
    stubFetch([claudeToolUse("boom", {}), claudeText("That didn't work.")]);

    const result = await anthropicProvider.chat(ask, [
      tool("boom", async () => {
        throw new Error("database is on fire");
      }),
    ]);

    assert.equal(result.steps[0].error, "database is on fire");
    const resultBlock = requests[1].body.messages.at(-1).content[0];
    assert.equal(resultBlock.is_error, true);
    assert.deepEqual(JSON.parse(resultBlock.content), { error: "database is on fire" });
  });

  test("an invented tool name is reported back instead of throwing", async () => {
    stubFetch([claudeToolUse("launch_missiles", {}), claudeText("Let me try again.")]);

    const result = await anthropicProvider.chat(ask, [tool("get_list", async () => [])]);

    assert.equal(result.steps[0].error, "No such tool: launch_missiles");
    assert.equal(result.reply, "Let me try again.");
  });

  test("an error event in the stream surfaces its message", async () => {
    stubFetch([sse([{ event: "error", data: { error: { message: "overloaded_error" } } }])]);
    await assert.rejects(() => anthropicProvider.chat(ask, []), /overloaded_error/);
  });

  test("malformed tool input degrades to {} rather than crashing the turn", async () => {
    stubFetch([
      sse([
        { event: "content_block_start", data: { index: 0, content_block: { type: "tool_use", id: "t1", name: "get_list" } } },
        { event: "content_block_delta", data: { index: 0, delta: { type: "input_json_delta", partial_json: "{not json" } } },
        { event: "content_block_stop", data: { index: 0 } },
      ]),
      claudeText("done"),
    ]);
    let received: any;

    await anthropicProvider.chat(ask, [tool("get_list", async (a) => ((received = a), "ok"))]);

    assert.deepEqual(received, {});
  });
});

describe("anthropic: the max_tokens cutoff (the project notes #1)", () => {
  test("a truncated answer is marked exhausted and says so visibly", async () => {
    // Without this the user is handed half an answer as though it were whole.
    stubFetch([claudeText("You spent $214 at Cost", "max_tokens")]);

    const result = await anthropicProvider.chat(ask, []);

    assert.equal(result.exhausted, true);
    assert.match(result.reply, /\[Response was cut off before finishing\.\]$/);
    assert.ok(result.reply.startsWith("You spent $214 at Cost"), "the partial text is still shown");
  });

  test("a normal end_turn is not marked exhausted", async () => {
    stubFetch([claudeText("All done.", "end_turn")]);
    const result = await anthropicProvider.chat(ask, []);

    assert.equal(result.exhausted, false);
    assert.equal(result.reply.includes("cut off"), false);
  });
});

describe("anthropic: transport (the project notes #4 and #5)", () => {
  test("retries a 429, because rate limits are transient", async () => {
    stubFetch([new Response("", { status: 429 }), claudeText("ready")]);

    assert.equal((await anthropicProvider.chat(ask, [])).reply, "ready");
    assert.equal(requests.length, 2);
  });

  test("retries a 529 overload the same way", async () => {
    stubFetch([new Response("", { status: 529 }), claudeText("ready")]);

    assert.equal((await anthropicProvider.chat(ask, [])).reply, "ready");
    assert.equal(requests.length, 2);
  });

  test("a 401 is a configuration problem, reported with the fix", async () => {
    stubFetch([new Response("", { status: 401 })]);

    await assert.rejects(
      () => anthropicProvider.chat(ask, []),
      (err: any) => err instanceof ProviderUnavailableError && /ANTHROPIC_API_KEY/.test(err.hint)
    );
  });

  test("a 400 fails without retrying", async () => {
    stubFetch([new Response("bad request", { status: 400 })]);

    await assert.rejects(() => anthropicProvider.chat(ask, []), /status 400/);
    assert.equal(requests.length, 1);
  });

  test("an out-of-credit 400 is reported with the fix, not as a generic failure", async () => {
    const body = JSON.stringify({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
      },
    });
    stubFetch([new Response(body, { status: 400 })]);

    await assert.rejects(
      () => anthropicProvider.chat(ask, []),
      (err: any) => err instanceof ProviderUnavailableError && /out of credit/.test(err.hint)
    );
    assert.equal(requests.length, 1, "billing isn't transient -- no retry");
  });

  test("a network failure is 'unreachable', with a hint meant for the user", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;

    await assert.rejects(
      () => anthropicProvider.chat(ask, []),
      (err: any) => err instanceof ProviderUnavailableError && /network connectivity/.test(err.hint)
    );
  });

  test("an abort propagates as an abort, not as 'unreachable'", async () => {
    globalThis.fetch = (async () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }) as typeof fetch;

    await assert.rejects(() => anthropicProvider.chat(ask, []), (err: any) => err.name === "AbortError");
  });

  test("the caller's signal reaches the underlying fetch", async () => {
    stubFetch([claudeText("hi")]);
    const controller = new AbortController();

    await anthropicProvider.chat(ask, [], { signal: controller.signal });

    assert.equal(requests[0].signal, controller.signal);
  });

  test("gives up after maxRounds", async () => {
    stubFetch([() => claudeToolUse("get_list", {})]);

    const result = await anthropicProvider.chat(ask, [tool("get_list", async () => ({}))], { maxRounds: 2 });

    assert.equal(result.exhausted, true);
    assert.match(result.reply, /ran out of steps/);
    assert.equal(result.steps.length, 2);
  });
});

// ---- Gemini ----------------------------------------------------------------

function geminiText(text: string, finishReason = "STOP"): Response {
  return sse([
    { data: { candidates: [{ content: { parts: [{ text }] } }] } },
    { data: { candidates: [{ content: { parts: [] }, finishReason }] } },
  ]);
}

function geminiCall(name: string, args: Record<string, any>): Response {
  return sse([
    { data: { candidates: [{ content: { parts: [{ functionCall: { name, args } }] }, finishReason: "STOP" }] } },
  ]);
}

describe("gemini: configuration and request shape", () => {
  test("reports itself configured once a key is present", () => {
    assert.equal(geminiConfigured(), true);
  });

  test("hoists system messages into systemInstruction and maps assistant to model", async () => {
    stubFetch([geminiText("hi")]);
    await geminiProvider.chat([...ask, { role: "assistant", content: "earlier reply" }], []);

    assert.equal(requests[0].body.systemInstruction.parts[0].text, "You are the household assistant.");
    assert.deepEqual(
      requests[0].body.contents.map((c: any) => c.role),
      ["user", "model"],
      'Gemini calls the assistant "model"'
    );
  });

  test("drops replayed role:\"tool\" history", async () => {
    stubFetch([geminiText("hi")]);
    await geminiProvider.chat([...ask, { role: "tool", content: '{"items":[]}' }], []);

    assert.equal(requests[0].body.contents.length, 1);
  });

  test("sends a real output-token budget at a low temperature", async () => {
    stubFetch([geminiText("hi")]);
    await geminiProvider.chat(ask, []);

    assert.equal(requests[0].body.generationConfig.maxOutputTokens, 2048);
    assert.equal(requests[0].body.generationConfig.temperature, 0.1);
    assert.ok(requests[0].url.includes("alt=sse"));
  });

  test("sends the API key in the x-goog-api-key header, never in the URL (audit L3)", async () => {
    stubFetch([geminiText("hi")]);
    await geminiProvider.chat(ask, []);

    assert.equal(requests[0].url.includes("test-key-gemini"), false);
    assert.equal(/[?&]key=/.test(requests[0].url), false);
    assert.equal(requests[0].headers["x-goog-api-key"], "test-key-gemini");
  });

  test("declares tools under functionDeclarations", async () => {
    stubFetch([geminiText("hi")]);
    await geminiProvider.chat(ask, [tool("get_list", async () => [])]);

    assert.deepEqual(requests[0].body.tools[0].functionDeclarations[0].name, "get_list");
  });
});

describe("gemini: the streaming translation", () => {
  test("joins streamed text fragments and streams them out", async () => {
    stubFetch([
      sse([
        { data: { candidates: [{ content: { parts: [{ text: "You " }] } }] } },
        { data: { candidates: [{ content: { parts: [{ text: "need milk." }] } }] } },
        { data: { candidates: [{ content: { parts: [] }, finishReason: "STOP" }] } },
      ]),
    ]);
    const deltas: string[] = [];

    const result = await geminiProvider.chat(ask, [], { onDelta: (t) => deltas.push(t) });

    assert.equal(result.reply, "You need milk.");
    assert.deepEqual(deltas, ["You ", "need milk."]);
  });

  test("runs a functionCall and replies with a functionResponse object", async () => {
    // Gemini's functionResponse.response must be an OBJECT, not the JSON string
    // Ollama and Anthropic take -- the project notes #3 records this as correct
    // per-provider behaviour rather than an inconsistency to fix.
    stubFetch([geminiCall("get_list", { q: "Weekly" }), geminiText("You need milk.")]);

    const result = await geminiProvider.chat(ask, [tool("get_list", async () => ({ items: ["milk"] }))]);

    const followUp = requests[1].body.contents.at(-1);
    assert.equal(followUp.role, "user");
    const response = followUp.parts[0].functionResponse;
    assert.equal(response.name, "get_list");
    assert.equal(typeof response.response, "object", "must be an object, not a JSON string");
    assert.deepEqual(response.response, { result: { items: ["milk"] } });
    assert.deepEqual(result.steps[0].result, { items: ["milk"] });
  });

  test("ToolStep.result stays the raw value, matching the other providers", async () => {
    // The wire payloads differ per provider; what the UI's step display sees
    // must not.
    stubFetch([geminiCall("get_list", {}), geminiText("done")]);

    const result = await geminiProvider.chat(ask, [tool("get_list", async () => ({ items: ["milk"] }))]);

    assert.deepEqual(result.steps[0].result, { items: ["milk"] });
  });

  test("a failing tool sends an error response and records the step", async () => {
    stubFetch([geminiCall("boom", {}), geminiText("That didn't work.")]);

    const result = await geminiProvider.chat(ask, [
      tool("boom", async () => {
        throw new Error("database is on fire");
      }),
    ]);

    assert.equal(result.steps[0].error, "database is on fire");
    assert.deepEqual(requests[1].body.contents.at(-1).parts[0].functionResponse.response, {
      error: "database is on fire",
    });
  });

  test("an invented tool name is reported back instead of throwing", async () => {
    stubFetch([geminiCall("launch_missiles", {}), geminiText("Let me try again.")]);

    const result = await geminiProvider.chat(ask, [tool("get_list", async () => [])]);
    assert.equal(result.steps[0].error, "No such tool: launch_missiles");
  });
});

describe("gemini: the MAX_TOKENS cutoff (the project notes #1)", () => {
  test("a truncated answer is marked exhausted and says so visibly", async () => {
    stubFetch([geminiText("You spent $214 at Cost", "MAX_TOKENS")]);

    const result = await geminiProvider.chat(ask, []);

    assert.equal(result.exhausted, true);
    assert.match(result.reply, /\[Response was cut off before finishing\.\]$/);
  });

  test("a normal STOP is not marked exhausted", async () => {
    stubFetch([geminiText("All done.", "STOP")]);
    const result = await geminiProvider.chat(ask, []);
    assert.equal(result.exhausted, false);
  });
});

describe("gemini: transport (the project notes #4 and #5)", () => {
  test("retries a 429", async () => {
    stubFetch([new Response("", { status: 429 }), geminiText("ready")]);

    assert.equal((await geminiProvider.chat(ask, [])).reply, "ready");
    assert.equal(requests.length, 2);
  });

  test("retries a 503 overload", async () => {
    stubFetch([new Response("", { status: 503 }), geminiText("ready")]);

    assert.equal((await geminiProvider.chat(ask, [])).reply, "ready");
    assert.equal(requests.length, 2);
  });

  test("a 403 is a configuration problem, reported with the fix", async () => {
    stubFetch([new Response("bad key", { status: 403 })]);

    await assert.rejects(
      () => geminiProvider.chat(ask, []),
      (err: any) => err instanceof ProviderUnavailableError && /GEMINI_API_KEY/.test(err.hint)
    );
  });

  test("a 500 fails without retrying", async () => {
    stubFetch([new Response("server error", { status: 500 })]);

    await assert.rejects(() => geminiProvider.chat(ask, []), /status 500/);
    assert.equal(requests.length, 1);
  });

  test("an abort propagates as an abort", async () => {
    globalThis.fetch = (async () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }) as typeof fetch;

    await assert.rejects(() => geminiProvider.chat(ask, []), (err: any) => err.name === "AbortError");
  });

  test("the caller's signal reaches the underlying fetch", async () => {
    stubFetch([geminiText("hi")]);
    const controller = new AbortController();

    await geminiProvider.chat(ask, [], { signal: controller.signal });

    assert.equal(requests[0].signal, controller.signal);
  });

  test("gives up after maxRounds", async () => {
    stubFetch([() => geminiCall("get_list", {})]);

    const result = await geminiProvider.chat(ask, [tool("get_list", async () => ({}))], { maxRounds: 2 });

    assert.equal(result.exhausted, true);
    assert.equal(result.steps.length, 2);
  });
});

// ---- Both ------------------------------------------------------------------

describe("both cloud adapters agree on the shared contract", () => {
  const cases = [
    { name: "anthropic", provider: anthropicProvider, ok: () => claudeText("done"), call: () => claudeToolUse("get_list", { q: "x" }) },
    { name: "gemini", provider: geminiProvider, ok: () => geminiText("done"), call: () => geminiCall("get_list", { q: "x" }) },
  ];

  for (const { name, provider, ok, call } of cases) {
    test(`${name}: a plain answer returns {reply, steps: [], exhausted: false}`, async () => {
      stubFetch([ok()]);
      const result = await provider.chat(ask, []);

      assert.equal(result.reply, "done");
      assert.deepEqual(result.steps, []);
      assert.equal(result.exhausted, false);
    });

    test(`${name}: onToolStart fires before the tool runs, onToolEnd after`, async () => {
      stubFetch([call(), ok()]);
      const events: string[] = [];

      await provider.chat(ask, [tool("get_list", async () => (events.push("run"), "value"))], {
        onToolStart: (c) => events.push(`start:${c.tool}`),
        onToolEnd: (s) => events.push(`end:${s.tool}`),
      });

      assert.deepEqual(events, ["start:get_list", "run", "end:get_list"]);
    });

    test(`${name}: does not mutate the caller's message array`, async () => {
      stubFetch([call(), ok()]);
      const messages: ChatMessage[] = [{ role: "user", content: "go" }];

      await provider.chat(messages, [tool("get_list", async () => ({}))]);

      assert.equal(messages.length, 1);
    });
  }
});
