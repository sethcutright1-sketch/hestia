// Gemini as a Provider, over the raw generateContent REST API -- same
// no-SDK reasoning as anthropic.ts.
//
// Gemini's tool loop uses functionCall/functionResponse parts inside
// "model"/"user" turns rather than a dedicated tool role, closer in shape to
// Anthropic's than Ollama's.

// Must be the first import -- see env.ts. Without this, GEMINI_MODEL/API_KEY
// below can be read before server.ts's dotenv setup has loaded .env.local.
import "../../env.ts";

import type { ToolDefinition } from "../../ollama.ts";
import { ProviderUnavailableError, type ChatResult, type Provider, type ToolStep } from "./types.ts";

export const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const API_KEY = process.env.GEMINI_API_KEY || "";
// Raised from 1024 -- too small a budget was the main practical cause of the
// MAX_TOKENS truncation this file now has to detect (the project notes bug #1).
const MAX_OUTPUT_TOKENS = 2048;

export function geminiConfigured(): boolean {
  return API_KEY.length > 0;
}

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: Record<string, any> };
  functionResponse?: { name: string; response: Record<string, any> };
}
interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

async function geminiConnect(body: unknown, signal?: AbortSignal, attempt = 1): Promise<Response> {
  // alt=sse switches the streaming endpoint from its default newline-delimited
  // JSON-array framing to Server-Sent Events, which is much simpler to parse
  // incrementally (one full JSON object per `data:` line) than trying to find
  // array-element boundaries in a partially-received JSON array.
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:streamGenerateContent?alt=sse`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      // Header, not `?key=`: a URL ends up in proxy and error logs (L3).
      headers: { "content-type": "application/json", "x-goog-api-key": API_KEY! },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err: any) {
    // A caller-initiated abort (Stage 3's Stop button) is not "unreachable" --
    // let it propagate as-is so the caller can tell the two apart.
    if (err?.name === "AbortError") throw err;
    throw new ProviderUnavailableError("gemini", "Couldn't reach the Gemini API -- check network connectivity.");
  }

  if (response.status === 400 || response.status === 403) {
    const text = await response.text().catch(() => "");
    throw new ProviderUnavailableError("gemini", `GEMINI_API_KEY looks invalid -- check .env.local. (${text.slice(0, 150)})`);
  }
  // 429 (rate limited) and 503 (model overloaded) are transient -- Ollama's 503
  // retry already covers its own equivalent; Anthropic and Gemini didn't
  // (the project notes bug #5).
  if ((response.status === 429 || response.status === 503) && attempt <= 3) {
    console.warn(`Gemini returned ${response.status} (attempt ${attempt}/3). Retrying in ${attempt * 1000}ms...`);
    await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    return geminiConnect(body, signal, attempt + 1);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Gemini request failed with status ${response.status}: ${text.slice(0, 300)}`);
  }
  return response;
}

/**
 * Streams one round via `streamGenerateContent`, returning the same
 * `{parts, finishReason}` shape the old one-shot `generateContent` response
 * had. Each SSE chunk here is a complete, self-contained JSON object shaped
 * like a (partial) GenerateContentResponse -- unlike Anthropic's index-keyed
 * deltas, Gemini just sends each new text fragment as its own `text` part
 * (streamed out via onDelta as it lands) and, when the model calls a tool,
 * the whole `functionCall` part complete in one chunk -- Gemini's API has no
 * partial/incremental function-call-argument streaming to reassemble.
 */
async function geminiStream(
  body: Record<string, unknown>,
  signal: AbortSignal | undefined,
  onDelta: ((text: string) => void) | undefined
): Promise<{ parts: GeminiPart[]; finishReason: string | null }> {
  const response = await geminiConnect(body, signal);
  const reader = response.body?.getReader();
  if (!reader) {
    // No streaming body available (e.g. a test double) -- fall back to a
    // single JSON parse of the whole response.
    const data = await response.json();
    const candidate = data.candidates?.[0];
    const parts: GeminiPart[] = candidate?.content?.parts || [];
    for (const p of parts) if (typeof p.text === "string") onDelta?.(p.text);
    return { parts, finishReason: candidate?.finishReason ?? null };
  }

  const decoder = new TextDecoder();
  let buffer = "";
  const parts: GeminiPart[] = [];
  let textPart: GeminiPart | null = null;
  let finishReason: string | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let eventEnd: number;
    while ((eventEnd = buffer.indexOf("\n\n")) !== -1) {
      const rawEvent = buffer.slice(0, eventEnd);
      buffer = buffer.slice(eventEnd + 2);

      let dataStr = "";
      for (const line of rawEvent.split("\n")) {
        if (line.startsWith("data:")) dataStr += line.slice(5).trim();
      }
      if (!dataStr) continue;
      const chunk = JSON.parse(dataStr);

      const candidate = chunk.candidates?.[0];
      if (candidate?.finishReason) finishReason = candidate.finishReason;
      for (const p of candidate?.content?.parts || []) {
        if (typeof p.text === "string") {
          // Merged into one running text part, same shape a non-streaming
          // response would have had, rather than many small parts.
          if (!textPart) {
            textPart = { text: "" };
            parts.push(textPart);
          }
          textPart.text += p.text;
          onDelta?.(p.text);
        } else if (p.functionCall) {
          parts.push(p);
        }
      }
    }
  }

  return { parts, finishReason };
}

function toGeminiTools(tools: ToolDefinition[]) {
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      })),
    },
  ];
}

export const geminiProvider: Provider = {
  id: "gemini",
  label: `Gemini (${GEMINI_MODEL})`,
  async chat(messages, tools, opts): Promise<ChatResult> {
    if (!geminiConfigured()) {
      throw new ProviderUnavailableError("gemini", "GEMINI_API_KEY is not set in .env.local.");
    }

    const maxRounds = opts?.maxRounds ?? 8;
    const systemInstruction = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    const contents: GeminiContent[] = messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));

    const geminiTools = toGeminiTools(tools);
    const steps: ToolStep[] = [];

    for (let round = 0; round < maxRounds; round++) {
      const { parts, finishReason } = await geminiStream(
        {
          contents,
          tools: geminiTools,
          ...(systemInstruction ? { systemInstruction: { parts: [{ text: systemInstruction }] } } : {}),
          generationConfig: { temperature: 0.1, maxOutputTokens: MAX_OUTPUT_TOKENS },
        },
        opts?.signal,
        opts?.onDelta
      );

      const calls = parts.filter((p) => p.functionCall);
      const text = parts
        .filter((p) => typeof p.text === "string")
        .map((p) => p.text)
        .join("");

      if (calls.length === 0) {
        // the project notes bug #1: a MAX_TOKENS cutoff with no function call
        // in flight means `text` is genuinely incomplete -- say so rather than
        // returning it as a finished answer.
        if (finishReason === "MAX_TOKENS") {
          return { reply: text + "\n\n[Response was cut off before finishing.]", steps, exhausted: true };
        }
        return { reply: text, steps, exhausted: false };
      }

      contents.push({ role: "model", parts });

      const responseParts: GeminiPart[] = [];
      for (const p of calls) {
        const name = p.functionCall!.name;
        const args = p.functionCall!.args || {};
        const tool = tools.find((t) => t.name === name);
        opts?.onToolStart?.({ tool: name, args });
        if (!tool) {
          const error = `No such tool: ${name}`;
          const step = { tool: name, args, result: null, error };
          steps.push(step);
          opts?.onToolEnd?.(step);
          responseParts.push({ functionResponse: { name, response: { error } } });
          continue;
        }
        try {
          const result = await tool.run(args);
          const step = { tool: tool.name, args, result };
          steps.push(step);
          opts?.onToolEnd?.(step);
          responseParts.push({ functionResponse: { name, response: { result: result as Record<string, any> } } });
        } catch (err: any) {
          const error = err?.message || String(err);
          const step = { tool: tool.name, args, result: null, error };
          steps.push(step);
          opts?.onToolEnd?.(step);
          responseParts.push({ functionResponse: { name, response: { error } } });
        }
      }
      contents.push({ role: "user", parts: responseParts });
    }

    return {
      reply: "I wasn't able to finish that -- I kept needing more information and ran out of steps.",
      steps,
      exhausted: true,
    };
  },
};
