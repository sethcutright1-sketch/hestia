// Tap an entry: change its amount and serving, move it to another meal, log it (when it is only planned),
// or delete it. The amount step is the same one Add food uses, started from how the entry was logged.
//
// A quick add, or an entry whose food is gone, has no food to measure again: it only has a quantity (its
// calories and macros scale with it) and a meal.

import { useEffect, useState } from "react";
import { foodApi, errorText } from "./api.ts";
import { editPatch, startAmount, type AmountInput, type ComputedAmount } from "./amount.ts";
import AmountStep from "./AmountStep.tsx";
import { amountText, kcalText } from "./calories.ts";
import { LOG_ON_THE_DAY } from "./dates.ts";
import type { DiaryEntry, Food } from "./types.ts";
import { Field, Notice, Sheet, btnDanger, btnPrimary, btnSecondary, inputCls, mutedCls } from "./ui.tsx";

interface Props {
  entry: DiaryEntry;
  /** Meals this entry may sit in: the enabled ones, plus the one it is in now. */
  slots: Array<{ key: string; label: string }>;
  onClose: () => void;
  /** Send the change; resolves when done (the sheet closes), rejects with the message to show. */
  onSave: (patch: Record<string, unknown>) => Promise<void>;
  onLog: () => Promise<void>;
  /** false on a future day: a planned entry can't be logged before its day. */
  canLog: boolean;
  onDelete: () => Promise<void>;
}

export default function EntrySheet({ entry, slots, onClose, onSave, onLog, canLog, onDelete }: Props) {
  const measurable = !entry.isQuickAdd && entry.foodId !== null;
  const [food, setFood] = useState<Food | null>(null);
  const [foodGone, setFoodGone] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  useEffect(() => {
    if (!measurable) return;
    let alive = true;
    foodApi.food(entry.foodId!).then((f) => alive && setFood(f)).catch(() => alive && setFoodGone(true));
    return () => { alive = false; };
  }, [measurable, entry.foodId]);

  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  const planned = entry.status === "planned";
  const summary = `${planned ? "Planned, " : ""}${kcalText(entry.nutrients.kcal)} kcal for ${amountText(entry.quantity, entry.unit)}`;

  const actions = (
    <div className="space-y-2 pt-1">
      {planned && canLog && (
        <button className={`${btnSecondary} w-full`} disabled={busy} onClick={() => void run(onLog)}>
          Log it (I ate this)
        </button>
      )}
      {planned && !canLog && <p className="text-xs text-slate-500 dark:text-slate-400">{LOG_ON_THE_DAY}: a planned meal can be logged on its day or later.</p>}
      {confirmingDelete ? (
        <div className="space-y-2 rounded-lg border border-red-200 dark:border-red-900/60 p-3">
          <p className="text-sm text-slate-800 dark:text-slate-200">Delete {entry.name} from this day?</p>
          <div className="flex gap-2">
            <button className={`${btnDanger} flex-1`} disabled={busy} onClick={() => void run(onDelete)}>Delete</button>
            <button className={`${btnSecondary} flex-1`} disabled={busy} onClick={() => setConfirmingDelete(false)}>Keep it</button>
          </div>
        </div>
      ) : (
        <button className={`${btnDanger} w-full`} disabled={busy} onClick={() => setConfirmingDelete(true)}>
          Delete
        </button>
      )}
    </div>
  );

  return (
    <Sheet title={entry.name} onClose={onClose}>
      <p className={`text-sm ${mutedCls}`}>{summary}</p>
      {entry.source === "plan" && <p className={`text-xs ${mutedCls}`}>Made by the meal plan.</p>}

      {measurable && !food && !foodGone && <p className={`text-sm ${mutedCls}`}>Loading…</p>}

      {measurable && food ? (
        <AmountStep
          food={food}
          start={startAmount(food, entry.relog)}
          slots={slots}
          slot={entry.slotKey}
          confirmLabel="Save"
          busy={busy}
          error={error}
          onConfirm={(computed: ComputedAmount, input: AmountInput, slotKey) => {
            const start = startAmount(food, entry.relog);
            // Only send what was touched: an untouched amount stays exactly as logged (the box shows it rounded).
            const touched = input.qty !== start.qty || input.unit !== start.unit;
            const patch: Record<string, unknown> = touched ? { ...editPatch(start, input, computed, entry.unit) } : {};
            if (slotKey && slotKey !== entry.slotKey) patch.slot = slotKey;
            if (Object.keys(patch).length === 0) {
              onClose();
              return;
            }
            void run(() => onSave(patch));
          }}
          below={actions}
        />
      ) : (
        (!measurable || foodGone) && (
          <QuantityOnly entry={entry} slots={slots} busy={busy} error={error} gone={foodGone} onSave={(patch) => void run(() => onSave(patch))} below={actions} />
        )
      )}
    </Sheet>
  );
}

/** For an entry with no food behind it: a quantity (its numbers scale with it) and a meal. */
function QuantityOnly({ entry, slots, busy, error, gone, onSave, below }: {
  entry: DiaryEntry;
  slots: Array<{ key: string; label: string }>;
  busy: boolean;
  error: string;
  gone: boolean;
  onSave: (patch: Record<string, unknown>) => void;
  below: React.ReactNode;
}) {
  const [qty, setQty] = useState(String(Math.round(entry.quantity * 100) / 100));
  const [slotKey, setSlotKey] = useState(entry.slotKey);
  const [problem, setProblem] = useState("");

  return (
    <div className="space-y-3">
      <Notice tone="info">
        {gone
          ? "The food behind this entry is gone, so only its quantity and meal can change."
          : "Quick adds scale their calories and macros with the quantity."}
      </Notice>
      <Field label={`Quantity (${entry.unit})`} htmlFor="entry-qty">
        <input id="entry-qty" type="number" inputMode="decimal" min="0" step="any" className={inputCls} value={qty} onChange={(e) => { setProblem(""); setQty(e.target.value); }} />
      </Field>
      <Field label="Meal" htmlFor="entry-slot">
        <select id="entry-slot" className={inputCls} value={slotKey} onChange={(e) => setSlotKey(e.target.value)}>
          {slots.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
      </Field>
      {(problem || error) && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{problem || error}</p>}
      <button
        className={`${btnPrimary} w-full`}
        disabled={busy}
        onClick={() => {
          const q = Number(qty);
          if (!(q > 0) || !Number.isFinite(q)) {
            setProblem("Quantity must be more than 0.");
            return;
          }
          const patch: Record<string, unknown> = {};
          if (q !== entry.quantity) patch.quantity = q;
          if (slotKey !== entry.slotKey) patch.slot = slotKey;
          onSave(patch);
        }}
      >
        Save
      </button>
      {below}
    </div>
  );
}
