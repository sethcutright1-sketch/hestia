// The weight chart's range buttons: 1M, 3M, 6M, 1Y and All. The table of ranges (and how long each is) is the server's
// (nutrition/weightRange.ts); this adds the words on the buttons and remembering the choice on this device.
//
// The choice lives in localStorage, per device (not per login, not on the server). Browsers can refuse localStorage
// (a private window, blocked site data) or throw on the very access, so every read and write is wrapped and the
// chart simply opens on the default (1Y) when it cannot remember.

import { DEFAULT_WEIGHT_RANGE, WEIGHT_RANGES, isWeightRange, rangeStart, type WeightRange } from "../../../nutrition/weightRange.ts";

export { DEFAULT_WEIGHT_RANGE, WEIGHT_RANGES, isWeightRange, rangeStart };
export type { WeightRange };

/** What is printed on each button. */
export const RANGE_LABELS: Record<WeightRange, string> = { "1m": "1M", "3m": "3M", "6m": "6M", "1y": "1Y", all: "All" };

/** The range in words, for a screen reader and for "fewer than two weigh-ins in ...". */
export const RANGE_WORDS: Record<WeightRange, string> = {
  "1m": "the last month",
  "3m": "the last 3 months",
  "6m": "the last 6 months",
  "1y": "the last year",
  all: "your whole history",
};

export const RANGE_STORAGE_KEY = "household.food.weightRange";

export interface RangeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The browser's localStorage, or null when it is missing or refuses to be touched. */
function browserStorage(): RangeStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** The range this device last used; the default (1Y) when there is none, it is not one of the five, or storage fails. */
export function loadRange(storage: RangeStorage | null = browserStorage()): WeightRange {
  try {
    const v = storage?.getItem(RANGE_STORAGE_KEY);
    return isWeightRange(v) ? v : DEFAULT_WEIGHT_RANGE;
  } catch {
    return DEFAULT_WEIGHT_RANGE;
  }
}

/** Remember the range on this device. Never throws: not remembering is fine. */
export function saveRange(range: WeightRange, storage: RangeStorage | null = browserStorage()): void {
  try {
    storage?.setItem(RANGE_STORAGE_KEY, range);
  } catch {
    // The choice just lasts until the page closes.
  }
}
