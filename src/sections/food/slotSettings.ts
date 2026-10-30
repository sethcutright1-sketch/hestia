// Food settings > Meals and Snack allowance: the pure parts. A meal's key never changes when it is renamed (so
// entries, saved meals and plan rows keep pointing at it); a switched-off meal keeps showing its old entries and
// takes no new food; at least one meal stays on. A meal's target is a number of calories OR a share of the day's
// calorie budget. Ported from the calorie app's meal-targets.js; tested in tests/foodSettingsForms.test.ts.

import { kcalText } from "./calories.ts";
import type { Built } from "./forms.ts";
import type { SettingsSlot } from "./types.ts";

export type TargetKind = "none" | "kcal" | "pct";

export const TARGET_KINDS: Array<[TargetKind, string]> = [
  ["none", "No target"],
  ["kcal", "A number of calories"],
  ["pct", "A share of my calorie budget"],
];

export const targetKindOf = (s: Pick<SettingsSlot, "targetKcal" | "targetPct">): TargetKind =>
  s.targetKcal != null ? "kcal" : s.targetPct != null ? "pct" : "none";

/** How the meal list describes a target. */
export function targetSummary(s: Pick<SettingsSlot, "targetKcal" | "targetPct">): string {
  if (s.targetKcal != null) return `Target ${kcalText(s.targetKcal)} kcal`;
  if (s.targetPct != null) return `Target ${Math.round(s.targetPct * 100) / 100}% of your calorie budget`;
  return "No target";
}

/** Move the meal at `index` up (-1) or down (+1); the same list at the ends. Returns the new key order. */
export function moveKey(keys: string[], index: number, dir: 1 | -1): string[] {
  const to = index + dir;
  if (index < 0 || index >= keys.length || to < 0 || to >= keys.length) return keys;
  const next = keys.slice();
  [next[index], next[to]] = [next[to], next[index]];
  return next;
}

/** The target fields to send from the form: a kind and a typed value. Setting one kind clears the other server-side. */
export function targetBody(kind: TargetKind, text: string): Built<{ targetKcal: number | null; targetPct: number | null }> {
  if (kind === "none") return { ok: true, body: { targetKcal: null, targetPct: null } };
  const n = text.trim() === "" ? NaN : Number(text);
  if (kind === "kcal") {
    return Number.isFinite(n) && n >= 1 && n <= 10_000
      ? { ok: true, body: { targetKcal: n, targetPct: null } }
      : { ok: false, error: "Enter calories between 1 and 10,000." };
  }
  return Number.isFinite(n) && n >= 1 && n <= 100
    ? { ok: true, body: { targetKcal: null, targetPct: n } }
    : { ok: false, error: "Enter a percentage between 1 and 100." };
}

/** Is this the only meal still switched on? Then it can't be switched off (the server refuses too). */
export const isLastEnabled = (slots: Array<Pick<SettingsSlot, "key" | "enabled">>, key: string): boolean =>
  slots.filter((s) => s.enabled).length === 1 && slots.some((s) => s.key === key && s.enabled);

/** The most meals a person can have (the server's limit). */
export const MAX_MEALS = 20;

export function mealBody(label: string): Built<{ label: string }> {
  const t = label.trim();
  if (t === "") return { ok: false, error: "Give the meal a name." };
  if (t.length > 40) return { ok: false, error: "A meal's name can be at most 40 characters." };
  return { ok: true, body: { label: t } };
}

export function snackBody(text: string, min: number, max: number): Built<{ snackAllowancePct: number }> {
  const n = text.trim() === "" ? NaN : Number(text);
  if (!Number.isFinite(n) || n < min || n > max) return { ok: false, error: `Enter a percentage from ${min} to ${max}.` };
  return { ok: true, body: { snackAllowancePct: n } };
}
