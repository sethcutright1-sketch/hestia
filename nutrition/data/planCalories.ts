// The calorie view of the meal plan (merge plan decision 5 and section 2): for one week, each person who
// keeps a food diary, each day -- their CALORIE budget (calorie schedule applied), the snack allowance, what
// is planned and what is logged -- so a screen can show "planned + logged vs calorie budget" and the
// assistant can plan within it.
//
// Health data. Only logins that keep a diary can ask for it (the kiosk never reaches it: routes/nutrition.ts
// answers it 403). A viewer gets THEIR OWN numbers, plus those of any other login that shares "totals" or
// "everything" with them (visibility.ts -- the user's phase 5 decision: each person chooses what the other login
// may see of theirs, default Nothing, enforced by the server). The route works out who that is and passes it as
// `shared`; with no `shared`, only the viewer's own numbers come back. `everyone: true` is for server-side
// callers that need every tracker's calorie budget whatever they share, e.g. the assistant's weekly planning
// (phase 6 decision 1); never pass it from a route that answers one person. Nothing is written: a budget is
// computed with `persist: false`, so looking at a week doesn't freeze its days.
//
//   planned  entries that are still 'planned' (the plan's, and anything a person planned by hand)
//   logged   entries that are 'logged' -- what was eaten
//   target   calorie budget x (1 - snack allowance %) -- what planned meals aim at

import { addDays, mondayOf } from "../dates.ts";
import { round2 } from "../nutrients.ts";
import { resolveDayCalorieBudget } from "./days.ts";
import { parseJson } from "./input.ts";
import { planningTargetKcal, snackAllowanceKcal, snackAllowancePct } from "./snackAllowance.ts";
import { all, type Db } from "./sql.ts";
import { listTrackers, todayFor } from "./tracker.ts";

interface Row {
  local_date: string;
  status: "logged" | "planned";
  nutrients_total: string;
}

export function weekCalories(
  db: Db, viewerId: string, weekContaining: string, now: Date, opts: { everyone?: boolean; shared?: ReadonlySet<string> } = {},
) {
  const weekStart = mondayOf(weekContaining);
  const dates = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const trackers = listTrackers(db).filter((p) => opts.everyone === true || p.id === viewerId || opts.shared?.has(p.id) === true);
  const people = trackers.map((person) => {
    const today = todayFor(person, now);
    const pct = snackAllowancePct(db, person.id);
    const rows = all<Row>(db,
      `SELECT local_date, status, nutrients_total FROM nutrition_diary_entries
        WHERE user_id = ? AND local_date BETWEEN ? AND ? AND deleted_at IS NULL`,
      person.id, dates[0], dates[6]);
    const days = dates.map((date) => {
      const b = resolveDayCalorieBudget(db, person, date, today, { persist: false });
      const sum = (status: Row["status"]) =>
        round2(rows.filter((r) => r.local_date === date && r.status === status).reduce((a, r) => a + parseJson<{ kcal: number }>(r.nutrients_total).kcal, 0));
      const planned = sum("planned");
      const logged = sum("logged");
      const target = planningTargetKcal(b.calorieBudget, pct);
      return {
        date,
        calorieBudget: b.calorieBudget,
        snackAllowanceKcal: snackAllowanceKcal(b.calorieBudget, pct),
        planningTargetKcal: target,
        plannedKcal: planned,
        loggedKcal: logged,
        plannedPlusLoggedKcal: round2(planned + logged),
        // Room left under the planning target after both (negative = over); null without a calorie budget.
        roomKcal: target === null ? null : round2(target - planned - logged),
        missing: b.missing,
      };
    });
    return { userId: person.id, name: person.displayName, isMe: person.id === viewerId, snackAllowancePct: pct, days };
  });
  return { weekStart, dates, people };
}
