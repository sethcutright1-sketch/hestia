// Food settings > Import from Lose It!: bring your own Lose It! history into your own diary.
//
// The flow: choose the ZIP -> a dry-run preview (the whole import, rolled back, so the numbers are exactly what a real run does)
// -> the options (foods shared with the household or "Only me"; what to do with days you already logged here; the weight unit)
// -> Import -> the result -> an optional, separate "Match my Lose It! calorie budget".
//
// It always imports into the signed-in login's diary (the server takes who from the session). Nothing here changes a calorie goal
// until the person presses "Match my Lose It! calorie budget".

import { useRef, useState } from "react";
import { foodApi } from "../api.ts";
import {
  CONFLICT_CHOICES, calibrationView, importQuery, num, type ConflictMode, type ImportReport, type WeightChoice,
} from "../importView.ts";
import type { Profile } from "../types.ts";
import { Notice, btnPrimary, btnSecondary, mutedCls } from "../ui.tsx";
import ImportReportView from "./ImportReportView.tsx";
import SettingsCard, { Select } from "./SettingsCard.tsx";

interface Props {
  profile: Profile;
  fail: (err: unknown) => string;
  /** The diary has new food in it (or a new goal): read the day again. */
  onChanged: () => void;
}

const sizeText = (bytes: number): string => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

export default function ImportCard({ profile, fail, onChanged }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [conflict, setConflict] = useState<ConflictMode>("skip");
  const [onlyMe, setOnlyMe] = useState(false);
  const [weight, setWeight] = useState<WeightChoice>("account");
  const [preview, setPreview] = useState<ImportReport | null>(null);
  const [result, setResult] = useState<ImportReport | null>(null);
  const [checking, setChecking] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState("");
  const [match, setMatch] = useState<{ busy: boolean; tone?: "ok" | "error"; text?: string }>({ busy: false });
  // A later dry run replaces an earlier one that is still in flight: only the newest answer is shown.
  const ticket = useRef(0);
  const accountUnit = profile.unitSystem === "metric" ? "kg" : "lb";

  async function check(f: File, next: { conflict: ConflictMode; weight: WeightChoice }) {
    const mine = ++ticket.current;
    setChecking(true);
    setError("");
    try {
      const report = await foodApi.importLoseItDryRun(f, importQuery({ conflict: next.conflict, onlyMe, weight: next.weight }));
      if (mine === ticket.current) setPreview(report);
    } catch (err) {
      if (mine === ticket.current) {
        setPreview(null);
        setError(fail(err));
      }
    } finally {
      if (mine === ticket.current) setChecking(false);
    }
  }

  function choose(f: File | null) {
    setResult(null);
    setPreview(null);
    setMatch({ busy: false });
    setFile(f);
    if (f) void check(f, { conflict, weight });
  }

  function changeConflict(value: ConflictMode) {
    setConflict(value);
    if (file) void check(file, { conflict: value, weight });
  }

  function changeWeight(value: WeightChoice) {
    setWeight(value);
    if (file) void check(file, { conflict, weight: value });
  }

  async function runImport() {
    if (!file || importing || checking) return;
    setImporting(true);
    setError("");
    try {
      const report = await foodApi.importLoseIt(file, importQuery({ conflict, onlyMe, weight }));
      setResult(report);
      setPreview(null);
      onChanged();
    } catch (err) {
      setError(fail(err));
    } finally {
      setImporting(false);
    }
  }

  async function matchBudget(pal: number) {
    setMatch({ busy: true });
    try {
      await foodApi.matchCalorieBudget(pal);
      setMatch({ busy: false, tone: "ok", text: `Done. From today your calorie goal uses an activity multiplier of ${pal}. Earlier days keep the calorie budget they were lived under.` });
      onChanged();
    } catch (err) {
      setMatch({ busy: false, tone: "error", text: fail(err) });
    }
  }

  function startOver() {
    setFile(null);
    setPreview(null);
    setResult(null);
    setError("");
    setMatch({ busy: false });
  }

  const cal = result ? calibrationView(result.calibration) : preview ? calibrationView(preview.calibration) : null;

  return (
    <SettingsCard
      title="Import from Lose It!"
      description="Bring your Lose It! history into your own food diary: food, weights, exercise, steps, progress photos and your Done logging days. It goes into your diary only. Nothing is changed until you press Import, and you can run it again later: it never adds the same thing twice."
    >
      {!result && (
        <>
          <details className="text-xs leading-normal text-slate-700 dark:text-slate-300">
            <summary className="cursor-pointer font-medium text-slate-900 dark:text-slate-100">How do I get my Lose It! export?</summary>
            <ol className="mt-1.5 ml-4 list-decimal space-y-1">
              <li>Sign in at <span className="font-medium">my.loseit.com</span> on a computer.</li>
              <li>Go to <span className="font-medium">loseit.com/export/data</span> and ask for your full export.</li>
              <li>Download the ZIP file and choose it below as it is. Don't unzip it.</li>
            </ol>
          </details>

          <div className="space-y-1">
            <label htmlFor="loseit-zip" className="block text-xs font-medium text-slate-600 dark:text-slate-400">Your Lose It! export (a .zip file)</label>
            <input
              id="loseit-zip"
              type="file"
              accept=".zip,application/zip,application/x-zip-compressed"
              disabled={checking || importing}
              onChange={(e) => choose(e.target.files?.[0] ?? null)}
              className="block w-full min-w-0 text-sm text-slate-700 dark:text-slate-300 file:mr-3 file:px-3 file:py-2 file:rounded-lg file:border-0 file:bg-slate-100 dark:file:bg-slate-800 file:text-sm file:font-medium file:text-slate-800 dark:file:text-slate-200"
            />
            {file && <p className={`text-xs break-words ${mutedCls}`}>{file.name} ({sizeText(file.size)})</p>}
          </div>

          {checking && <Notice>Reading your export and checking what an import would do. Nothing is saved yet…</Notice>}
          {error && <Notice tone="error">{error}</Notice>}

          {preview && (
            <div className="space-y-3">
              <h4 className="font-semibold text-slate-900 dark:text-slate-100">What importing will do</h4>
              <ImportReportView report={preview} foodScope={onlyMe ? "personal" : "joint"} />

              {cal && <CalibrationNote view={cal} after={false} />}

              <fieldset className="space-y-2">
                <legend className="text-sm font-semibold text-slate-900 dark:text-slate-100">Options</legend>

                <label className="flex items-start gap-2.5 rounded-xl border border-slate-200 dark:border-slate-800 p-3 text-sm cursor-pointer">
                  <input type="checkbox" className="mt-1" checked={onlyMe} onChange={(e) => setOnlyMe(e.target.checked)} disabled={importing} />
                  <span className="min-w-0">
                    <span className="block font-medium text-slate-900 dark:text-slate-100">Only me</span>
                    <span className={`block text-xs leading-normal ${mutedCls}`}>
                      Keep the foods this import creates to yourself. Otherwise they are shared with the household, so everyone can search them. This is about the foods only: what you ate stays in your own diary either way.
                    </span>
                  </span>
                </label>

                {preview.conflicts.count > 0 && (
                  <div role="radiogroup" aria-label={`${num(preview.conflicts.count)} days you already logged here`} className="space-y-2">
                    <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
                      For the {num(preview.conflicts.count)} {preview.conflicts.count === 1 ? "day" : "days"} you already logged here
                    </p>
                    {CONFLICT_CHOICES.map((c) => (
                      <label key={c.value} className={`flex items-start gap-2.5 rounded-xl border p-3 cursor-pointer ${conflict === c.value ? "border-blue-500 bg-blue-50/60 dark:bg-blue-950/20" : "border-slate-200 dark:border-slate-800"}`}>
                        <input type="radio" name="loseit-conflict" className="mt-1" checked={conflict === c.value} disabled={checking || importing} onChange={() => changeConflict(c.value)} />
                        <span className="min-w-0">
                          <span className="block text-sm font-medium text-slate-900 dark:text-slate-100">{c.label}{c.value === "skip" && <span className={`font-normal ${mutedCls}`}> (default)</span>}</span>
                          <span className={`block text-xs leading-normal ${mutedCls}`}>{c.detail}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                )}

                {preview.weights && (
                  <div className="space-y-1">
                    <label htmlFor="loseit-weight" className="block text-xs font-medium text-slate-600 dark:text-slate-400">The weights in the file are in</label>
                    <Select id="loseit-weight" value={weight} onChange={(v) => changeWeight(v as WeightChoice)}>
                      <option value="account">My account setting ({accountUnit === "lb" ? "pounds" : "kilograms"})</option>
                      <option value="lb">Pounds</option>
                      <option value="kg">Kilograms</option>
                    </Select>
                    <p className={`text-xs leading-normal ${mutedCls}`}>Lose It!'s weights file doesn't say which. Check the sentence under Weight above.</p>
                  </div>
                )}
              </fieldset>

              <button type="button" onClick={() => void runImport()} disabled={importing || checking} className={`${btnPrimary} w-full`}>
                {importing ? "Importing…" : "Import into my diary"}
              </button>
              <p className={`text-xs leading-normal ${mutedCls}`}>The import happens all at once: if anything goes wrong, nothing is saved.</p>
            </div>
          )}
        </>
      )}

      {result && (
        <div className="space-y-3">
          <Notice tone="ok">Imported. Everything below is now in your diary.</Notice>
          <ImportReportView report={result} />
          {cal && <CalibrationNote view={cal} after onMatch={(pal) => void matchBudget(pal)} busy={match.busy} done={match.tone === "ok"} />}
          {match.text && <Notice tone={match.tone === "ok" ? "ok" : "error"}>{match.text}</Notice>}
          <button type="button" onClick={startOver} className={`${btnSecondary} w-full`}>Import another file</button>
        </div>
      )}
    </SettingsCard>
  );
}

function CalibrationNote({ view, after, onMatch, busy, done }: {
  view: ReturnType<typeof calibrationView>;
  after: boolean;
  onMatch?: (pal: number) => void;
  busy?: boolean;
  done?: boolean;
}) {
  return (
    <section aria-label="Compare calorie budgets" className="rounded-xl border border-slate-200 dark:border-slate-800 p-3 space-y-2">
      <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Your Lose It! calorie budget</h4>
      <p className="text-sm leading-normal text-slate-700 dark:text-slate-300">{view.text}</p>
      {view.blocked && <p className="text-xs leading-normal text-amber-700 dark:text-amber-400">{view.blocked}</p>}
      {view.kind === "compare" && !after && (
        <p className={`text-xs leading-normal ${mutedCls}`}>Importing never changes your calorie goal. After the import you can choose to match it.</p>
      )}
      {after && view.kind === "compare" && onMatch && view.pal !== undefined && (
        <>
          <button type="button" onClick={() => onMatch(view.pal!)} disabled={!view.canApply || busy || done} className={`${btnSecondary} w-full`}>
            {busy ? "Matching…" : done ? "Matched" : "Match my Lose It! calorie budget"}
          </button>
          <p className={`text-xs leading-normal ${mutedCls}`}>Optional. It adds a new calorie goal from today with Lose It!'s activity level ({view.pal}). Your older days and your other settings stay as they are.</p>
        </>
      )}
    </section>
  );
}
