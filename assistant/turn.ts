// Everything POST /api/assistant/chat decides BEFORE the first model call, as one plain function so the data
// boundary can be tested without a server (server.ts calls app.listen() at import time).
//
// The decisions, in order:
//   1. Does the turn look financial? Does it look like health data (food diary, calories, weight)? Two independent
//      rules, each scanning the message and exactly the history about to be sent (providers/index.ts).
//   2. Which provider runs it? The user's pick, unless the turn is financial / health-related and that provider has
//      not been opted in for that kind of data -- then local Ollama.
//   3. Is a spoken money or health question refused outright? (Defaults: yes, both.) The Wear OS watch always is, because its
//      speech-to-text may go through Google; the browser mic is not, but only while our own Whisper does the listening.
//   4. Which tools does that provider get? Never a financial tool without the money opt-in, never a health tool
//      without the health opt-in (the hard guarantee: the definitions are not in the payload at all), nothing
//      financial while the budget PIN lock is engaged, nothing health while the person's food-diary lock is.
//   5. What may the system prompt mention? Exactly the capabilities that survived step 4.
//
// "Kiosk" is a role, not a setting here: the kiosk login's calorie tools are chosen by the calorie module
// itself (assistant/tools/calories.ts) from the role and the admin's kiosk setting.

import { getConfig, getUserById } from "../db.ts";
import { pinRequiredFor } from "../routes/nutrition/pin.ts";
import type { ToolDefinition } from "../ollama.ts";
import { cloudHealthSettings, noHealthVoiceData } from "./healthSettings.ts";
import { speechBackend } from "./speech/settings.ts";
import {
  blocksVoiceFinance,
  blocksVoiceHealth,
  mayReceiveFinancial,
  mayReceiveHealth,
  selectProvider,
  toolsForProvider,
  turnTouchesFinancialData,
  turnTouchesHealthData,
  type CloudFinanceAllowance,
  type CloudHealthAllowance,
  type Provider,
} from "./providers/index.ts";
import { buildTools, type ToolContext } from "./registry.ts";
import type { PromptOptions } from "./systemPrompt.ts";

export interface TurnInput {
  userId: string;
  message: string;
  /** The stored history about to be transmitted with this turn -- exactly that, so nothing goes out unscanned. */
  history: { text: string }[];
  /** The picker's choice (a provider id), or anything else the client sent. */
  requestedProvider?: string;
  /**
   * "voice" for the Wear OS app (audio transcribed by something that may be a cloud service); "voice_local" for the browser
   * mic when the household's own Whisper transcribed it (see planTurn). A typed web request omits it.
   */
  inputMode?: unknown;
  /** auth.ts's isUnlocked(req): the household PIN lock is open (true when no PIN is set). */
  unlocked: boolean;
  /** The request carried a Wear OS device token. */
  device?: boolean;
  /** Test seam for the clock. */
  now?: () => Date;
  /**
   * A value unique to this chat request (server.ts makes one per POST /api/assistant/chat). Becomes the tools' ctx.turnId,
   * which is how a bulk delete knows a confirmation came from a LATER request. Left out, buildTools makes one up.
   */
  turnId?: string;
}

export interface TurnPlan {
  provider: Provider;
  isFinancial: boolean;
  isHealth: boolean;
  /** The budget PIN lock is engaged for this session. */
  financialLocked: boolean;
  /** The person turned on "Require the PIN for my food diary" and this session hasn't unlocked it. */
  foodDiaryLocked: boolean;
  role: string | undefined;
  cloudFinance: CloudFinanceAllowance;
  cloudHealth: CloudHealthAllowance;
  /** Set when the turn must be refused before any provider sees it (a spoken money / health question). */
  blocked?: { kind: "finance" | "health"; reply: string };
  /** What the provider is actually handed. */
  tools: ToolDefinition[];
  /** What the system prompt may describe, to match `tools`. */
  prompt: PromptOptions;
}

export const VOICE_FINANCE_REPLY = "That sounds like a money question -- type it in instead so it stays off voice.";
export const VOICE_HEALTH_REPLY = "That sounds like a question about someone's food diary or health -- type it in instead so it stays off voice.";

export function planTurn(input: TurnInput): TurnPlan {
  const { userId, message, history } = input;
  const role = getUserById(userId)?.role;
  const financialLocked = !input.unlocked;
  const device = input.device === true;

  const isFinancial = turnTouchesFinancialData(message, history);
  const isHealth = turnTouchesHealthData(message, history);

  // Per-provider admin opt-ins, all off by default. Read once per turn so routing and tool filtering can't disagree.
  const cloudFinance: CloudFinanceAllowance = {
    anthropic: getConfig("assistant.allowCloudFinance.anthropic", false) === true,
    gemini: getConfig("assistant.allowCloudFinance.gemini", false) === true,
  };
  const cloudHealth: CloudHealthAllowance = cloudHealthSettings();
  const provider = selectProvider(input.requestedProvider, isFinancial, cloudFinance, isHealth, cloudHealth);

  // The person's own food-diary PIN lock (routes/nutrition/pin.ts): the same state in which /api/nutrition answers 423.
  // A device token can never enter a PIN, so it is locked out of a login that requires one. The kiosk has no diary.
  const foodDiaryLocked = role !== "kiosk" && pinRequiredFor(userId) && (device || financialLocked);

  const base = { provider, isFinancial, isHealth, financialLocked, foodDiaryLocked, role, cloudFinance, cloudHealth };

  // Audio that our own Whisper transcribed never left the house, so a "voice_local" turn is exactly as private as a typed
  // one and skips the voice refusals. But that is only true while the admin has Whisper switched on: with the backend off
  // (or changed), the claim comes from a client we can't vouch for, so it is refused like the watch's voice. "voice"
  // itself is untouched, and any other value (including none) is a typed turn, as before.
  const inputMode = input.inputMode === "voice_local" ? (speechBackend() === "whisper_local" ? undefined : "voice") : input.inputMode;

  const blockedKind: "finance" | "health" | null = blocksVoiceFinance(inputMode, isFinancial, getConfig("assistant.noFinanceVoiceData", true))
    ? "finance"
    : blocksVoiceHealth(inputMode, isHealth, noHealthVoiceData())
      ? "health"
      : null;

  const ctx: ToolContext = { role, device, foodDiaryLocked, now: input.now, turnId: input.turnId };
  let tools = toolsForProvider(provider.id, buildTools(userId, !financialLocked, ctx), cloudFinance, cloudHealth);
  if (financialLocked) tools = tools.filter((t) => t.sensitivity !== "financial");
  if (foodDiaryLocked) tools = tools.filter((t) => t.sensitivity !== "health");

  const kiosk = role === "kiosk";
  const prompt: PromptOptions = {
    // Described only when really offered: not while the budget PIN lock is engaged, and not to a cloud provider that
    // has no money consent (it was never handed the budget tools, so the prompt shouldn't advertise them).
    hideFinancial: financialLocked || !mayReceiveFinancial(provider.id, cloudFinance),
    // The health section is described only when its tools really are offered.
    hideHealth: foodDiaryLocked || !mayReceiveHealth(provider.id, cloudHealth),
    kiosk: kiosk ? { toolNames: tools.filter((t) => t.sensitivity === "health").map((t) => t.name) } : undefined,
  };

  return {
    ...base,
    blocked: blockedKind
      ? { kind: blockedKind, reply: blockedKind === "finance" ? VOICE_FINANCE_REPLY : VOICE_HEALTH_REPLY }
      : undefined,
    tools,
    prompt,
  };
}
