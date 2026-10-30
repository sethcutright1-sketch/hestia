// Local calendar dates ("YYYY-MM-DD") without ever touching toISOString().
//
// toISOString() is always UTC, so at 8 pm Eastern it already says tomorrow, which would
// file an evening snack under the wrong day. Everything in the nutrition code that means
// "today" goes through localDate(timezone) with the person's own timezone instead.
// (planWeek.ts keeps the same rule for the meal plan's weeks.)

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function localDate(timezone: string, at: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/**
 * Today's calendar date ("YYYY-MM-DD") in the SERVER's own timezone -- the household PC's clock, not UTC and not a
 * particular person's profile timezone. For things that belong to the household rather than to one person (the
 * assistant's "today", a manually added transaction's default date). Built from getFullYear/getMonth/getDate, which
 * read the machine's local time, where toISOString() would already say tomorrow after 8 pm Eastern.
 */
export function serverToday(at: Date = new Date()): string {
  const p = (x: number, w = 2) => String(x).padStart(w, "0");
  return `${p(at.getFullYear(), 4)}-${p(at.getMonth() + 1)}-${p(at.getDate())}`;
}

/** The server-local month ("YYYY-MM") of `at`: the same rule as serverToday(), for "this month". */
export function serverMonth(at: Date = new Date()): string {
  return serverToday(at).slice(0, 7);
}

export function isValidLocalDate(s: unknown): s is string {
  if (typeof s !== "string") return false;
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  // Round-trip catches 2026-02-30, which Date.UTC would silently roll to March.
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** Calendar-day arithmetic. Done in UTC on date-only values, so DST never shifts it. */
export function addDays(date: string, n: number): string {
  if (!isValidLocalDate(date)) throw new RangeError(`Not a local date: ${date}`);
  const m = DATE_RE.exec(date)!;
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + n));
  const p = (x: number, w = 2) => String(x).padStart(w, "0");
  return `${p(dt.getUTCFullYear(), 4)}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

/** Day of the week of a local date: 0 = Sunday ... 6 = Saturday (the calorie schedule's numbering). */
export function dayOfWeek(date: string): number {
  if (!isValidLocalDate(date)) throw new RangeError(`Not a local date: ${date}`);
  const m = DATE_RE.exec(date)!;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay();
}

/** The Monday on or before `date`: the household meal plan's weeks start there. */
export function mondayOf(date: string): string {
  return addDays(date, -((dayOfWeek(date) + 6) % 7));
}
