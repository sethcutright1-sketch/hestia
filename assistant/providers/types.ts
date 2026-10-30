// Shared provider abstraction (Stage 2).
//
// Each provider implements the same tool-calling loop shape as ollama.ts's
// original chatWithTools -- run tools, feed results back, repeat until the
// model answers in prose -- in its own native wire format internally. The
// caller (server.ts) never branches on which provider is active; it just
// gets a ChatResult back.

import type { ChatMessage, ChatResult, ToolStep } from "../../ollama.ts";

export type { ChatMessage, ChatResult, ToolStep };

export interface ChatOptions {
  signal?: AbortSignal;
  /** Called with each incremental piece of the model's prose reply as it streams in. */
  onDelta?: (text: string) => void;
  /** Called the moment a tool call is about to run, before its result is known. */
  onToolStart?: (call: { tool: string; args: Record<string, any> }) => void;
  /** Called once a tool call finishes (or errors) with its full result. */
  onToolEnd?: (step: ToolStep) => void;
  maxRounds?: number;
}

export type ProviderId = "ollama" | "anthropic" | "gemini";

export interface Provider {
  id: ProviderId;
  label: string;
  chat(messages: ChatMessage[], tools: import("../../ollama.ts").ToolDefinition[], opts?: ChatOptions): Promise<ChatResult>;
}

/**
 * A provider couldn't handle this turn -- missing key, unreachable, rejected
 * credentials. Carries a `hint` meant to be shown to the user verbatim rather
 * than a generic "something went wrong", since the fix is usually "start
 * Ollama" or "paste a key", not a bug to investigate.
 */
export class ProviderUnavailableError extends Error {
  provider: string;
  hint: string;
  constructor(provider: string, hint: string) {
    super(`${provider} is not available: ${hint}`);
    this.name = "ProviderUnavailableError";
    this.provider = provider;
    this.hint = hint;
  }
}
