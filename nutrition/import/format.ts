// Plain-text rendering of the importer's results for the CLI. Counts and short labels only: never photo bytes,
// and food names appear only inside the first few warnings.

import type { InventoryItem } from "./loseitParse.ts";
import type { ImportReport } from "./types.ts";

const n = (x: number): string => x.toLocaleString("en-US");
const kcal = (x: number): string => n(Math.round(x));

/** understood = the importer reads it; skipped = left out on purpose (the note says why); NOT understood = a file it should read but can't. */
const verdict = (f: InventoryItem): string => (f.status === "not understood" ? "NOT understood" : f.status);

/**
 * The file inventory: every file with its headers, so a new or unknown layout can be built against real
 * headers. Headers are printed in full; with `samples`, so is each file's first data row.
 */
export function formatInventory(items: InventoryItem[], opts: { samples?: boolean } = {}): string {
  if (items.length === 0) return "No CSV files found.";
  const out: string[] = [];
  for (const f of items) {
    out.push(`${f.name}  (${n(f.rows)} ${f.name.endsWith(".csv") ? "data rows" : "lines"})  ${verdict(f)}: ${f.note}`);
    if (f.headers.length) out.push(`    headers: ${f.headers.join(" | ")}`);
    if (f.settings) out.push(`    settings: ${f.settings.join(" | ")}`);
    if (opts.samples && f.sample) out.push(`    first row: ${Object.entries(f.sample).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" | ")}`);
  }
  return out.join("\n");
}

export function formatReport(r: ImportReport, who: string): string {
  const out: string[] = [];
  const line = (s = "") => out.push(s);
  const section = (title: string) => { line(); line(title); };
  const verb = r.dryRun ? "to create" : "created";

  line(r.dryRun
    ? `Lose It! import for ${who}: DRY RUN. Nothing was written; a real run would do exactly this.`
    : `Lose It! import for ${who}: DONE.`);

  section("Files");
  for (const f of r.files) {
    line(`  ${f.name.padEnd(28)} ${n(f.rows).padStart(7)} rows  ${verdict(f).padEnd(14)}  ${f.note}`);
    if (f.status === "not understood" && f.headers.length) line(`      headers: ${f.headers.join(" | ")}`);
  }
  if (r.ignoredImages) line(`  ${n(r.ignoredImages)} meal photo(s) in the ZIP were skipped on purpose (photos of meals aren't imported)`);

  section("Diary");
  if (r.dateRange) line(`  Dates:    ${r.dateRange.from} to ${r.dateRange.to} (${n(r.dateRange.daysWithEntries)} days with entries)`);
  const c = r.counts;
  line(`  Entries:  ${n(c.created)} ${verb}, ${n(c.alreadyImported)} already imported, ${n(c.deletedSince)} deleted in Lose It! since the last import, ${n(c.skippedByConflict)} skipped (days you logged here)`);
  const extras = [
    c.outsideRange && `${n(c.outsideRange)} outside --from/--to`,
    c.deletedInExport && `${n(c.deletedInExport)} rows marked Deleted in the export`,
    c.plannedInFuture && `${n(c.plannedInFuture)} filed as plans (dated after today)`,
  ].filter(Boolean);
  if (extras.length) line(`            also: ${extras.join("; ")}`);
  line(`  Foods:    ${n(r.foods.created)} new from your history, ${n(r.foods.reused)} reused${r.foods.withoutNutrition ? `, ${n(r.foods.withoutNutrition)} without usable nutrition` : ""} (${r.options.foodScope === "personal" ? "only you" : "shared with the household"})`);
  if (r.customFoods.rows) line(`  Custom:   ${n(r.customFoods.rows)} custom foods in the file: ${n(r.customFoods.created)} ${verb}, ${n(r.customFoods.reused)} reused${r.customFoods.withoutNutrition ? `, ${n(r.customFoods.withoutNutrition)} without usable nutrition` : ""}`);
  for (const s of r.customSlots) {
    line(`  Meal:     "${s.name}" (${s.key}): ${n(s.entries)} entries, ${s.enabled ? "enabled" : "disabled (not used in the export's last 60 days)"}${s.created ? ", slot created" : ", slot already existed"}`);
  }

  if (r.conflicts.count > 0) {
    section(`Days you already logged here (--conflict ${r.conflicts.mode}): ${n(r.conflicts.count)}`);
    for (const d of r.conflicts.dates.slice(0, 10)) line(`  ${d.date}  ${d.nativeEntries} of your entries, ${d.importRows} Lose It! rows: ${d.action}`);
    if (r.conflicts.count > 10) line(`  ...and ${n(r.conflicts.count - 10)} more`);
    if (r.conflicts.replacedEntries) line(`  ${n(r.conflicts.replacedEntries)} of your own entries were replaced (soft-deleted)`);
  }

  section("Weights");
  if (!r.weights) {
    line("  none (no usable weights.csv)");
  } else {
    const w = r.weights;
    line(`  Read as ${w.unit} (decided by: ${w.unitSource}). ${n(w.created)} ${verb}, ${n(w.alreadyImported)} already imported, ${n(w.updated)} updated, ${n(w.deletedSince)} deleted since, ${n(w.rejected)} rejected${w.outsideRange ? `, ${n(w.outsideRange)} outside --from/--to` : ""}`);
    if (w.first && w.last) line(`  Check the unit: first ${w.first.date} = ${w.first.kg} kg, last ${w.last.date} = ${w.last.kg} kg${w.unit === "lb" ? ` (${Math.round(w.last.kg / 0.45359237 * 10) / 10} lb)` : ""}`);
  }

  section("Exercise");
  const ex = r.exercise;
  line(ex.mode === "none"
    ? "  none"
    : `  From ${ex.mode === "logs" ? "exercise-logs.csv" : "the daily summary's Exercise cals"}: ${n(ex.created)} ${verb}, ${n(ex.alreadyImported)} already imported, ${n(ex.updated)} updated, ${n(ex.deletedSince)} deleted since${ex.skippedByConflict ? `, ${n(ex.skippedByConflict)} skipped (conflict)` : ""}`);
  if (ex.mode === "logs" && ex.mismatches) line(`  ${n(ex.mismatches)} day(s) where the exercise log disagrees with the summary's Exercise cals: check the exercise columns`);

  section("Done logging days");
  const d = r.doneDays;
  line(`  ${n(d.inFile)} days marked Complete in the file: ${n(d.marked)} ${r.dryRun ? "to mark" : "marked"}, ${n(d.alreadyDone)} already done${d.skippedByConflict ? `, ${n(d.skippedByConflict)} skipped (conflict)` : ""}${d.outsideRange ? `, ${n(d.outsideRange)} outside --from/--to` : ""}${d.future ? `, ${n(d.future)} in the future` : ""}`);
  if (d.notComplete) line(`  ${n(d.notComplete)} Complete row(s) say the day was not completed (0): not marked`);
  if (d.weightsResetDates.length) line(`  RecordedWeightsResetDate noted (${d.weightsResetDates.join(", ")}); nothing is done with it`);

  section("Steps");
  const st = r.steps;
  line(`  ${n(st.inFile)} days in the file: ${n(st.created)} ${verb}, ${n(st.updated)} updated, ${n(st.alreadyImported)} already imported, ${n(st.keptManual)} kept because you typed them yourself${st.outsideRange ? `, ${n(st.outsideRange)} outside --from/--to` : ""}${st.future ? `, ${n(st.future)} in the future` : ""}${st.rejected ? `, ${n(st.rejected)} rejected` : ""}`);

  section("Progress photos");
  const p = r.photos;
  line(`  ${n(p.inFile)} in the file: ${n(p.created)} ${verb}, ${n(p.alreadyImported)} already imported, ${n(p.skippedDeleted)} marked Deleted${p.tooBig ? `, ${n(p.tooBig)} over the ${Math.round(p.limitBytes / 1024 / 1024)} MB limit (skipped, never shrunk)` : ""}${p.unusable ? `, ${n(p.unusable)} unusable` : ""}${p.outsideRange ? `, ${n(p.outsideRange)} outside --from/--to` : ""}${p.future ? `, ${n(p.future)} in the future` : ""}`);
  if (p.deletedSinceKept) line(`  ${n(p.deletedSinceKept)} photo(s) deleted in Lose It! since an earlier import were kept here`);

  section("Calorie budgets");
  line(`  ${n(r.budgetSnapshots.written)} past days ${r.dryRun ? "to freeze" : "frozen"} at their Lose It! calorie budget, ${n(r.budgetSnapshots.unchanged)} already were`);

  section("Reconciliation against Lose It!'s own daily Food cals");
  if (r.reconciliation.compared === 0) {
    line("  nothing to compare (no daily-calorie-summary.csv)");
  } else if (r.reconciliation.mismatches === 0) {
    line(`  all ${n(r.reconciliation.compared)} days match`);
  } else {
    line(`  ${n(r.reconciliation.mismatches)} of ${n(r.reconciliation.compared)} days differ by more than max(2 kcal, 1%):`);
    for (const m of r.reconciliation.first) {
      line(`    ${m.date}  Lose It! ${kcal(m.summaryKcal)}   export rows ${kcal(m.fileKcal)}${m.diaryKcal === null ? "" : `   diary ${kcal(m.diaryKcal)}`}`);
    }
    if (r.reconciliation.mismatches > r.reconciliation.first.length) line(`    ...and ${n(r.reconciliation.mismatches - r.reconciliation.first.length)} more`);
  }

  section("Calorie budget comparison (the activity multiplier implied by your Lose It! calorie budgets)");
  const cal = r.calibration;
  if (cal.status === "skipped") {
    line(`  skipped: ${cal.reason}`);
  } else {
    line(`  Lose It! gave you about ${kcal(cal.loseItAvgKcal!)} a day over the last ${n(cal.daysUsed)} days; this app gives ${kcal(cal.appAvgKcal!)} (${kcal(cal.matchedAvgKcal!)} with the matched multiplier).`);
    line(`  Implied multiplier: median ${cal.median} (range ${cal.min} to ${cal.max}). ${cal.applied ? `${r.dryRun ? "Would be applied" : "Applied"} as a new goal row effective today.` : cal.applyRequested ? cal.reason ?? "" : cal.canApply ? "Not applied; use --apply-calibration to set it." : cal.reason ?? ""}`);
  }

  if (c.warnings > 0) {
    section(`Warnings (${n(c.warnings)}${c.warnings > r.warnings.length ? `, first ${r.warnings.length} shown` : ""})`);
    for (const w of r.warnings) line(`  - ${w}`);
  }
  return out.join("\n");
}
