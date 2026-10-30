// steps.csv (Date|Value|Secondary Value|Last Updated) -> nutrition_steps with source = 'import_loseit'.
//
//   - Values like 9999.9 are rounded to whole steps.
//   - A day the person TYPED themselves (source = 'manual') is never overwritten (assumptions 5b.10): it is kept
//     and counted in `keptManual`.
//   - A day an earlier import brought in follows the file (a later export may carry the final number).
//   - Days after the person's today are ignored; days outside --from/--to are left out.
//   - Steps never change the calorie budget, and the diary-day conflict rule does not apply to them.

import { MAX_STEPS } from "../data/steps.ts";
import type { Ctx } from "./context.ts";
import type { ImportReport } from "./types.ts";

export function importSteps(ctx: Ctx): ImportReport["steps"] {
  const { db, user, o, warnings } = ctx;
  const rep: ImportReport["steps"] = { inFile: 0, created: 0, updated: 0, alreadyImported: 0, keptManual: 0, outsideRange: 0, future: 0, rejected: 0 };
  const rows = ctx.parsed.steps;
  if (!rows) return rep;

  // One value per date: if a date is listed twice the later row wins.
  const byDate = new Map<string, number>();
  for (const r of rows) byDate.set(r.date, r.steps);
  rep.inFile = byDate.size;

  const find = db.prepare("SELECT steps, source FROM nutrition_steps WHERE user_id = ? AND local_date = ?");
  const insert = db.prepare("INSERT INTO nutrition_steps (user_id, local_date, steps, source, updated_at) VALUES (?, ?, ?, 'import_loseit', ?)");
  const update = db.prepare("UPDATE nutrition_steps SET steps = ?, updated_at = ? WHERE user_id = ? AND local_date = ? AND source = 'import_loseit'");
  const now = new Date().toISOString();

  for (const [date, raw] of [...byDate].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!ctx.inWindow(date)) { rep.outsideRange++; continue; }
    if (date > o.today) { rep.future++; continue; }
    const steps = Math.round(raw);
    if (!(steps >= 0 && steps <= MAX_STEPS)) {
      warnings.add(`${date}: ${raw} steps is outside 0-${MAX_STEPS.toLocaleString("en-US")}, skipped`);
      rep.rejected++;
      continue;
    }
    const prior = find.get(user.id, date) as unknown as { steps: number; source: string } | undefined;
    if (!prior) {
      insert.run(user.id, date, steps, now);
      rep.created++;
    } else if (prior.source === "manual") {
      rep.keptManual++;
    } else if (prior.steps !== steps) {
      update.run(steps, now, user.id, date);
      rep.updated++;
    } else {
      rep.alreadyImported++;
    }
  }
  return rep;
}
