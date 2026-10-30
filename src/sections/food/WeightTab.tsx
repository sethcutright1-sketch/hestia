// The Weight & progress tab: the signed-in person's own weigh-ins (with the chart, trend and goal projection),
// steps typed by hand, and private progress photos. Plain online calls; nothing here is queued.
//
// "Today" comes from the server (the person's own timezone), like the diary. When a weigh-in is added or
// deleted the diary is told (`onWeightChanged`), because the latest weight drives the day's calorie budget.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { foodApi } from "./api.ts";
import { failWith, type ToastFn } from "./fail.ts";
import PhotosCard from "./PhotosCard.tsx";
import StepsCard from "./StepsCard.tsx";
import type { Profile, Weight, WeightTrend } from "./types.ts";
import { Notice, btnSecondary } from "./ui.tsx";
import WeighIns from "./WeighIns.tsx";
import { loadRange, saveRange, type WeightRange } from "./weightRange.ts";

/** The weigh-in list asks for everything: the chart's range buttons only change the chart, and an old history must not read as "no weigh-ins yet". */
const ALL_WEIGHTS_FROM = "2000-01-01";

interface Props {
  profile: Profile | null;
  toast: ToastFn;
  onLocked: () => void;
  onWeightChanged: () => void;
  onOpenSettings: () => void;
  onOpenSettingsCard: (card: "weight-start") => void;
  /** Bumped when the weight loss start day changed in settings: read the chart's numbers again. */
  reloadToken?: number;
}

export default function WeightTab({ profile, toast, onLocked, onWeightChanged, onOpenSettings, onOpenSettingsCard, reloadToken = 0 }: Props) {
  const [today, setToday] = useState<string | null>(null);
  const [weights, setWeights] = useState<Weight[] | null>(null);
  const [trend, setTrend] = useState<WeightTrend | null>(null);
  const [error, setError] = useState("");
  /** Remembered on this device (localStorage, if the browser allows it). */
  const [range, setRange] = useState<WeightRange>(() => loadRange());
  const [trendBusy, setTrendBusy] = useState(false);
  const fail = useMemo(() => failWith(onLocked), [onLocked]);
  const seq = useRef(0);
  const rangeRef = useRef(range);
  rangeRef.current = range;

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const { today: t } = await foodApi.streak();
      const [w, tr] = await Promise.all([foodApi.weights(ALL_WEIGHTS_FROM), foodApi.weightTrend(rangeRef.current)]);
      if (mine !== seq.current) return; // a newer load (another range, a new weigh-in) is on its way
      setToday(t);
      setWeights(w);
      setTrend(tr);
      setError("");
    } catch (err) {
      if (mine === seq.current) setError(fail(err));
    } finally {
      if (mine === seq.current) setTrendBusy(false);
    }
  }, [fail]);

  useEffect(() => {
    void load();
  }, [load, reloadToken]);

  // A different range reads the chart again; the chart on screen stays (faded) until the new one arrives.
  function chooseRange(next: WeightRange) {
    if (next === range) return;
    setRange(next);
    rangeRef.current = next;
    saveRange(next);
    setTrendBusy(true);
    void load();
  }

  if (!today) {
    return error ? (
      <div className="space-y-2">
        <Notice tone="error">{error}</Notice>
        <button onClick={() => void load()} className={btnSecondary}>Retry</button>
      </div>
    ) : (
      <p className="text-sm text-slate-500 dark:text-slate-400">Loading…</p>
    );
  }

  return (
    <div className="space-y-3">
      {error && <Notice tone="error">{error}</Notice>}
      <WeighIns
        profile={profile}
        today={today}
        weights={weights}
        trend={trend}
        fail={fail}
        toast={toast}
        onChanged={async () => {
          await load();
          onWeightChanged();
        }}
        onOpenSettings={onOpenSettings}
        onOpenSettingsCard={onOpenSettingsCard}
        range={range}
        onRangeChange={chooseRange}
        trendBusy={trendBusy}
      />
      <StepsCard today={today} fail={fail} toast={toast} />
      <PhotosCard today={today} fail={fail} toast={toast} />
    </div>
  );
}
