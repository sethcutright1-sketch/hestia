// Steps, typed by hand: today's number, a bar chart of the last 30 days, and the last week with edit and delete.
// One row per date; typing a date again replaces it. Steps never change the calorie budget.
// (Phase 7 will bring in Lose It!'s steps.csv; those rows are marked "imported" here and become typed ones if edited.)

import { useCallback, useEffect, useState } from "react";
import { Footprints, Plus } from "lucide-react";
import { foodApi } from "./api.ts";
import { addDays, longDate, whenLabel } from "./dates.ts";
import { CHART_DAYS, averageText, lastDays, stepsText, type DaySteps } from "./stepsChart.ts";
import type { StepsDay } from "./types.ts";
import { Field, Notice, Sheet, btnDanger, btnPrimary, btnSecondary, cardCls, chipCls, inputCls, mutedCls } from "./ui.tsx";
import { StepsChartView } from "./WeightChartView.tsx";
import type { ToastFn } from "./fail.ts";

const RECENT_DAYS = 7;
/** Mirrors the server's limit (nutrition/data/steps.ts MAX_STEPS). */
const MAX_STEPS = 200_000;

interface Props {
  today: string;
  fail: (err: unknown) => string;
  toast: ToastFn;
}

export default function StepsCard({ today, fail, toast }: Props) {
  const [rows, setRows] = useState<StepsDay[] | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<{ date: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(await foodApi.steps(addDays(today, -(CHART_DAYS - 1)), today));
      setError("");
    } catch (err) {
      setError(fail(err));
    }
  }, [today, fail]);

  useEffect(() => {
    void load();
  }, [load]);

  const days = lastDays(rows ?? [], today);
  const byDate = new Map((rows ?? []).map((r) => [r.date, r]));
  const todaySteps = days[days.length - 1].steps;
  const recent = days.slice(-RECENT_DAYS).reverse();
  const average = averageText(days);

  return (
    <section className={`${cardCls} space-y-3`} aria-label="Steps">
      <div className="flex items-center gap-2">
        <Footprints size={16} className="text-slate-500" />
        <h3 className="font-semibold text-slate-900 dark:text-slate-100 flex-1">Steps</h3>
        <button onClick={() => setEditing({ date: today })} className={`${chipCls} inline-flex items-center gap-1`} aria-label="Add steps">
          <Plus size={14} /> Add steps
        </button>
      </div>

      {error && <Notice tone="error">{error}</Notice>}
      {rows === null && !error ? (
        <p className={`text-sm ${mutedCls}`}>Loading…</p>
      ) : (
        <>
          <p className="text-sm text-slate-900 dark:text-slate-100">
            Today: {todaySteps === null ? <span className={mutedCls}>not entered</span> : <strong>{stepsText(todaySteps)} steps</strong>}
          </p>
          <StepsChartView days={days} />
          {average ? <p className={`text-xs ${mutedCls}`}>{average}</p> : <p className={`text-xs ${mutedCls}`}>Nothing entered in the last {CHART_DAYS} days. Tap "Add steps" to type a day's count.</p>}

          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {recent.map((d) => (
              <li key={d.date}>
                <button onClick={() => setEditing({ date: d.date })} className="w-full flex items-center gap-2 py-2 text-left" aria-label={`${whenLabel(d.date, today)}: ${d.steps === null ? "no steps entered" : `${stepsText(d.steps)} steps`}. Edit`}>
                  <span className="flex-1 min-w-0 text-sm text-slate-700 dark:text-slate-300">{whenLabel(d.date, today)}</span>
                  {d.source === "import_loseit" && <span className={`text-xs ${mutedCls}`}>imported</span>}
                  <span className={`text-sm tabular-nums ${d.steps === null ? mutedCls : "text-slate-900 dark:text-slate-100"}`}>{d.steps === null ? "not entered" : stepsText(d.steps)}</span>
                </button>
              </li>
            ))}
          </ul>
          <p className={`text-xs ${mutedCls}`}>Typed by hand. Steps never change your calorie budget.</p>
        </>
      )}

      {editing && (
        <StepsSheet
          today={today}
          date={editing.date}
          existing={byDate.get(editing.date)?.steps ?? null}
          fail={fail}
          onClose={() => setEditing(null)}
          onSaved={(message) => {
            setEditing(null);
            toast(message);
            void load();
          }}
        />
      )}
    </section>
  );
}

function StepsSheet({ today, date: initialDate, existing, fail, onClose, onSaved }: {
  today: string;
  date: string;
  existing: number | null;
  fail: (err: unknown) => string;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [date, setDate] = useState(initialDate);
  const [text, setText] = useState(existing === null ? "" : String(existing));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const editingExisting = existing !== null && date === initialDate;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const n = text.trim() === "" ? NaN : Number(text);
    if (!Number.isInteger(n) || n < 0 || n > MAX_STEPS) return setError(`Enter a whole number of steps from 0 to ${stepsText(MAX_STEPS)}.`);
    if (!date || date > today) return setError("Pick a day that has already happened.");
    setBusy(true);
    setError("");
    try {
      await foodApi.putSteps(date, n);
      onSaved(`${stepsText(n)} steps saved for ${longDate(date)}.`);
    } catch (err) {
      setError(fail(err));
      setBusy(false);
    }
  }

  async function remove() {
    if (busy) return;
    setBusy(true);
    try {
      await foodApi.deleteSteps(initialDate);
      onSaved(`Removed the steps for ${longDate(initialDate)}.`);
    } catch (err) {
      setError(fail(err));
      setBusy(false);
    }
  }

  return (
    <Sheet title={editingExisting ? "Edit steps" : "Add steps"} onClose={onClose}>
      <form onSubmit={save} className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Date" htmlFor="st-date">
            <input id="st-date" type="date" max={today} className={inputCls} value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Steps" htmlFor="st-steps">
            <input id="st-steps" type="number" inputMode="numeric" min="0" step="1" autoFocus className={inputCls} value={text} onChange={(e) => setText(e.target.value)} />
          </Field>
        </div>
        <p className={`text-xs ${mutedCls}`}>Typing a day that already has steps replaces them.</p>
        {error && <Notice tone="error">{error}</Notice>}
        <button type="submit" disabled={busy} className={`${btnPrimary} w-full`}>Save</button>
        {editingExisting &&
          (confirming ? (
            <div className="space-y-2 rounded-lg border border-red-200 dark:border-red-900/60 p-3">
              <p className="text-sm text-slate-800 dark:text-slate-200">Remove the steps for {longDate(initialDate)}?</p>
              <div className="flex gap-2">
                <button type="button" className={`${btnDanger} flex-1`} disabled={busy} onClick={() => void remove()}>Remove</button>
                <button type="button" className={`${btnSecondary} flex-1`} disabled={busy} onClick={() => setConfirming(false)}>Keep it</button>
              </div>
            </div>
          ) : (
            <button type="button" className={`${btnDanger} w-full`} onClick={() => setConfirming(true)}>Remove this day</button>
          ))}
      </form>
    </Sheet>
  );
}
