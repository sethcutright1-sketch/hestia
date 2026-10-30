// "Done logging" days from daily-values.csv (Date|Name|Value).
//
// A row with Name = Complete and a true Value (1) is a day the person finished logging in Lose It!. It sets the
// day's done flag the way POST /days/:date/done does -- nutrition_day_logs.done_logging_at, which the streak counts
// (loggingStreaks.ts) -- but WITHOUT markDayDone's checks (the 7-day window, "no planned entries left"): those are
// rules for tapping the button on a live day, not for history.
//
//   - A Complete row whose Value is 0 means the day was NOT completed: it is counted as such and not marked.
//   - A day already marked done here keeps its original time (the import never refreshes it).
//   - A day left alone by the conflict rule (skip) is not touched, like the rest of that day.
//   - A day after the person's today is ignored (a day that hasn't happened can't be done).
//   - RecordedWeightsResetDate rows are only noted in the report; nothing is done with them.

import { run } from "../data/sql.ts";
import type { Ctx } from "./context.ts";
import { parseDate, parseFlag } from "./loseitParse.ts";
import type { ImportReport } from "./types.ts";

export function importDoneDays(ctx: Ctx): ImportReport["doneDays"] {
  const { db, user, o } = ctx;
  const rep: ImportReport["doneDays"] = {
    inFile: 0, marked: 0, alreadyDone: 0, notComplete: 0, outsideRange: 0, skippedByConflict: 0, future: 0, weightsResetDates: [],
  };
  const rows = ctx.parsed.dailyValues;
  if (!rows) return rep;

  const find = db.prepare("SELECT done_logging_at FROM nutrition_day_logs WHERE user_id = ? AND local_date = ?");
  const now = new Date().toISOString();
  const seen = new Set<string>();

  for (const r of rows) {
    if (r.name.toLowerCase() === "recordedweightsresetdate") {
      // Its Value is a bare number in the real file (not a date); keep it as written, or as ISO if a future export writes a date.
      rep.weightsResetDates.push(parseDate(r.value) ?? (r.value.slice(0, 40) || r.date));
      continue;
    }
    if (r.name.toLowerCase() !== "complete") continue;
    if (!parseFlag(r.value)) {
      rep.notComplete++;
      continue;
    }
    if (seen.has(r.date)) continue; // the same day listed twice
    seen.add(r.date);
    rep.inFile++;
    if (!ctx.inWindow(r.date)) { rep.outsideRange++; continue; }
    if (r.date > o.today) { rep.future++; continue; }
    if (ctx.skipped.has(r.date)) { rep.skippedByConflict++; continue; }

    const prior = find.get(user.id, r.date) as unknown as { done_logging_at: string | null } | undefined;
    if (prior?.done_logging_at) {
      rep.alreadyDone++;
      continue;
    }
    run(db,
      `INSERT INTO nutrition_day_logs (user_id, local_date, done_logging_at) VALUES (?, ?, ?)
       ON CONFLICT (user_id, local_date) DO UPDATE SET done_logging_at = excluded.done_logging_at`,
      user.id, r.date, now);
    rep.marked++;
  }
  return rep;
}
