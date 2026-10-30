// weights.csv -> nutrition_weights.
//
// The real weights.csv has a bare `Weight` column (no unit in the header), and profile.csv has no unit setting
// either, so the unit is resolved in order: the caller's explicit choice, a unit the file itself names (a
// "Weight (kg)" header, or a unit setting in profile.csv), then THIS LOGIN'S own unit system (the unitSystem on
// their nutrition profile; a login with no profile yet counts as imperial, the profile's own default). The
// report says which one decided, and shows the first and last weight after conversion so a wrong guess is
// obvious.
//
// Entry ids are deterministic: loseit-w-<user>-<date>-<hash of the value as written>. A re-import of the same
// file finds them; a re-import with a CORRECTED unit finds them too and updates the stored kilograms in place
// instead of leaving the wrong ones behind.

import { round2 } from "../nutrients.ts";
import { KG_PER_LB } from "../weightTrend.ts";
import { sha256, type Ctx } from "./context.ts";
import type { ImportReport, WeightUnit } from "./types.ts";

const MIN_KG = 20;
const MAX_KG = 400;

type WeightsReport = NonNullable<ImportReport["weights"]>;

export function resolveWeightUnit(ctx: Ctx): { unit: WeightUnit; source: WeightsReport["unitSource"] } {
  if (ctx.o.weightUnit) return { unit: ctx.o.weightUnit, source: "option" };
  if (ctx.parsed.weights?.unitHint) return { unit: ctx.parsed.weights.unitHint, source: "weights.csv header" };
  if (ctx.parsed.profile) return { unit: ctx.parsed.profile.unit, source: "profile.csv" };
  return { unit: ctx.user.profile?.unit_system === "metric" ? "kg" : "lb", source: "account setting" };
}

export function importWeights(ctx: Ctx): ImportReport["weights"] {
  const parsed = ctx.parsed.weights;
  if (!parsed) return null;
  const { db, user, warnings } = ctx;
  const { unit, source } = resolveWeightUnit(ctx);
  const rep: WeightsReport = {
    unit, unitSource: source, created: 0, alreadyImported: 0, updated: 0, deletedSince: 0, rejected: 0, outsideRange: 0,
    first: null, last: null,
  };

  const find = db.prepare("SELECT weight_kg, deleted_at FROM nutrition_weights WHERE id = ?");
  const insert = db.prepare("INSERT INTO nutrition_weights (id, user_id, measured_on, weight_kg, source) VALUES (?, ?, ?, ?, 'import_loseit')");
  const update = db.prepare("UPDATE nutrition_weights SET weight_kg = ? WHERE id = ?");
  const softDelete = db.prepare("UPDATE nutrition_weights SET deleted_at = ? WHERE id = ?");
  const now = new Date().toISOString();
  const seen = new Set<string>();

  for (const r of parsed.rows) {
    if (!ctx.inWindow(r.date)) {
      if (!r.deleted) rep.outsideRange++;
      continue;
    }
    const id = `loseit-w-${user.id}-${r.date}-${sha256(String(r.value)).slice(0, 12)}`;
    const prior = find.get(id) as unknown as { weight_kg: number; deleted_at: string | null } | undefined;

    if (r.deleted) {
      if (prior && !prior.deleted_at) {
        softDelete.run(now, id);
        rep.deletedSince++;
      }
      continue;
    }
    if (seen.has(id)) continue; // the same weigh-in listed twice in one file
    seen.add(id);

    const kg = round2(unit === "lb" ? r.value * KG_PER_LB : r.value);
    if (!(kg >= MIN_KG && kg <= MAX_KG)) {
      warnings.add(`${r.date}: weight ${r.value} ${unit} (${kg} kg) is outside ${MIN_KG}-${MAX_KG} kg, skipped. Is the weight unit right?`);
      rep.rejected++;
      continue;
    }
    if (!rep.first || r.date < rep.first.date) rep.first = { date: r.date, kg };
    if (!rep.last || r.date >= rep.last.date) rep.last = { date: r.date, kg };

    if (!prior) {
      insert.run(id, user.id, r.date, kg);
      rep.created++;
    } else if (!prior.deleted_at && Math.abs(prior.weight_kg - kg) > 0.005) {
      update.run(kg, id);
      rep.updated++;
    } else {
      rep.alreadyImported++; // unchanged, or removed by the person here (not undone)
    }
  }
  return rep;
}
