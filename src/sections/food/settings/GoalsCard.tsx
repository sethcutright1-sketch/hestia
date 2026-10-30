// Food settings > Calorie goals: weekly plan, activity level, goal weight, macros, the minimum-calorie warning, an
// optional calorie budget of your own, "I started my weight loss on" (its own little form), and the calorie schedule (higher-calorie weekdays, with a live preview of each
// weekday's calorie budget from POST /me/goals/preview -- the same server code as the diary, fed with what is typed
// here, saved or not).
//
// Goals are append-only: Save adds a new goal effective from today; earlier days keep the goal and calorie budget
// they had. The goal in effect is shown at the top.

import { useEffect, useRef, useState } from "react";
import { foodApi } from "../api.ts";
import { kcalText } from "../calories.ts";
import { longDate } from "../dates.ts";
import {
  ACTIVITY_OPTIONS, MAX_EXTRA_KCAL, MIN_MODE_OPTIONS, PLANS, SAVED_MESSAGE, WEEK, buildGoal, goalFormFrom, goalSummary, macroTotal, planLabel, previewBody,
  scheduleProblem, toggleDay, type GoalForm,
} from "../goalForm.ts";
import type { ActivityLevel, Goal, MinCalorieBudgetMode, Profile, SchedulePreview } from "../types.ts";
import { Field, Notice, btnPrimary, inputCls, mutedCls } from "../ui.tsx";
import { weightUnit } from "../units.ts";
import SettingsCard, { Select } from "./SettingsCard.tsx";
import WeightStartField from "./WeightStartField.tsx";

/** The "maintain weight" starting goal a new profile gets is dated 2000-01-01 so it covers every day; it isn't worth printing. */
const PLACEHOLDER_GOAL_DATE = "2000-01-01";

interface Props {
  profile: Profile;
  fail: (err: unknown) => string;
  /** A goal was saved: the diary's calorie budget may have moved. */
  onSaved: () => void;
  /** "I started my weight loss on" was saved or cleared. */
  onWeightStartChanged?: () => void;
}

export default function GoalsCard({ profile, fail, onSaved, onWeightStartChanged }: Props) {
  const system = profile.unitSystem;
  const [current, setCurrent] = useState<Goal | null | undefined>(undefined); // undefined = loading
  const [form, setForm] = useState<GoalForm>(() => goalFormFrom(null, system));
  const [status, setStatus] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState("");
  const palOverride = useRef<number | null>(null);

  useEffect(() => {
    foodApi.goals()
      .then((g) => {
        setCurrent(g.current);
        palOverride.current = g.current?.palOverride ?? null;
        setForm(goalFormFrom(g.current, system));
      })
      .catch((err) => {
        setCurrent(null);
        setLoadError(fail(err));
      });
    // The goal weight box is in the person's units: start again if they change units.
  }, [system]);

  const set = <K extends keyof GoalForm>(key: K, value: GoalForm[K]) => setForm((f) => ({ ...f, [key]: value }));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const built = buildGoal(form, system, palOverride.current);
    if (!built.ok) return setStatus({ tone: "error", text: built.error });
    setBusy(true);
    setStatus(null);
    try {
      const saved = await foodApi.saveGoal(built.body);
      setCurrent(saved);
      setStatus({ tone: "ok", text: SAVED_MESSAGE });
      onSaved();
    } catch (err) {
      setStatus({ tone: "error", text: fail(err) });
    } finally {
      setBusy(false);
    }
  }

  const total = macroTotal(form);

  return (
    <SettingsCard
      title="Calorie goals"
      description="Saving adds a new goal that starts today. Earlier days keep the calorie budget they had."
    >
      {loadError && <Notice tone="error">{loadError}</Notice>}
      <p className={`text-xs ${mutedCls}`} aria-live="polite">
        {current === undefined ? "Loading your goal…" : <>Current goal: {goalSummary(current, system)}{current && current.effectiveFrom !== PLACEHOLDER_GOAL_DATE ? ` (since ${longDate(current.effectiveFrom)})` : ""}</>}
      </p>
      <WeightStartField fail={fail} onChanged={onWeightStartChanged} />
      <form onSubmit={save} className="space-y-3">
        <Field label="Weekly goal" htmlFor="gl-plan">
          <Select id="gl-plan" value={String(form.plan)} onChange={(v) => set("plan", Number(v))}>
            {PLANS.map((p) => <option key={p} value={String(p)}>{planLabel(p)}</option>)}
          </Select>
        </Field>
        <Field label="Activity level" htmlFor="gl-activity">
          <Select id="gl-activity" value={form.activity} onChange={(v) => set("activity", v as ActivityLevel)}>
            {ACTIVITY_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </Select>
        </Field>
        <Field label={`Goal weight (${weightUnit(system)}, optional)`} htmlFor="gl-goalw" hint="Used for the goal date on the Weight & progress tab.">
          <input id="gl-goalw" type="number" inputMode="decimal" step="0.1" min="0" className={inputCls} value={form.goalWeight} onChange={(e) => set("goalWeight", e.target.value)} placeholder="Optional" />
        </Field>

        <div className="space-y-1">
          <p className="text-xs font-medium text-slate-600 dark:text-slate-400">Macros (percent of your calories)</p>
          <div className="grid grid-cols-3 gap-2">
            {([["protein", "Protein %"], ["carbs", "Carbs %"], ["fat", "Fat %"]] as const).map(([k, l]) => (
              <Field key={k} label={l} htmlFor={`gl-${k}`}>
                <input id={`gl-${k}`} type="number" inputMode="decimal" min="0" max="100" step="any" className={inputCls} value={form[k]} onChange={(e) => set(k, e.target.value)} />
              </Field>
            ))}
          </div>
          <p className={`text-xs ${total === 100 ? mutedCls : "text-amber-700 dark:text-amber-400 font-medium"}`}>Total {total}% (must be 100)</p>
        </div>

        <Field label="Daily calories (leave empty for automatic)" htmlFor="gl-override" hint="A calorie budget of your own instead of the one worked out from your profile and plan.">
          <input id="gl-override" type="number" inputMode="numeric" min="500" max="10000" step="1" className={inputCls} value={form.override} onChange={(e) => set("override", e.target.value)} placeholder="Automatic" />
        </Field>
        <Field label="Minimum calorie warning" htmlFor="gl-mode" hint="Only a warning: your calorie budget is never raised to meet it.">
          <Select id="gl-mode" value={form.minMode} onChange={(v) => set("minMode", v as MinCalorieBudgetMode)}>
            {MIN_MODE_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </Select>
        </Field>

        <ScheduleField form={form} onDays={(days) => set("highDays", days)} onExtra={(v) => set("extra", v)} fail={fail} />

        {status && <Notice tone={status.tone}>{status.text}</Notice>}
        <button type="submit" disabled={busy} className={`${btnPrimary} w-full`}>Save goals</button>
      </form>
    </SettingsCard>
  );
}

function ScheduleField({ form, onDays, onExtra, fail }: { form: GoalForm; onDays: (days: number[]) => void; onExtra: (v: string) => void; fail: (err: unknown) => string }) {
  const [preview, setPreview] = useState<SchedulePreview | null>(null);
  const [note, setNote] = useState("");
  const seq = useRef(0);
  const problem = scheduleProblem(form);

  // The preview follows what is typed above and in the chips, a moment after the last change.
  const key = JSON.stringify(previewBody(form));
  useEffect(() => {
    if (problem) {
      setNote(problem);
      return;
    }
    const mine = ++seq.current;
    const timer = window.setTimeout(() => {
      foodApi.previewGoal(JSON.parse(key))
        .then((p) => {
          if (mine !== seq.current) return;
          setPreview(p);
          setNote(
            !p.days
              ? p.missing.includes("weight") ? "Add a weigh-in to see your calorie budget for each day." : "Save your profile to see your calorie budget for each day."
              : p.days.some((d) => d.belowFloor) ? "Some days are below the minimum calorie warning for your profile." : "",
          );
        })
        .catch((err) => {
          if (mine !== seq.current) return;
          setPreview(null);
          setNote(fail(err));
        });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [key, problem, fail]);

  return (
    <div className="space-y-2 rounded-xl border border-slate-200 dark:border-slate-800 p-3">
      <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Calorie schedule</h4>
      <p className={`text-xs leading-normal ${mutedCls}`}>
        Make some days higher-calorie days. The other days give up a little, so your week still averages your calorie budget.
      </p>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Higher-calorie days">
        {WEEK.map(([n, label]) => {
          const on = form.highDays.includes(n);
          return (
            <button
              key={n}
              type="button"
              aria-pressed={on}
              aria-label={`${label} is a higher-calorie day`}
              onClick={() => onDays(toggleDay(form.highDays, n))}
              className={`px-3 py-1.5 rounded-full border text-xs font-medium ${on ? "bg-blue-600 border-blue-600 text-white" : "border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"}`}
            >
              {label}
            </button>
          );
        })}
      </div>
      {form.highDays.length > 0 && (
        <Field label="Extra calories on higher-calorie days" htmlFor="gl-extra">
          <input id="gl-extra" type="number" inputMode="numeric" min="0" max={MAX_EXTRA_KCAL} step="25" className={inputCls} value={form.extra} onChange={(e) => onExtra(e.target.value)} />
        </Field>
      )}
      <p className={`text-xs font-medium ${mutedCls}`}>Calorie budget for each day</p>
      {preview?.days ? (
        <div className="grid grid-cols-7 gap-1" role="list">
          {WEEK.map(([n, label]) => {
            const d = preview.days!.find((x) => x.weekday === n);
            return d ? (
              <div
                key={n}
                role="listitem"
                aria-label={`${label}: ${kcalText(d.kcal)} calories${d.high ? ", higher-calorie day" : ""}`}
                className={`rounded-lg border px-0.5 py-1.5 text-center ${d.high ? "border-blue-300 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/30" : "border-slate-200 dark:border-slate-800"} ${d.belowFloor ? "ring-1 ring-amber-400" : ""}`}
              >
                <span className={`block text-[10px] ${mutedCls}`}>{label}</span>
                <strong className="block text-[11px] tabular-nums text-slate-900 dark:text-slate-100">{kcalText(d.kcal)}</strong>
              </div>
            ) : null;
          })}
        </div>
      ) : (
        <p className={`text-xs ${mutedCls}`}>{note || "…"}</p>
      )}
      {preview?.days && note && <Notice tone="warn">{note}</Notice>}
    </div>
  );
}
