// Provider selection: which of Ollama/Anthropic/Gemini are configured, and
// the data-boundary rule (PLAN.md Stage 2) that decides which one actually
// handles a given turn.
//
// The locked-in rule: any turn that could touch financial data runs on local
// Ollama only, decided *before* the first model call -- never by trusting a
// cloud model not to ask for a tool it was never offered. Two layers enforce
// it independently:
//   1. selectProvider() routes the whole turn to Ollama when the turn looks
//      financial, regardless of what the user picked.
//   2. toolsForProvider() never includes a `sensitivity: "financial"` tool in
//      what a cloud provider is even offered, so even a misrouted turn can't
//      have a financial tool called on it.
//
// The one exception is the per-provider admin opt-in
// `assistant.allowCloudFinance.<provider>` (routes/assistant.ts, all off by
// default): when a provider's flag is on, both layers let financial turns and
// tools through to *that* provider only. Claude and Gemini are separate
// switches so enabling one never implies the other. Callers that omit the
// allowance get the strict local-only behaviour.
//
// HEALTH data (the food diary, calorie budgets, weight, steps, goals, streaks;
// `sensitivity: "health"`) follows the very same rule as a second, INDEPENDENT
// rule with its own opt-in, `assistant.allowCloudHealth.<provider>`: its own
// signal (turnTouchesHealthData), its own allowance, and the same two layers.
// Letting a provider see money never lets it see health, and the other way round.
// A turn that is both needs both consents. Plain recipe calories and the household
// meal plan are NOT health data (they stay `household`); see assistant/tools/calories.ts.

import type { ToolDefinition } from "../../ollama.ts";
import { ollamaProvider, ollamaReachable } from "./ollama.ts";
import { anthropicProvider, anthropicConfigured, ANTHROPIC_MODEL } from "./anthropic.ts";
import { geminiProvider, geminiConfigured, GEMINI_MODEL } from "./gemini.ts";
import type { Provider, ProviderId } from "./types.ts";

export * from "./types.ts";

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  available: boolean;
  reason?: string;
}

export async function listProviders(): Promise<ProviderInfo[]> {
  const ollamaUp = await ollamaReachable();
  return [
    {
      id: "ollama",
      label: ollamaProvider.label,
      available: ollamaUp,
      reason: ollamaUp ? undefined : "Ollama isn't reachable -- start it locally.",
    },
    {
      id: "anthropic",
      label: `Claude (${ANTHROPIC_MODEL})`,
      available: anthropicConfigured(),
      reason: anthropicConfigured() ? undefined : "ANTHROPIC_API_KEY not set.",
    },
    {
      id: "gemini",
      label: `Gemini (${GEMINI_MODEL})`,
      available: geminiConfigured(),
      reason: geminiConfigured() ? undefined : "GEMINI_API_KEY not set.",
    },
  ];
}

const PROVIDERS: Record<ProviderId, Provider> = {
  ollama: ollamaProvider,
  anthropic: anthropicProvider,
  gemini: geminiProvider,
};

/** A provider by id, or null for anything that isn't one. Unlike selectProvider this applies NO data
 *  boundary and never falls back to Ollama: for one-shot jobs that send only non-sensitive text
 *  (itemCalories.ts sends food names) and must say exactly which model answered. */
export function providerById(id: unknown): Provider | null {
  return typeof id === "string" && Object.hasOwn(PROVIDERS, id) ? PROVIDERS[id as ProviderId] : null;
}

// Stand-in for Stage 5's eval-measured classifier. Deliberately biased toward
// false positives -- a wrongly-local household question just costs answer
// quality; a wrongly-cloud financial one costs the actual privacy guarantee.
// When in doubt, this says yes.
// Deliberately excludes words that read as financial only in a budget context but
// are common outside one -- "goal", "paid", "afford", "alert" -- which were causing
// the routing override below to fire (and silently override the user's provider
// choice) on ordinary turns like "set an alert" or "what's my goal for the week."
const FINANCIAL_SIGNAL =
  /\b(spend|spent|spending|budget|bill|bills|bank|plaid|balance|credit ?card|debit|expense|transaction|category|categories|income|transfer|savings|paycheck|owe|debt|money)\b|\$\d/i;

/**
 * True if this turn, or any turn we are about to send along with it, looks
 * financial. A stopgap for the real per-conversation pin Stage 4's persistence
 * will do properly: it only sees the window the client supplied, so it cannot
 * know about a financial turn that has already scrolled out of that window.
 * What it does guarantee is that nothing we transmit goes unscanned.
 */
export function turnTouchesFinancialData(message: string, recentHistory: { text: string }[]): boolean {
  if (FINANCIAL_SIGNAL.test(message)) return true;
  // The caller passes exactly the history it is about to transmit, so every
  // entry is scanned -- a fixed-size tail would let anything older reach a cloud
  // provider unchecked. The assistant's own prose about a budget question names
  // merchants and amounts, so that is a real leak, not a theoretical one.
  return recentHistory.some((h) => FINANCIAL_SIGNAL.test(h.text));
}

// The health twin of FINANCIAL_SIGNAL, with the same bias: when in doubt, say yes (a wrongly-local question
// costs answer quality, a wrongly-cloud one costs the privacy guarantee). It is about a PERSON's food diary,
// calorie budget, weight, steps and goals, and about someone saying what they ate. Words that are only
// health-ish in context are left out the way "goal" is left out of the money list: bare "budget" (that is
// money, and has its own signal), bare "steps" (recipe steps), "eat"/"food" (every meal-plan question).
// "Calories" on its own DOES count even though a recipe's calories are household data: the question can't be
// told apart from "how many have I had", and a false positive only means the local model answers it.
const HEALTH_SIGNAL = new RegExp(
  [
    String.raw`\b(?:calor(?:ie|ies|ic)|kcal|kilocalor\w*|macros?|protein|carbs?|carbohydrates?|bmi|body\s*fat)\b`,
    String.raw`\bdiary\b|\b(?:food|meal)\s*(?:log|journal)\b`,
    String.raw`\bweigh(?:s|ed|ing|-?ins?)?\b|\bweight\b`,
    String.raw`\b(?:ate|eaten|drank|snacked)\b`,
    String.raw`\b(?:i|we)\s+(?:just\s+|also\s+)?(?:had|have\s+had)\b`,
    String.raw`\blog(?:ged|ging)?\s+(?:my|our|the|this|that|it|a)\b`,
    String.raw`\bhow\s+many\s+steps\b|\bsteps\s+(?:i|we|he|she|they)\b|\b(?:my|our|his|her|their|\w+'s)\s+steps\b|\bsteps\s+(?:today|yesterday|this|last|walked|count|goal)\b|\bstep\s*count\b`,
    String.raw`\b(?:streak|workout|exercis(?:e|ed|ing)|snack\s+allowance|dieting|diet|fasting|intake)\b`,
  ].join("|"),
  "i"
);

/**
 * True if this turn, or any turn we are about to send along with it, looks like it touches a person's health
 * data (the food diary, calories eaten, a calorie budget, weight, steps, goals, streaks). The twin of
 * turnTouchesFinancialData and just as much a stopgap: it only sees the window the client supplied, and
 * everything we are about to transmit is scanned (the assistant's own prose about a diary names foods and calories).
 */
export function turnTouchesHealthData(message: string, recentHistory: { text: string }[]): boolean {
  if (HEALTH_SIGNAL.test(message)) return true;
  return recentHistory.some((h) => HEALTH_SIGNAL.test(h.text));
}

/** Which cloud providers an admin has opted in to receiving financial data. */
export type CloudFinanceAllowance = Partial<Record<Exclude<ProviderId, "ollama">, boolean>>;

/** Which cloud providers an admin has opted in to receiving health data (`assistant.allowCloudHealth.<provider>`). Independent of the money one. */
export type CloudHealthAllowance = Partial<Record<Exclude<ProviderId, "ollama">, boolean>>;

/**
 * True if `providerId` may see financial turns/tools under `allowed`. The one
 * place both boundary layers below read, so they can't disagree. Strict
 * `=== true` so a malformed stored value never counts as consent.
 */
export function mayReceiveFinancial(providerId: ProviderId, allowed: CloudFinanceAllowance = {}): boolean {
  if (providerId === "ollama") return true;
  return allowed[providerId] === true;
}

/** The health twin of mayReceiveFinancial. Strict `=== true`; Ollama always may. */
export function mayReceiveHealth(providerId: ProviderId, allowed: CloudHealthAllowance = {}): boolean {
  if (providerId === "ollama") return true;
  return allowed[providerId] === true;
}

/**
 * Picks the provider for one turn. `requestedId` is the user's choice from
 * the picker; honoured only when the provider is a real one and, for a
 * financial turn, it may receive financial data, and for a health turn, it
 * may receive health data. Ollama is always the fallback, both when nothing
 * else is configured and when the boundary overrides a cloud request.
 */
export function selectProvider(
  requestedId: string | undefined,
  isFinancial: boolean,
  allowed: CloudFinanceAllowance = {},
  isHealth = false,
  allowedHealth: CloudHealthAllowance = {}
): Provider {
  // Use Object.hasOwn to check only own keys, not inherited Object.prototype keys
  // like "constructor" and "toString", which resolve to something that is not a provider.
  if (!requestedId || !Object.hasOwn(PROVIDERS, requestedId)) return ollamaProvider;
  const requested = PROVIDERS[requestedId as ProviderId];
  if (isFinancial && !mayReceiveFinancial(requested.id, allowed)) return ollamaProvider;
  if (isHealth && !mayReceiveHealth(requested.id, allowedHealth)) return ollamaProvider;
  return requested;
}

/**
 * Tools a given provider may be handed. This is the hard guarantee -- a
 * financial tool is never in a cloud provider's wire payload, and neither is a
 * health tool, so neither can be called there no matter how the routing above
 * is misjudged. The two allowances are independent of each other.
 */
export function toolsForProvider(
  providerId: ProviderId,
  tools: ToolDefinition[],
  allowed: CloudFinanceAllowance = {},
  allowedHealth: CloudHealthAllowance = {}
): ToolDefinition[] {
  const money = mayReceiveFinancial(providerId, allowed);
  const health = mayReceiveHealth(providerId, allowedHealth);
  if (money && health) return tools;
  return tools.filter((t) => (t.sensitivity !== "financial" || money) && (t.sensitivity !== "health" || health));
}

/**
 * True if a turn must be refused before it ever reaches a provider, because
 * it arrived by voice and looks financial. A different guarantee from
 * toolsForProvider above: that one gates which tools a turn that IS running
 * can use; this gates whether the turn runs at all. Only relevant for
 * inputMode "voice" -- a typed request is never affected regardless of the
 * setting. See server.ts's POST /api/assistant/chat and routes/assistant.ts's
 * GET/PUT /settings for where inputMode and noFinanceVoiceData come from.
 */
export function blocksVoiceFinance(inputMode: unknown, isFinancial: boolean, noFinanceVoiceData: boolean): boolean {
  return inputMode === "voice" && isFinancial && noFinanceVoiceData;
}

/**
 * The health twin of blocksVoiceFinance: a spoken question about someone's food diary, calories, weight or
 * steps is refused (by default; `assistant.noHealthVoiceData`) so it stays off voice. Typed requests are never affected.
 */
export function blocksVoiceHealth(inputMode: unknown, isHealth: boolean, noHealthVoiceData: boolean): boolean {
  return inputMode === "voice" && isHealth && noHealthVoiceData;
}
