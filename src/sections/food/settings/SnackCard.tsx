// Food settings > Snack allowance: the share of your calorie budget that calorie-aware meal planning keeps free for
// snacks (0 to 50 percent, 10 by default). A planned day's meals aim at the calorie budget times (1 minus this).

import { useEffect, useState } from "react";
import { foodApi } from "../api.ts";
import { snackBody } from "../slotSettings.ts";
import type { SnackAllowance } from "../types.ts";
import { Field, Notice, btnPrimary, inputCls, mutedCls } from "../ui.tsx";
import SettingsCard from "./SettingsCard.tsx";

export default function SnackCard({ fail }: { fail: (err: unknown) => string }) {
  const [info, setInfo] = useState<SnackAllowance | null>(null);
  const [text, setText] = useState("");
  const [status, setStatus] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    foodApi.snackAllowance()
      .then((a) => {
        setInfo(a);
        setText(String(a.snackAllowancePct));
      })
      .catch((err) => setStatus({ tone: "error", text: fail(err) }));
  }, [fail]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !info) return;
    const built = snackBody(text, info.min, info.max);
    if (!built.ok) return setStatus({ tone: "error", text: built.error });
    setBusy(true);
    setStatus(null);
    try {
      const saved = await foodApi.setSnackAllowance(built.body.snackAllowancePct);
      setInfo(saved);
      setText(String(saved.snackAllowancePct));
      setStatus({ tone: "ok", text: "Saved." });
    } catch (err) {
      setStatus({ tone: "error", text: fail(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingsCard
      title="Snack allowance"
      description="The share of your calorie budget that meal planning keeps free for snacks. Planned meals aim at your calorie budget minus this, so a day that is not planned to the last calorie still has room."
    >
      <form onSubmit={save} className="space-y-3">
        <Field label={`Percent of my calorie budget (${info?.min ?? 0} to ${info?.max ?? 50})`} htmlFor="sn-pct" hint={info ? `The default is ${info.defaultPct}%.` : undefined}>
          <input id="sn-pct" type="number" inputMode="decimal" step="0.5" min={info?.min ?? 0} max={info?.max ?? 50} className={inputCls} value={text} onChange={(e) => setText(e.target.value)} disabled={!info} />
        </Field>
        {!info && !status && <p className={`text-xs ${mutedCls}`}>Loading…</p>}
        {status && <Notice tone={status.tone}>{status.text}</Notice>}
        <button type="submit" disabled={busy || !info} className={`${btnPrimary} w-full`}>Save snack allowance</button>
      </form>
    </SettingsCard>
  );
}
