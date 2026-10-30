// Helpers shared by more than one domain module. Moved verbatim from the old
// single-file assistant/tools.ts.

import { normalizeName } from "../../ingredients.ts";
import { type Weekday, isWeekday } from "../../routes/recurrence.ts";

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Both calendar.ts's create_recurring_event and chores.ts's create_chore take
// weekdays the way a person says them, not iCal's two-letter codes.
const DAY_NAME_TO_CODE: Record<string, Weekday> = {
  sunday: "SU", sun: "SU",
  monday: "MO", mon: "MO",
  tuesday: "TU", tue: "TU", tues: "TU",
  wednesday: "WE", wed: "WE",
  thursday: "TH", thu: "TH", thur: "TH", thurs: "TH",
  friday: "FR", fri: "FR",
  saturday: "SA", sat: "SA",
};

/** Accepts full/abbreviated day names or already-valid iCal codes; drops
 * anything unrecognized rather than throwing. */
export function toWeekdayCodes(days: unknown): Weekday[] {
  const list = Array.isArray(days) ? days : days ? [days] : [];
  return list
    .map((d) => (isWeekday(d) ? d : DAY_NAME_TO_CODE[String(d).trim().toLowerCase()]))
    .filter((d): d is Weekday => !!d);
}

/** Dates are ISO strings, so a YYYY-MM prefix is a month filter. */
export function inMonth(record: { date?: string }, month?: string): boolean {
  if (!month) return true;
  return typeof record.date === "string" && record.date.startsWith(month);
}

// Models refer to things the way people do ("the grocery list", "Sam"), not by
// id, so match on name first and fall back to an exact id.
//
// The substring fallback is right for READS ("Weekly Grocery" -> the Weekly Groceries list, "did you mean" hints) and
// wrong for WRITES that act on an existing item: add_pantry_item("flour") must not update "Almond flour", and a partial
// name must not delete or fill the first thing that happens to contain it. Those callers pass { exact: true }: same
// normalization (trim + lowercase), same id fallback, no substring. A miss then goes to notFound with suggestNames so
// the model can ask the person or retry with the exact name.
export function findByName<T extends { id: string; name: string }>(
  items: T[],
  nameOrId: string,
  opts: { exact?: boolean } = {}
): T | undefined {
  const needle = String(nameOrId).trim().toLowerCase();
  return (
    items.find((i) => i.name.toLowerCase() === needle) ||
    items.find((i) => i.id === nameOrId) ||
    (opts.exact ? undefined : items.find((i) => i.name.toLowerCase().includes(needle)))
  );
}

// Barcodes are exact codes, not names typed by a person -- no fuzzy matching
// here (that's what closestNames is for, once a name is in hand).
export function findByBarcode<T extends { barcode?: string }>(items: T[], barcode: string): T | undefined {
  const needle = String(barcode).trim();
  return items.find((i) => i.barcode === needle);
}

/** Free-text list of names the model may hand over as an array or as JSON text. */
export function cleanNames(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    const name = String(entry ?? "").trim();
    const key = normalizeName(name);
    if (!name || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

// Stage 5: structured "not found" errors, so a bad name gets the model a real
// list of near-misses to try instead of just a dead end it has to guess around.

export interface ToolError {
  error: string;
  hint?: string;
  validValues?: string[];
}

function levenshtein(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

/** Names within a distance proportional to their length -- close typos match,
 * unrelated names don't. Empty when nothing is close enough to suggest. */
export function closestNames<T extends { name: string }>(items: T[], nameOrId: string, limit = 3): string[] {
  const needle = String(nameOrId).trim().toLowerCase();
  if (!needle) return [];
  return items
    .map((i) => ({ name: i.name, dist: levenshtein(needle, i.name.toLowerCase()) }))
    .filter((s) => s.dist <= Math.max(2, Math.ceil(0.4 * Math.max(needle.length, s.name.length))))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, limit)
    .map((s) => s.name);
}

/** Suggestions for a write that found no exact match: names that contain what was asked for (or are contained in
 * it -- "flour" vs "Almond flour"), then the typo-close ones from closestNames. closestNames alone misses the partial
 * name case, which is exactly the one an exact-only write refuses. */
export function suggestNames<T extends { name: string }>(items: T[], nameOrId: string, limit = 3): string[] {
  const needle = String(nameOrId).trim().toLowerCase();
  if (!needle) return [];
  const partial = items
    .filter((i) => {
      const n = i.name.toLowerCase();
      return n.includes(needle) || needle.includes(n);
    })
    .map((i) => i.name);
  return [...new Set([...partial, ...closestNames(items, nameOrId, limit)])].slice(0, limit);
}

/** Builds a "not found" error, offering the closest real names when any are
 * close enough to suggest -- omitted (not forced) when nothing is close. */
export function notFound(kind: string, requested: string, candidates: string[]): ToolError {
  const base = { error: `No ${kind} named "${requested}".` };
  if (candidates.length === 0) return base;
  return {
    ...base,
    hint: `Did you mean ${candidates.map((c) => `"${c}"`).join(" or ")}?`,
    validValues: candidates,
  };
}
