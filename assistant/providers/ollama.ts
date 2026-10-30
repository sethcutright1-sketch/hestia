// Ollama as a Provider. Thin wrapper -- all the real logic (the tool loop,
// the coerceArgs shim for llama3.1's malformed args, retry-on-503) stays in
// ollama.ts, since it's used elsewhere too (generateJson).

import { chatWithTools, OllamaUnavailableError, OLLAMA_MODEL, OLLAMA_URL } from "../../ollama.ts";
import { ProviderUnavailableError, type Provider } from "./types.ts";

// Local model, no per-call cost, so it gets more rounds than the paid providers' 8: saving a week one day per call needs
// two reads plus seven writes. (The chat route is rate limited, so a long loop can't be hammered.)
export const OLLAMA_MAX_ROUNDS = 12;

export const ollamaProvider: Provider = {
  id: "ollama",
  label: `Ollama (${OLLAMA_MODEL}, local)`,
  async chat(messages, tools, opts) {
    try {
      return await chatWithTools(
        messages,
        tools,
        opts?.maxRounds ?? OLLAMA_MAX_ROUNDS,
        opts?.signal,
        opts?.onDelta,
        opts?.onToolStart,
        opts?.onToolEnd
      );
    } catch (err) {
      if (err instanceof OllamaUnavailableError) {
        throw new ProviderUnavailableError(
          "ollama",
          `Ollama isn't running at ${OLLAMA_URL}. Start it and make sure the model is pulled: \`ollama pull ${OLLAMA_MODEL}\`.`
        );
      }
      throw err;
    }
  },
};

export async function ollamaReachable(): Promise<boolean> {
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`);
    return r.ok;
  } catch {
    return false;
  }
}
