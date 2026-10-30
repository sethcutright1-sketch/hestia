// The decisions the Scan tab makes, with no DOM or network in them so node:test can check each one:
// is this code even a barcode, is it an in-store label, what did the lookup's answer mean, and which words
// to look for among your own foods. Ported from the calorie app's scan-logic.js; the barcode rules
// themselves are the server's (nutrition/barcode.ts), imported rather than copied, so the camera and the
// API can never disagree about what a valid code is.

import { canonicalGtin, isRandomWeight } from "../../../nutrition/barcode.ts";
import type { BarcodeLookupInfo } from "./types.ts";

export type CodeCheck =
  | { kind: "invalid" }
  /** An in-store price/weight label (UPC-A starting 2, EAN-13 starting 02): never looked up. */
  | { kind: "label"; gtin14: string }
  | { kind: "ok"; gtin14: string };

/** What a code read from the camera, or typed, is, before anything is asked of the server. */
export function checkCode(raw: string, format?: string): CodeCheck {
  const canon = canonicalGtin(raw, format);
  if (!canon) return { kind: "invalid" };
  if (isRandomWeight(canon.gtin14)) return { kind: "label", gtin14: canon.gtin14 };
  return { kind: "ok", gtin14: canon.gtin14 };
}

/** The camera loop's filter: only a valid barcode ends a scan. A misread frame is ignored and the camera keeps looking. */
export const isScannableRead = (raw: string, format?: string): boolean => canonicalGtin(raw, format) !== null;

/** The shortest form the number is printed in (UPC-A 12, EAN-13 13, EAN-8 8), for people to read and for pre-filling the barcode box. */
export function displayCode(gtin14: string): string {
  const lengths = [14, 13, 12, 8].filter((len) => /^0*$/.test(gtin14.slice(0, 14 - len)));
  return gtin14.slice(14 - Math.min(...lengths));
}

export type LookupOutcome =
  /** 200 / 201: a food (already yours, or just made from a database). */
  | "food"
  /** 404: the databases answered and have no nutrition for it. */
  | "miss"
  /** 503 with `unavailable`: a database couldn't be reached. NOT the same as "not found". */
  | "unavailable"
  /** 422 with `randomWeight`: an in-store label. */
  | "label"
  /** 400: not a barcode. */
  | "invalid"
  /** No answer at all: no network, or the server is down. */
  | "network"
  | "error";

/**
 * Turn POST /barcodes/lookup's answer into one of the screens the scan tab shows. `status` is null when the
 * request never got an answer (the fetch itself failed).
 */
export function lookupOutcome(res: { status: number; body?: any } | null): LookupOutcome {
  if (!res) return "network";
  const { status, body } = res;
  if (status >= 200 && status < 300) return "food";
  if (status === 404) return "miss";
  if (status === 422 && body?.randomWeight) return "label";
  if (status === 400) return "invalid";
  if (status === 503 && body?.unavailable) return "unavailable";
  return "error";
}

const UNIT_WORDS = new Set(["oz", "fl", "lb", "lbs", "g", "kg", "ml", "l", "ct", "pk", "pack", "count", "pcs", "each"]);

/**
 * The words to look for among your own foods. A database's product name carries sizes and counts
 * ("Cheerios Cereal 18 oz") that a food you logged years ago won't, and they would only pull in unrelated
 * matches, so pure numbers and unit words are dropped.
 */
export function candidateQuery(info: { name?: string | null; brand?: string | null } = {}): string {
  const source = (info.name && info.name.trim()) || (info.brand && info.brand.trim()) || "";
  return source
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w && !/^\d+([.,]\d+)?$/.test(w) && !UNIT_WORDS.has(w.toLowerCase()))
    .slice(0, 6)
    .join(" ");
}

/** What to pre-fill in Create food after a scan that found no nutrition: whatever name the databases did know, and the code as printed. */
export function createPrefill(gtin14: string, info: Partial<BarcodeLookupInfo> | null | undefined): { name: string; brand: string; barcode: string } {
  return { name: info?.name ?? "", brand: info?.brand ?? "", barcode: displayCode(gtin14) };
}

/** Typed digits: keep only the digits (a pasted code may carry spaces or dashes). */
export const digitsOnly = (text: string): string => text.replace(/\D/g, "");
