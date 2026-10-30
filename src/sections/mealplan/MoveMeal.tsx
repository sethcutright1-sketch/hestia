// The "Move" panel on a planned meal (phase 5c): pick another day and/or meal. The same check the server runs
// (nutrition/planCells.ts checkMoveCell) is run here first, so a move the server would refuse is explained instead
// of tried: a cell that already has a meal, a leftover that would come before its original, an original that would
// come after its leftovers.

import { useState } from "react";
import { DAY_NAMES, checkMoveCell, type CellMeal } from "../../../nutrition/planCells.ts";

export default function MoveMeal({ meal, meals, slots, busy, onMove, onClose }: {
  meal: CellMeal & { name: string };
  /** Every meal of the plan (the check looks at the cells they fill). */
  meals: CellMeal[];
  slots: Array<{ key: string; label: string }>;
  busy?: boolean;
  onMove: (day: string, slot: string) => void;
  onClose: () => void;
}) {
  const [day, setDay] = useState(meal.day);
  // A meal in a slot the household doesn't list any more still shows its own slot.
  const options = slots.some((s) => s.key === meal.slot) ? slots : [...slots, { key: meal.slot, label: meal.slot }];
  const [slot, setSlot] = useState(meal.slot);
  const label = (key: string) => options.find((s) => s.key === key)?.label ?? key;
  const unchanged = day === meal.day && slot === meal.slot;
  const problem = unchanged ? null : checkMoveCell(meals, meal, day, slot, label);

  const selectCls = "min-w-0 flex-1 px-2 py-1.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900";
  return (
    <div className="mt-2 rounded-md bg-slate-100 dark:bg-slate-800 p-2 text-xs space-y-2">
      <div className="font-medium text-slate-700 dark:text-slate-200">Move "{meal.name}" to</div>
      <div className="flex gap-2">
        <select className={selectCls} value={day} onChange={(e) => setDay(e.target.value)} aria-label={`Day for ${meal.name}`}>
          {DAY_NAMES.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
        <select className={selectCls} value={slot} onChange={(e) => setSlot(e.target.value)} aria-label={`Meal for ${meal.name}`}>
          {options.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
      </div>
      {problem && <p role="alert" className="text-amber-700 dark:text-amber-400">{problem}</p>}
      {unchanged && <p className="text-slate-500 dark:text-slate-400">Pick another day or meal.</p>}
      <div className="flex gap-2">
        <button
          onClick={() => onMove(day, slot)}
          disabled={busy || unchanged || problem !== null}
          className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium"
        >
          Move
        </button>
        <button onClick={onClose} className="px-3 py-1.5 rounded-lg bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 text-sm">
          Cancel
        </button>
      </div>
    </div>
  );
}
