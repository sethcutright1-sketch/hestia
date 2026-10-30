// The "lost so far" lines above the weight chart on the person's OWN Weight & progress tab (never on someone else's):
// "Lost 12.4 lb since Jan 3, 2026" with "18.6 lb to go to 175 lb" under it, or, with no start day set, a small link to
// the Food setting where it is set. The numbers and words are weightLoss.ts.

import type { LossSummary } from "./weightLoss.ts";
import { mutedCls } from "./ui.tsx";

interface Props {
  summary: LossSummary;
  /** Opens Food settings at the card that has "I started my weight loss on". */
  onSetStart: () => void;
}

export default function LossHeadline({ summary, onSetStart }: Props) {
  if (summary.kind === "unset") {
    return (
      <p className={`text-xs ${mutedCls}`}>
        <button type="button" onClick={onSetStart} className="text-blue-600 dark:text-blue-400 underline text-left">
          Set your start date to see how much you've lost
        </button>
      </p>
    );
  }
  if (summary.kind === "no-weigh-ins") return <p className={`text-sm ${mutedCls}`}>{summary.text}</p>;
  return (
    <div className="space-y-0.5" aria-live="polite">
      <p className="text-lg font-semibold text-slate-900 dark:text-slate-100 leading-snug">{summary.headline}</p>
      {summary.goalLine && (
        <p className={`text-sm ${summary.goalReached ? "font-medium text-emerald-700 dark:text-emerald-400" : "text-slate-700 dark:text-slate-300"}`}>{summary.goalLine}</p>
      )}
      {summary.note && <p className={`text-xs ${mutedCls}`}>{summary.note}</p>}
    </div>
  );
}
