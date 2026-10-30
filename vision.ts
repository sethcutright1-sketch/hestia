// One-shot, non-conversational image analysis: "what food items are visible
// in this photo?" Deliberately isolated from assistant/providers/* -- those
// are a multi-round tool-calling chat loop, this is a single request with a
// strict "reply with only a JSON array" contract, called directly by
// routes/fridge.ts, routes/vision.ts, and assistant/tools/fridge.ts. Same
// isolation reasoning as smartthings.ts living apart from routes/fridge.ts.
//
// Must be the first import -- see env.ts. Without this, the process.env
// reads below (ANTHROPIC_API_KEY etc.) can run before server.ts's dotenv
// setup has loaded .env.local.
import "./env.ts";

import fs from "fs";
import path from "path";
import { getConfig, setConfig, getScopedItems } from "./db.ts";
import { findByName } from "./assistant/tools/shared.ts";
import type { PantryItem } from "./routes/pantry.ts";

export type VisionProviderId = "anthropic" | "gemini" | "ollama";
export type VisionProviderSetting = VisionProviderId | "auto";

export class VisionUnavailableError extends Error {}

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
// No default on purpose: the app's default OLLAMA_MODEL (llama3.1) is
// text-only, so "vision configured for Ollama" has to be an explicit,
// separate opt-in rather than silently reusing the chat model.
const OLLAMA_VISION_MODEL = process.env.OLLAMA_VISION_MODEL || "";

const PROVIDER_LABELS: Record<VisionProviderId, string> = {
  anthropic: `Claude (${ANTHROPIC_MODEL})`,
  gemini: `Gemini (${GEMINI_MODEL})`,
  ollama: OLLAMA_VISION_MODEL ? `Ollama (${OLLAMA_VISION_MODEL}, local)` : "Ollama (local)",
};

// Fixed priority for "auto" -- cloud providers first since they're generally
// the more capable/reliable models; Ollama last since it also needs a
// specific vision model pulled, not just a running server.
const AUTO_ORDER: VisionProviderId[] = ["anthropic", "gemini", "ollama"];

export function getVisionProviderSetting(): VisionProviderSetting {
  return getConfig("vision.provider", "auto");
}

export function setVisionProviderSetting(id: VisionProviderSetting): void {
  setConfig("vision.provider", id);
}

async function ollamaReachable(): Promise<boolean> {
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`);
    return r.ok;
  } catch {
    return false;
  }
}

export async function visionProviderStatus(): Promise<
  { id: VisionProviderId; label: string; available: boolean; reason?: string }[]
> {
  const ollamaUp = OLLAMA_VISION_MODEL ? await ollamaReachable() : false;
  return [
    {
      id: "anthropic",
      label: PROVIDER_LABELS.anthropic,
      available: ANTHROPIC_API_KEY.length > 0,
      reason: ANTHROPIC_API_KEY.length > 0 ? undefined : "ANTHROPIC_API_KEY not set.",
    },
    {
      id: "gemini",
      label: PROVIDER_LABELS.gemini,
      available: GEMINI_API_KEY.length > 0,
      reason: GEMINI_API_KEY.length > 0 ? undefined : "GEMINI_API_KEY not set.",
    },
    {
      id: "ollama",
      label: PROVIDER_LABELS.ollama,
      available: ollamaUp,
      reason: OLLAMA_VISION_MODEL
        ? ollamaUp
          ? undefined
          : `Ollama isn't reachable at ${OLLAMA_URL}.`
        : "OLLAMA_VISION_MODEL not set -- the default chat model can't see images.",
    },
  ];
}

// Every provider gets the exact same instruction, so a switch in settings
// never changes what's being asked -- only who answers.
const PROMPT =
  'List the distinct food or grocery items visible in this photo. Reply with ONLY a JSON array ' +
  'of short item names (e.g. ["milk","eggs"]), no other text. If nothing is identifiable, reply with [].';

function parseItemList(text: string): string[] {
  try {
    const parsed = JSON.parse(text.trim());
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((x) => typeof x === "string")
      .map((x) => x.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function viaAnthropic(base64Image: string, mediaType: string): Promise<string[]> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 512,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: base64Image } },
            { type: "text", text: PROMPT },
          ],
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic vision request failed (${res.status})`);
  const data: any = await res.json();
  const text = (data.content || [])
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("");
  return parseItemList(text);
}

async function viaGemini(base64Image: string, mediaType: string): Promise<string[]> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    // The key goes in a header, not the URL: query strings end up in proxy and error logs (L3).
    headers: { "content-type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ inlineData: { mimeType: mediaType, data: base64Image } }, { text: PROMPT }],
        },
      ],
      generationConfig: { temperature: 0.1, maxOutputTokens: 512 },
    }),
  });
  if (!res.ok) throw new Error(`Gemini vision request failed (${res.status})`);
  const data: any = await res.json();
  const parts = data.candidates?.[0]?.content?.parts || [];
  const text = parts
    .filter((p: any) => typeof p.text === "string")
    .map((p: any) => p.text)
    .join("");
  return parseItemList(text);
}

async function viaOllama(base64Image: string): Promise<string[]> {
  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_VISION_MODEL,
      prompt: PROMPT,
      images: [base64Image],
      stream: false,
    }),
  });
  if (!res.ok) throw new Error(`Ollama vision request failed (${res.status})`);
  const data: any = await res.json();
  return parseItemList(data.response || "");
}

async function runProvider(id: VisionProviderId, base64Image: string, mediaType: string): Promise<string[]> {
  if (id === "anthropic") return viaAnthropic(base64Image, mediaType);
  if (id === "gemini") return viaGemini(base64Image, mediaType);
  return viaOllama(base64Image);
}

const LOG_DIR = path.join(process.cwd(), "data", "logs");
const LOG_PATH = path.join(LOG_DIR, "vision.log");

// Best-effort only -- a scan must never fail because logging failed.
function logScan(entry: Record<string, unknown>): void {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_PATH, JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + "\n");
  } catch (err) {
    console.error("Failed to write vision.log:", err);
  }
}

export async function identifyFoodItems(
  base64Image: string,
  mediaType: string,
  source: "camera" | "upload" | "assistant"
): Promise<{ items: string[]; provider: VisionProviderId }> {
  const setting = getVisionProviderSetting();
  const statuses = await visionProviderStatus();
  const availableById = new Map(statuses.map((s) => [s.id, s]));

  // An explicit choice behaves like one: it either runs or fails naming
  // itself, never silently falling back to a different provider.
  const candidates: VisionProviderId[] = setting === "auto" ? AUTO_ORDER : [setting];

  for (const id of candidates) {
    const status = availableById.get(id);
    if (!status?.available) continue;
    try {
      const items = await runProvider(id, base64Image, mediaType);
      logScan({ source, provider: id, itemCount: items.length, items });
      return { items, provider: id };
    } catch (err: any) {
      logScan({ source, provider: id, error: err?.message || String(err) });
      // A specific choice that errors should surface that error, not silently
      // try other providers behind the user's back.
      if (setting !== "auto") {
        throw new VisionUnavailableError(`${PROVIDER_LABELS[id]} couldn't analyze the photo: ${err?.message || err}`);
      }
    }
  }

  const message =
    setting === "auto"
      ? "Scanning needs one of: an Anthropic or Gemini API key, or an Ollama vision model -- none are configured."
      : `${PROVIDER_LABELS[setting]} isn't available (${availableById.get(setting)?.reason || "not configured"}).`;
  logScan({ source, provider: setting, error: message });
  throw new VisionUnavailableError(message);
}

export function annotateAgainstPantry(names: string[], userId: string): { name: string; alreadyTracked: boolean }[] {
  const pantryItems = getScopedItems("pantry_items", userId) as PantryItem[];
  return names.map((name) => ({ name, alreadyTracked: !!findByName(pantryItems, name) }));
}
