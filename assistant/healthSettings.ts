// The admin's health-data settings for the assistant, read in one place so the chat endpoint
// (assistant/turn.ts) and the settings routes (routes/assistant.ts) can't disagree about a key.
//
// They are the health twins of the money settings and mirror them exactly:
//
//   assistant.allowCloudHealth.anthropic   off by default; Claude may receive food-diary / calorie / weight data
//   assistant.allowCloudHealth.gemini      off by default; Gemini may. Separate switches, never implying each other,
//                                          and independent of assistant.allowCloudFinance.<provider>.
//   assistant.noHealthVoiceData            ON (true) by default: a spoken (Wear OS) question that looks like health data
//                                          is refused so it stays off voice, like assistant.noFinanceVoiceData for money.

import { getConfig } from "../db.ts";
import type { CloudHealthAllowance } from "./providers/index.ts";

export const CLOUD_HEALTH_PROVIDERS = ["anthropic", "gemini"] as const;
export type CloudHealthProvider = (typeof CLOUD_HEALTH_PROVIDERS)[number];

export const cloudHealthKey = (provider: CloudHealthProvider): string => `assistant.allowCloudHealth.${provider}`;
export const NO_HEALTH_VOICE_KEY = "assistant.noHealthVoiceData";

/** Which cloud providers may receive health data. Strict `=== true`: a malformed stored value never counts as consent. */
export function cloudHealthSettings(): Record<CloudHealthProvider, boolean> & CloudHealthAllowance {
  return {
    anthropic: getConfig(cloudHealthKey("anthropic"), false) === true,
    gemini: getConfig(cloudHealthKey("gemini"), false) === true,
  };
}

/** Is a spoken health question refused? Default yes. */
export const noHealthVoiceData = (): boolean => getConfig(NO_HEALTH_VOICE_KEY, true) !== false;
