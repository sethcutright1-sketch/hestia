// Food settings > Who can see my food data: what the OTHER diary logins can see of yours. Nothing by default. The choice
// is stored per login and enforced by the server, not just hidden here. Progress photos are never shared.

import { useEffect, useState } from "react";
import { foodApi } from "../api.ts";
import { LEVELS, PHOTOS_NEVER_SHARED } from "../sharing.ts";
import type { Visibility } from "../types.ts";
import { Notice, mutedCls } from "../ui.tsx";
import SettingsCard from "./SettingsCard.tsx";

export default function VisibilityCard({ fail }: { fail: (err: unknown) => string }) {
  const [level, setLevel] = useState<Visibility | null>(null);
  const [status, setStatus] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    foodApi.visibility()
      .then((v) => setLevel(v.visibility))
      .catch((err) => setStatus({ tone: "error", text: fail(err) }));
  }, [fail]);

  async function choose(next: Visibility) {
    if (busy || next === level) return;
    setBusy(true);
    setStatus(null);
    try {
      const saved = await foodApi.setVisibility(next);
      setLevel(saved.visibility);
      setStatus({ tone: "ok", text: "Saved." });
    } catch (err) {
      setStatus({ tone: "error", text: fail(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingsCard
      title="Who can see my food data"
      description="Choose what the other logins in this household can see of yours. They can only look; nobody can change your food data but you."
    >
      <div role="radiogroup" aria-label="Who can see my food data" className="space-y-2">
        {LEVELS.map((l) => (
          <label
            key={l.value}
            className={`flex items-start gap-2.5 rounded-xl border p-3 cursor-pointer ${level === l.value ? "border-blue-500 bg-blue-50/60 dark:bg-blue-950/20" : "border-slate-200 dark:border-slate-800"}`}
          >
            <input type="radio" name="food-visibility" className="mt-1" checked={level === l.value} disabled={level === null || busy} onChange={() => void choose(l.value)} />
            <span className="min-w-0">
              <span className="block text-sm font-medium text-slate-900 dark:text-slate-100">
                {l.label}
                {l.value === "nothing" && <span className={`font-normal ${mutedCls}`}> (default)</span>}
              </span>
              <span className={`block text-xs leading-normal ${mutedCls}`}>{l.detail}</span>
            </span>
          </label>
        ))}
      </div>
      <p className="text-xs font-medium text-slate-700 dark:text-slate-300">{PHOTOS_NEVER_SHARED}</p>
      {level === null && !status && <p className={`text-xs ${mutedCls}`}>Loading…</p>}
      {status && <Notice tone={status.tone}>{status.text}</Notice>}
    </SettingsCard>
  );
}
