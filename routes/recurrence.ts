// Weekly recurrence, shared by calendar events and chores (Stage 10, PLAN.md).
// Deliberately minimal: weekly-by-weekday only, no RFC5545 engine -- nothing
// in this app's own wishlist asks for monthly/yearly/every-N-days, and there
// was no existing recurrence precedent here to extend instead.

export type Weekday = "SU" | "MO" | "TU" | "WE" | "TH" | "FR" | "SA";
const WEEKDAYS: Weekday[] = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"]; // Date#getDay() order

export interface RecurrenceRule {
  freq: "weekly";
  byDay: Weekday[]; // at least one
  until?: string; // YYYY-MM-DD, inclusive. Omitted = open-ended (capped, see MAX_HORIZON_DAYS).
}

export function isWeekday(value: unknown): value is Weekday {
  return typeof value === "string" && (WEEKDAYS as string[]).includes(value);
}

export function isValidRecurrence(value: unknown): value is RecurrenceRule {
  if (!value || typeof value !== "object") return false;
  const r = value as { freq?: unknown; byDay?: unknown; until?: unknown };
  if (r.freq !== "weekly") return false;
  if (!Array.isArray(r.byDay) || r.byDay.length === 0 || !r.byDay.every(isWeekday)) return false;
  if (r.until !== undefined && (typeof r.until !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(r.until))) return false;
  return true;
}

// The server runs on the household PC in local time, not UTC -- using
// toISOString().slice(0, 10) here would flip to tomorrow's date a few hours
// early (e.g. after 8pm Eastern), same bug routes/budget.ts's
// normalizeStatementDate and the client's FamilyGrid.tsx already avoid with
// this same en-CA formatting, which happens to come out YYYY-MM-DD.
export function todayISO(): string {
  return new Date().toLocaleDateString("en-CA");
}

function addDaysISO(date: string, days: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function weekdayOf(date: string): Weekday {
  return WEEKDAYS[new Date(date + "T00:00:00Z").getUTCDay()];
}

// Plain string comparison is correct here because every date is the same
// YYYY-MM-DD shape -- lexicographic order matches calendar order.
function minISO(a: string, b: string): string { return a < b ? a : b; }
function maxISO(a: string, b: string): string { return a > b ? a : b; }

// Bounds how far an open-ended (no `until`) rule expands when the caller
// doesn't cap `to` either -- otherwise "every Monday, forever" would try to
// generate occurrences without end.
const MAX_HORIZON_DAYS = 180;

export interface Recurring {
  id: string;
  date: string;
  recurrence?: RecurrenceRule;
}

/** Recovers the master row's id from a synthetic occurrence id (`${id}::${date}`).
 * A plain (non-occurrence) id passes through unchanged. */
export function seriesIdOf(id: string): string {
  const sep = id.indexOf("::");
  return sep === -1 ? id : id.slice(0, sep);
}

/**
 * Expands stored rows into individual occurrences within [from, to]. A
 * non-recurring row passes through unchanged except for a uniform `seriesId`
 * (equal to its own id), filtered by [from, to] exactly as before this
 * existed -- both bounds stay optional so `listEvents(userId)` with neither
 * keeps returning every one-off event ever created, unchanged behavior.
 *
 * A recurring row's `date` is its series anchor: the earliest date it can
 * occur on, never earlier. Occurrences only need *some* bound to stay finite,
 * so -- and only for recurring rows -- an omitted `from`/`to` defaults to
 * "today through +180 days" rather than the unbounded range a one-off event
 * gets. Each occurrence gets a synthetic `${id}::${date}` id so `seriesIdOf`
 * can recover the master row for edits/deletes: this pass edits/deletes
 * whole series only, never a single occurrence (see PLAN.md Stage 10).
 */
export function expandOccurrences<T extends Recurring>(
  rows: T[],
  from?: string,
  to?: string
): (T & { seriesId: string })[] {
  const rangeStart = from || todayISO();
  const rangeEnd = to || addDaysISO(rangeStart, MAX_HORIZON_DAYS);

  return rows.flatMap((row): (T & { seriesId: string })[] => {
    if (!row.recurrence) {
      const inRange = (!from || row.date >= from) && (!to || row.date <= to);
      return inRange ? [{ ...row, seriesId: row.id }] : [];
    }

    const effectiveEnd = row.recurrence.until ? minISO(row.recurrence.until, rangeEnd) : rangeEnd;
    const occurrences: (T & { seriesId: string })[] = [];
    for (let d = maxISO(row.date, rangeStart); d <= effectiveEnd; d = addDaysISO(d, 1)) {
      if (row.recurrence.byDay.includes(weekdayOf(d))) {
        occurrences.push({ ...row, id: `${row.id}::${d}`, date: d, seriesId: row.id });
      }
    }
    return occurrences;
  });
}
