// Food settings > Meals: rename, switch on or off, put in order (up/down), add your own, and give each a calorie target
// (a number of calories, or a share of the day's calorie budget). A meal's key never changes when it is renamed, so what
// was logged in it, saved meals and the meal plan keep pointing at it. A meal switched off takes no new food but keeps
// showing what it holds; at least one meal stays on.

import { useCallback, useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Pencil, Plus } from "lucide-react";
import { foodApi } from "../api.ts";
import { MAX_MEALS, TARGET_KINDS, isLastEnabled, mealBody, moveKey, targetBody, targetKindOf, targetSummary, type TargetKind } from "../slotSettings.ts";
import type { SettingsSlot } from "../types.ts";
import { Field, Notice, Sheet, btnPrimary, btnSecondary, inputCls, mutedCls } from "../ui.tsx";
import SettingsCard, { Select } from "./SettingsCard.tsx";

interface Props {
  fail: (err: unknown) => string;
  /** The diary's meals or targets changed. */
  onChanged: () => void;
}

export default function MealsCard({ fail, onChanged }: Props) {
  const [slots, setSlots] = useState<SettingsSlot[] | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<SettingsSlot | "new" | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setSlots(await foodApi.slots());
      setError("");
    } catch (err) {
      setError(fail(err));
    }
  }, [fail]);

  useEffect(() => {
    void load();
  }, [load]);

  async function move(index: number, dir: 1 | -1) {
    if (!slots || busy) return;
    const keys = moveKey(slots.map((s) => s.key), index, dir);
    setBusy(true);
    try {
      setSlots(await foodApi.reorderSlots(keys));
      setError("");
      onChanged();
    } catch (err) {
      setError(fail(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingsCard title="Meals" description="Rename your meals, switch them off, put them in order and give each a calorie target. Renaming keeps what you logged.">
      {error && <Notice tone="error">{error}</Notice>}
      {slots === null && !error && <p className={`text-sm ${mutedCls}`}>Loading…</p>}
      {slots && (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {slots.map((s, i) => (
            <li key={s.key} className={`flex items-center gap-1 py-2 ${s.enabled ? "" : "opacity-60"}`}>
              <div className="flex flex-col">
                <button onClick={() => void move(i, -1)} disabled={i === 0 || busy} aria-label={`Move ${s.label} up`} className="p-1 rounded text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-30">
                  <ArrowUp size={16} />
                </button>
                <button onClick={() => void move(i, 1)} disabled={i === slots.length - 1 || busy} aria-label={`Move ${s.label} down`} className="p-1 rounded text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-30">
                  <ArrowDown size={16} />
                </button>
              </div>
              <button onClick={() => setEditing(s)} className="flex-1 min-w-0 text-left px-2">
                <span className="block text-sm font-medium text-slate-900 dark:text-slate-100 break-words">
                  {s.label}
                  {!s.enabled && <span className={`font-normal ${mutedCls}`}> (off)</span>}
                </span>
                <span className={`block text-xs ${mutedCls}`}>{targetSummary(s)}</span>
              </button>
              <button onClick={() => setEditing(s)} aria-label={`Edit ${s.label}`} className="p-2 rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800">
                <Pencil size={16} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {slots && slots.length < MAX_MEALS && (
        <button onClick={() => setEditing("new")} className={`${btnSecondary} w-full inline-flex items-center justify-center gap-2`}>
          <Plus size={16} /> Add a meal
        </button>
      )}

      {editing && slots && (
        <MealSheet
          slot={editing === "new" ? null : editing}
          slots={slots}
          fail={fail}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
            onChanged();
          }}
        />
      )}
    </SettingsCard>
  );
}

function MealSheet({ slot, slots, fail, onClose, onSaved }: { slot: SettingsSlot | null; slots: SettingsSlot[]; fail: (e: unknown) => string; onClose: () => void; onSaved: () => void }) {
  const [label, setLabel] = useState(slot?.label ?? "");
  const [enabled, setEnabled] = useState(slot?.enabled ?? true);
  const [kind, setKind] = useState<TargetKind>(slot ? targetKindOf(slot) : "none");
  const [amount, setAmount] = useState(slot ? String(slot.targetKcal ?? slot.targetPct ?? "") : "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const lastOn = slot !== null && isLastEnabled(slots, slot.key);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const name = mealBody(label);
    if (!name.ok) return setError(name.error);
    const target = targetBody(kind, amount);
    if (!target.ok) return setError(target.error);
    setBusy(true);
    setError("");
    try {
      if (slot) await foodApi.updateSlot(slot.key, { label: name.body.label, enabled, ...target.body });
      else await foodApi.addSlot({ label: name.body.label, ...target.body });
      onSaved();
    } catch (err) {
      setError(fail(err));
      setBusy(false);
    }
  }

  return (
    <Sheet title={slot ? `Edit ${slot.label}` : "Add a meal"} onClose={onClose}>
      <form onSubmit={save} className="space-y-3">
        <Field label="Name" htmlFor="ml-name">
          <input id="ml-name" type="text" maxLength={40} autoFocus className={inputCls} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Pre-workout" />
        </Field>
        {slot && (
          <label className="flex items-start gap-2.5 text-sm text-slate-800 dark:text-slate-200">
            <input type="checkbox" className="mt-1" checked={enabled} disabled={lastOn} onChange={(e) => setEnabled(e.target.checked)} />
            <span>
              Show this meal in my diary
              {lastOn && <span className={`block text-xs ${mutedCls}`}>It is your only meal that is on, so it has to stay on.</span>}
              {!enabled && <span className={`block text-xs ${mutedCls}`}>Switched off: it takes no new food, and what you logged in it still shows on those days.</span>}
            </span>
          </label>
        )}
        <Field label="Calorie target" htmlFor="ml-kind">
          <Select id="ml-kind" value={kind} onChange={(v) => setKind(v as TargetKind)}>
            {TARGET_KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </Select>
        </Field>
        {kind !== "none" && (
          <Field label={kind === "kcal" ? "Calories for this meal (kcal)" : "Percent of the day's calorie budget"} htmlFor="ml-amount">
            <input id="ml-amount" type="number" inputMode="decimal" step="any" className={inputCls} value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
        )}
        <p className={`text-xs ${mutedCls}`}>The diary shows this meal as eaten / target. A percentage follows each day's calorie budget.</p>
        {error && <Notice tone="error">{error}</Notice>}
        <button type="submit" disabled={busy} className={`${btnPrimary} w-full`}>{slot ? "Save" : "Add meal"}</button>
      </form>
    </Sheet>
  );
}
