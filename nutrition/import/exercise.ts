// Exercise: from exercise-logs.csv when its headers are recognized, otherwise one entry per day from the daily
// summary's "Exercise cals". Never both, or a day would count its workout twice.
//
// The real export stores the calories burned as NEGATIVE numbers (the parser makes them positive; skipping them,
// as the first importer did, lost 52 real workouts in the first dry run). Zero-calorie rows are real and import
// as 0. When the Units column says minutes, the duration is kept too (it is for the person's reference only;
// only calories change a day).
//
// Lose It!'s "Budget cals" EXCLUDES exercise (remaining = budget - food + exercise). That is also how this app's
// day summary adds exercise back, so the numbers line up. The real export confirms it: the summary's positive
// Exercise cals equals the (negated) exercise log on every day with a log.

import { round2 } from "../nutrients.ts";
import { kcalTolerance, normNum, sha256, type Ctx } from "./context.ts";
import { normText } from "./foods.ts";
import type { ImportReport } from "./types.ts";

type ExerciseReport = ImportReport["exercise"];

const blank = (mode: ExerciseReport["mode"]): ExerciseReport => ({
  mode, created: 0, alreadyImported: 0, updated: 0, deletedSince: 0, skippedByConflict: 0, mismatches: 0,
});

export function importExercise(ctx: Ctx): ExerciseReport {
  if (ctx.parsed.exercise) return fromLogs(ctx);
  if (ctx.parsed.summary) return fromSummary(ctx);
  return blank("none");
}

function fromLogs(ctx: Ctx): ExerciseReport {
  const { db, user, warnings, parsed } = ctx;
  const rep = blank("logs");
  const find = db.prepare("SELECT deleted_at FROM nutrition_exercise WHERE id = ?");
  const insert = db.prepare(
    "INSERT INTO nutrition_exercise (id, user_id, local_date, name, kcal, minutes, exclude_from_budget, source) VALUES (?, ?, ?, ?, ?, ?, 0, 'import_loseit')");
  const softDelete = db.prepare("UPDATE nutrition_exercise SET deleted_at = ? WHERE id = ?");
  const now = new Date().toISOString();
  const earlier = new Map<string, number>();
  const kcalByDate = new Map<string, number>();

  for (const r of parsed.exercise!) {
    // Same twin-stable scheme as the diary: identical rows are told apart by how many came before.
    const tuple = [user.id, r.date, normText(r.name), normNum(r.calories, 2)].join("|");
    const occurrence = earlier.get(tuple) ?? 0;
    earlier.set(tuple, occurrence + 1);
    if (!ctx.inWindow(r.date)) continue;
    if (ctx.skipped.has(r.date)) {
      if (!r.deleted) rep.skippedByConflict++;
      continue;
    }
    const id = `loseit-ex-${sha256(`${tuple}|${occurrence}`).slice(0, 24)}`;
    const prior = find.get(id) as unknown as { deleted_at: string | null } | undefined;

    if (r.deleted) {
      if (prior && !prior.deleted_at) {
        softDelete.run(now, id);
        rep.deletedSince++;
      }
      continue;
    }
    if (r.calories === null) {
      warnings.add(`${r.date} exercise "${r.name}": no calories, skipped`);
      continue;
    }
    kcalByDate.set(r.date, (kcalByDate.get(r.date) ?? 0) + r.calories);
    if (prior) {
      rep.alreadyImported++;
      continue;
    }
    insert.run(id, user.id, r.date, r.name.slice(0, 100), round2(r.calories), r.minutes);
    rep.created++;
  }

  // The summary's own Exercise cals is the cross-check that the columns were read correctly.
  for (const s of parsed.summary ?? []) {
    if (!ctx.inWindow(s.date) || ctx.skipped.has(s.date) || s.exerciseCals === null) continue;
    if (Math.abs((kcalByDate.get(s.date) ?? 0) - s.exerciseCals) > kcalTolerance(s.exerciseCals)) rep.mismatches++;
  }
  return rep;
}

function fromSummary(ctx: Ctx): ExerciseReport {
  const { db, user } = ctx;
  const rep = blank("summary");
  const find = db.prepare("SELECT kcal, deleted_at FROM nutrition_exercise WHERE id = ?");
  const insert = db.prepare(
    "INSERT INTO nutrition_exercise (id, user_id, local_date, name, kcal, exclude_from_budget, source) VALUES (?, ?, ?, 'Exercise (from Lose It!)', ?, 0, 'import_loseit')");
  const update = db.prepare("UPDATE nutrition_exercise SET kcal = ? WHERE id = ?");
  const softDelete = db.prepare("UPDATE nutrition_exercise SET deleted_at = ? WHERE id = ?");
  const now = new Date().toISOString();

  for (const s of ctx.parsed.summary!) {
    if (!ctx.inWindow(s.date)) continue;
    const kcal = s.exerciseCals !== null && s.exerciseCals > 0 ? round2(s.exerciseCals) : 0;
    if (ctx.skipped.has(s.date)) {
      if (kcal > 0) rep.skippedByConflict++;
      continue;
    }
    // One derived row per day, so it can follow the number: a later export of the same
    // day (the first one may have been taken mid-day) updates it rather than adding a second.
    const id = `loseit-exday-${user.id}-${s.date}`;
    const prior = find.get(id) as unknown as { kcal: number; deleted_at: string | null } | undefined;
    if (kcal > 0) {
      if (!prior) {
        insert.run(id, user.id, s.date, kcal);
        rep.created++;
      } else if (!prior.deleted_at && Math.abs(prior.kcal - kcal) > 0.005) {
        update.run(kcal, id);
        rep.updated++;
      } else {
        rep.alreadyImported++; // unchanged, or removed by the person here (not undone)
      }
    } else if (prior && !prior.deleted_at) {
      softDelete.run(now, id);
      rep.deletedSince++;
    }
  }
  return rep;
}
