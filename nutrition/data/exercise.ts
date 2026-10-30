// The exercise log. Exercise adds to that day's CALORIE budget (the day summary's `exercise`
// figure, which raises "left") unless it is flagged "exclude from budget".
//
// A row is a name, optional minutes and the calories burned, all typed in by the person. Minutes
// are for their own reference; only the calories ever change a day. Everything is scoped to the
// signed-in person's own rows.

import crypto from "node:crypto";
import { assertCanTrack, type Tracker } from "./access.ts";
import { NutritionError } from "./errors.ts";
import { bodyObject, localDateField, optNumber, reqNumber, reqString } from "./input.ts";
import { all, get, run, type Db } from "./sql.ts";
import { todayFor } from "./tracker.ts";

interface ExerciseRow {
  id: string;
  local_date: string;
  name: string;
  kcal: number;
  minutes: number | null;
  exclude_from_budget: number;
  source: string;
}

const COLUMNS = "id, local_date, name, kcal, minutes, exclude_from_budget, source";

const exerciseJson = (r: ExerciseRow) => ({
  id: r.id, localDate: r.local_date, name: r.name, kcal: r.kcal, minutes: r.minutes, excludeFromBudget: r.exclude_from_budget === 1,
});

/** Minutes are optional; a blank (null) means "not entered". A day has 1,440 of them. */
const MAX_MINUTES = 1440;

export function listExercise(db: Db, user: Tracker, now: Date, date?: unknown) {
  const day = date === undefined ? todayFor(user, now) : localDateField(date, "date");
  return all<ExerciseRow>(db,
    `SELECT ${COLUMNS} FROM nutrition_exercise WHERE user_id = ? AND local_date = ? AND deleted_at IS NULL ORDER BY rowid`,
    user.id, day).map(exerciseJson);
}

export function addExercise(db: Db, user: Tracker, now: Date, input: unknown) {
  assertCanTrack(user);
  const b = bodyObject(input);
  const id = crypto.randomUUID();
  const date = b.localDate === undefined ? todayFor(user, now) : localDateField(b.localDate, "localDate");
  const kcal = reqNumber(b, "kcal", 0, 20_000);
  const name = reqString(b, "name", 100);
  const minutes = optNumber(b, "minutes", 0, MAX_MINUTES);
  const exclude = b.excludeFromBudget === true;
  run(db, "INSERT INTO nutrition_exercise (id, user_id, local_date, name, kcal, minutes, exclude_from_budget, source) VALUES (?, ?, ?, ?, ?, ?, ?, 'manual')",
    id, user.id, date, name, kcal, minutes, exclude ? 1 : 0);
  return { id, localDate: date, name, kcal, minutes, excludeFromBudget: exclude };
}

/**
 * Edit one of the person's own exercise rows: only the fields present change. `minutes: null`
 * clears it. The day it sits on is not editable (delete and add again), which keeps every
 * day's frozen figures easy to reason about.
 */
export function updateExercise(db: Db, user: Tracker, id: string, input: unknown) {
  assertCanTrack(user);
  const b = bodyObject(input);
  const cur = get<ExerciseRow>(db,
    `SELECT ${COLUMNS} FROM nutrition_exercise WHERE id = ? AND user_id = ? AND deleted_at IS NULL`, id, user.id);
  if (!cur) throw new NutritionError(404, "Exercise entry not found.");
  const next = {
    name: b.name === undefined ? cur.name : reqString(b, "name", 100),
    kcal: b.kcal === undefined ? cur.kcal : reqNumber(b, "kcal", 0, 20_000),
    minutes: b.minutes === undefined ? cur.minutes : optNumber(b, "minutes", 0, MAX_MINUTES),
    exclude: b.excludeFromBudget === undefined ? cur.exclude_from_budget === 1 : b.excludeFromBudget === true,
  };
  run(db, "UPDATE nutrition_exercise SET name = ?, kcal = ?, minutes = ?, exclude_from_budget = ? WHERE id = ? AND user_id = ?",
    next.name, next.kcal, next.minutes, next.exclude ? 1 : 0, cur.id, user.id);
  return exerciseJson({ ...cur, name: next.name, kcal: next.kcal, minutes: next.minutes, exclude_from_budget: next.exclude ? 1 : 0 });
}

export function deleteExercise(db: Db, user: Tracker, id: string): void {
  const r = run(db, "UPDATE nutrition_exercise SET deleted_at = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
    new Date().toISOString(), id, user.id);
  if (!r.changes) throw new NutritionError(404, "Exercise entry not found.");
}

/**
 * "Recent exercises" for one-tap repeat: this person's own distinct (name, minutes, calories)
 * combinations, newest first. Same name with different minutes or calories counts as different, because
 * "Run 30 min 300 kcal" and "Run 60 min 600 kcal" are two things worth repeating. Only the signed-in
 * person's rows are ever read.
 */
export function recentExercise(db: Db, user: Tracker, limit?: unknown) {
  const max = Math.min(30, Math.max(1, Math.trunc(Number(limit)) || 8));
  return all<ExerciseRow>(db,
    `SELECT ${COLUMNS} FROM nutrition_exercise
      WHERE user_id = ? AND deleted_at IS NULL
        AND rowid IN (SELECT MAX(rowid) FROM nutrition_exercise WHERE user_id = ? AND deleted_at IS NULL
                       GROUP BY lower(name), COALESCE(minutes, -1), kcal)
      ORDER BY rowid DESC LIMIT ?`,
    user.id, user.id, max).map(exerciseJson);
}
