import { useEffect, useRef, useState } from "react";
import { Send, Loader2, Lock, Square, MessageSquare, Plus, Pencil, Trash2, Mic, X, Volume2, VolumeX } from "lucide-react";
import { api, ApiError, type AssistantSettings, type CloudFinanceSettings, type CloudHealthSettings, type Conversation, type ConversationMessage } from "./api.ts";
import { startRecording, voiceSupported, type RecorderHandle } from "./voice/recorder.ts";
import { getReadAloudPref, setReadAloudPref, speak, speechSupported, stopSpeaking, type ReadAloudPref } from "./voice/speak.ts";

type VoiceState = "idle" | "starting" | "recording" | "transcribing";

const READ_ALOUD_LABELS: Record<ReadAloudPref, string> = {
  spoken: "Read answers aloud when you asked by voice",
  always: "Read every answer aloud",
  off: "Don't read answers aloud",
};
// The order the speaker button cycles through on each tap.
const READ_ALOUD_NEXT: Record<ReadAloudPref, ReadAloudPref> = { spoken: "always", always: "off", off: "spoken" };

function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

interface ToolStep {
  tool: string;
  args: Record<string, any>;
  result?: unknown;
  error?: string;
  /** True from the moment `tool_start` arrives until `tool_end` fills in the
   *  result -- lets the transcript show a tool running, not just ones already
   *  finished (Stage 3's "live tool steps"). */
  pending?: boolean;
}

interface Turn {
  role: "user" | "assistant";
  text: string;
  steps?: ToolStep[];
  error?: boolean;
  /** Which provider actually answered -- may differ from what was selected,
   *  since a financial turn is always routed to Ollama regardless of choice. */
  provider?: string;
  /** True while this turn's SSE stream is still open -- drives the "still
   *  generating" cursor and disables re-sending until it settles. */
  streaming?: boolean;
}

interface ToolManifestEntry {
  name: string;
  mutates: boolean;
}

interface ProviderInfo {
  id: "ollama" | "anthropic" | "gemini";
  label: string;
  available: boolean;
  reason?: string;
}

// Which tools change data comes from the server's registry, not a list kept here.
// When the assistant runs one, the section showing that data needs to re-read it
// or the screen silently goes stale -- and the copy that used to live here went
// stale itself every time a tool was added (it never learned about the calendar
// tools at all).

export default function Assistant({
  onMutated,
  financialLocked,
  onRequestUnlock,
}: {
  onMutated: () => void;
  /** Mirrors App.tsx's lock status -- the server independently strips
   *  financial tools from what it offers the model whenever this is true
   *  (see server.ts's /api/assistant/chat), so this prop only controls
   *  whether the inline nudge below is shown, not what the model can do. */
  financialLocked: boolean;
  onRequestUnlock: () => void;
}) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const mutatingTools = useRef<Set<string> | null>(null);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [selectedProvider, setSelectedProvider] = useState("ollama");
  // Only drives the hint beside the picker -- the server decides routing on its
  // own from the same settings, so a stale value here can't send data anywhere.
  const [cloudFinance, setCloudFinance] = useState<CloudFinanceSettings>({ anthropic: false, gemini: false });
  const [cloudHealth, setCloudHealth] = useState<CloudHealthSettings>({ anthropic: false, gemini: false });
  // Lets the Stop button actually cancel the in-flight request -- see
  // server.ts's /api/assistant/chat, which propagates a closed connection
  // into an AbortSignal that reaches all the way down into the provider's
  // own upstream fetch, not just this component's view of it.
  const abortRef = useRef<AbortController | null>(null);

  // Voice input. The mic only appears when the admin turned it on (Settings -> Security), Whisper is
  // set up on the server, AND this browser can record (needs https or localhost) -- otherwise the
  // form looks exactly as it did before.
  const [micEnabled, setMicEnabled] = useState(false);
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [voiceNote, setVoiceNote] = useState<{ kind: "info" | "error"; text: string } | null>(null);
  const [recSeconds, setRecSeconds] = useState(0);
  const recorderRef = useRef<RecorderHandle | null>(null);
  const transcribeAbortRef = useRef<AbortController | null>(null);
  // The level pulse is written straight to the DOM: it changes ~15 times a second and would
  // otherwise re-render the whole chat transcript each time.
  const micRingRef = useRef<HTMLSpanElement>(null);
  const mountedRef = useRef(true);
  const [readAloud, setReadAloud] = useState<ReadAloudPref>(getReadAloudPref);
  // Mirrored in a ref because the streaming handler in send() is a closure from when the message was
  // sent -- a change made while an answer is streaming should still apply when it finishes.
  const readAloudRef = useRef(readAloud);
  readAloudRef.current = readAloud;
  // Points at the newest `send` every render: a voice question is sent several seconds after the
  // mic was tapped, and the closure that tapped it may hold a stale conversation id or busy flag
  // (say, someone hit "New chat" while it was transcribing).
  const sendRef = useRef<(raw: string, opts?: { inputMode?: string }) => Promise<void>>(async () => {});

  // Stage 4: persisted conversations. `conversationId` null means "not
  // started yet" -- no DB row exists until the first message in it is
  // actually sent (see server.ts), so idle "New chat" clicks don't clutter
  // the list with empty threads.
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [listOpen, setListOpen] = useState(false);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [turns, busy]);

  // Fetched once. If it fails, mutatingTools stays null and every successful tool
  // step triggers a refresh -- a redundant re-read is a far cheaper wrong answer
  // than a screen showing data the assistant already changed.
  useEffect(() => {
    fetch("/api/assistant/tools")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((data: { tools: ToolManifestEntry[] }) => {
        mutatingTools.current = new Set(data.tools.filter((t) => t.mutates).map((t) => t.name));
      })
      .catch(() => { mutatingTools.current = null; });
  }, []);

  // Only Ollama is guaranteed to exist, so it's the default until the picker
  // confirms something else is actually configured and reachable.
  useEffect(() => {
    fetch("/api/assistant/providers")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((data: { providers: ProviderInfo[] }) => setProviders(data.providers || []))
      .catch(() => setProviders([]));
    api
      .get<AssistantSettings>("/api/assistant/settings")
      .then((d) => {
        if (d.allowCloudFinance) setCloudFinance(d.allowCloudFinance);
        if (d.allowCloudHealth) setCloudHealth(d.allowCloudHealth);
        setMicEnabled(d.speechBackend === "whisper_local" && !!d.whisperConfigured && voiceSupported());
      })
      .catch(() => {});
  }, []);

  // Leaving the screen mid-recording or mid-sentence must not leave the mic open or the speaker talking.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      recorderRef.current?.cancel();
      transcribeAbortRef.current?.abort();
      stopSpeaking();
    };
  }, []);

  useEffect(() => {
    api.get<{ conversations: Conversation[] }>("/api/assistant/conversations")
      .then((res) => setConversations(res.conversations))
      .catch(() => setConversations([]));
  }, []);

  // Applies one update to the currently-streaming turn (always the last one
  // in the array while `busy` is true) without touching any earlier turn.
  function updateStreamingTurn(update: (turn: Turn) => Turn) {
    setTurns((prev) => {
      if (prev.length === 0) return prev;
      const next = prev.slice();
      next[next.length - 1] = update(next[next.length - 1]);
      return next;
    });
  }

  // Moves (or inserts) a conversation to the front of the list with a fresh
  // updatedAt -- keeps the dropdown's recency order right without a full
  // re-fetch after every turn.
  function bumpConversation(id: string, title?: string) {
    setConversations((prev) => {
      const now = new Date().toISOString();
      const existing = prev.find((c) => c.id === id);
      const entry: Conversation = existing
        ? { ...existing, title: title ?? existing.title, updatedAt: now }
        : { id, title: title ?? "New chat", createdAt: now, updatedAt: now };
      return [entry, ...prev.filter((c) => c.id !== id)];
    });
  }

  function submitTyped(e: React.FormEvent) {
    e.preventDefault();
    void send(input);
  }

  // The core of a turn. `inputMode: "voice_local"` marks a question that came from the mic, so the
  // server applies the same money/health voice rules it does for the Wear OS app.
  async function send(raw: string, opts?: { inputMode?: string }) {
    const message = raw.trim();
    if (!message || busy) return;
    // Decides whether the answer gets read aloud when it finishes (see the `done` event below).
    const fromMic = opts?.inputMode === "voice_local";
    stopSpeaking();

    setTurns((prev) => [
      ...prev,
      { role: "user", text: message },
      // The streaming placeholder every SSE event below fills in -- pushed
      // immediately so the assistant bubble (and its "Thinking…" cursor)
      // appears right away instead of only once the first token lands.
      { role: "assistant", text: "", steps: [], streaming: true },
    ]);
    setInput("");
    setBusy(true);

    const controller = new AbortController();
    abortRef.current = controller;
    let mutatedAnything = false;
    // Captured locally rather than read back from the `conversationId` state
    // variable: this closure's `conversationId` is whatever it was when
    // `send` was created, and the `meta` event below needs to update the
    // *active* id mid-stream (a brand-new conversation has none yet), not
    // wait for a re-render that won't happen until this function returns.
    let activeConversationId = conversationId;
    const mutates = (tool: string) => mutatingTools.current?.has(tool) ?? true;

    try {
      const res = await fetch("/api/assistant/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          conversationId,
          provider: selectedProvider,
          ...(opts?.inputMode ? { inputMode: opts.inputMode } : {}),
        }),
        signal: controller.signal,
      });
      if (res.status === 429) {
        // The server's rate limit answers before any stream opens, with a plain-English reason
        // ("still answering your last message", or how long to wait) -- show that, not a generic failure.
        const body = await res.json().catch(() => null);
        updateStreamingTurn((t) => ({
          ...t,
          text: typeof body?.error === "string" ? body.error : "Too many messages. Try again in a few minutes.",
          error: true,
          streaming: false,
        }));
        return;
      }
      if (!res.ok || !res.body) throw new Error("stream failed to open");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let eventEnd: number;
        while ((eventEnd = buffer.indexOf("\n\n")) !== -1) {
          const rawEvent = buffer.slice(0, eventEnd);
          buffer = buffer.slice(eventEnd + 2);

          let eventType = "";
          let dataStr = "";
          for (const line of rawEvent.split("\n")) {
            if (line.startsWith("event:")) eventType = line.slice(6).trim();
            else if (line.startsWith("data:")) dataStr += line.slice(5).trim();
          }
          if (!eventType || !dataStr) continue;
          const data = JSON.parse(dataStr);

          if (eventType === "meta") {
            // Always sent, even for an existing conversation -- harmless to
            // set again, and the one case that matters is a brand-new one,
            // where this is the only place the real id is ever learned.
            activeConversationId = data.conversationId;
            setConversationId(data.conversationId);
            bumpConversation(data.conversationId, data.title);
          } else if (eventType === "delta") {
            updateStreamingTurn((t) => ({ ...t, text: t.text + data.text }));
          } else if (eventType === "tool_start") {
            updateStreamingTurn((t) => ({
              ...t,
              steps: [...(t.steps || []), { tool: data.tool, args: data.args, pending: true }],
            }));
          } else if (eventType === "tool_end") {
            if (mutates(data.tool) && !data.error) mutatedAnything = true;
            updateStreamingTurn((t) => {
              const steps = t.steps || [];
              // Matches the most recent still-pending step for this tool --
              // safe because the server runs tool calls one at a time,
              // awaiting each result before starting the next, so tool_start
              // and tool_end for one call always bracket each other with no
              // interleaving from a second call.
              const idx = steps.map((s) => s.pending).lastIndexOf(true);
              if (idx === -1) return t;
              const nextSteps = steps.slice();
              nextSteps[idx] = { tool: data.tool, args: data.args, result: data.result, error: data.error };
              return { ...t, steps: nextSteps };
            });
          } else if (eventType === "done") {
            updateStreamingTurn((t) => ({
              ...t,
              text: data.reply,
              error: data.error,
              provider: data.provider,
              streaming: false,
            }));
            if (activeConversationId) bumpConversation(activeConversationId);
            const pref = readAloudRef.current;
            if (!data.error && data.reply && (pref === "always" || (pref === "spoken" && fromMic))) speak(String(data.reply));
          }
        }
      }
    } catch (err: any) {
      if (err?.name === "AbortError") {
        // User-initiated (Stop) -- leave whatever text/steps already streamed
        // in place rather than replacing them with an error, just mark the
        // turn settled.
        updateStreamingTurn((t) => ({ ...t, streaming: false, text: t.text || "Stopped." }));
      } else {
        updateStreamingTurn((t) => ({ ...t, text: "Couldn't reach the server.", error: true, streaming: false }));
      }
    } finally {
      abortRef.current = null;
      setBusy(false);
      if (mutatedAnything) onMutated();
    }
  }

  sendRef.current = send;

  function stop() {
    abortRef.current?.abort();
    stopSpeaking();
  }

  function cycleReadAloud() {
    const next = READ_ALOUD_NEXT[readAloud];
    setReadAloud(next);
    setReadAloudPref(next);
    if (next === "off") stopSpeaking();
  }

  function cancelRecording() {
    recorderRef.current?.cancel();
  }

  // Tap once to start, tap again to stop (it also stops itself after a pause or 30 seconds).
  async function toggleMic() {
    if (voiceState === "recording") {
      recorderRef.current?.stop();
      return;
    }
    if (voiceState !== "idle" || busy) return;

    stopSpeaking(); // otherwise the microphone would hear the assistant's own voice
    setVoiceNote(null);
    setVoiceState("starting");

    let rec: RecorderHandle;
    try {
      rec = await startRecording({
        onLevel: (level) => {
          const ring = micRingRef.current;
          if (ring) {
            ring.style.transform = `scale(${1 + level * 0.9})`;
            ring.style.opacity = String(0.25 + level * 0.5);
          }
        },
        onTick: (s) => setRecSeconds(Math.floor(s)),
      });
    } catch (err: any) {
      if (!mountedRef.current) return;
      setVoiceState("idle");
      setVoiceNote({
        kind: "error",
        text:
          err?.name === "NotAllowedError" || err?.name === "SecurityError"
            ? "Microphone permission is blocked for this site."
            : err?.name === "NotFoundError"
              ? "No microphone found on this device."
              : "Couldn't start the microphone.",
      });
      return;
    }
    if (!mountedRef.current) {
      rec.cancel();
      return;
    }
    recorderRef.current = rec;
    setRecSeconds(0);
    setVoiceState("recording");

    let wav: Blob;
    try {
      wav = await rec.finished;
    } catch {
      // Cancelled (× or Escape, or the screen closed): nothing to send.
      recorderRef.current = null;
      if (mountedRef.current) setVoiceState("idle");
      return;
    }
    recorderRef.current = null;
    if (!mountedRef.current) return;
    setVoiceState("transcribing");

    const controller = new AbortController();
    transcribeAbortRef.current = controller;
    let text = "";
    try {
      const res = await fetch("/api/assistant/transcribe", {
        method: "POST",
        headers: { "Content-Type": "audio/wav" },
        body: wav,
        signal: controller.signal,
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        // The server words these for people ("Whisper is busy", "too long", rate limit...) -- show as-is.
        setVoiceNote({ kind: "error", text: typeof body?.error === "string" ? body.error : "Couldn't turn that into text." });
        return;
      }
      text = typeof body?.text === "string" ? body.text.trim() : "";
    } catch (err: any) {
      if (err?.name !== "AbortError" && mountedRef.current) setVoiceNote({ kind: "error", text: "Couldn't reach the server." });
      return;
    } finally {
      transcribeAbortRef.current = null;
      if (mountedRef.current) setVoiceState("idle");
    }

    if (!text) {
      setVoiceNote({ kind: "info", text: "Didn't catch that — try again." });
      return;
    }
    void sendRef.current(text, { inputMode: "voice_local" });
  }

  // Escape cancels a recording from anywhere on the page.
  useEffect(() => {
    if (voiceState !== "recording") return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") recorderRef.current?.cancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [voiceState]);

  function newChat() {
    stopSpeaking();
    setConversationId(null);
    setTurns([]);
    setListOpen(false);
  }

  async function selectConversation(id: string) {
    setListOpen(false);
    if (id === conversationId) return;
    try {
      const res = await api.get<{ conversation: Conversation; messages: ConversationMessage[] }>(
        `/api/assistant/conversations/${id}/messages`
      );
      setConversationId(id);
      setTurns(res.messages.map((m) => ({ role: m.role, text: m.text, steps: m.steps })));
    } catch {
      // Left on whatever was showing -- a transient fetch failure here
      // shouldn't blow away an in-progress conversation.
    }
  }

  async function renameConversation(c: Conversation) {
    const title = window.prompt("Rename conversation", c.title);
    if (!title || !title.trim() || title.trim() === c.title) return;
    const trimmed = title.trim();
    try {
      await api.put(`/api/assistant/conversations/${c.id}`, { title: trimmed });
      setConversations((prev) => prev.map((x) => (x.id === c.id ? { ...x, title: trimmed } : x)));
    } catch (err) {
      window.alert(err instanceof ApiError ? err.message : "Couldn't rename that conversation.");
    }
  }

  async function removeConversation(c: Conversation) {
    if (!window.confirm(`Delete "${c.title}"? This can't be undone.`)) return;
    try {
      await api.del(`/api/assistant/conversations/${c.id}`);
      setConversations((prev) => prev.filter((x) => x.id !== c.id));
      if (conversationId === c.id) {
        setConversationId(null);
        setTurns([]);
      }
    } catch (err) {
      window.alert(err instanceof ApiError ? err.message : "Couldn't delete that conversation.");
    }
  }

  // Only worth showing once there's an actual choice -- Ollama alone (the
  // common case with no keys configured) would just be a picker with one option.
  const pickableProviders = providers.filter((p) => p.available);
  const showPicker = pickableProviders.length > 1;
  const currentTitle = conversations.find((c) => c.id === conversationId)?.title ?? "New chat";

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 pt-3 pb-1 flex items-center gap-1 relative">
        <button
          type="button"
          onClick={() => setListOpen((v) => !v)}
          className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500 dark:text-slate-400 shrink-0"
          aria-label="Conversations"
          title="Conversations"
        >
          <MessageSquare size={16} />
        </button>
        <span className="flex-1 min-w-0 truncate text-sm font-medium text-slate-700 dark:text-slate-300">
          {currentTitle}
        </span>
        {speechSupported() && (
          <button
            type="button"
            onClick={cycleReadAloud}
            className="min-w-[44px] min-h-[44px] -my-2 flex items-center justify-center rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500 dark:text-slate-400 shrink-0"
            aria-label={READ_ALOUD_LABELS[readAloud]}
            title={`${READ_ALOUD_LABELS[readAloud]} — tap to change`}
          >
            {readAloud === "off" ? <VolumeX size={16} /> : <Volume2 size={16} className={readAloud === "always" ? "text-blue-600 dark:text-blue-400" : ""} />}
          </button>
        )}
        <button
          type="button"
          onClick={newChat}
          className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500 dark:text-slate-400 shrink-0"
          aria-label="New chat"
          title="New chat"
        >
          <Plus size={16} />
        </button>

        {listOpen && (
          <div className="absolute left-3 top-full mt-1 w-72 max-h-80 overflow-y-auto bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg shadow-lg z-20 py-1">
            {conversations.length === 0 ? (
              <p className="px-3 py-2 text-xs text-slate-400 dark:text-slate-500">No conversations yet.</p>
            ) : (
              conversations.map((c) => (
                <div
                  key={c.id}
                  className={`group flex items-center gap-0.5 px-1.5 py-1 ${
                    c.id === conversationId ? "bg-slate-100 dark:bg-slate-800" : ""
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => selectConversation(c.id)}
                    className="flex-1 min-w-0 text-left px-1.5 py-1 rounded text-sm text-slate-700 dark:text-slate-300 truncate hover:bg-slate-100 dark:hover:bg-slate-800"
                  >
                    {c.title}
                  </button>
                  <button
                    type="button"
                    onClick={() => renameConversation(c)}
                    className="shrink-0 p-1 rounded text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 opacity-0 group-hover:opacity-100"
                    aria-label={`Rename ${c.title}`}
                  >
                    <Pencil size={12} />
                  </button>
                  <button
                    type="button"
                    onClick={() => removeConversation(c)}
                    className="shrink-0 p-1 rounded text-slate-400 hover:text-red-600 dark:hover:text-red-400 opacity-0 group-hover:opacity-100"
                    aria-label={`Delete ${c.title}`}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {showPicker && (
        <div className="px-4 pb-1 flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
          <span>Answer using</span>
          <select
            className="rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-1.5 py-1 text-xs"
            value={selectedProvider}
            onChange={(e) => setSelectedProvider(e.target.value)}
          >
            {pickableProviders.map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </select>
          {selectedProvider !== "ollama" &&
            (cloudFinance[selectedProvider as keyof CloudFinanceSettings] ? (
              <span
                className="text-amber-600 dark:text-amber-400"
                title="Allowed under Settings → Security. Money questions asked here are answered by this model, so your transactions are sent to it."
              >
                (money questions go to this model)
              </span>
            ) : (
              <span title="Money questions run on Ollama locally no matter what's picked here, unless this model is allowed under Settings → Security.">
                (money questions stay local)
              </span>
            ))}
          {selectedProvider !== "ollama" &&
            (cloudHealth[selectedProvider as keyof CloudHealthSettings] ? (
              <span
                className="text-amber-600 dark:text-amber-400"
                title="Allowed under Settings → Security. Food-diary questions asked here are answered by this model, so what people ate, their calorie budgets and weight are sent to it."
              >
                (food-diary questions go to this model)
              </span>
            ) : (
              <span title="Questions about what people ate, calorie budgets, weight and steps run on Ollama locally no matter what's picked here, unless this model is allowed under Settings → Security.">
                (food-diary questions stay local)
              </span>
            ))}
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-4 space-y-3" onClick={() => listOpen && setListOpen(false)}>
        {turns.length === 0 && (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Ask me to add things to a list, or what's already on one.
          </p>
        )}

        {turns.map((turn, i) => (
          <div key={i} className="space-y-1.5">
            {/* Showing which tools ran is how you tell a real lookup from a guess.
                Steps appear the moment they start (Stage 3), not only once the
                whole reply is finished. */}
            {turn.steps && turn.steps.length > 0 && (
              <div className="text-[11px] font-mono text-slate-500 dark:text-slate-400 bg-slate-100 dark:bg-slate-800 rounded-lg px-2.5 py-1.5 overflow-x-auto">
                {turn.steps.map((s, j) => (
                  <div key={j} className="whitespace-nowrap">
                    <span className="text-slate-700 dark:text-slate-200">{s.tool}</span>
                    ({JSON.stringify(s.args)})
                    {s.pending ? (
                      <span className="inline-flex items-center gap-1 ml-1">
                        <Loader2 size={10} className="animate-spin inline" /> running…
                      </span>
                    ) : s.error ? (
                      ` → ${s.error}`
                    ) : (
                      " ✓"
                    )}
                  </div>
                ))}
              </div>
            )}

            {(turn.text || !turn.streaming) && (
              <div
                className={`px-3.5 py-2 rounded-xl text-sm max-w-[92%] whitespace-pre-wrap ${
                  turn.role === "user"
                    ? "bg-blue-600 text-white ml-auto"
                    : turn.error
                      ? "bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300"
                      : "bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700"
                }`}
              >
                {turn.text}
                {turn.streaming && <span className="inline-block w-1.5 h-3.5 bg-current opacity-60 animate-pulse ml-0.5 align-text-bottom" />}
              </div>
            )}

            {showPicker && turn.role === "assistant" && turn.provider && turn.provider !== selectedProvider && (
              turn.provider === "ollama" ? (
                // A financial-sounding turn overrides the picker silently server-side (PLAN.md
                // Stage 2's privacy boundary) -- this has to be obvious in the moment, not a dim
                // aside easy to scroll past, or "why didn't it use Claude" looks like a bug.
                <div className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 rounded-lg px-2.5 py-1.5">
                  <Lock size={12} className="shrink-0" />
                  Answered locally on Ollama, not {providers.find((p) => p.id === selectedProvider)?.label ?? selectedProvider} —
                  this looked financial, which always stays on-device.
                </div>
              ) : (
                <div className="text-[11px] text-slate-400 dark:text-slate-500 pl-0.5">
                  answered via {providers.find((p) => p.id === turn.provider)?.label ?? turn.provider}
                </div>
              )
            )}
          </div>
        ))}

        {busy && !turns[turns.length - 1]?.text && !turns[turns.length - 1]?.steps?.length && (
          <div className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
            <Loader2 size={14} className="animate-spin" /> Thinking…
          </div>
        )}
        <div ref={endRef} />
      </div>

      {financialLocked && (
        <button
          type="button"
          onClick={onRequestUnlock}
          className="mx-3 mb-2 flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 rounded-lg px-2.5 py-1.5 text-left"
        >
          <Lock size={12} className="shrink-0" />
          Budget and spending questions are locked right now — tap to enter your PIN.
        </button>
      )}

      <form onSubmit={submitTyped} className="p-3 border-t border-slate-200 dark:border-slate-800 flex flex-col gap-1.5">
        {/* Announces voice state changes to screen readers; the visible note below is the same text. */}
        <div className="sr-only" role="status" aria-live="polite">
          {voiceState === "recording" ? "Recording. Tap the red button to stop." : voiceState === "transcribing" ? "Turning your voice into text." : ""}
        </div>
        {voiceNote && (
          <p
            role={voiceNote.kind === "error" ? "alert" : "status"}
            className={`text-xs font-medium ${
              voiceNote.kind === "error" ? "text-rose-600 dark:text-rose-400" : "text-slate-500 dark:text-slate-400"
            }`}
          >
            {voiceNote.text}
          </p>
        )}
        <div className="flex gap-2">
          {voiceState === "recording" ? (
            <div className="flex-1 min-w-0 min-h-[44px] flex items-center gap-2 px-3 text-sm rounded-lg border border-red-300 dark:border-red-900 bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-300">
              <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse shrink-0" />
              <span className="truncate">Listening…</span>
              <span className="ml-auto tabular-nums">{formatClock(recSeconds)}</span>
              <button
                type="button"
                onClick={cancelRecording}
                className="min-w-[44px] min-h-[44px] -mr-2 flex items-center justify-center rounded-lg hover:bg-red-100 dark:hover:bg-red-900/40"
                aria-label="Cancel recording"
                title="Cancel (Esc)"
              >
                <X size={16} />
              </button>
            </div>
          ) : (
            <input
              className="flex-1 min-w-0 min-h-[44px] px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
              placeholder={voiceState === "transcribing" ? "Turning your voice into text…" : "Ask the assistant…"}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={busy || voiceState === "transcribing"}
            />
          )}
          {micEnabled && (
            <button
              type="button"
              onClick={toggleMic}
              disabled={busy || voiceState === "starting" || voiceState === "transcribing"}
              aria-pressed={voiceState === "recording"}
              aria-label={voiceState === "recording" ? "Stop recording" : "Speak your question"}
              title={voiceState === "recording" ? "Stop recording" : "Speak your question"}
              className={`relative shrink-0 min-w-[44px] min-h-[44px] flex items-center justify-center rounded-lg disabled:opacity-50 ${
                voiceState === "recording"
                  ? "bg-red-600 hover:bg-red-700 text-white"
                  : "border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200"
              }`}
            >
              {voiceState === "recording" && (
                <span ref={micRingRef} className="absolute inset-0 rounded-lg bg-red-500 opacity-25 transition-transform duration-100 pointer-events-none" />
              )}
              {voiceState === "transcribing" || voiceState === "starting" ? (
                <Loader2 size={18} className="animate-spin" />
              ) : voiceState === "recording" ? (
                <Square size={16} fill="currentColor" className="relative" />
              ) : (
                <Mic size={18} />
              )}
            </button>
          )}
          {busy ? (
            <button
              type="button"
              onClick={stop}
              className="min-w-[44px] min-h-[44px] px-3 rounded-lg bg-slate-600 hover:bg-slate-700 text-white"
              aria-label="Stop"
              title="Stop generating"
            >
              <Square size={16} fill="currentColor" className="mx-auto" />
            </button>
          ) : (
            <button
              disabled={!input.trim() || voiceState !== "idle"}
              className="min-w-[44px] min-h-[44px] px-3 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white"
              aria-label="Send"
            >
              <Send size={16} className="mx-auto" />
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
