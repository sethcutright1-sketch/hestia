// The app's entry point -- `npm run dev` runs this file directly (via tsx,
// which lets Node run .ts files without a separate build step). Read this
// file to see how every other piece connects: it loads env vars, wires
// Express middleware and each section's routes, defines the assistant chat
// endpoint, then starts listening. Everything above `async function start()`
// is *route/endpoint definitions* -- Express just records them; nothing runs
// until a real request matches one. `start()` at the bottom is what actually
// boots the server. See LEARNING.md for a guided tour of how this fits with
// the rest of the codebase.
// Must be the first import -- see env.ts for why db.ts (imported below) needs
// this to have already run before ITS top-level code executes, not just
// before server.ts's own.
import "./env.ts";

import express from "express";
import path from "path";
import { randomUUID } from "crypto";
import { createServer as createViteServer } from "vite";

import {
  backupIfNeeded,
  pruneSessions,
  db,
  DB_PATH,
  getConfig,
  getConversation,
  getUserById,
  createConversation,
  listMessages,
  addMessage,
  touchConversation,
  type StoredToolCall,
  type StoredToolResult,
} from "./db.ts";
import { securityHeaders } from "./securityHeaders.ts";
import { appendSecurityEvent } from "./securityLog.ts";
import { assistantTurns, tooManyTurns } from "./rateLimit.ts";
import { sessionMiddleware, deviceTokenAuth, requireAuth, requireUnlocked, forbidKiosk, requireAdmin, isUnlocked, currentUserId, verifyPassword, authRoutes } from "./auth.ts";
import { deviceRoutes } from "./routes/devices.ts";
import { groceryRoutes } from "./routes/grocery.ts";
import { pantryRoutes } from "./routes/pantry.ts";
import { mealPlanRoutes } from "./routes/mealplan.ts";
import { memberRoutes } from "./routes/members.ts";
import { calendarRoutes } from "./routes/calendar.ts";
import { choreRoutes } from "./routes/chores.ts";
import { rewardRoutes } from "./routes/rewards.ts";
import { budgetRoutes } from "./routes/budget.ts";
import { budgetPlaidRoutes } from "./routes/budget-plaid.ts";
import { krogerRoutes } from "./routes/kroger.ts";
import { krogerKeepAlive } from "./kroger.ts";
import { fridgeRoutes } from "./routes/fridge.ts";
import { visionRoutes } from "./routes/vision.ts";
import { lockRoutes } from "./routes/lock.ts";
import { nutritionRoutes } from "./routes/nutrition.ts";
import { assistantRoutes } from "./routes/assistant.ts";
import { toolManifest } from "./assistant/registry.ts";
import { planTurn } from "./assistant/turn.ts";
import { pinRequiredFor } from "./routes/nutrition/pin.ts";
import { isZipImportPath } from "./routes/nutrition/import.ts";
import { systemPrompt } from "./assistant/systemPrompt.ts";
import { replayStoredMessages } from "./assistant/history.ts";
import { OLLAMA_MODEL, type ChatMessage } from "./ollama.ts";
import { healthRoutes } from "./routes/health.ts";
import { listProviders, ProviderUnavailableError } from "./assistant/providers/index.ts";

const app = express();
const PORT = Number(process.env.PORT) || 3200;

// Express announces itself in an X-Powered-By header by default; it tells a stranger nothing
// useful except which bugs to try.
app.disable("x-powered-by");
app.use(securityHeaders);
// Trust X-Forwarded-* only from a loopback peer (Cloudflare Tunnel and Tailscale Serve both connect
// from 127.0.0.1). A LAN client connects from its own address, so its headers are never believed
// and it can't claim to be "HTTPS". This only feeds req.secure (the cookie's secure:"auto");
// the rate limiter reads the socket address and ignores X-Forwarded-For (rateLimit.ts clientIp).
app.set("trust proxy", "loopback");

// The Lose It! import takes a ZIP (up to 100 MB) as the raw request body and reads it itself (express.raw in
// routes/nutrition/import.ts), so the 10 MB JSON parser steps aside for exactly those two POST paths.
const jsonBody = express.json({ limit: "10mb" });
app.use((req, res, next) => (req.method === "POST" && isZipImportPath(req.path) ? next() : jsonBody(req, res, next)));
app.use(sessionMiddleware());
app.use(deviceTokenAuth);

// One express.Router() per section (see routes/pantry.ts for the simplest
// example), mounted under its own path prefix. requireAuth runs first on
// every line but the auth routes themselves -- a request to e.g.
// `/api/pantry/abc123` hits requireAuth, then pantryRoutes' own
// `router.get("/:id", ...)` (which sees just "/abc123", the prefix already
// stripped by app.use).
app.use("/api/auth", authRoutes);
// The kiosk login (auth.ts) reaches every section a real household member
// does -- Groceries, Pantry, Meal Plan, Family, Calendar, Chores, Fridge, the
// assistant, all open. forbidKiosk is reserved for pairing a new device token
// for yourself -- not a "section," and not shared household policy either, so
// it stays at "any real person" rather than admin-only. The household/lock
// PIN, kiosk login management, Plaid credentials and backup download are all
// admin-only now (requireAdmin) -- see auth.ts's comments on both middlewares.
// Budget needs no special-casing here -- getScopedItems' ownership filter
// (owner_user_id IS NULL OR = the caller) already limits a session that owns
// no personal rows of its own to joint data only, the same mechanism that
// keeps one real member from seeing another's personal transactions.
app.use("/api/auth/devices", requireAuth, forbidKiosk, deviceRoutes);
// Before /api/grocery, and without requireAuth: Kroger's sign-in redirect lands on its /callback
// as a plain browser navigation, which has to end in a redirect back into the app, never a 401
// page. Each of its other routes applies requireAuth (and admin/kiosk gates) itself.
app.use("/api/grocery/kroger", krogerRoutes);
app.use("/api/grocery", requireAuth, groceryRoutes);
app.use("/api/pantry", requireAuth, pantryRoutes);
app.use("/api/mealplan", requireAuth, mealPlanRoutes);
app.use("/api/members", requireAuth, memberRoutes);
app.use("/api/calendar", requireAuth, calendarRoutes);
app.use("/api/chores", requireAuth, choreRoutes);
app.use("/api/rewards", requireAuth, rewardRoutes);
// requireUnlocked here also covers everything budgetRoutes mounts on itself
// (budgetPlaidRoutes at "/plaid", store-config, etc.) since it's one middleware
// in front of the whole router, not one per leaf route -- see auth.ts's
// requireUnlocked and PLAN's PIN-lock design.
budgetRoutes.use("/plaid", budgetPlaidRoutes);
app.use("/api/budget", requireAuth, requireUnlocked, budgetRoutes);
app.use("/api/fridge", requireAuth, fridgeRoutes);
app.use("/api/vision", requireAuth, visionRoutes);
app.use("/api/lock", requireAuth, lockRoutes);
// Food diary, calorie budgets, weight, barcodes. requireAuth only -- deliberately no requireUnlocked
// (the PIN lock covers money, and logging food should be quick) and no forbidKiosk here: the
// router's own gate gives the kiosk login 403 everywhere but its two admin-enabled routes
// (see routes/nutrition/kiosk.ts).
app.use("/api/nutrition", requireAuth, nutritionRoutes);
app.use("/api/assistant", requireAuth, assistantRoutes);

// Lets a household member save a copy of the whole database somewhere off this
// machine -- the automatic daily snapshots in data/backups/ only protect against
// corruption, not a lost/failed disk. App-wide, not budget-specific, even though
// it was budget's route in the standalone app.
//
// This is a POST that re-checks the caller's password, not a GET gated only by
// a session cookie: the file contains every household member's transactions
// plus plaintext Plaid access tokens, so a stolen/left-open session shouldn't
// be enough on its own to exfiltrate the whole database. requireUnlocked adds
// the PIN on top -- the password alone no longer being enough once the fridge
// (a permanently signed-in browser) is a device this session could be running on.
// requireAdmin on top of that: this bypasses getScopedItems' ownership filter
// entirely -- it's a raw copy of the database file, not a query -- so "kiosk
// (or a parent) sees joint data only" can't be enforced by the data model
// itself here the way it can for every other route.
app.post("/api/backup/download", requireAuth, requireUnlocked, requireAdmin, async (req, res) => {
  const ok = await verifyPassword(currentUserId(req), req.body?.password);
  if (!ok) return res.status(401).json({ error: "Incorrect password." });

  const filename = `household-backup-${new Date().toISOString().slice(0, 10)}.db`;
  res.download(DB_PATH, filename, (err) => {
    if (err) console.error("Backup download failed:", err);
  });
});

// The tool list, so the client stops keeping its own copy of which tools write.
// Scoped to the caller for the same reason the tools themselves are: a later stage
// gates tools per household member, and the manifest has to agree with reality.
// Also drops financial tools while the PIN lock is engaged for this session --
// the same rule /api/assistant/chat applies to what's actually offered to a
// model, kept in sync here so the client never advertises a capability the
// chat endpoint is about to refuse anyway.
app.get("/api/assistant/tools", requireAuth, (req, res) => {
  const userId = currentUserId(req);
  // Same two locks the chat endpoint applies (assistant/turn.ts): the budget PIN lock hides money tools, and the
  // person's own "Require the PIN for my food diary" lock hides the calorie-diary tools.
  const foodDiaryLocked = pinRequiredFor(userId) && (!!req.deviceUserId || !isUnlocked(req));
  res.json({ tools: toolManifest(userId, !isUnlocked(req), { device: !!req.deviceUserId, foodDiaryLocked }) });
});

// What the picker renders. Ollama's reachability is checked live; the cloud
// providers just report whether a key is configured -- checking those live
// would cost a real API call on every keystroke of opening the assistant.
app.get("/api/assistant/providers", requireAuth, async (_req, res) => {
  res.json({ providers: await listProviders() });
});

// Longest a conversation-title snippet gets before truncating with an
// ellipsis -- long enough to be recognizable in the dropdown, short enough
// not to wrap.
const TITLE_LENGTH = 40;
function titleFromMessage(message: string): string {
  const trimmed = message.trim();
  return trimmed.length > TITLE_LENGTH ? `${trimmed.slice(0, TITLE_LENGTH)}…` : trimmed;
}

// Stage 4: how much stored history (measured in characters, a rough proxy for
// tokens -- no tokenizer dependency needed for an approximate budget) gets
// replayed into a request. Walked newest-first so what's kept is always the
// most recent turns, never an arbitrary middle slice.
const HISTORY_CHAR_BUDGET = 12_000;

// Stage 3: Server-Sent Events instead of one buffered JSON response, so the
// UI can render tokens as they land and show each tool the moment it starts
// rather than only after the whole (up to 12 generations on Ollama, 8 on the cloud providers) loop
// finishes. Event types: `meta` (the resolved conversation, sent first so the
// client learns a brand-new id even if the request is later aborted), `delta`
// (a piece of prose), `tool_start`, `tool_end`, and a terminal `done` carrying
// the same {reply, steps, exhausted, provider} shape the old single JSON
// response had -- `error` is folded into `done` (error: true) rather than a
// separate terminal event, so the client doesn't need two different "the turn
// is over" code paths.
//
// Stage 4: persists the conversation server-side instead of taking a
// client-built `history` array on every request -- see PLAN.md Stage 4. The
// client now sends `conversationId` (omitted/null to start a new one) instead
// of `history`.
//
// Rate limited per login (rateLimit.ts's RequestRateLimiter): one turn in flight, 20 per 5 minutes, 300 per day,
// because each turn can run up to 8 model generations and the app is public. The wrapper below is what guarantees the
// in-flight slot comes back: `finally` covers every return and throw in assistantChat, and a client that hangs up
// mid-stream releases it from res's 'close' (assistantChat registers that) even if the provider is slow to notice.
app.post("/api/assistant/chat", requireAuth, async (req, res, next) => {
  try {
    await assistantChat(req, res);
  } catch (err) {
    // Express 4 does not catch a rejected async handler, so without this an exception before the first byte left the
    // request hanging and, in Node 22, took the whole process down as an unhandled rejection.
    next(err);
  } finally {
    res.locals.releaseTurn?.();
  }
});

async function assistantChat(req: express.Request, res: express.Response) {
  const { message, conversationId, provider: requestedProvider, inputMode } = req.body || {};
  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: "message is required" });
  }

  const userId = currentUserId(req);
  let conversation = conversationId ? getConversation(userId, conversationId) : undefined;
  if (conversationId && !conversation) {
    return res.status(404).json({ error: "Conversation not found" });
  }

  // The limit comes after the 400 and 404 -- a malformed request never reaches a model, so it should not spend one of
  // a person's turns -- and before anything is written: createConversation below adds a row, and a refused flood
  // must not be able to fill the database with empty conversations.
  const turn = assistantTurns.acquire(`chat:${userId}`);
  if (!turn.ok) {
    if (turn.announce) {
      const who = getUserById(userId)?.username ?? "a login";
      appendSecurityEvent(`Assistant chat paused for "${who}": too many messages (${turn.reason === "day" ? "daily" : "5-minute"} limit).`, "warning");
    }
    return tooManyTurns(res, turn);
  }
  res.locals.releaseTurn = turn.release;
  res.on("close", turn.release);

  if (!conversation) conversation = createConversation(userId, titleFromMessage(message));

  const stored = listMessages(conversation.id);

  // Walk stored history newest-first under a character budget, then replay it (assistant/history.ts): each assistant
  // turn's actual tool calls/results, not just its prose, as real role:"tool" wire messages, each result labelled as
  // an earlier one so the model re-reads a list instead of answering from a stale result.
  const windowed: typeof stored = [];
  let budget = HISTORY_CHAR_BUDGET;
  for (let i = stored.length - 1; i >= 0; i--) {
    const cost = stored[i].content.length;
    if (budget - cost < 0 && windowed.length > 0) break;
    budget -= cost;
    windowed.unshift(stored[i]);
  }

  const replayedMessages = replayStoredMessages(windowed);

  // Decided before any model sees the question, per PLAN.md Stage 2 -- a provider that has already been sent the
  // question has already been sent it. Fed from the same windowed history above (mapped to the shape the scans
  // expect) rather than a client-supplied array. assistant/turn.ts holds every decision (financial and health
  // routing, the voice refusals, which tools the provider is handed, what the prompt may mention) so they can be
  // tested without a server; this handler only carries them out.
  const plan = planTurn({
    userId,
    message,
    history: windowed.map((m) => ({ text: m.content })),
    requestedProvider,
    inputMode,
    unlocked: isUnlocked(req),
    device: !!req.deviceUserId,
    // One per request: a bulk delete's confirmation can only be redeemed by a later request (assistant/confirmations.ts).
    turnId: randomUUID(),
  });
  const { provider } = plan;

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt(userId, plan.prompt) },
    ...replayedMessages,
    { role: "user", content: message },
  ];

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store, no-transform",
    Connection: "keep-alive",
    // Nginx-style reverse proxies buffer a response by default, which would
    // silently turn this back into one big delayed write. Harmless if nothing
    // in front of this server does that (Tailscale Serve doesn't).
    "X-Accel-Buffering": "no",
  });
  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  send("meta", { conversationId: conversation.id, title: conversation.title });

  // Saved before the provider ever runs, so an aborted request still keeps
  // the question in history on reload.
  addMessage(conversation.id, "user", message);

  // A voice-originated financial OR health question never reaches a provider at all, by default -- admin-configurable
  // via PUT /api/assistant/settings (money) and PUT /api/assistant/settings/health-voice (health), routes/assistant.ts.
  // This is a different guarantee from the tool filtering in planTurn: that gates which *tools* a turn can use once it's
  // already running; this gates whether the turn runs at all when it arrived by voice, which is the client-side
  // half of PLAN.md Stage 8b's rule that spoken audio (unless it stayed fully on-device) must not carry a financial
  // question in the first place. inputMode is supplied by the caller (the Wear OS app always sends "voice"); a typed
  // web request omits it and is never affected.
  if (plan.blocked) {
    const reply = plan.blocked.reply;
    addMessage(conversation.id, "assistant", reply);
    touchConversation(conversation.id);
    send("done", { reply, steps: [], blocked: true, provider: null });
    return res.end();
  }

  // The Stop button (Assistant.tsx) aborts its fetch, which closes this
  // connection -- propagate that into a real AbortSignal so it reaches all
  // the way down into the provider's own upstream fetch, not just this
  // response. Without this, clicking Stop would only stop the *client* from
  // listening; the server would keep running the model to completion anyway.
  // Must be `res`, not `req`: express.json() has already fully consumed the
  // request body by the time this handler runs, so `req`'s own 'close' fires
  // almost immediately (the incoming stream is done being read) -- long
  // before the client actually disconnects. `res` only closes when the
  // response/connection itself ends, which is the event actually wanted here.
  const controller = new AbortController();
  res.on("close", () => controller.abort());

  try {
    // Tools are bound to the signed-in user, so the assistant sees exactly what that person would see in the UI --
    // never the other member's personal rows. planTurn already stripped financial and health tools before a cloud
    // provider could see the list (unless the admin opted that provider in for that kind of data), and while the
    // budget PIN lock / the person's food-diary lock is engaged, independent of whether the routing judged correctly.
    const { tools } = plan;
    const result = await provider.chat(messages, tools, {
      signal: controller.signal,
      onDelta: (text) => send("delta", { text }),
      onToolStart: (call) => send("tool_start", call),
      onToolEnd: (step) => send("tool_end", step),
    });
    const toolCalls: StoredToolCall[] = result.steps.map((s) => ({ tool: s.tool, args: s.args }));
    const toolResults: StoredToolResult[] = result.steps.map((s) => ({ tool: s.tool, result: s.result, error: s.error }));
    addMessage(conversation.id, "assistant", result.reply, toolCalls, toolResults);
    touchConversation(conversation.id);
    send("done", { reply: result.reply, steps: result.steps, exhausted: result.exhausted, provider: provider.id });
  } catch (err: any) {
    if (err?.name === "AbortError") {
      // The client hung up (Stop, or just closed the tab) -- res is already
      // gone from the client's perspective, nothing to send. Nothing to
      // persist either: the user's message is already saved above, and there
      // is no assistant reply to record.
      return res.end();
    }
    if (err instanceof ProviderUnavailableError) {
      // Persisted like any other assistant reply so a reload shows what
      // happened instead of the conversation just silently stopping short.
      addMessage(conversation.id, "assistant", err.hint);
      touchConversation(conversation.id);
      send("done", { reply: err.hint, steps: [], error: true, provider: provider.id });
      return res.end();
    }
    console.error("Assistant chat failed:", err);
    const errorReply = "Something went wrong handling that.";
    addMessage(conversation.id, "assistant", errorReply);
    touchConversation(conversation.id);
    send("done", { reply: errorReply, steps: [], error: true, provider: provider.id });
  }
  res.end();
}

app.use("/api/health", healthRoutes);

// Anything under /api that didn't match a route above is a real 404, not a
// page -- without this, the SPA fallback in start() below would hand back
// index.html for a typo'd or removed API path, which looks like a working
// response instead of an error.
app.use("/api", (_req, res) => res.status(404).json({ error: "Not found" }));

async function start() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: "spa" });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => res.sendFile(path.join(distPath, "index.html")));
  }

  // Bound to all interfaces (not just loopback) so the household can reach this
  // over Tailscale from a phone -- see vite.config.ts's matching allowedHosts entry.
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Household app running on http://localhost:${PORT}`);
  });

  // Re-check for a same-day backup periodically, so a server left running across
  // several days still gets fresh snapshots without a restart. pruneSessions
  // rides the same timer -- an always-on server never naturally restarts to
  // clear out expired session rows on its own, so something has to.
  setInterval(() => {
    backupIfNeeded();
    pruneSessions();
  }, 6 * 60 * 60 * 1000);

  // Keeps the household's Kroger sign-in alive: its refresh token lasts about a day and every
  // refresh returns a new one, so an hourly check refreshes it once it's 12 hours old (kroger.ts).
  // Does nothing when Kroger isn't connected. Never logs a token.
  setInterval(() => {
    krogerKeepAlive()
      .then((result) => {
        if (result === "refreshed") console.log("Kroger sign-in refreshed.");
      })
      .catch((err) => console.error("Kroger keep-alive failed:", err instanceof Error ? err.message : "unexpected error"));
  }, 60 * 60 * 1000);

  // A removable drive can glitch and re-enumerate under a different letter
  // without the Node process itself crashing -- it would otherwise keep
  // running against a dead SQLite handle and return SQLITE_IOERR on every
  // request forever. Exiting is the fix, not recovering in place: the
  // supervisor (scripts/launch-household.ps1) re-resolves the drive letter by
  // volume label + contents on every restart, which actually heals this.
  setInterval(() => {
    try {
      db.prepare("SELECT 1").get();
    } catch (err) {
      console.error("Database handle is dead -- exiting so the supervisor can restart against the current drive letter:", err);
      process.exit(1);
    }
  }, 60_000);
}

start();
