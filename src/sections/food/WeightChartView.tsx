// The weight chart and the steps chart, drawn as plain inline SVG from the numbers in weightChart.ts and
// stepsChart.ts. No chart library. Used by both the person's own Weight & progress tab and the read-only
// view of someone who shares their weigh-ins.

import { buildStepsChart, stepsText, type DaySteps } from "./stepsChart.ts";
import { buildWeightChart, changeText } from "./weightChart.ts";
import { projectionText } from "./trendText.ts";
import type { TrendPoint, UnitSystem, WeightTrend } from "./types.ts";
import { formatWeight } from "./units.ts";
import { mutedCls } from "./ui.tsx";
import { RANGE_LABELS, RANGE_WORDS, WEIGHT_RANGES, rangeStart, type WeightRange } from "./weightRange.ts";

const LABEL = "fill-slate-500 dark:fill-slate-400";

/** 1M 3M 6M 1Y All, above the weight chart. Used for the person's own weigh-ins and for someone else's. */
export function RangeButtons({ value, onChange }: { value: WeightRange; onChange: (range: WeightRange) => void }) {
  return (
    <div role="group" aria-label="Chart range" className="grid grid-cols-5 gap-1.5">
      {WEIGHT_RANGES.map((r) => (
        <button
          key={r}
          type="button"
          aria-pressed={value === r}
          aria-label={`${RANGE_LABELS[r]}: ${RANGE_WORDS[r]}`}
          onClick={() => onChange(r)}
          className={`min-h-9 rounded-lg border text-xs font-medium ${
            value === r
              ? "bg-blue-600 border-blue-600 text-white"
              : "border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
          }`}
        >
          {RANGE_LABELS[r]}
        </button>
      ))}
    </div>
  );
}

interface WeightProps {
  points: TrendPoint[];
  trendKg: number | null;
  system: UnitSystem;
  /** Own view only: the goal weight, plan and projection. Left out for someone else's weigh-ins, so no goal line and no projection. */
  goal?: Pick<WeightTrend, "goalKg" | "planLbPerWeek" | "projection">;
  /** The chosen range and what to do when another button is tapped. The buttons show only when both are given. */
  range?: WeightRange;
  onRangeChange?: (range: WeightRange) => void;
  /** The person's own today (the axis runs to it). */
  today?: string;
  /** A different range is loading: the chart stays, a little faded. */
  busy?: boolean;
}

export function WeightChartView({ points, trendKg, system, goal, range, onRangeChange, today, busy }: WeightProps) {
  const chart = buildWeightChart(points, system, undefined, {
    rangeStart: range && today ? rangeStart(range, today) : undefined,
    today,
    goal: goal ? { goalKg: goal.goalKg, projection: goal.projection } : null,
  });
  const change = changeText(points, system);
  const sentence = goal ? projectionText({ trendKg, goalKg: goal.goalKg, planLbPerWeek: goal.planLbPerWeek, projection: goal.projection, system }) : "";
  return (
    <div className="space-y-2" aria-busy={busy ? true : undefined}>
      {range && onRangeChange && <RangeButtons value={range} onChange={onRangeChange} />}
      {!chart && range && (
        <p className={`text-sm ${mutedCls}`}>Fewer than two weigh-ins in {RANGE_WORDS[range]}. Try a longer range.</p>
      )}
      {chart && (
        <>
          <svg viewBox={`0 0 ${chart.width} ${chart.height}`} className={`w-full h-auto ${busy ? "opacity-60" : ""}`} role="img" aria-label={chart.description}>
            {chart.goalLine && (
              <line x1={chart.goalLine.x1} x2={chart.goalLine.x2} y1={chart.goalLine.y} y2={chart.goalLine.y} strokeWidth={1.5} strokeDasharray="6 4" className="stroke-emerald-600 dark:stroke-emerald-400" />
            )}
            <polyline points={chart.rawLine} fill="none" strokeWidth={1} className="stroke-slate-300 dark:stroke-slate-600" />
            {chart.dots.map((d) => (
              <circle key={d.date} cx={d.x} cy={d.y} r={2.5} className="fill-slate-400 dark:fill-slate-500" />
            ))}
            <polyline points={chart.trendLine} fill="none" strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" className="stroke-blue-600 dark:stroke-blue-400" />
            {chart.projection && (
              <line x1={chart.projection.x1} y1={chart.projection.y1} x2={chart.projection.x2} y2={chart.projection.y2} strokeWidth={2.5} strokeDasharray="0.1 6" strokeLinecap="round" className="stroke-blue-600 dark:stroke-blue-400" />
            )}
            <circle cx={chart.end.x} cy={chart.end.y} r={4} className="fill-blue-600 dark:fill-blue-400" />
            <text x={8} y={chart.top.y} fontSize={10} className={LABEL}>{chart.top.label}</text>
            <text x={8} y={chart.bottom.y} fontSize={10} className={LABEL}>{chart.bottom.label}</text>
            <text x={8} y={chart.height - 6} fontSize={10} className={LABEL}>{chart.startLabel}</text>
            <text x={chart.width - 8} y={chart.height - 6} fontSize={10} textAnchor="end" className={LABEL}>{chart.endLabel}</text>
            {chart.todayMark && (
              <>
                <line x1={chart.todayMark.x} x2={chart.todayMark.x} y1={chart.height - 20} y2={chart.height - 14} strokeWidth={1} className="stroke-slate-400 dark:stroke-slate-500" />
                <text x={chart.todayMark.x} y={chart.height - 6} fontSize={10} textAnchor="middle" className={LABEL}>{chart.todayMark.label}</text>
              </>
            )}
          </svg>
          <p className={`text-xs ${mutedCls}`}>
            <span aria-hidden="true" className="inline-block w-2 h-2 rounded-full bg-slate-400 dark:bg-slate-500 align-middle" /> weigh-in{" "}
            <span aria-hidden="true" className="inline-block w-4 h-0.5 bg-blue-600 dark:bg-blue-400 align-middle ml-2" /> trend
            {chart.goalLine && (
              <>
                <span aria-hidden="true" className="inline-block w-4 border-t-2 border-dashed border-emerald-600 dark:border-emerald-400 align-middle ml-2" /> goal {chart.goalLine.label}
              </>
            )}
            {chart.projection && (
              <>
                <span aria-hidden="true" className="inline-block w-4 border-t-2 border-dotted border-blue-600 dark:border-blue-400 align-middle ml-2" /> on plan
              </>
            )}
            {change && <span className="ml-2">· {change}</span>}
          </p>
          {chart.goalNote && <p className={`text-xs ${mutedCls}`}>{chart.goalNote}</p>}
        </>
      )}
      {trendKg !== null && (
        <p className="text-sm text-slate-900 dark:text-slate-100">
          Trend weight: <strong>{formatWeight(trendKg, system)}</strong>
        </p>
      )}
      {sentence && <p className={`text-sm ${mutedCls}`}>{sentence}</p>}
    </div>
  );
}

interface StepsProps {
  days: DaySteps[];
}

export function StepsChartView({ days }: StepsProps) {
  const chart = buildStepsChart(days);
  const total = days.filter((d) => d.steps !== null).length;
  return (
    <svg
      viewBox={`0 0 ${chart.width} ${chart.height}`}
      className="w-full h-auto"
      role="img"
      aria-label={`Steps for the last ${days.length} days; ${total} ${total === 1 ? "day has" : "days have"} steps entered; the most is ${stepsText(chart.max)}.`}
    >
      <line x1={0} x2={chart.width} y1={chart.baselineY} y2={chart.baselineY} strokeWidth={1} className="stroke-slate-300 dark:stroke-slate-700" />
      {chart.bars.map((b) =>
        b.steps === null || b.height === 0 ? null : (
          <rect key={b.date} x={b.x} y={b.y} width={b.width} height={b.height} rx={1.5} className="fill-emerald-500 dark:fill-emerald-400">
            <title>{`${b.date}: ${stepsText(b.steps)} steps`}</title>
          </rect>
        ),
      )}
      <text x={2} y={chart.height - 4} fontSize={10} className={LABEL}>{chart.startLabel}</text>
      <text x={chart.width - 2} y={chart.height - 4} fontSize={10} textAnchor="end" className={LABEL}>{chart.endLabel}</text>
      <text x={2} y={9} fontSize={10} className={LABEL}>{stepsText(chart.max)}</text>
    </svg>
  );
}
