// The admin's voice-input setting, read in one place so the chat planner (assistant/turn.ts), the settings routes
// (routes/assistant.ts) and the transcribe endpoint can't disagree about the key.
//
//   assistant.speechBackend   "off" (default)   no microphone; POST /api/assistant/transcribe answers 409.
//                             "whisper_local"   our own whisper.cpp on this PC (assistant/speech/whisper.ts). The audio
//                                               never leaves the house, so a question typed by voice is treated like a
//                                               typed one -- money and health questions included.
//
// A "web_speech" value (the browser's own recognizer, which streams audio to Google) is planned (PLAN.md Stage 8b) but
// deliberately not accepted yet: it would need the per-turn mic restrictions that make it safe, and a stored value
// nothing enforces is worse than none.

import { getConfig } from "../../db.ts";

export const SPEECH_BACKEND_KEY = "assistant.speechBackend";
export const SPEECH_BACKENDS = ["off", "whisper_local"] as const;
export type SpeechBackend = (typeof SPEECH_BACKENDS)[number];

/** Which backend is on. Anything stored that isn't a known value reads as "off" -- a malformed row never turns the mic on. */
export function speechBackend(): SpeechBackend {
  return getConfig(SPEECH_BACKEND_KEY, "off") === "whisper_local" ? "whisper_local" : "off";
}
