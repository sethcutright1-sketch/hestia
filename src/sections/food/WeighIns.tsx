// Weigh-ins on the Weight & progress tab: add one (date + weight in the person's units), the chart with the
// smoothed trend line, "Trend weight: 183.3 lb" and the goal projection, range buttons (1M to All), "lost so far" from the day
// the person started, and the recent weigh-ins with delete.
// Weights are stored in kilograms; a pound entry is sent as weightLb so the server does the one conversion.
// Adding or deleting one can change today's calorie budget (the latest weight drives it), so the diary is told.

import { useState } from "react";
import { Trash2 } from "lucide-react";
import { foodApi } from "./api.ts";
import { longDate, whenLabel } from "./dates.ts";
import type { Profile, Weight, WeightTrend } from "./types.ts";
import { Field, Notice, btnPrimary, cardCls, inputCls, mutedCls } from "./ui.tsx";
import { formatWeight, weightBody, weightUnit } from "./units.ts";
import LossHeadline from "./LossHeadline.tsx";
import { lossSummary } from "./weightLoss.ts";
import type { WeightRange } from "./weightRange.ts";
import { WeightChartView } from "./WeightChartView.tsx";
import type { ToastFn } from "./fail.ts";

const RECENT = 30;

interface Props {
  profile: Profile | null;
  today: string;
  weights: Weight[] | null;
  trend: WeightTrend | null;
  fail: (err: unknown) => string;
  toast: ToastFn;
  /** Reload the weights and trend, and tell the diary its calorie budget may have moved. */
  onChanged: () => Promise<void>;
  onOpenSettings: () => void;
  /** Open Food settings scrolled to a card ("weight-start" = "I started my weight loss on"). */
  onOpenSettingsCard: (card: "weight-start") => void;
  /** The chart's range, and a different one chosen. */
  range: WeightRange;
  onRangeChange: (range: WeightRange) => void;
  /** A different range is loading. */
  trendBusy: boolean;
}

export default function WeighIns({ profile, today, weights, trend, fail, toast, onChanged, onOpenSettings, onOpenSettingsCard, range, onRangeChange, trendBusy }: Props) {
  const system = profile?.unitSystem ?? "imperial";
  const unit = weightUnit(system);
  const [text, setText] = useState("");
  const [on, setOn] = useState(today);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const built = weightBody(text, system);
    if (!built.ok) return setError(built.error);
    if (!on || on > today) return setError("Pick a day that has already happened.");
    setBusy(true);
    setError("");
    try {
      await foodApi.addWeight({ ...built.body, measuredOn: on });
      setText("");
      toast(`Weigh-in added: ${text.trim()} ${unit} on ${longDate(on)}.`);
      await onChanged();
    } catch (err) {
      setError(fail(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(w: Weight) {
    if (busy) return;
    setBusy(true);
    try {
      await foodApi.deleteWeight(w.id);
      setConfirmId(null);
      toast(`Deleted the ${longDate(w.measuredOn)} weigh-in.`);
      await onChanged();
    } catch (err) {
      toast(fail(err), { tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  const recent = weights ? weights.slice(-RECENT).reverse() : [];

  return (
    <>
      <section className={`${cardCls} space-y-3`} aria-label="Add a weigh-in">
        <h3 className="font-semibold text-slate-900 dark:text-slate-100">Weigh-in</h3>
        <form onSubmit={add} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label={`Weight (${unit})`} htmlFor="wi-weight">
              <input id="wi-weight" type="number" inputMode="decimal" step="0.1" min="0" className={inputCls} value={text} onChange={(e) => setText(e.target.value)} placeholder={unit} />
            </Field>
            <Field label="Date" htmlFor="wi-date">
              <input id="wi-date" type="date" max={today} className={inputCls} value={on} onChange={(e) => setOn(e.target.value)} />
            </Field>
          </div>
          {error && <Notice tone="error">{error}</Notice>}
          <button type="submit" disabled={busy} className={`${btnPrimary} w-full`}>Add weigh-in</button>
        </form>
        {profile && !profile.hasProfile && (
          <p className={`text-xs ${mutedCls}`}>
            Your calorie budget also needs your profile.{" "}
            <button onClick={onOpenSettings} className="text-blue-600 dark:text-blue-400 underline">Open Food settings</button>
          </p>
        )}
      </section>

      {weights === null ? (
        <p className={`text-sm ${mutedCls}`}>Loading…</p>
      ) : weights.length === 0 ? (
        <p className={`text-sm text-center ${mutedCls}`}>No weigh-ins yet. Your calorie budget is based on your latest weight.</p>
      ) : (
        <>
          <section className={`${cardCls} space-y-2`} aria-label="Weight trend">
            <h3 className="font-semibold text-slate-900 dark:text-slate-100">Trend</h3>
            {trend ? (
              <>
                <LossHeadline
                  summary={lossSummary(trend.weightStart ?? null, trend.trendKg, trend.goalKg, system)}
                  onSetStart={() => onOpenSettingsCard("weight-start")}
                />
                <WeightChartView points={trend.points} trendKg={trend.trendKg} system={system} goal={trend} range={range} onRangeChange={onRangeChange} today={today} busy={trendBusy} />
              </>
            ) : (
              <p className={`text-sm ${mutedCls}`}>Loading…</p>
            )}
          </section>

          <section className={cardCls} aria-label="Recent weigh-ins">
            <h3 className="font-semibold text-slate-900 dark:text-slate-100 mb-1">Recent</h3>
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {recent.map((w) => (
                <li key={w.id} className="flex items-center gap-2 py-2">
                  <span className="flex-1 min-w-0 text-sm text-slate-700 dark:text-slate-300">{whenLabel(w.measuredOn, today)}</span>
                  <strong className="text-sm tabular-nums text-slate-900 dark:text-slate-100">{formatWeight(w.weightKg, system)}</strong>
                  {confirmId === w.id ? (
                    <span className="flex items-center gap-1.5">
                      <button onClick={() => void remove(w)} disabled={busy} className="text-xs font-medium text-red-700 dark:text-red-400 underline">Delete</button>
                      <button onClick={() => setConfirmId(null)} className="text-xs text-slate-500 underline">Keep</button>
                    </span>
                  ) : (
                    <button onClick={() => setConfirmId(w.id)} aria-label={`Delete the ${w.measuredOn} weigh-in`} className="p-1.5 rounded-lg text-slate-400 hover:text-red-600 hover:bg-slate-100 dark:hover:bg-slate-800">
                      <Trash2 size={15} />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </>
  );
}
