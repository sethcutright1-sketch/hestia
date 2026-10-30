// Stage 4: conversation-list CRUD for the assistant's persisted history.
// The actual chat turn (POST /api/assistant/chat) stays in server.ts, since it
// also owns the system prompt and provider/tool routing -- this file is just
// the list/rename/delete/read-transcript surface around what that endpoint
// writes to conversations/messages.
import express from "express";
import { listConversations, getConversation, renameConversation, deleteConversation, listMessages, getConfig, setConfig } from "../db.ts";
import { currentUserId, verifyPassword, requireAdmin, requireRealSession } from "../auth.ts";
import { transcribeTurns, tooManyTurns } from "../rateLimit.ts";
import { SHARE_GROCERY_BUDGET_KEY } from "./mealplan.ts";
import {
  CLOUD_HEALTH_PROVIDERS,
  NO_HEALTH_VOICE_KEY,
  cloudHealthKey,
  cloudHealthSettings,
  noHealthVoiceData,
} from "../assistant/healthSettings.ts";
import { SPEECH_BACKEND_KEY, speechBackend } from "../assistant/speech/settings.ts";
import { whisper, whisperConfigured } from "../assistant/speech/whisper.ts";
import { whisperPrompt } from "../assistant/speech/prompt.ts";
import { checkWav } from "../assistant/speech/wav.ts";

export const assistantRoutes = express.Router();

// Household-wide (not per-user), like lock_pin_hash -- one shared setting for
// whether a voice-originated financial question is allowed through at all.
// Default true (blocked) since that's the safe posture; see server.ts's
// POST /api/assistant/chat for where this is actually enforced.
assistantRoutes.get("/settings", (_req, res) => {
  res.json({
    noFinanceVoiceData: getConfig("assistant.noFinanceVoiceData", true),
    allowCloudFinance: cloudFinanceSettings(),
    // The health twins (assistant/healthSettings.ts): which cloud providers may receive food-diary / calorie /
    // weight data (all off), and whether a spoken health question is refused (on).
    allowCloudHealth: cloudHealthSettings(),
    noHealthVoiceData: noHealthVoiceData(),
    shareGroceryBudget: getConfig(SHARE_GROCERY_BUDGET_KEY, false) === true,
    // Voice input (assistant/speech/): which backend the microphone uses, and whether this server has Whisper installed
    // at all (a model and a server binary that exist), so Settings can say why the option isn't offered.
    speechBackend: speechBackend(),
    whisperConfigured: whisperConfigured(),
  });
});

// Admin-only, and only from a real sign-in: a device token (the watch, the one client that
// sends voice) must never switch off the rule that keeps its own voice questions about money
// away from a model. the project notes 10.5.
assistantRoutes.put("/settings", requireAdmin, requireRealSession, (req, res) => {
  const { noFinanceVoiceData } = req.body || {};
  if (typeof noFinanceVoiceData !== "boolean") {
    return res.status(400).json({ error: "noFinanceVoiceData must be a boolean" });
  }
  setConfig("assistant.noFinanceVoiceData", noFinanceVoiceData);
  res.json({ noFinanceVoiceData });
});

// Per-provider admin opt-in that relaxes the Stage 2 data boundary: when a
// provider's flag is true, financial turns and budget tools may run on it if
// it's the one picked. See assistant/providers/index.ts's mayReceiveFinancial
// for the enforcement. Claude and Gemini are separate keys so consenting to
// one never implies the other. Asymmetric on purpose: turning one ON sends
// real financial data off the machine, so it needs the account password and
// is refused to the kiosk login -- the same bar as removing the budget PIN
// (routes/lock.ts). Turning one OFF only makes things safer, so any signed-in
// session can do it. Kept off PUT /settings so the voice toggle is unchanged.
const CLOUD_FINANCE_PROVIDERS = ["anthropic", "gemini"] as const;
type CloudFinanceProvider = (typeof CLOUD_FINANCE_PROVIDERS)[number];

function cloudFinanceSettings(): Record<CloudFinanceProvider, boolean> {
  return {
    anthropic: getConfig("assistant.allowCloudFinance.anthropic", false) === true,
    gemini: getConfig("assistant.allowCloudFinance.gemini", false) === true,
  };
}

assistantRoutes.put("/settings/cloud-finance", requireAdmin, async (req, res) => {
  const { provider, allow, password } = req.body || {};
  if (!CLOUD_FINANCE_PROVIDERS.includes(provider)) {
    return res.status(400).json({ error: 'provider must be "anthropic" or "gemini"' });
  }
  if (typeof allow !== "boolean") {
    return res.status(400).json({ error: "allow must be a boolean" });
  }
  if (allow && !(await verifyPassword(currentUserId(req), password))) {
    return res.status(401).json({ error: "Incorrect password." });
  }
  setConfig(`assistant.allowCloudFinance.${provider}`, allow);
  res.json({ allowCloudFinance: cloudFinanceSettings() });
});

// HEALTH data (the food diary, calories, calorie budgets, weight, steps; `sensitivity: "health"`) has its own
// per-provider opt-in, a mirror of the money one above and independent of it: allowing Claude to see money never
// lets it see health data, and Claude and Gemini are separate. Same asymmetry: turning one ON sends real health data
// off the machine, so it needs the admin's account password; turning it OFF is always allowed to an admin.
// Off by default. While a provider's switch is off, the health tools are not even in its request
// (assistant/providers/index.ts toolsForProvider) and a health-looking turn runs on the local model.
assistantRoutes.put("/settings/cloud-health", requireAdmin, async (req, res) => {
  const { provider, allow, password } = req.body || {};
  if (!(CLOUD_HEALTH_PROVIDERS as readonly string[]).includes(provider)) {
    return res.status(400).json({ error: 'provider must be "anthropic" or "gemini"' });
  }
  if (typeof allow !== "boolean") {
    return res.status(400).json({ error: "allow must be a boolean" });
  }
  if (allow && !(await verifyPassword(currentUserId(req), password))) {
    return res.status(401).json({ error: "Incorrect password." });
  }
  setConfig(cloudHealthKey(provider), allow);
  res.json({ allowCloudHealth: cloudHealthSettings() });
});

// The health twin of noFinanceVoiceData: whether a spoken (Wear OS / future voice input) question that looks like
// health data is refused before it reaches any model. Default ON (refused), the same default as money. Admin only,
// and -- unlike the money one, whose PUT /settings has no admin check at all (the project notes 10.5) -- never from a
// device token, since the watch is exactly what this guard is about.
assistantRoutes.put("/settings/health-voice", requireAdmin, (req, res) => {
  if (req.deviceUserId) return res.status(403).json({ error: "Not available from a device token." });
  const { noHealthVoiceData: block } = req.body || {};
  if (typeof block !== "boolean") {
    return res.status(400).json({ error: "noHealthVoiceData must be a boolean" });
  }
  setConfig(NO_HEALTH_VOICE_KEY, block);
  res.json({ noHealthVoiceData: noHealthVoiceData() });
});

// Voice input. "whisper_local" turns the browser microphone on, with the audio transcribed by whisper.cpp on this PC
// (assistant/speech/whisper.ts) -- it never leaves the house, which is why a spoken question is then treated like a typed
// one (assistant/turn.ts). Admin only, from a real sign-in. A device token is refused (the watch, the one
// client the voice refusals exist for, must not be able to change how voice is treated). Turning it off is always allowed, even on a server without Whisper.
// "web_speech" (the browser's own recognizer, which streams audio to Google) is not accepted until its restrictions exist.
assistantRoutes.put("/settings/speech", requireAdmin, requireRealSession, (req, res) => {
  const { speechBackend: next } = req.body || {};
  if (next !== "off" && next !== "whisper_local") {
    return res.status(400).json({ error: 'speechBackend must be "off" or "whisper_local"' });
  }
  if (next === "whisper_local" && !whisperConfigured()) {
    return res.status(400).json({ error: "Whisper isn't set up on this server." });
  }
  setConfig(SPEECH_BACKEND_KEY, next);
  // Off frees the model's memory (and the GPU) right away instead of at the idle timeout.
  if (next === "off") whisper.stop();
  res.json({ speechBackend: speechBackend() });
});

// Lets meal planning see the Groceries category's budgeted amount -- one
// number, never transactions (see groceryBudget() in routes/mealplan.ts).
// Same asymmetric bar as cloud-finance above: it goes into every system
// prompt, so a cloud provider sees it on every turn once this is on, and
// turning that ON needs the account password. OFF is always allowed.
assistantRoutes.put("/settings/grocery-budget", requireAdmin, async (req, res) => {
  const { allow, password } = req.body || {};
  if (typeof allow !== "boolean") {
    return res.status(400).json({ error: "allow must be a boolean" });
  }
  if (allow && !(await verifyPassword(currentUserId(req), password))) {
    return res.status(401).json({ error: "Incorrect password." });
  }
  setConfig(SHARE_GROCERY_BUDGET_KEY, allow);
  res.json({ shareGroceryBudget: allow });
});

assistantRoutes.get("/conversations", (req, res) => {
  res.json({ conversations: listConversations(currentUserId(req)) });
});

assistantRoutes.put("/conversations/:id", (req, res) => {
  const { title } = req.body || {};
  if (!title || typeof title !== "string" || !title.trim()) {
    return res.status(400).json({ error: "title is required" });
  }
  const ok = renameConversation(currentUserId(req), req.params.id, title.trim());
  if (!ok) return res.status(404).json({ error: "Conversation not found" });
  res.json({ success: true });
});

assistantRoutes.delete("/conversations/:id", (req, res) => {
  const ok = deleteConversation(currentUserId(req), req.params.id);
  if (!ok) return res.status(404).json({ error: "Conversation not found" });
  res.json({ success: true });
});

// Full transcript, shaped so the client can rebuild its Turn[] array directly:
// tool_calls/tool_results are zipped back together into one ToolStep[] per
// assistant message, the same shape the live SSE tool_start/tool_end events
// already build turn-by-turn.
assistantRoutes.get("/conversations/:id/messages", (req, res) => {
  const userId = currentUserId(req);
  const conversation = getConversation(userId, req.params.id);
  if (!conversation) return res.status(404).json({ error: "Conversation not found" });

  const messages = listMessages(conversation.id).map((m) => ({
    role: m.role,
    text: m.content,
    steps: m.toolCalls
      ? m.toolCalls.map((call, i) => ({
          tool: call.tool,
          args: call.args,
          result: m.toolResults?.[i]?.result,
          error: m.toolResults?.[i]?.error,
        }))
      : undefined,
  }));

  res.json({ conversation, messages });
});

// Speech to text for the browser's microphone. The body is the raw recording (Content-Type: audio/wav, 16 kHz mono 16-bit,
// at most 30 s); the reply is { text }, possibly empty when nothing was said. This mounts its own raw-body parser:
// server.ts's app-wide express.json() only touches JSON, so the bytes reach this route untouched.
//
// The audio exists only in memory for the length of this request -- it is never written to disk, and neither the audio
// nor the transcript is logged. Open to every signed-in login (the kiosk and device tokens included, as chat is).
const MAX_UPLOAD_BYTES = 1024 * 1024;
const rawWav = express.raw({ type: "audio/wav", limit: MAX_UPLOAD_BYTES });

// Before the body is read, so a server with voice switched off doesn't spend memory on recordings it will refuse.
function voiceReady(_req: express.Request, res: express.Response, next: express.NextFunction) {
  if (speechBackend() !== "whisper_local") return res.status(409).json({ error: "Voice input is off." });
  if (!whisperConfigured()) {
    console.error("Voice input is switched on but WHISPER_MODEL / WHISPER_SERVER_BIN aren't set to files that exist.");
    return res.status(503).json({ error: "Voice isn't available right now." });
  }
  next();
}

// body-parser reports an oversize or broken body through next(err), which Express would turn into an HTML page.
function readWav(req: express.Request, res: express.Response, next: express.NextFunction) {
  rawWav(req, res, (err?: any) => {
    if (!err) return next();
    if (err.type === "entity.too.large") return res.status(413).json({ error: "That recording is too long." });
    res.status(400).json({ error: "Couldn't read that recording." });
  });
}

assistantRoutes.post("/transcribe", voiceReady, readWav, async (req, res) => {
  if (!Buffer.isBuffer(req.body)) {
    return req.is("audio/wav")
      ? res.status(400).json({ error: "No recording was received." })
      : res.status(415).json({ error: "Send the recording as audio/wav." });
  }
  const check = checkWav(req.body);
  if (!check.ok) return res.status(400).json({ error: check.error });

  // After validation, like chat: a malformed upload never reaches Whisper, so it shouldn't spend one of a person's turns.
  const userId = currentUserId(req);
  const turn = transcribeTurns.acquire(`transcribe:${userId}`);
  if (!turn.ok) return tooManyTurns(res, turn);
  // `finally` covers every path out of the handler; 'close' covers a client that hangs up while Whisper is still working.
  res.on("close", turn.release);
  try {
    const text = await whisper.transcribe(req.body, { prompt: whisperPrompt(userId) });
    res.json({ text });
  } catch (err) {
    // The real reason stays in the server log: it can name file paths, which the browser has no business seeing.
    console.error("Voice transcription failed:", err instanceof Error ? err.message : "unexpected error");
    res.status(503).json({ error: "Voice isn't available right now." });
  } finally {
    turn.release();
  }
});
