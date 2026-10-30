// Food settings > Calorie goals > "I started my weight loss on": the day the Weight & progress tab measures "lost so far"
// from. Its own little form with its own Save and Clear (it is not part of a calorie goal, so it does not make a new
// goal and does not touch earlier days). Private to this login: another person who can see your weigh-ins never sees it.
// The Weight & progress tab opens the settings scrolled here (id "weight-start").

import { useEffect, useState } from "react";
import { foodApi } from "../api.ts";
import { longDate } from "../dates.ts";
import type { WeightStartSetting } from "../types.ts";
import { Field, Notice, btnPrimary, btnSecondary, inputCls, mutedCls } from "../ui.tsx";
import { weightStartBody } from "../weightLoss.ts";

interface Props {
  fail: (err: unknown) => string;
  /** Saved or cleared. */
  onChanged?: () => void;
}

export default function WeightStartField({ fail, onChanged }: Props) {
  const [info, setInfo] = useState<WeightStartSetting | null>(null);
  const [text, setText] = useState("");
  const [status, setStatus] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    foodApi.weightStart()
      .then((s) => {
        setInfo(s);
        setText(s.weightStartDate ?? "");
      })
      .catch((err) => setStatus({ tone: "error", text: fail(err) }));
  }, [fail]);

  async function send(body: { weightStartDate: string | null }) {
    setBusy(true);
    setStatus(null);
    try {
      const saved = await foodApi.setWeightStart(body.weightStartDate);
      setInfo(saved);
      setText(saved.weightStartDate ?? "");
      setStatus({ tone: "ok", text: saved.weightStartDate ? `Saved. Lost so far counts from ${longDate(saved.weightStartDate)}.` : "Cleared. The Weight & progress tab no longer shows how much you've lost." });
      onChanged?.();
    } catch (err) {
      setStatus({ tone: "error", text: fail(err) });
    } finally {
      setBusy(false);
    }
  }

  function save(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !info) return;
    const built = weightStartBody(text, info.today, info.earliest);
    if (!built.ok) return setStatus({ tone: "error", text: built.error });
    void send(built.body);
  }

  return (
    <div id="weight-start" className="space-y-2 rounded-xl border border-slate-200 dark:border-slate-800 p-3 scroll-mt-3">
      <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">I started my weight loss on</h4>
      <p className={`text-xs leading-normal ${mutedCls}`}>
        The Weight & progress tab shows how much you've lost since this day, using your trend weight. Only you see it.
      </p>
      <form onSubmit={save} className="space-y-3">
        <Field label="Start date" htmlFor="ws-date">
          <input id="ws-date" type="date" className={inputCls} value={text} min={info?.earliest} max={info?.today} onChange={(e) => setText(e.target.value)} disabled={!info} />
        </Field>
        {status && <Notice tone={status.tone}>{status.text}</Notice>}
        <div className="flex gap-2">
          <button type="submit" disabled={busy || !info} className={`${btnPrimary} flex-1`}>Save start date</button>
          <button type="button" disabled={busy || !info || !info.weightStartDate} onClick={() => void send({ weightStartDate: null })} className={btnSecondary}>Clear</button>
        </div>
      </form>
    </div>
  );
}
