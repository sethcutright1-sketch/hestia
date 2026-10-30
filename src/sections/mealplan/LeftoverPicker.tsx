// The leftover offer on a planned meal (phase 5c): how many servings are left over, and a chip for every free later
// lunch or dinner this week, the suggested one first. Tapping a chip adds "Leftover <dish>" there. It reads at 375px:
// the chips wrap, and each is a full-height touch target.

import { X } from "lucide-react";
import type { LeftoverOffer } from "../../api.ts";
import { choiceLabel, leftoverChoices, servingsLine } from "./leftovers.ts";

export default function LeftoverPicker({ mealName, offer, slotLabel, busy, onPick, onClose }: {
  mealName: string;
  offer: LeftoverOffer;
  slotLabel: (key: string) => string;
  busy?: boolean;
  onPick: (day: string, slot: string) => void;
  onClose: () => void;
}) {
  const choices = leftoverChoices(offer);
  return (
    <div className="mt-2 text-xs rounded-md bg-slate-100 dark:bg-slate-800 p-2 space-y-2">
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          {choices.length > 0 ? (
            <>
              <div className="font-medium text-slate-700 dark:text-slate-200">{servingsLine(offer)}</div>
              <div className="text-slate-500 dark:text-slate-400">Put the leftover {mealName} on:</div>
            </>
          ) : (
            <div className="text-slate-600 dark:text-slate-300">{offer.reason ?? "No leftovers to plan."}</div>
          )}
        </div>
        <button onClick={onClose} aria-label={`Close the leftovers offer for ${mealName}`} className="shrink-0 p-1 rounded text-slate-500 hover:bg-slate-200 dark:hover:bg-slate-700">
          <X size={14} />
        </button>
      </div>
      {choices.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {choices.map((c) => (
            <button
              key={`${c.day}|${c.slot}`}
              onClick={() => onPick(c.day, c.slot)}
              disabled={busy}
              aria-label={`Add leftovers on ${c.day} ${slotLabel(c.slot).toLowerCase()}`}
              className={`min-h-9 px-3 rounded-full text-sm border disabled:opacity-60 ${
                c.suggested
                  ? "border-blue-600 bg-blue-600 text-white font-medium"
                  : "border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700"
              }`}
            >
              {choiceLabel(c, slotLabel)}
              {c.suggested && <span className="ml-1 text-[10px] uppercase tracking-wide opacity-80">suggested</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
