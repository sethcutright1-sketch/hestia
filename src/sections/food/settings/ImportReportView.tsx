// The report of a Lose It! import, as the person reads it: the same view for the dry-run preview ("will be added") and the result
// ("added"). Counts per kind, the reconciliation check against Lose It!'s own daily calories, which files were read and which were
// skipped (and why), the days that conflict with food already logged here, and the first warnings.

import { fileGroups, num, reconciliationView, sections, type ImportReport } from "../importView.ts";
import { Notice, mutedCls } from "../ui.tsx";

export default function ImportReportView({ report, foodScope }: { report: ImportReport; foodScope?: "joint" | "personal" }) {
  const groups = fileGroups(report);
  const recon = reconciliationView(report);
  const conflicts = report.conflicts;
  const verb = report.dryRun ? "would be" : "were";

  return (
    <div className="space-y-3">
      {sections(report, foodScope).map((s) => (
        <section key={s.title} aria-label={s.title} className="rounded-xl border border-slate-200 dark:border-slate-800 p-3 space-y-1.5">
          <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{s.title}</h4>
          <dl className="space-y-1">
            {s.rows.map((row) => (
              <div key={row.label} className="flex items-baseline justify-between gap-3">
                <dt className={`text-sm min-w-0 ${row.tone === "warn" ? "text-amber-700 dark:text-amber-400" : "text-slate-700 dark:text-slate-300"}`}>{row.label}</dt>
                <dd className="text-sm font-semibold tabular-nums text-slate-900 dark:text-slate-100 shrink-0">{row.value}</dd>
              </div>
            ))}
          </dl>
          {s.note && <p className={`text-xs leading-normal ${mutedCls}`}>{s.note}</p>}
        </section>
      ))}

      <Notice tone={recon.tone === "ok" ? "ok" : recon.tone === "warn" ? "warn" : "info"}>
        {recon.text}
        {recon.examples.length > 0 && (
          <span className="block mt-1 text-xs">
            {recon.examples.map((e) => (
              <span key={e} className="block">{e}</span>
            ))}
          </span>
        )}
      </Notice>

      {conflicts.count > 0 && (
        <section aria-label="Days you already logged" className="rounded-xl border border-amber-200 dark:border-amber-900/60 bg-amber-50/60 dark:bg-amber-950/20 p-3 space-y-1">
          <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{num(conflicts.count)} {conflicts.count === 1 ? "day" : "days"} you already logged here</h4>
          <p className={`text-xs leading-normal ${mutedCls}`}>
            {conflicts.mode === "skip" && `These days ${verb} left alone.`}
            {conflicts.mode === "merge" && `The Lose It! foods for these days ${verb} added beside what you logged.`}
            {conflicts.mode === "replace" && `What you logged on these days ${verb} replaced${conflicts.replacedEntries ? ` (${num(conflicts.replacedEntries)} ${conflicts.replacedEntries === 1 ? "entry" : "entries"})` : ""}.`}
          </p>
          <ul className="text-xs text-slate-700 dark:text-slate-300 space-y-0.5">
            {conflicts.dates.slice(0, 8).map((d) => (
              <li key={d.date}>{d.date}: {num(d.nativeEntries)} yours, {num(d.importRows)} from Lose It! ({d.action})</li>
            ))}
            {conflicts.count > 8 && <li className={mutedCls}>and {num(conflicts.count - 8)} more</li>}
          </ul>
        </section>
      )}

      <details className="rounded-xl border border-slate-200 dark:border-slate-800 p-3">
        <summary className="cursor-pointer text-sm font-medium text-slate-900 dark:text-slate-100">
          Files in your export ({num(groups.understood.length)} read, {num(groups.skipped.length)} skipped)
        </summary>
        <div className="mt-2 space-y-2 text-xs">
          {groups.notUnderstood.length > 0 && (
            <div>
              <p className="font-medium text-amber-700 dark:text-amber-400">Couldn't read</p>
              <ul className="space-y-0.5 text-slate-700 dark:text-slate-300">
                {groups.notUnderstood.map((f) => <li key={f.name} className="break-words">{f.name}: {f.note}</li>)}
              </ul>
            </div>
          )}
          <div>
            <p className="font-medium text-slate-900 dark:text-slate-100">Read</p>
            <ul className="space-y-0.5 text-slate-700 dark:text-slate-300">
              {groups.understood.map((f) => <li key={f.name} className="break-words">{f.name} ({num(f.rows)} {f.rows === 1 ? "row" : "rows"})</li>)}
            </ul>
          </div>
          <div>
            <p className="font-medium text-slate-900 dark:text-slate-100">Skipped</p>
            <ul className="space-y-0.5 text-slate-700 dark:text-slate-300">
              {groups.skipped.map((f) => <li key={f.name} className="break-words">{f.name}: {f.note.replace(/^skipped( on purpose| by choice)?: /, (_m, how) => (how === " by choice" ? "by choice, " : ""))}</li>)}
              {groups.mealPhotos > 0 && <li>{num(groups.mealPhotos)} {groups.mealPhotos === 1 ? "photo" : "photos"} of meals: not imported</li>}
            </ul>
          </div>
        </div>
      </details>

      {report.warnings.length > 0 && (
        <details className="rounded-xl border border-slate-200 dark:border-slate-800 p-3">
          <summary className="cursor-pointer text-sm font-medium text-slate-900 dark:text-slate-100">
            {num(report.counts.warnings)} {report.counts.warnings === 1 ? "thing" : "things"} to know about
          </summary>
          <ul className="mt-2 space-y-1 text-xs text-slate-700 dark:text-slate-300">
            {report.warnings.slice(0, 12).map((w, i) => <li key={i} className="break-words">{w}</li>)}
            {report.counts.warnings > 12 && <li className={mutedCls}>and {num(report.counts.warnings - 12)} more</li>}
          </ul>
        </details>
      )}
    </div>
  );
}
