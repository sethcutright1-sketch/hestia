// The Exercise section at the bottom of the diary: what was done on this day, with name, minutes and
// calories burned typed in. The burned calories are added back to that day's calorie budget (the server's
// day summary does it), so every change here asks the diary to refetch its top card.
//
// Recent exercises are the person's own (GET /exercise/recent), one tap to log the same again on this day.

import { useEffect, useState } from "react";
import { Dumbbell, Plus } from "lucide-react";
import { foodApi, errorText } from "./api.ts";
import { kcalText } from "./calories.ts";
import { buildExercise, exerciseLine, type ExerciseForm } from "./forms.ts";
import type { Exercise } from "./types.ts";
import { Field, Notice, Sheet, btnDanger, btnPrimary, btnSecondary, chipCls, inputCls, mutedCls } from "./ui.tsx";

interface Props {
  date: string;
  /** Called after any change, so the diary's top card shows the new calories left. */
  onChanged: () => void;
  toast: (message: string, opts?: { tone?: "info" | "error"; action?: { label: string; onClick: () => void } }) => void;
}

export default function ExerciseSection({ date, onChanged, toast }: Props) {
  const [items, setItems] = useState<Exercise[] | null>(null);
  const [recent, setRecent] = useState<Exercise[]>([]);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<Exercise | "new" | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const [day, rec] = await Promise.all([foodApi.exercise(date), foodApi.recentExercise().catch(() => [] as Exercise[])]);
      setItems(day);
      setRecent(rec);
      setError("");
    } catch (err) {
      setError(errorText(err));
    }
  }

  useEffect(() => {
    setItems(null);
    void load();
  }, [date]);

  async function repeat(e: Exercise) {
    if (busy) return;
    setBusy(true);
    try {
      const made = await foodApi.addExercise({ name: e.name, minutes: e.minutes, kcal: e.kcal, localDate: date });
      toast(`Added ${e.name}: ${kcalText(e.kcal)} kcal burned.`, {
        action: {
          label: "Undo",
          onClick: () => {
            foodApi.deleteExercise(made.id).then(() => { void load(); onChanged(); }).catch((err) => toast(errorText(err), { tone: "error" }));
          },
        },
      });
      await load();
      onChanged();
    } catch (err) {
      toast(errorText(err), { tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  const burned = (items ?? []).filter((i) => !i.excludeFromBudget).reduce((a, i) => a + i.kcal, 0);
  // Recent ones that are not already on this day with the same numbers would just be duplicates; still offered (a second walk is real).
  return (
    <section className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-3" aria-label="Exercise">
      <div className="flex items-center gap-2">
        <Dumbbell size={16} className="text-slate-500" />
        <h3 className="font-semibold text-slate-900 dark:text-slate-100 flex-1">Exercise</h3>
        {items && items.length > 0 && <span className={`text-sm ${mutedCls}`}>{kcalText(burned)} kcal burned</span>}
        <button onClick={() => setEditing("new")} className={`${chipCls} inline-flex items-center gap-1`} aria-label="Add exercise">
          <Plus size={14} /> Add
        </button>
      </div>

      {error && <Notice tone="error">{error}</Notice>}
      {items && items.length === 0 && !error && <p className={`text-sm ${mutedCls}`}>No exercise logged. Burned calories are added back to your calorie budget for the day.</p>}

      {items && items.length > 0 && (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {items.map((e) => (
            <li key={e.id}>
              <button onClick={() => setEditing(e)} className="w-full text-left flex items-center gap-3 py-2.5">
                <span className="flex-1 min-w-0">
                  <span className="block text-sm font-medium text-slate-900 dark:text-slate-100 break-words">{e.name}</span>
                  <span className={`block text-xs ${mutedCls}`}>
                    {e.minutes !== null ? `${Math.round(e.minutes * 10) / 10} min` : "No duration"}
                    {e.excludeFromBudget ? " · not added to your calorie budget" : ""}
                  </span>
                </span>
                <span className="shrink-0 text-sm text-slate-800 dark:text-slate-200">{kcalText(e.kcal)} kcal</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {recent.length > 0 && (
        <div className="space-y-1.5">
          <p className={`text-xs font-medium uppercase tracking-wide ${mutedCls}`}>Recent</p>
          <div className="flex flex-wrap gap-1.5">
            {recent.map((e) => (
              <button key={e.id} disabled={busy} onClick={() => void repeat(e)} className={`${chipCls} max-w-full truncate`} title="Log this again on this day">
                {exerciseLine(e).replace(" burned", "")}
              </button>
            ))}
          </div>
        </div>
      )}

      {editing && (
        <ExerciseSheet
          date={date}
          exercise={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(message) => {
            setEditing(null);
            toast(message);
            void load();
            onChanged();
          }}
        />
      )}
    </section>
  );
}

function ExerciseSheet({ date, exercise, onClose, onSaved }: { date: string; exercise: Exercise | null; onClose: () => void; onSaved: (message: string) => void }) {
  const [f, setF] = useState<ExerciseForm>({
    name: exercise?.name ?? "",
    minutes: exercise?.minutes != null ? String(exercise.minutes) : "",
    kcal: exercise ? String(exercise.kcal) : "",
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const built = buildExercise(f);
    if (!built.ok) return setError(built.error);
    setBusy(true);
    setError("");
    try {
      if (exercise) await foodApi.updateExercise(exercise.id, built.body);
      else await foodApi.addExercise({ ...built.body, localDate: date });
      onSaved(exercise ? `Saved ${built.body.name}.` : `Added ${built.body.name}: ${kcalText(built.body.kcal)} kcal burned.`);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  async function remove() {
    if (!exercise || busy) return;
    setBusy(true);
    setError("");
    try {
      await foodApi.deleteExercise(exercise.id);
      onSaved(`Deleted ${exercise.name}.`);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <Sheet title={exercise ? "Edit exercise" : "Add exercise"} onClose={onClose}>
      <form onSubmit={save} className="space-y-3">
        <Field label="Name" htmlFor="ex-name">
          <input id="ex-name" type="text" maxLength={100} autoFocus className={inputCls} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Walk, run, bike…" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Minutes (optional)" htmlFor="ex-min">
            <input id="ex-min" type="number" inputMode="decimal" min="0" step="any" className={inputCls} value={f.minutes} onChange={(e) => setF({ ...f, minutes: e.target.value })} />
          </Field>
          <Field label="Calories burned" htmlFor="ex-kcal">
            <input id="ex-kcal" type="number" inputMode="decimal" min="0" step="any" className={inputCls} value={f.kcal} onChange={(e) => setF({ ...f, kcal: e.target.value })} />
          </Field>
        </div>
        <p className={`text-xs ${mutedCls}`}>Calories burned are added back to this day's calorie budget. You type them in; nothing is estimated.</p>
        {error && <Notice tone="error">{error}</Notice>}
        <button type="submit" disabled={busy} className={`${btnPrimary} w-full`}>
          {exercise ? "Save" : "Add exercise"}
        </button>
        {exercise &&
          (confirming ? (
            <div className="space-y-2 rounded-lg border border-red-200 dark:border-red-900/60 p-3">
              <p className="text-sm text-slate-800 dark:text-slate-200">Delete {exercise.name}?</p>
              <div className="flex gap-2">
                <button type="button" className={`${btnDanger} flex-1`} disabled={busy} onClick={remove}>Delete</button>
                <button type="button" className={`${btnSecondary} flex-1`} disabled={busy} onClick={() => setConfirming(false)}>Keep it</button>
              </div>
            </div>
          ) : (
            <button type="button" className={`${btnDanger} w-full`} disabled={busy} onClick={() => setConfirming(true)}>Delete</button>
          ))}
      </form>
    </Sheet>
  );
}
