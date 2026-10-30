// Does what we read add up to what Lose It! says? Each day's `Food cals` in the daily summary is Lose It!'s own
// total, so the food-log rows must add up to it. A day that doesn't (beyond max(2 kcal, 1%)) usually means a
// parser mistake: a misread column, a comma inside a name, a unit mix-up.
//
// Two sums are compared to that total:
//   - the food-log rows as read from the file (catches parser errors), and
//   - what the diary now holds from imports for that day (also catches the one thing the hashes can't: an entry
//     EDITED in Lose It! after an earlier import comes through as a new entry beside the old one, because its
//     quantity and calories changed).
// Days left alone because of a conflict only get the first check.

import { round2 } from "../nutrients.ts";
import { all } from "../data/sql.ts";
import { kcalTolerance, type Ctx } from "./context.ts";
import type { ImportReport } from "./types.ts";

const LISTED = 15;

export function reconcile(ctx: Ctx): ImportReport["reconciliation"] {
  const out: ImportReport["reconciliation"] = { compared: 0, mismatches: 0, first: [] };
  const summary = ctx.parsed.summary;
  if (!summary) return out;

  const fileKcal = new Map<string, number>();
  for (const r of ctx.parsed.foodLog) {
    if (r.deleted || !ctx.inWindow(r.date)) continue;
    fileKcal.set(r.date, (fileKcal.get(r.date) ?? 0) + (r.calories ?? 0));
  }
  const diaryKcal = new Map(
    all<{ local_date: string; kcal: number }>(ctx.db,
      `SELECT local_date, SUM(json_extract(nutrients_total, '$.kcal')) AS kcal FROM nutrition_diary_entries
        WHERE user_id = ? AND deleted_at IS NULL AND status = 'logged' AND source = 'import_loseit' GROUP BY local_date`,
      ctx.user.id).map((r) => [r.local_date, r.kcal] as const));

  for (const s of [...summary].sort((a, b) => (a.date < b.date ? -1 : 1))) {
    if (s.foodCals === null || !ctx.inWindow(s.date)) continue;
    out.compared++;
    const off = (kcal: number) => Math.abs(kcal - s.foodCals!) > kcalTolerance(s.foodCals!);
    const file = round2(fileKcal.get(s.date) ?? 0);
    const diary = ctx.skipped.has(s.date) ? null : round2(diaryKcal.get(s.date) ?? 0);
    if (!off(file) && (diary === null || !off(diary))) continue;
    out.mismatches++;
    if (out.first.length < LISTED) out.first.push({ date: s.date, summaryKcal: s.foodCals, fileKcal: file, diaryKcal: diary });
  }
  return out;
}
