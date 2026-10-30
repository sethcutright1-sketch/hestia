// Lose It!'s own daily CALORIE budgets (nothing to do with the household's money Budget), frozen into
// nutrition_day_logs so imported history shows the numbers you actually lived under rather than this app's
// re-derivation of them.
//
// Only PAST days (before the person's local today) get one: today and future days are always recomputed from the
// current goal, so a stored value would be overwritten anyway. maintenance_kcal_snapshot is left alone (the
// export has no such number); days.ts treats a past day with a budget snapshot as frozen even when maintenance
// is null.

import { get, run } from "../data/sql.ts";
import type { Ctx } from "./context.ts";
import type { ImportReport } from "./types.ts";

export function writeCalorieBudgets(ctx: Ctx): ImportReport["budgetSnapshots"] {
  const { db, user, o } = ctx;
  const out = { written: 0, unchanged: 0 };
  for (const s of ctx.parsed.summary ?? []) {
    if (s.date >= o.today || !ctx.inWindow(s.date) || ctx.skipped.has(s.date)) continue;
    // 0 or blank means "no budget that day" (e.g. before the account had a goal), not a budget of zero.
    if (s.budgetCals === null || !(s.budgetCals > 0)) continue;
    const cur = get<{ calorie_budget_kcal_snapshot: number | null }>(db,
      "SELECT calorie_budget_kcal_snapshot FROM nutrition_day_logs WHERE user_id = ? AND local_date = ?", user.id, s.date);
    if (cur?.calorie_budget_kcal_snapshot != null && Math.abs(cur.calorie_budget_kcal_snapshot - s.budgetCals) < 0.005) {
      out.unchanged++;
      continue;
    }
    run(db,
      `INSERT INTO nutrition_day_logs (user_id, local_date, calorie_budget_kcal_snapshot) VALUES (?, ?, ?)
       ON CONFLICT (user_id, local_date) DO UPDATE SET calorie_budget_kcal_snapshot = excluded.calorie_budget_kcal_snapshot`,
      user.id, s.date, s.budgetCals);
    out.written++;
  }
  return out;
}
