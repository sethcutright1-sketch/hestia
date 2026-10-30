// Weight and height in the person's own units. The server stores kilograms and centimetres; a person
// types and reads pounds and feet/inches (imperial) or kilograms and centimetres (metric). Every
// conversion the Food section does is here, so it is tested without a browser (tests/foodUnits.test.ts).

import { KG_PER_LB } from "../../../nutrition/weightTrend.ts";
import type { Built } from "./forms.ts";
import type { UnitSystem } from "./types.ts";

export { KG_PER_LB };

const LB_PER_KG = 1 / KG_PER_LB;

export const round1 = (n: number): number => Math.round(n * 10) / 10;
export const round2 = (n: number): number => Math.round(n * 100) / 100;

export const kgToLb = (kg: number): number => kg * LB_PER_KG;
export const lbToKg = (lb: number): number => lb * KG_PER_LB;

export const weightUnit = (system: UnitSystem): "lb" | "kg" => (system === "imperial" ? "lb" : "kg");

/** A weight in kg as the person reads it: pounds or kilograms to one decimal place. */
export const displayWeight = (kg: number, system: UnitSystem): number => round1(system === "imperial" ? kgToLb(kg) : kg);

/** "183.3 lb" / "83.2 kg". */
export const formatWeight = (kg: number, system: UnitSystem): string => `${displayWeight(kg, system)} ${weightUnit(system)}`;

/** What a weigh-in may be, as the server accepts it (weightLb 44 to 1100, weightKg 20 to 500). */
export const WEIGHT_LIMITS: Record<UnitSystem, { min: number; max: number }> = {
  imperial: { min: 44, max: 1100 },
  metric: { min: 20, max: 500 },
};

/**
 * A typed weight as a request body for POST /weights. Pounds are sent as `weightLb` and kilograms as
 * `weightKg`, so the server does the one conversion and the stored number is exactly its own.
 */
export function weightBody(text: string, system: UnitSystem): Built<{ weightLb: number } | { weightKg: number }> {
  const { min, max } = WEIGHT_LIMITS[system];
  const unit = weightUnit(system);
  const n = Number(text.trim());
  if (text.trim() === "" || !Number.isFinite(n) || n < min || n > max) {
    return { ok: false, error: `Enter a weight between ${min} and ${max} ${unit}.` };
  }
  return { ok: true, body: system === "imperial" ? { weightLb: n } : { weightKg: n } };
}

/** A goal weight typed in the person's units, as kilograms rounded to the hundredth. Empty = none (null). */
export function goalWeightKg(text: string, system: UnitSystem): Built<number | null> {
  if (text.trim() === "") return { ok: true, body: null };
  const { min, max } = WEIGHT_LIMITS[system];
  const n = Number(text.trim());
  if (!Number.isFinite(n) || n < min || n > max) return { ok: false, error: `Goal weight must be between ${min} and ${max} ${weightUnit(system)}, or empty.` };
  return { ok: true, body: round2(system === "imperial" ? lbToKg(n) : n) };
}

// ---- height ------------------------------------------------------------------------------------

export function cmToFtIn(cm: number): { ft: number; inch: number } {
  const totalIn = cm / 2.54;
  let ft = Math.floor(totalIn / 12);
  let inch = round1(totalIn - ft * 12);
  if (inch >= 12) {
    ft += 1;
    inch = 0;
  }
  return { ft, inch };
}

export const ftInToCm = (ft: number, inch: number): number => round1((ft * 12 + inch) * 2.54);

/** The server's range for a height. */
export const HEIGHT_CM_LIMITS = { min: 50, max: 260 } as const;

/** The height boxes as text, for a height in cm. */
export function heightBoxes(cm: number | null): { ft: string; inch: string; cm: string } {
  if (cm === null) return { ft: "", inch: "", cm: "" };
  const { ft, inch } = cmToFtIn(cm);
  return { ft: String(ft), inch: String(inch), cm: String(round1(cm)) };
}

/** The height typed in the boxes for `system`, in centimetres. */
export function heightFromBoxes(system: UnitSystem, boxes: { ft: string; inch: string; cm: string }): Built<number> {
  const bad = { ok: false as const, error: "Enter your height." };
  let cm: number;
  if (system === "imperial") {
    if (boxes.ft.trim() === "") return bad;
    const ft = Number(boxes.ft);
    const inch = boxes.inch.trim() === "" ? 0 : Number(boxes.inch);
    if (!Number.isFinite(ft) || !Number.isFinite(inch) || ft < 0 || inch < 0) return bad;
    cm = ftInToCm(ft, inch);
  } else {
    if (boxes.cm.trim() === "") return bad;
    cm = Number(boxes.cm);
    if (!Number.isFinite(cm)) return bad;
  }
  if (cm < HEIGHT_CM_LIMITS.min || cm > HEIGHT_CM_LIMITS.max) {
    return { ok: false, error: system === "imperial" ? "Height must be between about 1 ft 8 in and 8 ft 6 in." : "Height must be between 50 and 260 cm." };
  }
  return { ok: true, body: cm };
}
