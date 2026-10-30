// The top of the diary: calories only. A big "1,240 left" (or "150 over"), one line that shows the sum
// ("2,100 calorie budget − 980 food + 120 exercise"), and a bar. Protein, carbs and fat are hidden until the
// card is tapped.

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { macroRows, plannedNote, summaryView } from "./calories.ts";
import type { DaySummary } from "./types.ts";
import { Notice, chipPrimaryCls, mutedCls } from "./ui.tsx";

interface Props {
  summary: DaySummary;
  /** Where to go to fix what is missing: the gear (profile, goal) and the Weight & progress tab (a weigh-in). */
  onOpenSettings?: () => void;
  onOpenWeight?: () => void;
}

export default function SummaryCard({ summary, onOpenSettings, onOpenWeight }: Props) {
  const [open, setOpen] = useState(false);
  const v = summaryView(summary);
  const planned = plannedNote(summary);

  return (
    <section className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-3" aria-label="Calories for the day">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls="food-macros"
        className="w-full text-left space-y-2"
        title={open ? "Hide protein, carbs and fat" : "Show protein, carbs and fat"}
      >
        <div className="flex items-baseline gap-2">
          <span className="sr-only">{v.spoken}</span>
          <span aria-hidden="true" className={`text-4xl font-bold tabular-nums ${v.over ? "text-red-600 dark:text-red-400" : "text-slate-900 dark:text-slate-100"}`}>
            {v.big}
          </span>
          <span aria-hidden="true" className={`text-lg ${v.over ? "text-red-600 dark:text-red-400 font-medium" : "text-slate-600 dark:text-slate-400"}`}>
            {v.bigLabel}
          </span>
          <ChevronDown size={18} className={`ml-auto text-slate-400 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
        </div>
        {v.hasBudget && (
          <div
            role="progressbar"
            aria-label="Calories eaten against the calorie budget"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(v.fraction * 100)}
            className="h-2 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden"
          >
            <div className={`h-full rounded-full ${v.over ? "bg-red-500" : "bg-blue-600"}`} style={{ width: `${v.fraction * 100}%` }} />
          </div>
        )}
        {v.equation && <p className={`text-sm ${mutedCls}`}>{v.equation}</p>}
      </button>

      {open && (
        <div id="food-macros" className="space-y-2 pt-1">
          {macroRows(summary).map((m) => (
            <div key={m.key}>
              <div className="flex justify-between text-sm">
                <span className="text-slate-700 dark:text-slate-300">{m.label}</span>
                <span className={mutedCls}>{m.text}</span>
              </div>
              <div className="h-1.5 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
                <div className="h-full rounded-full bg-slate-500 dark:bg-slate-400" style={{ width: `${m.fraction * 100}%` }} />
              </div>
            </div>
          ))}
        </div>
      )}

      {v.missingNote && (
        <div className="space-y-2">
          <Notice tone="warn">{v.missingNote}</Notice>
          <div className="flex flex-wrap gap-2">
            {(summary.missing.includes("profile") || summary.missing.includes("goal")) && onOpenSettings && (
              <button onClick={onOpenSettings} className={chipPrimaryCls}>
                {summary.missing.includes("profile") ? "Set up your profile" : "Set a weight goal"}
              </button>
            )}
            {summary.missing.includes("weight") && onOpenWeight && (
              <button onClick={onOpenWeight} className={chipPrimaryCls}>Add a weigh-in</button>
            )}
          </div>
        </div>
      )}
      {summary.belowFloor && (
        <Notice tone="warn">This calorie budget is below the safe minimum for your profile. Consider a smaller weekly goal.</Notice>
      )}
      {planned && <p className={`text-sm ${mutedCls}`}>{planned}</p>}
    </section>
  );
}
