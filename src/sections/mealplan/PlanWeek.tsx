// Meal Plan → "Plan the week". A form for the one thing planning actually
// needs from a person -- which days -- that then asks the assistant exactly as
// if they'd typed it. Going through /api/assistant/chat rather than a planning
// endpoint of its own is the point: the family's dislikes, open requests,
// calendar-aware individual meals and the no-placeholder-names rule all live
// in the assistant's prompt and tools, and a second planner would have to copy
// every one of them and keep them in step. The conversation it creates shows
// up in the assistant's history, so what it said is never lost.

import { useEffect, useRef, useState } from "react";
import { Sparkles, Loader2, X } from "lucide-react";
import { weekDays, mondayOf, defaultDays, buildPlanMessage, saveNudge, savedDays, missingDays } from "./planWeek.ts";

interface ProviderInfo {
  id: string;
  label: string;
  available: boolean;
}

export default function PlanWeek({
  existingWeekStart,
  onPlanned,
  onCancel,
}: {
  /** weekStart of the plan already saved, to warn before replacing it. */
  existingWeekStart?: string;
  onPlanned: () => void;
  onCancel?: () => void;
}) {
  const [week, setWeek] = useState<"this" | "next">("this");
  const [picked, setPicked] = useState<Set<string>>(() => defaultDays("this", new Date()));
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [provider, setProvider] = useState("ollama");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    fetch("/api/assistant/providers")
      .then((r) => r.json())
      .then((d: { providers: ProviderInfo[] }) => {
        const usable = (d.providers || []).filter((p) => p.available);
        setProviders(usable);
        // Same default as the assistant panel, falling back to whatever is up.
        if (usable.length && !usable.some((p) => p.id === "ollama")) setProvider(usable[0].id);
      })
      .catch(() => {});
    return () => abortRef.current?.abort();
  }, []);

  const today = new Date();
  const monday = mondayOf(today);
  if (week === "next") monday.setDate(monday.getDate() + 7);
  const days = weekDays(monday);
  const weekStart = days[0].date;
  const replacing = existingWeekStart === weekStart;

  function chooseWeek(next: "this" | "next") {
    setWeek(next);
    setPicked(defaultDays(next, new Date()));
  }

  function toggleDay(day: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(day)) next.delete(day);
      else next.add(day);
      return next;
    });
  }

  async function plan() {
    const chosen = days.filter((d) => picked.has(d.day));
    if (chosen.length === 0) return;

    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setError("");
    setStatus("Asking the assistant…");

    // Success is judged by the tool result, never by the reply text: the model
    // has described a week back to the user before without having saved it.
    // The message asks for one create_meal_plan call per day, so a turn can save
    // some days and not others: the calls that worked are collected (with their
    // arguments, which say which days) and the days still missing worked out from them.
    async function turn(message: string, conversationId?: string) {
      const calls: { args: unknown }[] = [];
      let reply = "";
      let convId = conversationId;

      const res = await fetch("/api/assistant/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, conversationId, provider }),
        signal: controller.signal,
      });
      if (res.status === 429) {
        // The assistant's rate limit: say why, in the server's words.
        const body = await res.json().catch(() => null);
        throw new Error(typeof body?.error === "string" ? body.error : "Too many messages. Try again in a few minutes.");
      }
      if (!res.ok || !res.body) throw new Error("Couldn't reach the assistant.");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let end: number;
        while ((end = buffer.indexOf("\n\n")) !== -1) {
          const raw = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          let type = "";
          let data = "";
          for (const line of raw.split("\n")) {
            if (line.startsWith("event:")) type = line.slice(6).trim();
            else if (line.startsWith("data:")) data += line.slice(5).trim();
          }
          if (!type || !data) continue;
          const payload = JSON.parse(data);

          if (type === "meta") {
            convId = payload.conversationId;
          } else if (type === "tool_start") {
            setStatus(TOOL_STATUS[payload.tool] || "Working…");
          } else if (type === "tool_end" && payload.tool === "create_meal_plan") {
            if (!payload.error && !payload.result?.error) calls.push({ args: payload.args });
          } else if (type === "done") {
            reply = payload.reply || "";
          }
        }
      }
      return { calls, reply, conversationId: convId };
    }

    try {
      let result = await turn(buildPlanMessage(chosen));
      const calls = [...result.calls];

      // One nudge, in the same conversation. On the first real run llama3.1
      // checked the calendar, found it empty, then wrote the week out as prose
      // and stopped -- the loop ends whenever a reply has no tool call in it.
      // Asked again with its own dishes already sitting in the history, it only
      // has to copy them into the tool. Once, not a loop: a second miss means
      // something a retry won't fix. With a day saved per call the nudge names
      // the days that are still missing.
      const missing = () => missingDays(chosen, savedDays(calls));
      if (missing().length > 0 && result.conversationId) {
        setStatus("Saving the plan…");
        result = await turn(saveNudge(missing()), result.conversationId);
        calls.push(...result.calls);
      }

      // Anything saved counts: the plan on screen then shows what was and wasn't planned.
      if (calls.length > 0) {
        onPlanned();
      } else {
        const reply = result.reply;
        setError(
          "The assistant answered but didn't save a plan, so nothing changed. Try again" +
            (providers.length > 1 ? " or pick a different assistant." : ".") +
            (reply ? ` It said: "${reply.length > 240 ? `${reply.slice(0, 240)}…` : reply}"` : "")
        );
      }
    } catch (err: any) {
      if (err?.name !== "AbortError") setError(err?.message || "Planning failed.");
    } finally {
      setBusy(false);
      setStatus("");
      abortRef.current = null;
    }
  }

  const pill = (active: boolean) =>
    `px-3 py-1.5 rounded-lg text-sm ${
      active
        ? "bg-blue-600 text-white"
        : "bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700"
    }`;

  return (
    <div className="p-4 rounded-lg border border-slate-200 dark:border-slate-800 space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold flex items-center gap-1.5">
          <Sparkles size={15} /> Plan the week
        </h3>
        {onCancel && !busy && (
          <button onClick={onCancel} className="text-slate-400 hover:text-slate-600" aria-label="Close">
            <X size={16} />
          </button>
        )}
      </div>

      <div className="flex gap-2">
        <button type="button" disabled={busy} className={pill(week === "this")} onClick={() => chooseWeek("this")}>
          This week
        </button>
        <button type="button" disabled={busy} className={pill(week === "next")} onClick={() => chooseWeek("next")}>
          Next week
        </button>
      </div>

      <div className="flex flex-wrap gap-2">
        {days.map((d) => (
          <label
            key={d.day}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-sm cursor-pointer ${
              picked.has(d.day)
                ? "border-blue-500 bg-blue-50 dark:bg-blue-950/40"
                : "border-slate-300 dark:border-slate-700"
            }`}
          >
            <input type="checkbox" disabled={busy} checked={picked.has(d.day)} onChange={() => toggleDay(d.day)} />
            {d.day.slice(0, 3)}
            <span className="text-xs text-slate-500 dark:text-slate-400">{d.date.slice(5).replace("-", "/")}</span>
          </label>
        ))}
      </div>

      {replacing && (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          This replaces the meals already planned on the days you've ticked, in the week of {weekStart}.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {providers.length > 1 && (
          <select
            className="px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
            value={provider}
            disabled={busy}
            onChange={(e) => setProvider(e.target.value)}
            aria-label="Which assistant plans it"
          >
            {providers.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        )}
        {busy ? (
          <>
            <span className="text-sm text-slate-600 dark:text-slate-400 flex items-center gap-1.5">
              <Loader2 size={15} className="animate-spin" /> {status}
            </span>
            <button
              onClick={() => abortRef.current?.abort()}
              className="px-3 py-2 rounded-lg bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 dark:hover:bg-slate-700 text-sm font-medium"
            >
              Stop
            </button>
          </>
        ) : (
          <button
            onClick={plan}
            disabled={picked.size === 0}
            className="px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium"
          >
            Plan {picked.size === 7 ? "the whole week" : `${picked.size} day${picked.size === 1 ? "" : "s"}`}
          </button>
        )}
      </div>

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}

// What the button says while each tool runs -- the assistant can take a
// minute on the local model, and a spinner with no words reads as stuck.
const TOOL_STATUS: Record<string, string> = {
  list_calendar_events: "Checking the calendar…",
  list_recipes: "Looking through recipes…",
  list_meal_requests: "Checking meal requests…",
  create_meal_plan: "Saving the plan…",
  remove_meal_request: "Clearing used requests…",
};
