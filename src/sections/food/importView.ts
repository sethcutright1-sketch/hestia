// What the "Import from Lose It!" card shows, worked out from the server's report (nutrition/import/types.ts
// ImportReport) as plain data: the sentences and the numbers live here so they can be tested without a browser.
// "Calorie budget" is the only budget in any of it; the word is never bare.

import type { CalibrationReport, ConflictMode, ImportReport } from "../../../nutrition/import/types.ts";

export type { CalibrationReport, ConflictMode, ImportReport };
export type WeightChoice = "account" | "lb" | "kg";

/** Big numbers read with thousands separators. */
export const num = (n: number): string => Math.round(n).toLocaleString("en-US");

export const plural = (n: number, one: string, many = `${one}s`): string => `${num(n)} ${n === 1 ? one : many}`;

export const CONFLICT_CHOICES: Array<{ value: ConflictMode; label: string; detail: string }> = [
  { value: "skip", label: "Skip those days", detail: "Leave a day you already logged here completely alone. This is the safe choice." },
  { value: "merge", label: "Add beside what I logged", detail: "Bring in the Lose It! foods for that day as well as the ones you logged here." },
  { value: "replace", label: "Replace what I logged", detail: "Remove what you logged here for that day (it can't be brought back), then bring in the Lose It! foods." },
];

/** The query string for the import routes. `weight` "account" sends nothing: the server uses the login's own unit setting. */
export function importQuery(o: { conflict: ConflictMode; onlyMe: boolean; weight: WeightChoice }): string {
  const q = new URLSearchParams();
  q.set("conflict", o.conflict);
  if (o.onlyMe) q.set("onlyMe", "1");
  if (o.weight !== "account") q.set("weightUnit", o.weight);
  return q.toString();
}

export interface Row {
  label: string;
  value: string;
  /** Something to look at: a count that is not zero but not good news. */
  tone?: "warn";
}

export interface Section {
  title: string;
  rows: Row[];
  note?: string;
}

const verb = (dry: boolean) => (dry ? "will be added" : "added");

/** Counts per kind, in the order a person thinks about them. A dry run says "will be", the result says "added". */
export function sections(r: ImportReport, foodScope: "joint" | "personal" = r.options.foodScope): Section[] {
  const dry = r.dryRun;
  const out: Section[] = [];

  const c = r.counts;
  const diary: Row[] = [{ label: `Food entries ${verb(dry)}`, value: num(c.created) }];
  if (c.alreadyImported) diary.push({ label: "Already here from an earlier import", value: num(c.alreadyImported) });
  if (c.deletedSince) diary.push({ label: "Deleted in Lose It! since, removed here", value: num(c.deletedSince) });
  if (c.skippedByConflict) diary.push({ label: "Left alone (days you logged here)", value: num(c.skippedByConflict), tone: "warn" });
  if (c.deletedInExport) diary.push({ label: "Marked deleted in Lose It! (not imported)", value: num(c.deletedInExport) });
  if (c.plannedInFuture) diary.push({ label: "Dated after today (kept as planned)", value: num(c.plannedInFuture) });
  if (c.outsideRange) diary.push({ label: "Outside the date range", value: num(c.outsideRange) });
  out.push({
    title: "Food diary",
    rows: diary,
    note: r.dateRange ? `${r.dateRange.from} to ${r.dateRange.to}, ${plural(r.dateRange.daysWithEntries, "day")} with food.` : "No food entries in this export.",
  });

  const foods: Row[] = [{ label: `Foods made from your history`, value: num(r.foods.created) }];
  if (r.foods.reused) foods.push({ label: "Matched to a food that already exists", value: num(r.foods.reused) });
  if (r.customFoods.rows) foods.push({ label: "Your custom foods", value: num(r.customFoods.created + r.customFoods.reused) });
  if (r.foods.withoutNutrition + r.customFoods.withoutNutrition) foods.push({ label: "Without usable nutrition", value: num(r.foods.withoutNutrition + r.customFoods.withoutNutrition), tone: "warn" });
  out.push({ title: "Foods", rows: foods, note: foodScope === "personal" ? "These foods are only yours." : "These foods are shared with the household." });

  if (r.weights) {
    const w = r.weights;
    const rows: Row[] = [{ label: `Weigh-ins ${verb(dry)}`, value: num(w.created) }];
    if (w.alreadyImported) rows.push({ label: "Already here", value: num(w.alreadyImported) });
    if (w.updated) rows.push({ label: "Updated", value: num(w.updated) });
    if (w.rejected) rows.push({ label: "Skipped (not a believable weight)", value: num(w.rejected), tone: "warn" });
    out.push({ title: "Weight", rows, note: weightNote(w) });
  }

  if (r.exercise.mode !== "none") {
    const e = r.exercise;
    const rows: Row[] = [{ label: `Exercise entries ${verb(dry)}`, value: num(e.created) }];
    if (e.alreadyImported) rows.push({ label: "Already here", value: num(e.alreadyImported) });
    if (e.mismatches) rows.push({ label: "Days that disagree with Lose It!'s totals", value: num(e.mismatches), tone: "warn" });
    out.push({ title: "Exercise", rows });
  }

  const d = r.doneDays;
  if (d.inFile || d.notComplete) {
    const rows: Row[] = [{ label: `Days marked Done logging`, value: num(d.marked) }];
    if (d.alreadyDone) rows.push({ label: "Already done here", value: num(d.alreadyDone) });
    if (d.notComplete) rows.push({ label: "Not completed in Lose It! (not marked)", value: num(d.notComplete) });
    out.push({ title: "Done logging", rows, note: "These count toward your logging streak." });
  }

  const s = r.steps;
  if (s.inFile) {
    const rows: Row[] = [{ label: `Days of steps ${verb(dry)}`, value: num(s.created) }];
    if (s.updated) rows.push({ label: "Updated from Lose It!", value: num(s.updated) });
    if (s.alreadyImported) rows.push({ label: "Already here", value: num(s.alreadyImported) });
    if (s.keptManual) rows.push({ label: "Kept because you typed them yourself", value: num(s.keptManual) });
    out.push({ title: "Steps", rows });
  }

  const p = r.photos;
  if (p.inFile) {
    const rows: Row[] = [{ label: `Progress photos ${verb(dry)}`, value: num(p.created) }];
    if (p.alreadyImported) rows.push({ label: "Already here", value: num(p.alreadyImported) });
    if (p.skippedDeleted) rows.push({ label: "Deleted in Lose It! (skipped)", value: num(p.skippedDeleted) });
    if (p.tooBig) rows.push({ label: `Over the ${num(p.limitBytes / 1024 / 1024)} MB limit (skipped, never shrunk)`, value: num(p.tooBig), tone: "warn" });
    if (p.unusable) rows.push({ label: "Missing or not a picture (skipped)", value: num(p.unusable), tone: "warn" });
    out.push({ title: "Progress photos", rows, note: "Only you can see these. They are kept exactly as Lose It! gave them." });
  }

  if (r.budgetSnapshots.written || r.budgetSnapshots.unchanged) {
    out.push({
      title: "Calorie budgets",
      rows: [{ label: `Past days kept at their Lose It! calorie budget`, value: num(r.budgetSnapshots.written + r.budgetSnapshots.unchanged) }],
      note: "Days that are over keep the calorie budget you lived under.",
    });
  }
  return out;
}

function weightNote(w: NonNullable<ImportReport["weights"]>): string {
  const how = { option: "you chose", "weights.csv header": "named in the file", "profile.csv": "named in your Lose It! profile", "account setting": "your account setting" }[w.unitSource];
  const unit = w.unit === "lb" ? "pounds" : "kilograms";
  const last = w.last ? ` Your newest weigh-in (${w.last.date}) reads as ${kgText(w.last.kg)}; if that looks wrong, change the unit below.` : "";
  return `Read as ${unit} (${how}).${last}`;
}

const kgText = (kg: number): string => `${(Math.round(kg * 10) / 10).toLocaleString("en-US")} kg (${(Math.round((kg / 0.45359237) * 10) / 10).toLocaleString("en-US")} lb)`;

/** Which files were read, which were left out on purpose (with the reason), and which could not be read. */
export function fileGroups(r: ImportReport) {
  return {
    understood: r.files.filter((f) => f.status === "understood"),
    skipped: r.files.filter((f) => f.status === "skipped"),
    notUnderstood: r.files.filter((f) => f.status === "not understood"),
    mealPhotos: r.ignoredImages,
  };
}

/** The reconciliation sentence: does what was read add up to Lose It!'s own daily totals? */
export function reconciliationView(r: ImportReport): { tone: "ok" | "warn" | "info"; text: string; examples: string[] } {
  const x = r.reconciliation;
  if (x.compared === 0) return { tone: "info", text: "There were no daily totals in the export to check against.", examples: [] };
  if (x.mismatches === 0) return { tone: "ok", text: `All ${num(x.compared)} days add up to Lose It!'s own daily calories.`, examples: [] };
  return {
    tone: "warn",
    text: `${num(x.mismatches)} of ${num(x.compared)} days differ from Lose It!'s own daily calories by more than a little.`,
    examples: x.first.slice(0, 5).map((m) => `${m.date}: Lose It! says ${num(m.summaryKcal)}, the file adds up to ${num(m.fileKcal)}`),
  };
}

export interface CalibrationView {
  kind: "compare" | "needs-profile" | "unavailable";
  /** The comparison, or the reason there isn't one. */
  text: string;
  /** Why the match button is off, when a comparison is shown but can't be applied. */
  blocked?: string;
  canApply: boolean;
  /** The multiplier the button would send. */
  pal?: number;
}

/** "Lose It! gave you about X a day; the app would give Y." Shown after the preview and again after the import. */
export function calibrationView(c: CalibrationReport): CalibrationView {
  if (c.needsProfile) return { kind: "needs-profile", text: "To compare your Lose It! calorie budget with this app's, fill in your profile first (sex, birth date and height), under Profile above. Then choose your file again to compare.", canApply: false };
  if (c.status === "skipped" || c.median === undefined) return { kind: "unavailable", text: `No comparison: ${c.reason ?? "there is not enough to compare."}`.replace(/\.\.$/, "."), canApply: false };
  const days = plural(c.daysUsed, "day");
  const text = `Lose It! gave you about ${num(c.loseItAvgKcal!)} calories a day over your last ${days}. This app gives you ${num(c.appAvgKcal!)}. Matching Lose It! would make it ${num(c.matchedAvgKcal!)}.`;
  return { kind: "compare", text, blocked: c.canApply ? undefined : c.reason, canApply: c.canApply, pal: c.median };
}
