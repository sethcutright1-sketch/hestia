// One day's "calories per person" rows in the Meal Plan week (phase 5c). See planCaloriesView.ts for what is shown
// and why. Two short lines per person so it fits 375px: the name with "N of M kcal, K left", and a thin bar.

import type { DayRowView } from "./planCaloriesView.ts";

export default function PlanCalories({ rows }: { rows: DayRowView[] }) {
  if (rows.length === 0) return null;
  return (
    <ul className="mb-2 space-y-1.5" aria-label="Calories per person">
      {rows.map((r) => (
        <li key={r.userId} title={r.spoken}>
          <span className="sr-only">{r.spoken}</span>
          <div aria-hidden="true">
            <div className="flex flex-wrap items-baseline gap-x-2 text-xs">
              <span className="font-medium text-slate-700 dark:text-slate-200 truncate max-w-[9rem]">
                {r.name}
                {r.isMe && (
                  <span className="ml-1 px-1 py-px rounded bg-blue-100 dark:bg-blue-900/50 text-[10px] font-medium text-blue-700 dark:text-blue-300">you</span>
                )}
              </span>
              <span className="tabular-nums text-slate-600 dark:text-slate-300">{r.amount}</span>
              <span className={`ml-auto ${r.over ? "text-amber-700 dark:text-amber-400 font-medium" : "text-slate-500 dark:text-slate-400"}`}>{r.room}</span>
            </div>
            {r.hasTarget && (
              <div className="mt-0.5 h-1.5 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden flex">
                <div className={r.over ? "bg-amber-500" : "bg-emerald-600 dark:bg-emerald-500"} style={{ width: `${r.loggedPct}%` }} />
                <div className={r.over ? "bg-amber-300 dark:bg-amber-700" : "bg-emerald-300 dark:bg-emerald-800"} style={{ width: `${r.plannedPct}%` }} />
              </div>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
