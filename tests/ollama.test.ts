// ollama.ts's chatWithTools -- the loop that lets a model call tools, feeds
// results back, and repeats until it answers in prose.
//
// Everything here runs against a stubbed global fetch, so no Ollama is needed
// and nothing goes over the network. That's the point: the loop's hard cases
// are the ones you cannot reproduce on demand against a real model -- a tool
// that throws, a model inventing a tool name, a stream that splits a JSON line
// across two reads, a run that never converges. scripts/eval-assistant.ts
// covers the happy path against a real model; this covers the rest.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  chatWithTools,
  generateJson,
  OllamaUnavailableError,
  OLLAMA_MODEL,
  OLLAMA_NUM_CTX,
  OLLAMA_NUM_PREDICT,
  parseOllamaThink,
  type ChatMessage,
  type ToolDefinition,
} from "../ollama.ts";

const realFetch = globalThis.fetch;

/** Every request the stub saw, so tests can assert on the wire payload. */
let requests: { url: string; body: any; signal?: AbortSignal | null }[] = [];

/** One newline-delimited-JSON response, the shape Ollama's /api/chat streams. */
function ndjson(lines: unknown[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(new TextEncoder().encode(`${JSON.stringify(line)}\n`));
      }
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

/** A finished assistant turn: some prose, no tool calls. */
function proseTurn(...pieces: string[]): Response {
  return ndjson([
    ...pieces.map((content) => ({ message: { content }, done: false })),
    { message: { content: "" }, done: true },
  ]);
}

/** A turn where the model asks for tools. Ollama sends the whole tool-call
 *  list in the final chunk rather than building it up incrementally. */
function toolTurn(calls: { name: string; arguments?: Record<string, any> }[], content = ""): Response {
  return ndjson([
    {
      message: {
        content,
        tool_calls: calls.map((c) => ({ function: { name: c.name, arguments: c.arguments ?? {} } })),
      },
      done: true,
    },
  ]);
}

/** Queues responses to be returned in order, one per fetch call. */
function stubFetch(responses: (Response | (() => Response | Promise<Response>))[]): void {
  let i = 0;
  globalThis.fetch = (async (url: any, init: any) => {
    requests.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined, signal: init?.signal });
    const next = responses[Math.min(i, responses.length - 1)];
    i++;
    return typeof next === "function" ? next() : next;
  }) as typeof fetch;
}

function tool(name: string, run: ToolDefinition["run"], parameters?: ToolDefinition["parameters"]): ToolDefinition {
  return {
    name,
    description: `${name} (test fixture)`,
    parameters: parameters ?? { type: "object", properties: {} },
    run,
    domain: "test",
    sensitivity: "household",
  };
}

const ask: ChatMessage[] = [{ role: "user", content: "what's on the list" }];

beforeEach(() => {
  requests = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("a turn with no tool calls", () => {
  test("returns the prose and stops after one round", async () => {
    stubFetch([proseTurn("Milk", " and bread.")]);

    const result = await chatWithTools(ask, []);

    assert.equal(result.reply, "Milk and bread.");
    assert.deepEqual(result.steps, []);
    assert.equal(result.exhausted, false);
    assert.equal(requests.length, 1, "should not have asked for a second generation");
  });

  test("streams each piece through onDelta as it lands", async () => {
    stubFetch([proseTurn("You ", "need ", "milk.")]);
    const deltas: string[] = [];

    await chatWithTools(ask, [], 8, undefined, (text) => deltas.push(text));

    assert.deepEqual(deltas, ["You ", "need ", "milk."]);
  });

  test("reassembles a JSON line split across two stream reads", async () => {
    // The decoder's buffer is what makes this work; without it the partial
    // line would hit JSON.parse and throw mid-answer.
    const line = `${JSON.stringify({ message: { content: "hello there" }, done: true })}\n`;
    const bytes = new TextEncoder().encode(line);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 11));
        controller.enqueue(bytes.slice(11));
        controller.close();
      },
    });
    stubFetch([new Response(body, { status: 200 })]);

    assert.equal((await chatWithTools(ask, [])).reply, "hello there");
  });

  test("reads tool_calls from a final chunk with no trailing newline", async () => {
    // Ollama's done:true chunk doesn't always end with "\n" -- every other
    // fixture in this file appends one, which is why this case slipped
    // through. Without flushing the leftover buffer after the read loop
    // ends, this chunk (and its tool_calls) is silently dropped and the
    // turn reads as if the model just answered in prose.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            JSON.stringify({
              message: { content: "", tool_calls: [{ function: { name: "get_list", arguments: {} } }] },
              done: true,
            })
          )
          // deliberately no trailing "\n"
        );
        controller.close();
      },
    });
    stubFetch([new Response(body, { status: 200 }), proseTurn("You need milk.")]);

    const result = await chatWithTools(ask, [tool("get_list", async () => ({ items: ["milk"] }))]);

    assert.equal(result.steps.length, 1, "the tool call should not be silently dropped");
    assert.equal(result.steps[0].tool, "get_list");
    assert.equal(result.reply, "You need milk.");
  });

  test("tolerates blank lines in the stream", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("\n\n"));
        controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ message: { content: "ok" }, done: true })}\n`));
        controller.close();
      },
    });
    stubFetch([new Response(body, { status: 200 })]);

    assert.equal((await chatWithTools(ask, [])).reply, "ok");
  });
});

describe("the wire payload", () => {
  test("sends each tool's schema but never its run function or internal metadata", async () => {
    stubFetch([proseTurn("done")]);
    await chatWithTools(ask, [tool("list_items", async () => [])]);

    const [sent] = requests[0].body.tools;
    assert.equal(sent.type, "function");
    assert.deepEqual(Object.keys(sent.function).sort(), ["description", "name", "parameters"]);
    assert.equal("run" in sent.function, false);
    assert.equal("sensitivity" in sent.function, false, "internal metadata should not go over the wire");
    assert.equal("domain" in sent.function, false);
  });

  test("asks for a stream at a low temperature, with the configured model", async () => {
    stubFetch([proseTurn("done")]);
    await chatWithTools(ask, []);

    assert.equal(requests[0].body.model, OLLAMA_MODEL);
    assert.equal(requests[0].body.stream, true);
    assert.equal(requests[0].body.options.temperature, 0.1);
    assert.ok(requests[0].url.endsWith("/api/chat"));
  });

  test("always sends a context window big enough for the prompt and tools, and a cap on one reply", async () => {
    // A bare `ollama serve` defaults to a few thousand tokens of context; the assistant's prompt plus tools are
    // ~8,800, so without num_ctx Ollama silently cut the start of every request (Nutrition phase 6 review).
    stubFetch([proseTurn("done")]);
    await chatWithTools(ask, []);
    assert.equal(requests[0].body.options.num_ctx, OLLAMA_NUM_CTX);
    assert.ok(OLLAMA_NUM_CTX >= 16384, "room for the ~8,800-token prompt plus a conversation");
    assert.equal(requests[0].body.options.num_predict, OLLAMA_NUM_PREDICT);
    assert.ok(OLLAMA_NUM_PREDICT > 0, "a reply is capped, so a looping model stops");
  });

  test("does not mutate the caller's message array", async () => {
    // chatWithTools appends assistant/tool turns as it goes; if it did that in
    // place, server.ts's `messages` would grow across a conversation.
    stubFetch([toolTurn([{ name: "noop" }]), proseTurn("done")]);
    const messages: ChatMessage[] = [{ role: "user", content: "go" }];

    await chatWithTools(messages, [tool("noop", async () => ({ ok: true }))]);

    assert.equal(messages.length, 1);
  });
});

describe("running tools", () => {
  test("executes a tool, feeds the result back, and answers on the next round", async () => {
    stubFetch([toolTurn([{ name: "get_list", arguments: { list: "Weekly" } }]), proseTurn("You need milk.")]);
    const seen: any[] = [];

    const result = await chatWithTools(
      ask,
      [tool("get_list", async (args) => {
        seen.push(args);
        return { items: ["milk"] };
      })]
    );

    assert.deepEqual(seen, [{ list: "Weekly" }], "the tool receives the model's arguments");
    assert.equal(result.reply, "You need milk.");
    assert.equal(result.exhausted, false);
    assert.deepEqual(result.steps, [{ tool: "get_list", args: { list: "Weekly" }, result: { items: ["milk"] } }]);
  });

  test("the follow-up request replays the call and its result as real wire messages", async () => {
    stubFetch([toolTurn([{ name: "get_list", arguments: {} }]), proseTurn("done")]);

    await chatWithTools(ask, [tool("get_list", async () => ({ items: ["milk"] }))]);

    const replayed = requests[1].body.messages;
    const assistantTurn = replayed[replayed.length - 2];
    const toolTurnMsg = replayed[replayed.length - 1];

    assert.equal(assistantTurn.role, "assistant");
    assert.equal(assistantTurn.tool_calls[0].function.name, "get_list");
    assert.equal(toolTurnMsg.role, "tool");
    assert.deepEqual(JSON.parse(toolTurnMsg.content), { items: ["milk"] });
  });

  test("runs several tool calls from one round, in order", async () => {
    stubFetch([
      toolTurn([
        { name: "first", arguments: { n: 1 } },
        { name: "second", arguments: { n: 2 } },
      ]),
      proseTurn("done"),
    ]);
    const order: string[] = [];

    const result = await chatWithTools(ask, [
      tool("first", async () => {
        order.push("first");
        return 1;
      }),
      tool("second", async () => {
        order.push("second");
        return 2;
      }),
    ]);

    assert.deepEqual(order, ["first", "second"]);
    assert.deepEqual(result.steps.map((s) => s.tool), ["first", "second"]);
  });

  test("reports onToolStart before the tool runs and onToolEnd after", async () => {
    stubFetch([toolTurn([{ name: "slow", arguments: { a: 1 } }]), proseTurn("done")]);
    const events: string[] = [];

    await chatWithTools(
      ask,
      [tool("slow", async () => {
        events.push("run");
        return "value";
      })],
      8,
      undefined,
      undefined,
      (call) => events.push(`start:${call.tool}`),
      (step) => events.push(`end:${step.tool}:${step.result}`)
    );

    assert.deepEqual(events, ["start:slow", "run", "end:slow:value"]);
  });
});

describe("things the model gets wrong", () => {
  test("an invented tool name becomes an error step and the loop continues", async () => {
    // Models invent tool names. Throwing would end the turn; telling it plainly
    // usually gets a real tool on the next round.
    stubFetch([toolTurn([{ name: "launch_missiles" }]), proseTurn("Sorry, let me check the list instead.")]);

    const result = await chatWithTools(ask, [tool("get_list", async () => ({ items: [] }))]);

    assert.equal(result.steps.length, 1);
    assert.equal(result.steps[0].error, "No such tool: launch_missiles");
    assert.equal(result.steps[0].result, null);
    assert.equal(result.reply, "Sorry, let me check the list instead.");
    assert.equal(result.exhausted, false);

    const lastMessage = requests[1].body.messages.at(-1);
    assert.deepEqual(JSON.parse(lastMessage.content), { error: "No such tool: launch_missiles" });
  });

  test("a tool that throws is reported back, not propagated to the caller", async () => {
    stubFetch([toolTurn([{ name: "explodes" }]), proseTurn("That didn't work.")]);

    const result = await chatWithTools(
      ask,
      [tool("explodes", async () => {
        throw new Error("database is on fire");
      })]
    );

    assert.equal(result.steps[0].error, "database is on fire");
    assert.equal(result.reply, "That didn't work.");
    assert.deepEqual(JSON.parse(requests[1].body.messages.at(-1).content), { error: "database is on fire" });
  });

  test("a tool call with no name at all is handled like any unknown tool", async () => {
    stubFetch([ndjson([{ message: { content: "", tool_calls: [{ function: {} }] }, done: true }]), proseTurn("ok")]);

    const result = await chatWithTools(ask, [tool("get_list", async () => [])]);

    assert.equal(result.steps.length, 1);
    assert.match(result.steps[0].error!, /No such tool/);
  });

  test("gives up after maxRounds and says so", async () => {
    // A confused local model will call the same tool forever, and each round is
    // a full generation -- without the cap one question hangs for minutes.
    stubFetch([() => toolTurn([{ name: "get_list" }])]);
    let runs = 0;

    const result = await chatWithTools(
      ask,
      [tool("get_list", async () => {
        runs++;
        return { items: [] };
      })],
      3
    );

    assert.equal(result.exhausted, true);
    assert.equal(runs, 3, "should stop at exactly maxRounds generations");
    assert.match(result.reply, /ran out of steps/);
    assert.equal(result.steps.length, 3, "the work it did do is still reported");
  });
});

describe("coerceArgs -- llama3.1 hands nested arrays back as strings", () => {
  const arraySchema = {
    type: "object" as const,
    properties: { meals: { type: "array" }, note: { type: "string" } },
  };

  test("parses a stringified array into a real one", async () => {
    stubFetch([
      toolTurn([{ name: "save_meals", arguments: { meals: '[{"day":"Monday"}]' } }]),
      proseTurn("done"),
    ]);
    let received: any;

    await chatWithTools(ask, [tool("save_meals", async (args) => ((received = args), "ok"), arraySchema)]);

    assert.deepEqual(received.meals, [{ day: "Monday" }], "the tool should get an array, not a string");
  });

  test("leaves an already-correct array alone", async () => {
    stubFetch([toolTurn([{ name: "save_meals", arguments: { meals: [{ day: "Tuesday" }] } }]), proseTurn("done")]);
    let received: any;

    await chatWithTools(ask, [tool("save_meals", async (args) => ((received = args), "ok"), arraySchema)]);

    assert.deepEqual(received.meals, [{ day: "Tuesday" }]);
  });

  test("passes unparseable text through for the tool to reject on its own terms", async () => {
    stubFetch([toolTurn([{ name: "save_meals", arguments: { meals: "not json at all" } }]), proseTurn("done")]);
    let received: any;

    await chatWithTools(ask, [tool("save_meals", async (args) => ((received = args), "ok"), arraySchema)]);

    assert.equal(received.meals, "not json at all");
  });

  test("does not coerce when the parsed type disagrees with the schema", async () => {
    // '"just a string"' parses fine, but into a string where an array was
    // declared -- coercing it would hand the tool the wrong shape silently.
    stubFetch([toolTurn([{ name: "save_meals", arguments: { meals: '"just a string"' } }]), proseTurn("done")]);
    let received: any;

    await chatWithTools(ask, [tool("save_meals", async (args) => ((received = args), "ok"), arraySchema)]);

    assert.equal(received.meals, '"just a string"');
  });

  test("never touches a parameter declared as a string", async () => {
    // A note that happens to read as JSON is still a note.
    stubFetch([toolTurn([{ name: "save_meals", arguments: { note: "[1,2,3]" } }]), proseTurn("done")]);
    let received: any;

    await chatWithTools(ask, [tool("save_meals", async (args) => ((received = args), "ok"), arraySchema)]);

    assert.equal(received.note, "[1,2,3]");
  });
});

describe("coerceArgs -- llama3.1 also hands back Python-style single-quoted lists", () => {
  // JSON.parse throws on single quotes, so the bare stringified-JSON path
  // above can't repair these -- that's the coerceStringList fallback.
  const arraySchema = {
    type: "object" as const,
    properties: { dates: { type: "array" }, note: { type: "string" } },
  };
  const objectSchema = {
    type: "object" as const,
    properties: { info: { type: "object" } },
  };

  test("the reported bug: a single-quoted Python-style list becomes a real string array", async () => {
    stubFetch([
      toolTurn([{ name: "create_calendar_event", arguments: { dates: "['2026-09-05', '2026-09-06']" } }]),
      proseTurn("done"),
    ]);
    let received: any;

    await chatWithTools(ask, [
      tool("create_calendar_event", async (args) => ((received = args), "ok"), arraySchema),
    ]);

    assert.deepEqual(received.dates, ["2026-09-05", "2026-09-06"]);
  });

  test("a double-quoted stringified array still goes through the JSON.parse path", async () => {
    stubFetch([
      toolTurn([{ name: "create_calendar_event", arguments: { dates: '["2026-09-05", "2026-09-06"]' } }]),
      proseTurn("done"),
    ]);
    let received: any;

    await chatWithTools(ask, [
      tool("create_calendar_event", async (args) => ((received = args), "ok"), arraySchema),
    ]);

    assert.deepEqual(received.dates, ["2026-09-05", "2026-09-06"]);
  });

  test("a real array passed correctly is left untouched", async () => {
    stubFetch([
      toolTurn([{ name: "create_calendar_event", arguments: { dates: ["2026-09-05", "2026-09-06"] } }]),
      proseTurn("done"),
    ]);
    let received: any;

    await chatWithTools(ask, [
      tool("create_calendar_event", async (args) => ((received = args), "ok"), arraySchema),
    ]);

    assert.deepEqual(received.dates, ["2026-09-05", "2026-09-06"]);
  });

  test("an apostrophe inside an element is not corrupted", async () => {
    // A naive '->" replace would turn "Bob's birthday" into invalid JSON or
    // mangled data. Stripping only one matching pair of surrounding quotes
    // per element -- here the outer list is single-quoted (forcing the
    // fallback), but the element with the apostrophe is double-quoted, the
    // way a model would render it to avoid ambiguity -- leaves the
    // apostrophe untouched.
    stubFetch([
      toolTurn([{ name: "save_meals", arguments: { dates: `['milk', "Bob's birthday"]` } }]),
      proseTurn("done"),
    ]);
    let received: any;

    await chatWithTools(ask, [tool("save_meals", async (args) => ((received = args), "ok"), arraySchema)]);

    assert.deepEqual(received.dates, ["milk", "Bob's birthday"]);
  });

  test("a string that isn't list-shaped is left as-is", async () => {
    stubFetch([toolTurn([{ name: "save_meals", arguments: { dates: "chicken" } }]), proseTurn("done")]);
    let received: any;

    await chatWithTools(ask, [tool("save_meals", async (args) => ((received = args), "ok"), arraySchema)]);

    assert.equal(received.dates, "chicken");
  });

  test("an object-typed param with a malformed string is left as-is -- no comma-splitting", async () => {
    stubFetch([toolTurn([{ name: "save_info", arguments: { info: "['a', 'b']" } }]), proseTurn("done")]);
    let received: any;

    await chatWithTools(ask, [tool("save_info", async (args) => ((received = args), "ok"), objectSchema)]);

    assert.equal(received.info, "['a', 'b']");
  });

  test("an empty list does not produce an array with one empty string", async () => {
    stubFetch([toolTurn([{ name: "save_meals", arguments: { dates: "[]" } }]), proseTurn("done")]);
    let received: any;

    await chatWithTools(ask, [tool("save_meals", async (args) => ((received = args), "ok"), arraySchema)]);

    assert.deepEqual(received.dates, []);
  });

  test("a comma inside a quoted ingredient does not split it into two elements", async () => {
    // "beef, diced" is exactly what the recipe parser produces. A naive
    // split(",") turns one ingredient into two on the shopping list -- wrong
    // items silently appear with stray quote characters welded on.
    stubFetch([
      toolTurn([{ name: "save_meals", arguments: { dates: "['beef, diced', 'onion']" } }]),
      proseTurn("done"),
    ]);
    let received: any;

    await chatWithTools(ask, [tool("save_meals", async (args) => ((received = args), "ok"), arraySchema)]);

    assert.deepEqual(received.dates, ["beef, diced", "onion"]);
  });

  test("a quoted element with both a comma and an apostrophe is not corrupted", async () => {
    stubFetch([
      toolTurn([{ name: "save_meals", arguments: { dates: "['Bob's cake, iced']" } }]),
      proseTurn("done"),
    ]);
    let received: any;

    await chatWithTools(ask, [tool("save_meals", async (args) => ((received = args), "ok"), arraySchema)]);

    assert.deepEqual(received.dates, ["Bob's cake, iced"]);
  });

  test("a list of objects is left as the original string, not silently turned into junk strings", async () => {
    // create_meal_plan's `meals` param is an array of objects. Coercing this
    // into ["{'day':'Monday'}"] would let create_meal_plan.run's
    // .filter((m) => m && m.name && normalizeDay(m.day)) silently drop every
    // meal with no explanation. Leaving it as the original string lets the
    // tool reject cleanly so the model can retry.
    stubFetch([
      toolTurn([{ name: "save_meals", arguments: { dates: "[{'day':'Monday'}]" } }]),
      proseTurn("done"),
    ]);
    let received: any;

    await chatWithTools(ask, [tool("save_meals", async (args) => ((received = args), "ok"), arraySchema)]);

    assert.equal(received.dates, "[{'day':'Monday'}]");
  });

  test("a nested array is left as the original string, not flattened into junk", async () => {
    stubFetch([
      toolTurn([{ name: "save_meals", arguments: { dates: "[['a','b'],['c']]" } }]),
      proseTurn("done"),
    ]);
    let received: any;

    await chatWithTools(ask, [tool("save_meals", async (args) => ((received = args), "ok"), arraySchema)]);

    assert.equal(received.dates, "[['a','b'],['c']]");
  });
});

describe("transport failures", () => {
  test("a refused connection is reported as Ollama being unreachable", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;

    await assert.rejects(() => chatWithTools(ask, []), OllamaUnavailableError);
  });

  test("an abort propagates as an abort, not as 'Ollama is down'", async () => {
    // Stage 3's Stop button. server.ts checks err.name === "AbortError" to
    // decide it was the user hanging up rather than a failure worth reporting.
    globalThis.fetch = (async () => {
      const err = new Error("The operation was aborted.");
      err.name = "AbortError";
      throw err;
    }) as typeof fetch;

    await assert.rejects(() => chatWithTools(ask, []), (err: any) => err.name === "AbortError");
  });

  test("the caller's signal is handed to the underlying fetch", async () => {
    stubFetch([proseTurn("done")]);
    const controller = new AbortController();

    await chatWithTools(ask, [], 8, controller.signal);

    assert.equal(requests[0].signal, controller.signal);
  });

  test("a 404 names the model and the command that fixes it", async () => {
    stubFetch([new Response("", { status: 404 })]);

    await assert.rejects(
      () => chatWithTools(ask, []),
      (err: Error) => err.message.includes(OLLAMA_MODEL) && err.message.includes("ollama pull")
    );
  });

  test("a 500 fails rather than retrying", async () => {
    stubFetch([new Response("", { status: 500 })]);

    await assert.rejects(() => chatWithTools(ask, []), /status 500/);
    assert.equal(requests.length, 1, "only a 503 is worth retrying");
  });

  test("a 503 is retried, because the model is still loading into memory", async () => {
    // Common on the first request after a cold start; it resolves on its own.
    stubFetch([new Response("", { status: 503 }), proseTurn("ready now")]);

    const result = await chatWithTools(ask, []);

    assert.equal(result.reply, "ready now");
    assert.equal(requests.length, 2);
  });
});

describe("generateJson", () => {
  test("returns the model's response text", async () => {
    stubFetch([new Response(JSON.stringify({ response: '{"ok":true}' }), { status: 200 })]);

    assert.deepEqual(await generateJson("give me json"), { text: '{"ok":true}' });
    assert.equal(requests[0].body.format, "json");
    assert.equal(requests[0].body.stream, false);
    assert.ok(requests[0].url.endsWith("/api/generate"));
  });

  test("an empty response is an empty string, not undefined", async () => {
    stubFetch([new Response(JSON.stringify({}), { status: 200 })]);
    assert.deepEqual(await generateJson("prompt"), { text: "" });
  });
});

describe("OLLAMA_THINK", () => {
  test("parseOllamaThink maps each accepted spelling and rejects the rest", () => {
    for (const raw of ["false", "off", "0", "FALSE", " Off "]) assert.equal(parseOllamaThink(raw), false, raw);
    for (const raw of ["true", "on", "1", "True"]) assert.equal(parseOllamaThink(raw), true, raw);
    for (const level of ["low", "medium", "high", "HIGH"]) assert.equal(parseOllamaThink(level), level.toLowerCase());
    for (const raw of [undefined, "", "  ", "maybe", "2", "extreme"]) assert.equal(parseOllamaThink(raw), undefined, String(raw));
  });

  // The setting is read once when ollama.ts loads, so each case imports a fresh copy of the module (the query
  // string makes it a distinct module instance) with the env var set first, then puts the env back.
  let freshCount = 0;
  async function bodiesWithThink(raw: string | undefined): Promise<{ chat: any; generate: any }> {
    const before = process.env.OLLAMA_THINK;
    if (raw === undefined) delete process.env.OLLAMA_THINK;
    else process.env.OLLAMA_THINK = raw;
    const warn = console.warn;
    console.warn = () => {}; // the garbage case warns on purpose; keep test output clean
    let fresh: typeof import("../ollama.ts");
    try {
      fresh = await import(`../ollama.ts?think=${freshCount++}`);
    } finally {
      console.warn = warn;
      if (before === undefined) delete process.env.OLLAMA_THINK;
      else process.env.OLLAMA_THINK = before;
    }
    stubFetch([proseTurn("done"), new Response(JSON.stringify({ response: "{}" }), { status: 200 })]);
    await fresh.chatWithTools(ask, []);
    await fresh.generateJson("prompt");
    return { chat: requests[0].body, generate: requests[1].body };
  }

  test("unset sends no think key at all, so older models never see the field", async () => {
    const { chat, generate } = await bodiesWithThink(undefined);
    assert.equal("think" in chat, false);
    assert.equal("think" in generate, false);
  });

  test("an empty value is the same as unset", async () => {
    assert.equal("think" in (await bodiesWithThink("")).chat, false);
  });

  test("false is sent as a top-level think:false on both request bodies, not inside options", async () => {
    const { chat, generate } = await bodiesWithThink("false");
    assert.equal(chat.think, false);
    assert.equal(generate.think, false);
    assert.equal("think" in chat.options, false);
    assert.equal("think" in generate.options, false);
  });

  // generateJson backs short-timeout structured side jobs, so it never thinks, whatever the setting.
  test("true thinks in the chat loop but generateJson is forced to think:false", async () => {
    const { chat, generate } = await bodiesWithThink("on");
    assert.equal(chat.think, true);
    assert.equal(generate.think, false);
    assert.equal("think" in generate.options, false);
  });

  test("an effort level is sent to the chat loop, but generateJson is forced to think:false", async () => {
    const { chat, generate } = await bodiesWithThink("high");
    assert.equal(chat.think, "high");
    assert.equal(generate.think, false);
    assert.equal("think" in generate.options, false);
  });

  test("garbage is ignored: no think key", async () => {
    const { chat, generate } = await bodiesWithThink("banana");
    assert.equal("think" in chat, false);
    assert.equal("think" in generate, false);
  });

  test("message.thinking chunks never reach the reply or onDelta", async () => {
    stubFetch([
      ndjson([
        { message: { content: "", thinking: "let me work out the answer" }, done: false },
        { message: { content: "Milk.", thinking: "" }, done: false },
        { message: { content: "" }, done: true },
      ]),
    ]);
    const deltas: string[] = [];
    const result = await chatWithTools(ask, [], 8, undefined, (text) => deltas.push(text));
    assert.equal(result.reply, "Milk.");
    assert.deepEqual(deltas, ["Milk."]);
  });
});

// Ollama's gemma4 tool-call parser fails on a long call that mixes plain quotes with Gemma's own string tokens, and
// then returns an EMPTY message -- no content, no tool_calls -- after the model generated ~1,000 tokens. That used to
// read as a final answer and the user got a blank reply. chatWithTools now asks once for smaller calls.
describe("a tool call Ollama swallowed", () => {
  /** The shape Ollama sends when its parser gave up: empty message, a real token count in the final chunk. */
  const swallowed = (evalCount = 1170, doneReason = "stop") =>
    ndjson([{ message: { content: "" }, done: true, done_reason: doneReason, eval_count: evalCount }]);
  const lastUserMessage = (i: number) => {
    const msgs = requests[i].body.messages;
    return msgs[msgs.length - 1];
  };

  test("empty turn with a high eval_count: retries once with a corrective message and the retry's tool call runs", async () => {
    stubFetch([swallowed(), toolTurn([{ name: "save_day", arguments: { day: "Monday" } }]), proseTurn("Saved Monday.")]);
    const seen: any[] = [];

    const result = await chatWithTools(ask, [tool("save_day", async (args) => { seen.push(args); return { ok: true }; })]);

    assert.equal(requests.length, 3);
    assert.equal(lastUserMessage(1).role, "user");
    assert.match(lastUserMessage(1).content, /could not be read -- it was probably too long/);
    assert.match(lastUserMessage(1).content, /several smaller calls/);
    assert.deepEqual(seen, [{ day: "Monday" }]);
    assert.equal(result.reply, "Saved Monday.");
    assert.equal(result.exhausted, false);
  });

  test("the corrective message is only in the loop's own copy of the conversation", async () => {
    stubFetch([swallowed(), proseTurn("ok")]);
    const messages: ChatMessage[] = [{ role: "user", content: "plan it" }];
    await chatWithTools(messages, []);
    assert.equal(messages.length, 1);
  });

  test("still empty after the retry: a plain non-empty apology, after exactly one retry", async () => {
    stubFetch([() => swallowed()]); // a factory: every request gets a fresh body
    const deltas: string[] = [];

    const result = await chatWithTools(ask, [], 8, undefined, (t) => deltas.push(t));

    assert.equal(requests.length, 2, "one retry, not a loop");
    assert.match(result.reply, /^Sorry -- I couldn't finish that; my last step came back unreadable\. Please try again\.$/);
    assert.deepEqual(deltas, [result.reply], "streamed too, so a live view isn't left blank");
    assert.equal(result.exhausted, false);
  });

  test("done_reason length with nothing readable: retries with a cut-off message even when eval_count is small", async () => {
    stubFetch([swallowed(12, "length"), proseTurn("Here you go.")]);

    const result = await chatWithTools(ask, []);

    assert.equal(requests.length, 2);
    assert.match(lastUserMessage(1).content, /cut off/);
    assert.equal(result.reply, "Here you go.");
  });

  test("done_reason length that stays empty ends in the apology", async () => {
    stubFetch([() => swallowed(0, "length")]);
    const result = await chatWithTools(ask, []);
    assert.equal(requests.length, 2);
    assert.match(result.reply, /^Sorry -- /);
  });

  test("the retry is once per turn: a second swallowed call after a tool ran gets the apology, not another retry", async () => {
    stubFetch([swallowed(), toolTurn([{ name: "save_day" }]), swallowed()]);
    const result = await chatWithTools(ask, [tool("save_day", async () => ({ ok: true }))]);
    assert.equal(requests.length, 3);
    assert.match(result.reply, /^Sorry -- /);
    assert.equal(result.steps.length, 1);
  });

  test("a short empty turn is just an empty turn: no retry, the reply is returned as it was", async () => {
    stubFetch([ndjson([{ message: { content: "" }, done: true, done_reason: "stop", eval_count: 3 }])]);
    const result = await chatWithTools(ask, []);
    assert.equal(requests.length, 1);
    assert.equal(result.reply, "");
  });

  test("a turn with prose is never retried, whatever its eval_count", async () => {
    stubFetch([ndjson([{ message: { content: "Plenty to say." }, done: true, done_reason: "length", eval_count: 4096 }])]);
    const result = await chatWithTools(ask, []);
    assert.equal(requests.length, 1);
    assert.equal(result.reply, "Plenty to say.");
  });

  test("a normal turn that has tool calls but empty content is untouched, even with a high eval_count", async () => {
    stubFetch([
      ndjson([{ message: { content: "", tool_calls: [{ function: { name: "save_day", arguments: { day: "Monday" } } }] }, done: true, done_reason: "stop", eval_count: 900 }]),
      proseTurn("Done."),
    ]);
    const result = await chatWithTools(ask, [tool("save_day", async () => ({ ok: true }))]);
    assert.equal(requests.length, 2);
    assert.ok(!requests[1].body.messages.some((m: any) => m.role === "user" && /could not be read/.test(m.content)));
    assert.equal(result.reply, "Done.");
  });
});

describe("the Ollama provider's round limit", () => {
  test("defaults to OLLAMA_MAX_ROUNDS (12: two reads and seven one-day saves fit), and a caller's maxRounds still wins", async () => {
    const { ollamaProvider, OLLAMA_MAX_ROUNDS } = await import("../assistant/providers/ollama.ts");
    assert.equal(OLLAMA_MAX_ROUNDS, 12);
    const loopForever = () => toolTurn([{ name: "noop" }]);
    stubFetch([loopForever]);
    const noop = tool("noop", async () => ({ ok: true }));

    const byDefault = await ollamaProvider.chat(ask, [noop]);
    assert.equal(requests.length, 12);
    assert.equal(byDefault.exhausted, true);

    requests = [];
    await ollamaProvider.chat(ask, [noop], { maxRounds: 3 });
    assert.equal(requests.length, 3);
  });
});
