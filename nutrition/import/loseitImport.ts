// Imports a Lose It! full-account export into ONE login's own diary.
//
//   importLoseIt(db, user, exportContents, opts) -> ImportReport
//
// `user` is the signed-in login as a Tracker (an admin or parent, never the kiosk): the import always goes into
// that person's own diary, never someone else's. Everything happens in ONE transaction. A dry run is the real
// import followed by a rollback (a private sentinel thrown at the end), so the preview's numbers are exactly what
// a real run would produce, and a failure halfway leaves nothing behind either.
//
// Phases, in order (each in its own file): custom foods; food log -> diary entries, foods and meal slots; exercise;
// Lose It!'s daily calorie budgets; weights; "Done logging" days; steps; progress photos; reconciliation against the
// export's own daily totals; and the activity-multiplier comparison (never applied here unless the CLI's explicit
// --apply-calibration asked).
//
// Re-running is safe: every record the importer creates has a deterministic identity (import_hash on diary entries,
// derived ids on weights, exercise and photos, source_ref on foods, the date on steps and done days), so a second
// run of the same export creates nothing, and a final re-export at cutover only adds what's new.

import { isValidLocalDate } from "../dates.ts";
import { assertCanTrack, type Tracker } from "../data/access.ts";
import { NutritionError } from "../data/errors.ts";
import { ensureDefaultSlots } from "../data/slots.ts";
import { tx, type Db } from "../data/sql.ts";
import type { Scope } from "../data/foods.ts";
import { writeCalorieBudgets } from "./calorieBudgets.ts";
import { applyCalibration, calibrate } from "./calibration.ts";
import { Warnings, type Ctx, type ResolvedOptions } from "./context.ts";
import { importCustomFoods } from "./customFoods.ts";
import { importDiary } from "./diary.ts";
import { importDoneDays } from "./doneDays.ts";
import { importExercise } from "./exercise.ts";
import { FoodLibrary } from "./foods.ts";
import { parseExport, type ParsedExport } from "./loseitParse.ts";
import { importProgressPhotos } from "./progressPhotos.ts";
import { reconcile } from "./reconcile.ts";
import { importSteps } from "./steps.ts";
import type { ConflictMode, ImportOptions, ImportReport, WeightUnit } from "./types.ts";
import { importWeights } from "./weights.ts";
import type { ExportFiles, LoseItExport } from "./zip.ts";

export type { ImportOptions, ImportReport } from "./types.ts";

function resolveOptions(o: ImportOptions): ResolvedOptions {
  const date = (v: string | undefined, field: string): string | null => {
    if (v === undefined || v === "") return null;
    if (!isValidLocalDate(v)) throw new NutritionError(400, `${field} must be a date like 2026-03-31.`);
    return v;
  };
  if (!isValidLocalDate(o.today)) throw new NutritionError(400, "today must be a date like 2026-03-31.");
  const from = date(o.from, "from"), to = date(o.to, "to");
  if (from && to && from > to) throw new NutritionError(400, "from must not be after to.");
  // Callers (CLI flags, query strings) hand over plain strings: check them here, once.
  const choice = <T extends string>(v: T | undefined, field: string, allowed: readonly T[], fallback: T): T => {
    if (v === undefined) return fallback;
    if (!allowed.includes(v)) throw new NutritionError(400, `${field} must be one of ${allowed.join("|")}.`);
    return v;
  };
  return {
    dryRun: o.dryRun,
    today: o.today,
    conflict: choice<ConflictMode>(o.conflict, "conflict", ["skip", "merge", "replace"], "skip"),
    from, to,
    weightUnit: o.weightUnit === undefined ? null : choice<WeightUnit>(o.weightUnit, "weightUnit", ["lb", "kg"], "lb"),
    foodScope: choice<Scope>(o.foodScope, "foodScope", ["joint", "personal"], "joint"),
    applyCalibration: o.applyCalibration ?? false,
  };
}

/** Thrown at the end of a dry run to roll the transaction back; carries the report out. */
class DryRunRollback extends Error {
  constructor(readonly report: ImportReport) {
    super("dry run");
  }
}

const asExport = (e: LoseItExport | ExportFiles): LoseItExport =>
  e instanceof Map ? { files: e, photos: new Map(), ignoredImages: 0 } : e;

export function importLoseIt(db: Db, user: Tracker, contents: LoseItExport | ExportFiles, opts: ImportOptions): ImportReport {
  assertCanTrack(user); // the kiosk login never imports (and the table triggers would refuse it too)
  const o = resolveOptions(opts);
  const exp = asExport(contents);
  const parsed = parseExport(exp.files); // pure, and throws 400 for something that isn't a usable export before any write
  try {
    return tx(db, () => {
      const report = execute(db, user, parsed, exp, o);
      if (o.dryRun) throw new DryRunRollback(report);
      return report;
    });
  } catch (err) {
    if (err instanceof DryRunRollback) return err.report;
    throw err;
  }
}

function execute(db: Db, user: Tracker, parsed: ParsedExport, exp: LoseItExport, o: ResolvedOptions): ImportReport {
  const warnings = new Warnings();
  // Parse problems are warnings too. The parser keeps only its first messages, so top up the count.
  parsed.issues.messages.forEach((m) => warnings.add(m));
  warnings.total += parsed.issues.count - parsed.issues.messages.length;
  for (const f of parsed.inventory) {
    if (f.status === "not understood") warnings.add(`${f.name}: ${f.note}`);
  }

  // The four default meals, inside the transaction so a dry run leaves a brand-new login exactly as it was.
  ensureDefaultSlots(db, user.id);

  const ctx: Ctx = {
    db, user, o, parsed, photos: exp.photos, warnings,
    skipped: new Set(),
    inWindow: (d) => (o.from === null || d >= o.from) && (o.to === null || d <= o.to),
  };

  // Custom foods first, so the food log's rows for the same food find them. Two libraries keep the two counts apart.
  const customFoods = importCustomFoods(ctx, new FoodLibrary(db, user, o.foodScope, (m) => warnings.add(m)));
  const diary = importDiary(ctx, new FoodLibrary(db, user, o.foodScope, (m) => warnings.add(m)));
  const exercise = importExercise(ctx);
  const budgetSnapshots = writeCalorieBudgets(ctx);
  const weights = importWeights(ctx);
  const doneDays = importDoneDays(ctx);
  const steps = importSteps(ctx);
  const photos = importProgressPhotos(ctx);
  const reconciliation = reconcile(ctx);

  const calibration = calibrate(db, user, parsed.summary, { today: o.today, inWindow: ctx.inWindow, applyRequested: o.applyCalibration });
  if (o.applyCalibration) {
    if (calibration.status === "computed" && calibration.canApply) {
      applyCalibration(db, user, o.today, calibration.median);
      calibration.applied = true;
    }
  }

  return {
    dryRun: o.dryRun,
    options: {
      today: o.today, conflict: o.conflict, from: o.from, to: o.to, foodScope: o.foodScope, applyCalibration: o.applyCalibration,
    },
    files: parsed.inventory,
    ignoredImages: exp.ignoredImages,
    dateRange: diary.dateRange,
    counts: { ...diary.counts, warnings: warnings.total },
    foods: diary.foods,
    customFoods,
    customSlots: diary.customSlots,
    weights,
    exercise,
    doneDays,
    steps,
    photos,
    budgetSnapshots,
    conflicts: diary.conflicts,
    reconciliation,
    calibration,
    warnings: warnings.list,
  };
}
