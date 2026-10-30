// Date work for the diary, on "YYYY-MM-DD" local dates (the person's own calendar days, as the server
// sends them), never on instants: no toISOString(), no browser timezone. The arithmetic itself is the
// server's (nutrition/dates.ts); this adds what the screen needs around it. Wording is fixed English so a
// label reads the same on every phone and in the tests.

import { addDays, dayOfWeek, isValidLocalDate } from "../../../nutrition/dates.ts";

export { addDays, isValidLocalDate };

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** How many days back "Done logging" still accepts: today and the 7 before it. Mirrors DONE_WINDOW_DAYS on the server. */
export const DONE_WINDOW_DAYS = 7;

/** Previous / next day, one step at a time. */
export const stepDate = (date: string, dir: 1 | -1): string => addDays(date, dir);

/** "Today", "Yesterday", "Tomorrow", else the weekday. */
export function dayLabel(date: string, today: string): string {
  if (date === today) return "Today";
  if (date === addDays(today, -1)) return "Yesterday";
  if (date === addDays(today, 1)) return "Tomorrow";
  return WEEKDAYS[dayOfWeek(date)];
}

/** "Oct 15, 2026". */
export function longDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

/** "Oct 15": the day and month, for chart axes and short lists. */
export function shortDate(date: string): string {
  const [, m, d] = date.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}`;
}

/** Whole days from `a` to `b` (negative when `b` is earlier); date arithmetic only, so a daylight-saving change cannot add an hour. */
export const daysBetween = (a: string, b: string): number =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** "Today" / "Yesterday" / "Tomorrow", or "Monday, Oct 5": enough to tell last week's breakfast from this week's. */
export function whenLabel(date: string, today: string): string {
  const label = dayLabel(date, today);
  if (label === "Today" || label === "Yesterday" || label === "Tomorrow") return label;
  const [, m, d] = date.split("-").map(Number);
  return `${label}, ${MONTHS[m - 1]} ${d}`;
}

/** Can "Done logging" be tapped for this day? Today and the 7 days before, never a day that hasn't happened. */
export const canMarkDone = (date: string, today: string): boolean => date <= today && date >= addDays(today, -DONE_WINDOW_DAYS);

/** Anything added to a day after today is a plan, not a log (the server's rule). */
export const isFutureDay = (date: string, today: string): boolean => date > today;

/**
 * Can a PLANNED entry on this day be logged ("I ate it")? Only on or after its own day, everywhere: the diary's Log
 * and Log all, and the kiosk (user decision 2026-10-15; the server refuses it too). Today and past days: yes.
 */
export const canLogPlanned = (date: string, today: string): boolean => !isFutureDay(date, today);

/** What a future planned entry says in place of a Log button. */
export const LOG_ON_THE_DAY = "Log it on the day";
