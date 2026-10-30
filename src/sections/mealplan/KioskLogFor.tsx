// "Log for: Alex · Bea": the kiosk's buttons on an approved plan meal (phase 5c). One tap marks that person's planned
// portion of this meal as eaten; each live button shows that portion's calories (5b.R4). kioskLog.ts has the rules.

import { chipLabel, type LogChip } from "./kioskLog.ts";

export default function KioskLogFor({ mealName, chips, isBusy, onLog }: {
  mealName: string;
  chips: LogChip[];
  isBusy: (userId: string) => boolean;
  onLog: (chip: LogChip) => void;
}) {
  if (chips.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <span className="text-xs text-slate-500 dark:text-slate-400">Log for:</span>
      {chips.map((c) => (
        <button
          key={c.userId}
          onClick={() => onLog(c)}
          disabled={c.done || isBusy(c.userId)}
          aria-label={c.done ? `${c.name} logged ${mealName}` : `Log ${mealName} for ${chipLabel(c.name, false, c.kcal)}`}
          className={`min-h-11 px-4 rounded-full text-sm font-medium border ${
            c.done
              ? "border-emerald-300 dark:border-emerald-800 bg-emerald-100 dark:bg-emerald-950/50 text-emerald-800 dark:text-emerald-300"
              : "border-blue-700 dark:border-blue-500 bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-60"
          }`}
        >
          {chipLabel(c.name, c.done, c.kcal)}
        </button>
      ))}
    </div>
  );
}
