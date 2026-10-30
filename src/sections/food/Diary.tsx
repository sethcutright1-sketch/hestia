// The food diary: one day at a time, the signed-in person's own. A phone-style single column; Add food and
// the other dialogs open as sheets over it, never as a second column.
//
//   top        calories left (macros on tap), the day's streak
//   meals      each meal's "eaten / target", its entries (planned ones greyed, "from plan", with Log), Add, "…"
//   exercise   the day's exercise; burned calories are added back to the day's calorie budget
//   bottom     Copy day to…, Done logging
//
// All plain online calls: every action calls the API and then refetches the day, so what is on screen is
// what the server has. A failed call says why and changes nothing on screen.

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Copy, Flame } from "lucide-react";
import { ApiError, errorText, foodApi } from "./api.ts";
import AddFood, { type Logged } from "./AddFood.tsx";
import { doneToast, streakText } from "./calories.ts";
import { addDays, canLogPlanned, canMarkDone, dayLabel, longDate } from "./dates.ts";
import EntrySheet from "./EntrySheet.tsx";
import ExerciseSection from "./ExerciseSection.tsx";
import { itemsFromEntries } from "./meals.ts";
import PantryUsePrompt, { worthAsking } from "./PantryUsePrompt.tsx";
import SlotCard from "./SlotCard.tsx";
import { CopyDaySheet, SlotMenu } from "./SlotMenu.tsx";
import SummaryCard from "./SummaryCard.tsx";
import type { DayResponse, DiaryEntry, PantrySuggestions, Streak } from "./types.ts";
import { Notice, btnPrimary, btnSecondary } from "./ui.tsx";

interface Props {
  /** The server answered 423: the food diary is PIN-locked. The section swaps to its lock screen. */
  onLocked: () => void;
  toast: (message: string, opts?: { tone?: "info" | "error"; action?: { label: string; onClick: () => void } }) => void;
  /** "Set up your profile" / "Set a weight goal" in the top card: open Food settings (the gear). */
  onOpenSettings: () => void;
  /** "Add a weigh-in" in the top card: open the Weight & progress tab. */
  onOpenWeight: () => void;
  /** Bumped by the section when something outside the diary changed the day's numbers (a weigh-in, a goal, the meals): read the day again. */
  reloadToken: number;
}

type Sheet =
  | { kind: "add"; slot: string }
  | { kind: "entry"; id: string }
  | { kind: "menu"; slot: string }
  | { kind: "copyDay" };

export default function Diary({ onLocked, toast, onOpenSettings, onOpenWeight, reloadToken }: Props) {
  /** The person's own local date, from the server (their timezone, not the browser's). */
  const [today, setToday] = useState<string | null>(null);
  const [date, setDate] = useState<string | null>(null);
  const [day, setDay] = useState<DayResponse | null>(null);
  const [streak, setStreak] = useState<Streak | null>(null);
  const [error, setError] = useState("");
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [pantry, setPantry] = useState<{ suggestions: PantrySuggestions; position?: string; done: () => void } | null>(null);
  const [doneMsg, setDoneMsg] = useState<{ text: string; tone: "ok" | "warn" | "error" } | null>(null);
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
  const [marking, setMarking] = useState(false);
  const loadSeq = useRef(0);

  // Kept in a ref so `fail` (and the loaders built on it) keep one identity however the parent re-renders.
  const onLockedRef = useRef(onLocked);
  onLockedRef.current = onLocked;
  const fail = useCallback((err: unknown) => {
    if (err instanceof ApiError && err.status === 423) onLockedRef.current();
    return errorText(err);
  }, []);

  // ---- loading ---------------------------------------------------------------------------------

  const load = useCallback(
    async (d: string) => {
      const mine = ++loadSeq.current;
      try {
        const res = await foodApi.day(d);
        if (mine !== loadSeq.current) return;
        setDay(res);
        setError("");
      } catch (err) {
        if (mine !== loadSeq.current) return;
        setError(fail(err));
      }
    },
    [fail],
  );

  const loadStreak = useCallback(async () => {
    const s = await foodApi.streak();
    setStreak({ current: s.current, best: s.best, countedToday: s.countedToday });
    setToday(s.today);
    return s;
  }, []);

  // First open: ask the server what "today" is for this person, then show it.
  useEffect(() => {
    loadStreak()
      .then((s) => setDate((cur) => cur ?? s.today))
      .catch((err) => setError(fail(err)));
  }, [loadStreak, fail]);

  useEffect(() => {
    if (date) void load(date);
  }, [date, load]);

  // A phone left open overnight: when the page comes back, refresh "today" and what's shown.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      loadStreak().catch(() => {});
      if (date) void load(date);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [date, load, loadStreak]);

  const refresh = useCallback(async () => {
    if (date) await load(date);
  }, [date, load]);

  // Something outside the diary moved the numbers (a weigh-in, the goals, the meals): read the day and the streak again.
  const firstToken = useRef(reloadToken);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    if (reloadToken === firstToken.current) return;
    void refreshRef.current();
    loadStreak().catch(() => {});
  }, [reloadToken, loadStreak]);

  function goTo(d: string) {
    if (d === date) return;
    setDate(d);
    setDay(null);
    setError("");
    setDoneMsg(null);
  }

  // ---- logging planned entries -------------------------------------------------------------------

  const setBusy = (id: string, on: boolean) =>
    setBusyIds((cur) => {
      const next = new Set(cur);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  /** "Use from pantry?" for entries that were just logged: only the ones that have a recipe with matched, countable pantry items. */
  async function askPantry(entries: DiaryEntry[]) {
    const withFood = entries.filter((e) => e.foodId);
    const answers = await Promise.allSettled(withFood.map((e) => foodApi.pantrySuggestions(e.id))); // 404 = not a recipe: nothing to ask
    const worth = answers.flatMap((a) => (a.status === "fulfilled" && worthAsking(a.value) ? [a.value] : []));
    for (const [i, suggestions] of worth.entries()) {
      await new Promise<void>((resolve) =>
        setPantry({ suggestions, position: worth.length > 1 ? `${i + 1} of ${worth.length}` : undefined, done: resolve }),
      );
      setPantry(null);
    }
  }

  async function logOne(entry: DiaryEntry) {
    if (busyIds.has(entry.id)) return;
    setBusy(entry.id, true);
    try {
      await foodApi.patchEntry(entry.id, { status: "logged" });
      await refresh();
      loadStreak().catch(() => {});
      await askPantry([entry]);
    } catch (err) {
      toast(fail(err), { tone: "error" });
    } finally {
      setBusy(entry.id, false);
    }
  }

  async function logAll(slotKey: string) {
    if (!date || !day) return;
    const slot = day.slots.find((s) => s.key === slotKey);
    try {
      const res = await foodApi.logAll(date, slotKey);
      const loggedEntries = (slot?.entries ?? []).filter((e) => res.logged.includes(e.id));
      toast(`Logged ${res.logged.length} ${res.logged.length === 1 ? "entry" : "entries"} in ${slot?.label ?? "this meal"}.`);
      await refresh();
      await askPantry(loggedEntries);
    } catch (err) {
      // The server's own words, e.g. "That day hasn't happened yet. Log it on the day."
      toast(fail(err), { tone: "error" });
    }
  }

  // ---- Done logging --------------------------------------------------------------------------------

  async function markDone() {
    if (!date || marking) return;
    setMarking(true);
    try {
      const res = await foodApi.markDone(date);
      const { streak: after, ...summary } = res;
      setDay((d) => (d ? { ...d, summary } : d));
      setStreak(after);
      setDoneMsg({ text: "Nice. This day is marked done.", tone: "ok" });
      toast(doneToast(after));
    } catch (err) {
      setDoneMsg(
        err instanceof ApiError && err.status === 409
          ? { text: `${err.message} Tap "Log" on each planned item, or open it to delete it.`, tone: "warn" }
          : { text: fail(err), tone: "error" },
      );
    } finally {
      setMarking(false);
    }
  }

  // ---- what the sheets report back --------------------------------------------------------------------

  /** Something was logged: close the sheet, say so (with Undo where it can be taken back), and refetch. */
  function handleLogged(logged: Logged) {
    setSheet(null);
    toast(logged.message, logged.undo ? {
      action: {
        label: "Undo",
        onClick: () => {
          logged.undo!().then(() => { void refresh(); }).catch((err) => toast(fail(err), { tone: "error" }));
        },
      },
    } : undefined);
    void refresh();
  }

  // ---- render -------------------------------------------------------------------------------------------

  if (!date || !today) {
    return error ? <Notice tone="error">{error}</Notice> : <p className="text-sm text-slate-500 dark:text-slate-400">Loading…</p>;
  }

  const slots = day?.slots ?? [];
  const addable = slots.filter((s) => s.enabled).map((s) => ({ key: s.key, label: s.label }));
  const openEntry = sheet?.kind === "entry" ? slots.flatMap((s) => s.entries).find((e) => e.id === sheet.id) : undefined;
  const menuSlot = sheet?.kind === "menu" ? slots.find((s) => s.key === sheet.slot) : undefined;
  const copyable = slots.some((s) => s.enabled && itemsFromEntries(s.entries).items.length > 0);
  const done = day?.summary.doneLoggingAt;

  return (
    <div className="space-y-3">
      <header className="flex items-center gap-1">
        <button onClick={() => goTo(addDays(date, -1))} className="p-2 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300" aria-label="Previous day">
          <ChevronLeft size={20} />
        </button>
        <div className="flex-1 text-center min-w-0">
          <h3 className="font-semibold text-slate-900 dark:text-slate-100">{dayLabel(date, today)}</h3>
          <p className="text-xs text-slate-500 dark:text-slate-400">{longDate(date)}</p>
        </div>
        <button onClick={() => goTo(addDays(date, 1))} className="p-2 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300" aria-label="Next day">
          <ChevronRight size={20} />
        </button>
      </header>
      {date !== today && (
        <div className="text-center">
          <button onClick={() => goTo(today)} className="px-3 py-1 rounded-full border border-slate-300 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800">
            Today
          </button>
        </div>
      )}

      {streak && streak.current > 0 && (
        <p className="flex items-center justify-center gap-1.5 text-sm text-orange-600 dark:text-orange-400" title={`Best: ${streak.best} days`}>
          <Flame size={16} />
          <strong>{streakText(streak.current)}</strong>
          {!streak.countedToday && date === today && <span className="text-slate-500 dark:text-slate-400"> - Done logging today keeps it going</span>}
        </p>
      )}

      {error && (
        <div className="space-y-2">
          <Notice tone="error">{error}</Notice>
          <button onClick={() => void refresh()} className={btnSecondary}>Retry</button>
        </div>
      )}
      {!day && !error && <p className="text-sm text-slate-500 dark:text-slate-400">Loading…</p>}

      {day && (
        <>
          <SummaryCard summary={day.summary} onOpenSettings={onOpenSettings} onOpenWeight={onOpenWeight} />
          {slots.map((s) => (
            <SlotCard
              key={s.key}
              slot={s}
              busyIds={busyIds}
              onAdd={() => setSheet({ kind: "add", slot: s.key })}
              onMenu={() => setSheet({ kind: "menu", slot: s.key })}
              onOpenEntry={(e) => setSheet({ kind: "entry", id: e.id })}
              onLog={(e) => void logOne(e)}
              onLogAll={() => void logAll(s.key)}
              canLog={canLogPlanned(date, today)}
            />
          ))}
        </>
      )}

      <ExerciseSection date={date} onChanged={() => void refresh()} toast={toast} />

      {day && (
        <section className="space-y-2 pt-1">
          {doneMsg && <Notice tone={doneMsg.tone}>{doneMsg.text}</Notice>}
          {copyable && (
            <button onClick={() => setSheet({ kind: "copyDay" })} className={`${btnSecondary} w-full inline-flex items-center justify-center gap-2`}>
              <Copy size={16} /> Copy day to…
            </button>
          )}
          {(canMarkDone(date, today) || done) && (
            <button onClick={() => void markDone()} disabled={marking} className={`${done ? btnSecondary : btnPrimary} w-full`}>
              {done ? "Done logging (marked)" : "Done logging"}
            </button>
          )}
        </section>
      )}

      {sheet?.kind === "add" && (
        <AddFood date={date} today={today} slot={sheet.slot} slots={addable} onClose={() => setSheet(null)} onLogged={handleLogged} />
      )}

      {sheet?.kind === "entry" && openEntry && (
        <EntrySheet
          entry={openEntry}
          slots={slots.filter((s) => s.enabled || s.key === openEntry.slotKey).map((s) => ({ key: s.key, label: s.label }))}
          onClose={() => setSheet(null)}
          onSave={async (patch) => {
            if (Object.keys(patch).length === 0) {
              setSheet(null);
              return;
            }
            await foodApi.patchEntry(openEntry.id, patch);
            setSheet(null);
            toast(`Saved ${openEntry.name}.`);
            await refresh();
          }}
          canLog={canLogPlanned(date, today)}
          onLog={async () => {
            setSheet(null);
            await logOne(openEntry);
          }}
          onDelete={async () => {
            await foodApi.deleteEntry(openEntry.id);
            setSheet(null);
            toast(`Deleted ${openEntry.name}.`);
            await refresh();
          }}
        />
      )}

      {sheet?.kind === "menu" && menuSlot && (
        <SlotMenu date={date} today={today} slot={menuSlot} slots={addable} onClose={() => setSheet(null)} onDone={handleLogged} />
      )}

      {sheet?.kind === "copyDay" && day && (
        <CopyDaySheet date={date} today={today} slots={day.slots} onClose={() => setSheet(null)} onDone={handleLogged} />
      )}

      {pantry && (
        <PantryUsePrompt
          key={pantry.suggestions.entryId}
          suggestions={pantry.suggestions}
          position={pantry.position}
          onClose={pantry.done}
          onDone={(message) => {
            toast(message);
            pantry.done();
          }}
        />
      )}
    </div>
  );
}
