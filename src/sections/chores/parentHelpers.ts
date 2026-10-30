// Pure helpers for the Parent side of the Chores tab (Phase 3, PLAN.md) --
// kept dependency-free (no React, no DOM) so they can be unit tested directly
// under tests/, the same reasoning as routes/recurrence.ts's pure functions.
// Every date-shaped function below uses the LOCAL calendar day
// (`toLocaleDateString("en-CA")`), never `new Date().toISOString()`'s UTC
// day -- the same rule KidView.tsx and FamilyGrid.tsx already follow, so
// "today" never drifts a day off for someone west of UTC.

import type { Chore, HouseholdMember, RecurrenceRule, Weekday } from "../../api.ts";

export function todayISO(): string {
  return new Date().toLocaleDateString("en-CA");
}

export function addDaysISO(date: string, days: number): string {
  const d = new Date(date + "T00:00:00");
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString("en-CA");
}

// Sunday-first, matching FamilyGrid.tsx's week convention (the same grid
// Panel 2's "This week" overview mirrors).
export function startOfWeek(date: string): string {
  const d = new Date(date + "T00:00:00");
  return addDaysISO(date, -d.getDay());
}

// Mirrors routes/members.ts's isParentMember on the client -- unset counts as
// "kid", same convention KidView.tsx's local isKidMember already duplicates
// rather than importing a backend module into the frontend bundle.
export function isParentMember(member: Pick<HouseholdMember, "role">): boolean {
  return member.role === "parent";
}

export type OccurrenceMark = "✓" | "⏳" | "✗" | "○";

/** One occurrence's mark in Panel 2's weekly grid:
 *  - ✓ approved
 *  - ⏳ done, waiting on a parent
 *  - ✗ missed -- still pending, and its date is strictly before `today`
 *  - ○ upcoming, or pending today
 * `today` is passed in (rather than computed here) so callers share one
 * `todayISO()` call per render instead of the grid re-deriving it per cell. */
export function occurrenceMark(
  chore: Pick<Chore, "date" | "status" | "approval">,
  today: string
): OccurrenceMark {
  if (chore.approval === "approved") return "✓";
  if (chore.approval === "waiting") return "⏳";
  if (chore.status === "pending" && chore.date < today) return "✗";
  return "○";
}

const DAY_LABELS: Record<Weekday, string> = {
  SU: "Sun", MO: "Mon", TU: "Tue", WE: "Wed", TH: "Thu", FR: "Fri", SA: "Sat",
};
const DAY_ORDER: Weekday[] = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

/** Panel 3's repeat summary: "Mon, Wed, Fri" for a weekly series, or
 * "One-off Sep 25" for a single chore -- always in week order regardless of
 * how `byDay` was stored. */
export function formatRepeatSummary(chore: { recurrence?: RecurrenceRule; date: string }): string {
  if (!chore.recurrence) {
    const d = new Date(chore.date + "T00:00:00");
    return `One-off ${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
  }
  return [...chore.recurrence.byDay]
    .sort((a, b) => DAY_ORDER.indexOf(a) - DAY_ORDER.indexOf(b))
    .map((d) => DAY_LABELS[d])
    .join(", ");
}
