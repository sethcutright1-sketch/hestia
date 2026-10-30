// Another login's food data, READ-ONLY, at the level they chose to share (nothing here can change anything: there
// are no Log, Add, edit or menu buttons, and the server has no write route for someone else's data).
//
//   SharedDayView       the Diary tab for them: the day's top card and their streak ("Daily totals"); with "Everything"
//                       also their meals with entries, and their exercise.
//   SharedProgressView  the Weight & progress tab for them: weigh-ins, trend (with the 1M to All range buttons) and steps
//                       ("Everything" only). Never their goal weight, plan, goal date or start day: no goal line here.
//
// Progress photos are never shown: the server has no way to send them, and this file has nowhere to put them.
// If the person locked their diary behind the household PIN the server answers 423 and this asks for the PIN;
// if they stopped sharing it answers 403 and the section goes back to "Me".

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, Clock, Flame, Lock } from "lucide-react";
import { ApiError, errorText, foodApi } from "./api.ts";
import { amountText, kcalText, macroRows, streakText, summaryView } from "./calories.ts";
import { addDays, dayLabel, longDate, whenLabel } from "./dates.ts";
import { progressNotShared, viewShape, viewerBanner } from "./sharing.ts";
import { averageText, lastDays } from "./stepsChart.ts";
import type { Profile, SharedDay, SharedEntry, SharedProgress, SharedSlot, Sharer } from "./types.ts";
import { Notice, btnSecondary, cardCls, mutedCls } from "./ui.tsx";
import { formatWeight } from "./units.ts";
import { loadRange, saveRange, type WeightRange } from "./weightRange.ts";
import { StepsChartView, WeightChartView } from "./WeightChartView.tsx";

interface ViewProps {
  person: Sharer;
  /** Bumped when the PIN prompt succeeds, so a locked view loads again. */
  unlockCount: number;
  onRequestUnlock: () => void;
  /** They stopped sharing (403): ask the section to refresh who shares and go back to "Me". */
  onNoLongerShared: () => void;
}

/**
 * Loads one shared view and turns a failed call into the screen's state: the PIN panel (423), "no longer shared"
 * (403) or a message. `deps` are what the load depends on; a newer load always wins over an older one still in flight.
 * `quietDeps` also reload, but keep what is on screen until the new answer arrives (the chart's range buttons).
 */
function useSharedLoad<T>(load: () => Promise<T>, deps: unknown[], onNoLongerShared: () => void, quietDeps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [locked, setLocked] = useState(false);
  const seq = useRef(0);
  const noLonger = useRef(onNoLongerShared);
  noLonger.current = onNoLongerShared;

  const run = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const res = await load();
      if (mine !== seq.current) return;
      setData(res);
      setError("");
      setLocked(false);
    } catch (err) {
      if (mine !== seq.current) return;
      if (err instanceof ApiError && err.status === 423) setLocked(true);
      else if (err instanceof ApiError && err.status === 403) noLonger.current();
      else setError(errorText(err));
    }
    // `load` is a new function every render; the caller lists what it really depends on.
  }, [...deps, ...quietDeps]);

  useEffect(() => {
    setData(null);
    setError("");
  }, deps);

  useEffect(() => {
    void run();
  }, [run]);

  return { data, error, locked, reload: run };
}

function LockedPanel({ name, onRequestUnlock }: { name: string; onRequestUnlock: () => void }) {
  return (
    <div className={`${cardCls} text-center space-y-2`}>
      <Lock size={20} className="mx-auto text-amber-600 dark:text-amber-400" />
      <p className="text-sm font-medium text-slate-900 dark:text-slate-100">{name} keeps their food diary behind the household PIN.</p>
      <p className={`text-xs ${mutedCls}`}>Unlock with the PIN to see what they share with you.</p>
      <button onClick={onRequestUnlock} className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-xs font-bold">Unlock</button>
    </div>
  );
}

function Banner({ person }: { person: Sharer }) {
  return <p className={`text-xs rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50 px-3 py-2 ${mutedCls}`}>{viewerBanner(person.name, person.level)}</p>;
}

// ---- the Diary tab for someone else --------------------------------------------------------------------

export function SharedDayView({ person, unlockCount, onRequestUnlock, onNoLongerShared }: ViewProps) {
  // null = "their today", which the server resolves in their own timezone.
  const [date, setDate] = useState<string | null>(null);
  const { data, error, locked, reload } = useSharedLoad(() => foodApi.sharedDay(person.userId, date ?? "today"), [person.userId, date, unlockCount], onNoLongerShared);
  const shape = viewShape(person.level);

  if (locked) return <LockedPanel name={person.name} onRequestUnlock={onRequestUnlock} />;
  if (error) {
    return (
      <div className="space-y-2">
        <Notice tone="error">{error}</Notice>
        <button onClick={() => void reload()} className={btnSecondary}>Retry</button>
      </div>
    );
  }
  if (!data) return <p className={`text-sm ${mutedCls}`}>Loading…</p>;

  const day = data;
  const shown = day.date;
  return (
    <div className="space-y-3">
      <Banner person={person} />
      <header className="flex items-center gap-1">
        <button onClick={() => setDate(addDays(shown, -1))} className="p-2 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300" aria-label="Previous day">
          <ChevronLeft size={20} />
        </button>
        <div className="flex-1 text-center min-w-0">
          <h3 className="font-semibold text-slate-900 dark:text-slate-100">{dayLabel(shown, day.today)}</h3>
          <p className="text-xs text-slate-500 dark:text-slate-400">{longDate(shown)}</p>
        </div>
        <button onClick={() => setDate(addDays(shown, 1))} className="p-2 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300" aria-label="Next day">
          <ChevronRight size={20} />
        </button>
      </header>
      {shown !== day.today && (
        <div className="text-center">
          <button onClick={() => setDate(null)} className="px-3 py-1 rounded-full border border-slate-300 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800">Today</button>
        </div>
      )}

      {day.streak.current > 0 && (
        <p className="flex items-center justify-center gap-1.5 text-sm text-orange-600 dark:text-orange-400" title={`Best: ${day.streak.best} days`}>
          <Flame size={16} />
          <strong>{streakText(day.streak.current)}</strong>
        </p>
      )}

      <SharedSummaryCard day={day} name={person.name} />
      {shape.entries && day.slots && day.slots.map((s) => <SharedSlotCard key={s.key} slot={s} />)}
      {shape.entries && day.exercise && <SharedExerciseCard exercise={day.exercise} />}
    </div>
  );
}

function SharedSummaryCard({ day, name }: { day: SharedDay; name: string }) {
  const [open, setOpen] = useState(false);
  const v = summaryView(day.summary);
  const macros = day.summary.macros;
  return (
    <section className={`${cardCls} space-y-3`} aria-label={`${name}'s calories for the day`}>
      <button
        onClick={() => macros && setOpen((o) => !o)}
        disabled={!macros}
        aria-expanded={macros ? open : undefined}
        className="w-full text-left space-y-2 disabled:cursor-default"
      >
        <div className="flex items-baseline gap-2">
          <span className="sr-only">{v.spoken}</span>
          <span aria-hidden="true" className={`text-4xl font-bold tabular-nums ${v.over ? "text-red-600 dark:text-red-400" : "text-slate-900 dark:text-slate-100"}`}>{v.big}</span>
          <span aria-hidden="true" className={`text-lg ${v.over ? "text-red-600 dark:text-red-400 font-medium" : "text-slate-600 dark:text-slate-400"}`}>{v.bigLabel}</span>
          {macros && <ChevronDown size={18} className={`ml-auto text-slate-400 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />}
        </div>
        {v.hasBudget && (
          <div role="progressbar" aria-label="Calories eaten against the calorie budget" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(v.fraction * 100)} className="h-2 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
            <div className={`h-full rounded-full ${v.over ? "bg-red-500" : "bg-blue-600"}`} style={{ width: `${v.fraction * 100}%` }} />
          </div>
        )}
        {v.equation && <p className={`text-sm ${mutedCls}`}>{v.equation}</p>}
      </button>
      {open && macros && (
        <div className="space-y-2 pt-1">
          {macroRows({ macros }).map((m) => (
            <div key={m.key} className="flex justify-between text-sm">
              <span className="text-slate-700 dark:text-slate-300">{m.label}</span>
              <span className={mutedCls}>{m.text}</span>
            </div>
          ))}
        </div>
      )}
      {!v.hasBudget && <Notice tone="info">{name} hasn't got a calorie budget for this day yet.</Notice>}
    </section>
  );
}

function SharedSlotCard({ slot }: { slot: SharedSlot }) {
  return (
    <section className={`${cardCls} space-y-2`} aria-label={slot.label}>
      <div className="flex items-baseline gap-2">
        <h3 className="font-semibold text-slate-900 dark:text-slate-100 flex-1 min-w-0 break-words">{slot.label}</h3>
        <span className={`text-sm tabular-nums ${mutedCls}`}>{kcalText(slot.kcal)} kcal</span>
      </div>
      {slot.entries.length === 0 ? (
        <p className={`text-sm ${mutedCls}`}>Nothing here.</p>
      ) : (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {slot.entries.map((e) => <SharedEntryRow key={e.id} entry={e} />)}
        </ul>
      )}
    </section>
  );
}

function SharedEntryRow({ entry }: { entry: SharedEntry }) {
  const planned = entry.status === "planned";
  return (
    <li className={`flex items-center gap-2 py-2 ${planned ? "opacity-70" : ""}`}>
      <span className="flex-1 min-w-0">
        <span className={`flex items-center gap-1.5 text-sm font-medium ${planned ? "italic text-slate-600 dark:text-slate-300" : "text-slate-900 dark:text-slate-100"}`}>
          {planned && <Clock size={13} className="shrink-0 text-slate-400" aria-label="Planned" />}
          <span className="min-w-0 break-words">{entry.name}</span>
        </span>
        <span className={`block text-xs ${mutedCls}`}>{amountText(entry.quantity, entry.unit)}{planned ? " · planned" : ""}</span>
      </span>
      <span className={`shrink-0 text-sm tabular-nums ${planned ? "text-slate-400 dark:text-slate-500" : "text-slate-800 dark:text-slate-200"}`}>{kcalText(entry.nutrients.kcal)}</span>
    </li>
  );
}

function SharedExerciseCard({ exercise }: { exercise: NonNullable<SharedDay["exercise"]> }) {
  const burned = exercise.filter((e) => !e.excludeFromBudget).reduce((a, e) => a + e.kcal, 0);
  return (
    <section className={`${cardCls} space-y-2`} aria-label="Exercise">
      <div className="flex items-baseline gap-2">
        <h3 className="font-semibold text-slate-900 dark:text-slate-100 flex-1">Exercise</h3>
        {exercise.length > 0 && <span className={`text-sm ${mutedCls}`}>{kcalText(burned)} kcal burned</span>}
      </div>
      {exercise.length === 0 ? (
        <p className={`text-sm ${mutedCls}`}>No exercise.</p>
      ) : (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {exercise.map((e, i) => (
            <li key={i} className="flex items-center gap-3 py-2">
              <span className="flex-1 min-w-0">
                <span className="block text-sm font-medium text-slate-900 dark:text-slate-100 break-words">{e.name}</span>
                <span className={`block text-xs ${mutedCls}`}>{e.minutes !== null ? `${Math.round(e.minutes * 10) / 10} min` : "No duration"}</span>
              </span>
              <span className="shrink-0 text-sm text-slate-800 dark:text-slate-200">{kcalText(e.kcal)} kcal</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---- the Weight & progress tab for someone else ----------------------------------------------------------

const RECENT = 15;

export function SharedProgressView({ person, profile, unlockCount, onRequestUnlock, onNoLongerShared }: ViewProps & { profile: Profile | null }) {
  const shape = viewShape(person.level);
  // The range is remembered on this device like the person's own chart; it changes how much of THEIR history the chart draws.
  const [range, setRange] = useState<WeightRange>(() => loadRange());
  const { data, error, locked, reload } = useSharedLoad<SharedProgress | null>(
    () => (shape.progress ? foodApi.sharedProgress(person.userId, range) : Promise.resolve(null)),
    [person.userId, shape.progress, unlockCount],
    onNoLongerShared,
    [range],
  );
  const chooseRange = (next: WeightRange) => {
    setRange(next);
    saveRange(next);
  };
  const system = profile?.unitSystem ?? "imperial";

  if (!shape.progress) {
    return (
      <div className="space-y-3">
        <Banner person={person} />
        <p className={`text-sm text-center ${mutedCls}`}>{progressNotShared(person.name)}</p>
      </div>
    );
  }
  if (locked) return <LockedPanel name={person.name} onRequestUnlock={onRequestUnlock} />;
  if (error) {
    return (
      <div className="space-y-2">
        <Notice tone="error">{error}</Notice>
        <button onClick={() => void reload()} className={btnSecondary}>Retry</button>
      </div>
    );
  }
  if (!data) return <p className={`text-sm ${mutedCls}`}>Loading…</p>;

  const days = lastDays(data.steps, data.today);
  const average = averageText(days);
  const recent = data.weights.slice(-RECENT).reverse();
  return (
    <div className="space-y-3">
      <Banner person={person} />
      <section className={`${cardCls} space-y-2`} aria-label={`${person.name}'s weight`}>
        <h3 className="font-semibold text-slate-900 dark:text-slate-100">Weight</h3>
        {data.weights.length === 0 ? (
          <p className={`text-sm ${mutedCls}`}>{person.name} has no weigh-ins yet.</p>
        ) : (
          <>
            {/* No `goal`: their goal weight, plan and start day are theirs, so no goal line, no projection and no "lost so far". */}
            <WeightChartView points={data.trend.points} trendKg={data.trend.trendKg} system={system} range={range} onRangeChange={chooseRange} today={data.today} />
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {recent.map((w) => (
                <li key={w.date} className="flex items-center gap-2 py-2">
                  <span className="flex-1 text-sm text-slate-700 dark:text-slate-300">{whenLabel(w.date, data.today)}</span>
                  <strong className="text-sm tabular-nums text-slate-900 dark:text-slate-100">{formatWeight(w.weightKg, system)}</strong>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
      <section className={`${cardCls} space-y-2`} aria-label={`${person.name}'s steps`}>
        <h3 className="font-semibold text-slate-900 dark:text-slate-100">Steps</h3>
        <StepsChartView days={days} />
        <p className={`text-xs ${mutedCls}`}>{average ?? `${person.name} has no steps entered in the last 30 days.`}</p>
      </section>
    </div>
  );
}
