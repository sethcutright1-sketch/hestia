// "How much?": servings or grams with the calories it makes shown live. Used by Add food (log it) and by
// editing an entry (change it). It knows nothing about what happens next: it hands back the computed
// amount and the meal picked, and the caller decides.

import { useMemo, useState, type ReactNode } from "react";
import { GRAMS, canMeasureInGrams, computeAmount, defaultServing, qtyOnUnitChange, type AmountInput, type ComputedAmount } from "./amount.ts";
import { macroLine } from "./calories.ts";
import type { Food } from "./types.ts";
import { Field, btnPrimary, inputCls, mutedCls } from "./ui.tsx";

interface Props {
  food: Food;
  start: AmountInput;
  /** Meals to pick from; omit to hide the picker. */
  slots?: Array<{ key: string; label: string }>;
  slot?: string;
  confirmLabel: string;
  busy?: boolean;
  onConfirm: (computed: ComputedAmount, input: AmountInput, slotKey: string | null) => void;
  /** Extra rows above the amount (a note, a switch). */
  above?: ReactNode;
  /** Extra rows under the confirm button. */
  below?: ReactNode;
  error?: string;
}

export default function AmountStep({ food, start, slots, slot, confirmLabel, busy, onConfirm, above, below, error }: Props) {
  const [input, setInput] = useState<AmountInput>(start);
  const [slotKey, setSlotKey] = useState(slot ?? slots?.[0]?.key ?? "");
  const [problem, setProblem] = useState("");

  const perServing = food.basis === "per_serving";
  const gramsOk = canMeasureInGrams(food);
  const def = defaultServing(food);
  const computed = useMemo(() => computeAmount(food, input), [food, input]);

  function setUnit(unit: string) {
    setInput((cur) => ({ unit, qty: qtyOnUnitChange(food, cur.qty, cur.unit, unit) }));
  }

  return (
    <div className="space-y-3">
      {above}
      {food.brand && <p className={`text-sm ${mutedCls}`}>{food.brand}</p>}

      <div className="grid grid-cols-2 gap-3">
        <Field label="Amount" htmlFor="food-amount-qty">
          <input
            id="food-amount-qty"
            type="number"
            inputMode="decimal"
            min="0"
            step="any"
            autoFocus
            className={inputCls}
            value={input.qty}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => {
              setProblem("");
              setInput({ ...input, qty: e.target.value });
            }}
          />
        </Field>
        <Field label={perServing ? "Serving" : "Unit"} htmlFor="food-amount-unit">
          {perServing && !gramsOk ? (
            <p className="px-3 py-2 text-sm text-slate-700 dark:text-slate-300">{def?.label ?? "1 serving"}</p>
          ) : (
            <select id="food-amount-unit" className={inputCls} value={input.unit} onChange={(e) => setUnit(e.target.value)}>
              {food.servings.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
              {gramsOk && <option value={GRAMS}>grams</option>}
            </select>
          )}
        </Field>
      </div>

      {slots && (
        <Field label="Meal" htmlFor="food-amount-slot">
          <select id="food-amount-slot" className={inputCls} value={slotKey} onChange={(e) => setSlotKey(e.target.value)}>
            {slots.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
        </Field>
      )}

      <div className="rounded-lg bg-slate-50 dark:bg-slate-800/60 px-3 py-2 text-sm" aria-live="polite">
        {computed ? (
          <>
            <strong className="text-slate-900 dark:text-slate-100">{Math.round(computed.nutrients.kcal)} kcal</strong>
            <span className={`ml-2 ${mutedCls}`}>{macroLine(computed.nutrients)}</span>
          </>
        ) : (
          <span className={mutedCls}>Enter an amount above 0.</span>
        )}
      </div>

      {(problem || error) && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{problem || error}</p>}

      <button
        className={`${btnPrimary} w-full`}
        disabled={busy}
        onClick={() => {
          if (!computed) {
            setProblem("Enter an amount above 0.");
            return;
          }
          onConfirm(computed, input, slots ? slotKey : null);
        }}
      >
        {confirmLabel}
      </button>
      {below}
    </div>
  );
}
