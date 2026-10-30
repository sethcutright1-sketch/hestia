// The numbers and wording of the diary's top card and meal cards. All CALORIE figures: the grocery
// money budget is a different thing and appears nowhere in this folder.
//
// The server's day summary already has everything: calorieBudget, eaten, exercise (the burned
// calories that are added back to the day's calorie budget) and remaining (= calorie budget - food +
// exercise). This only decides how to word it. Over the calorie budget reads "150 over", never a
// negative "left".

import type { DaySlot, DaySummary, Nutrients } from "./types.ts";

/** "1,240": whole kcal with thousands separators, in fixed US form so a sentence reads the same everywhere. */
export const kcalText = (n: number): string => Math.round(n).toLocaleString("en-US");

const MINUS = "−";

export const MISSING_LABELS: Record<DaySummary["missing"][number], string> = {
  profile: "a profile (sex, birth date, height)",
  goal: "a weight goal",
  weight: "a weigh-in",
};

export interface SummaryView {
  /** false when the day has no calorie budget (see `missing`). */
  hasBudget: boolean;
  /** "1,240" / "150" / "980": the big number. */
  big: string;
  /** "left" / "over" / "eaten": what it counts. */
  bigLabel: "left" | "over" | "eaten";
  over: boolean;
  /** "2,100 calorie budget - 980 food + 120 exercise"; null when there is no calorie budget. */
  equation: string | null;
  /** 0 to 1: how much of (calorie budget + exercise) is eaten. */
  fraction: number;
  /** For screen readers: "1,240 calories left". */
  spoken: string;
  /** Said when the calorie budget can't be worked out yet: what is missing. */
  missingNote: string | null;
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** What the top card needs: the full day summary, or just the numbers another person shares at "Daily totals" (no `missing`). */
export type SummaryInput = Pick<DaySummary, "calorieBudget" | "remaining" | "eaten" | "exercise"> & { missing?: DaySummary["missing"] };

export function summaryView(s: SummaryInput): SummaryView {
  if (s.calorieBudget === null || s.remaining === null) {
    const needs = (s.missing ?? []).map((m) => MISSING_LABELS[m]);
    return {
      hasBudget: false,
      big: kcalText(s.eaten),
      bigLabel: "eaten",
      over: false,
      equation: null,
      fraction: 0,
      spoken: `${kcalText(s.eaten)} calories eaten`,
      missingNote: needs.length
        ? `Your calorie budget can't be worked out yet. It needs ${joinList(needs)}.`
        : "Your calorie budget can't be worked out yet.",
    };
  }
  const rounded = Math.round(s.remaining);
  const over = rounded < 0;
  const allowance = s.calorieBudget + s.exercise;
  return {
    hasBudget: true,
    big: kcalText(Math.abs(rounded)),
    bigLabel: over ? "over" : "left",
    over,
    equation: `${kcalText(s.calorieBudget)} calorie budget ${MINUS} ${kcalText(s.eaten)} food + ${kcalText(s.exercise)} exercise`,
    fraction: allowance > 0 ? Math.min(1, Math.max(0, s.eaten / allowance)) : s.eaten > 0 ? 1 : 0,
    spoken: `${kcalText(Math.abs(rounded))} calories ${over ? "over" : "left"}`,
    missingNote: null,
  };
}

export interface MacroRow {
  key: "protein" | "carbs" | "fat";
  label: string;
  eaten: number;
  goal: number | null;
  /** 0 to 1; 0 when there is no goal. */
  fraction: number;
  text: string;
}

const MACRO_LABELS: Array<[MacroRow["key"], string]> = [["protein", "Protein"], ["carbs", "Carbs"], ["fat", "Fat"]];

/** The three macro rows shown when the top card is expanded. */
export function macroRows(s: Pick<DaySummary, "macros">): MacroRow[] {
  return MACRO_LABELS.map(([key, label]) => {
    const { eaten, goal } = s.macros[key];
    return {
      key,
      label,
      eaten,
      goal,
      fraction: goal ? Math.min(1, Math.max(0, eaten / goal)) : 0,
      text: `${Math.round(eaten)}${goal ? ` / ${Math.round(goal)}` : ""} g`,
    };
  });
}

export interface SlotView {
  /** kcal logged in this meal. */
  eaten: number;
  target: number | null;
  /** More logged than the meal's target. Never true without a target. */
  over: boolean;
  /** kcal left in the target (negative when over); null without a target. */
  remaining: number | null;
  /** "320 / 500 kcal" with a target, "320 kcal" without. */
  text: string;
  /** Hover / screen-reader text; null without a target. */
  detail: string | null;
}

export function slotView(slot: Pick<DaySlot, "kcal" | "targetKcal">): SlotView {
  const eaten = slot.kcal ?? 0;
  const target = slot.targetKcal ?? null;
  if (target === null) return { eaten, target: null, over: false, remaining: null, text: `${kcalText(eaten)} kcal`, detail: null };
  const remaining = Math.round(target - eaten);
  const over = eaten > target;
  return {
    eaten,
    target,
    over,
    remaining,
    text: `${kcalText(eaten)} / ${kcalText(target)} kcal`,
    detail: over ? `${kcalText(-remaining)} kcal over this meal's target` : `${kcalText(remaining)} kcal left in this meal's target`,
  };
}

/** Planned entries don't count until logged; this says how many are waiting. */
export const plannedNote = (s: Pick<DaySummary, "plannedCount" | "plannedKcal">): string | null =>
  s.plannedCount > 0 ? `${s.plannedCount} planned (${kcalText(s.plannedKcal)} kcal) not counted until logged.` : null;

export const streakText = (n: number): string => `${n}-day streak`;

/** The toast after Done logging. */
export const doneToast = (streak: { current: number } | null | undefined): string =>
  streak && streak.current > 0 ? `Day done. ${streakText(streak.current)}.` : "Day done.";

const round2 = (n: number) => Math.round(n * 100) / 100;

/** "150 g", "2 x 1 bar", "1 cup (80 g)": avoids "1 1 cup" when the unit label already starts with a count. */
export function amountText(quantity: number, unit: string): string {
  const q = round2(quantity);
  if (/^\d/.test(unit)) return q === 1 ? unit : `${q} x ${unit}`;
  return `${q} ${unit}`;
}

/** One line of nutrients for a preview: "P 12g  C 30g  F 5g". */
export const macroLine = (n: Nutrients): string => `P ${round2(n.protein)}g  C ${round2(n.carbs)}g  F ${round2(n.fat)}g`;
