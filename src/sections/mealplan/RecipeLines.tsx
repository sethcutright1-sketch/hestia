// The recipe line editor (phase 5c): the screen behind a recipe's calories. Each ingredient line shows what the
// reader found in it (its amount), whether a food is linked, and lets the person pick a food (from the best matches
// or a search), set the amount (servings or grams) and unlink. The recipe's calories per serving follow every
// change, and read "calories partly estimated" until no AI-estimated or unlinked line remains. The website's own
// figure, when the page gave one, sits beside the calculated one.
//
// Nothing here edits a line's text or its pantry name, so pantry and grocery matching (which read `ingredients`)
// keep working exactly as before. Yield, serving name and cooked weight are editable at the top.
// The pure parts (wording, request bodies, the yield form's checks) are in recipeLines.ts.

import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../../api.ts";
import { foodApi, errorText } from "../food/api.ts";
import AmountStep from "../food/AmountStep.tsx";
import type { AmountInput } from "../food/amount.ts";
import { SearchTab } from "../food/FoodPickers.tsx";
import type { Amount, Food } from "../food/types.ts";
import { Field, Notice, Sheet, btnPrimary, inputCls, mutedCls } from "../food/ui.tsx";
import {
  caloriesHeadline, lineAmountText, lineStatus, linkBody, parsedText, startFor, statusText, summarize, summaryText, unlinkBody,
  usableFoods, yieldBody, yieldChanged, yieldFormOf, type MatchCandidate, type MatchLine, type RecipeDetail, type RecipeLineDetail, type YieldForm,
} from "./recipeLines.ts";

const N = "/api/nutrition/recipes";

type SheetState =
  | { index: number; step: "pick" }
  | { index: number; step: "amount"; food: Food; start: AmountInput; approx: boolean };

const smallBtn =
  "min-h-9 px-3 rounded-full border border-slate-300 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50";

export default function RecipeLines({ recipeId, version, onChanged, onRequestUnlock }: {
  recipeId: string;
  /** The recipe's `updatedAt` in the list: when it differs from what is shown here (Calculate ran), the editor reads it again. */
  version: string;
  /** Tell the Recipes list to re-read (calories changed). */
  onChanged: () => void;
  onRequestUnlock?: () => void;
}) {
  const [detail, setDetail] = useState<RecipeDetail | null>(null);
  const [match, setMatch] = useState<MatchLine[] | null>(null);
  const [matchState, setMatchState] = useState<"loading" | "ready" | "failed">("loading");
  const [matchNote, setMatchNote] = useState("");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [sheet, setSheet] = useState<SheetState | null>(null);
  const [sheetError, setSheetError] = useState("");
  const [form, setForm] = useState<YieldForm>({ yieldServings: "", servingLabel: "", totalCookedG: "" });
  const [formError, setFormError] = useState("");
  const held = useRef<string>("");

  function fail(err: unknown, into: (s: string) => void = setError) {
    if (err instanceof ApiError && err.status === 423) onRequestUnlock?.();
    into(errorText(err));
  }

  function take(d: RecipeDetail) {
    held.current = d.updatedAt;
    setDetail(d);
    setForm(yieldFormOf(d));
  }

  async function loadMatch() {
    setMatchState("loading");
    try {
      const m = await api.post<{ lines: MatchLine[]; modelError?: string }>(`${N}/${recipeId}/match`, {});
      setMatch(m.lines);
      setMatchNote(m.modelError ? "The local model couldn't read every line, so a few amounts may be missing." : "");
      setMatchState("ready");
    } catch {
      setMatchState("failed");
    }
  }

  useEffect(() => {
    let cancelled = false;
    api.get<RecipeDetail>(`${N}/${recipeId}`)
      .then((d) => { if (!cancelled) take(d); })
      .catch((err) => { if (!cancelled) fail(err); });
    void loadMatch();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recipeId]);

  // Calculate (or another device) changed the recipe: read it again, and its matches, since the lines changed.
  useEffect(() => {
    if (!detail || version === held.current) return;
    let cancelled = false;
    api.get<RecipeDetail>(`${N}/${recipeId}`).then((d) => { if (!cancelled) take(d); }).catch(() => {});
    void loadMatch();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  async function save<T>(run: () => Promise<T>, then: (r: T) => void, into: (s: string) => void = setError) {
    if (busy) return;
    setBusy(true);
    into("");
    try {
      then(await run());
    } catch (err) {
      fail(err, into);
    } finally {
      setBusy(false);
    }
  }

  const saved = (d: RecipeDetail, message: string) => {
    take(d);
    setSheet(null);
    setNote(message);
    onChanged();
  };

  function saveLink(index: number, food: Food, body: Omit<Amount, "foodId">) {
    const line = detail?.lines[index];
    void save(
      () => api.post<RecipeDetail>(`${N}/${recipeId}/links`, linkBody(index, food.id, body)),
      (d) => saved(d, `Linked "${line?.text ?? "the line"}" to ${food.name}.`),
      setSheetError,
    );
  }

  function unlink(line: RecipeLineDetail) {
    void save(
      () => api.post<RecipeDetail>(`${N}/${recipeId}/links`, unlinkBody(line.index)),
      (d) => saved(d, `Took the food off "${line.text}".`),
    );
  }

  function saveYield() {
    if (!detail) return;
    const out = yieldBody(form);
    if ("error" in out) return setFormError(out.error);
    setFormError("");
    void save(
      () => api.put<RecipeDetail>(`${N}/${recipeId}`, out.body),
      (d) => saved(d, "Saved the servings."),
      setFormError,
    );
  }

  // The amount step needs the whole food (its serving rows); a candidate or a linked line only knows the id.
  async function openAmount(index: number, foodId: string, amount: MatchCandidate["amount"] | Partial<RecipeLineDetail> | null) {
    setSheetError("");
    try {
      const food = await foodApi.food(foodId);
      const a = amount ? { quantity: amount.quantity, servingId: amount.servingId, grams: amount.grams } : null;
      setSheet({ index, step: "amount", food, start: startFor(food, a), approx: !!(amount && "approx" in amount && amount.approx) });
    } catch (err) {
      fail(err, setSheetError);
    }
  }

  function chooseFood(index: number, food: Food) {
    const proposed = match?.find((m) => m.index === index)?.candidates.find((c) => c.foodId === food.id)?.amount ?? null;
    setSheetError("");
    setSheet({ index, step: "amount", food, start: startFor(food, proposed), approx: !!proposed?.approx });
  }

  if (!detail) {
    return error ? <Notice tone="error">{error}</Notice> : <p className={`text-xs ${mutedCls}`}>Loading the ingredient lines…</p>;
  }

  const head = caloriesHeadline(detail);
  const sum = summarize(detail.lines);
  const sheetLine = sheet ? detail.lines[sheet.index] : null;

  return (
    <div className="space-y-3 text-sm">
      {/* The recipe's calories follow every change below. */}
      <div className="rounded-lg bg-slate-50 dark:bg-slate-800/60 px-3 py-2" aria-live="polite">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="font-semibold text-slate-900 dark:text-slate-100">{head.main}</span>
          {head.partly && (
            <span className="px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/40 text-xs text-amber-800 dark:text-amber-300">{head.partly}</span>
          )}
          {head.site && <span className={`text-xs ${mutedCls}`}>· {head.site}</span>}
        </div>
        <div className={`text-xs ${mutedCls}`}>
          {head.origin ? `${head.origin}. ` : ""}Makes {detail.yieldServings ?? "?"}{detail.yieldAssumed ? " (assumed)" : ""}. {summaryText(sum)}.
        </div>
      </div>

      {error && <Notice tone="error">{error}</Notice>}
      {note && <Notice tone="ok">{note}</Notice>}

      <section aria-label="Servings">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-1.5">Servings</h4>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Makes (servings)" htmlFor={`y-${recipeId}`}>
            <input id={`y-${recipeId}`} type="number" inputMode="decimal" min="0.01" step="any" className={inputCls} value={form.yieldServings}
              onChange={(e) => setForm({ ...form, yieldServings: e.target.value })} />
          </Field>
          <Field label="One serving is a" htmlFor={`l-${recipeId}`}>
            <input id={`l-${recipeId}`} type="text" maxLength={40} placeholder="serving" className={inputCls} value={form.servingLabel}
              onChange={(e) => setForm({ ...form, servingLabel: e.target.value })} />
          </Field>
          <Field label="Cooked weight (g)" htmlFor={`g-${recipeId}`} hint="Optional: lets a serving be logged by grams.">
            <input id={`g-${recipeId}`} type="number" inputMode="decimal" min="0" step="any" className={inputCls} value={form.totalCookedG}
              onChange={(e) => setForm({ ...form, totalCookedG: e.target.value })} />
          </Field>
          <div className="flex items-start pt-5">
            <button className={btnPrimary} disabled={busy || !yieldChanged(form, detail)} onClick={saveYield}>Save servings</button>
          </div>
        </div>
        {formError && <div className="mt-2"><Notice tone="error">{formError}</Notice></div>}
      </section>

      <section aria-label="Ingredient lines">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-1">Ingredient lines</h4>
        {matchState === "loading" && <p className={`text-xs ${mutedCls}`}>Reading the amounts…</p>}
        {matchState === "failed" && <p className="text-xs text-amber-700 dark:text-amber-400">Couldn't read the amounts or look for matches. You can still search for a food.</p>}
        {matchNote && <p className="text-xs text-amber-700 dark:text-amber-400">{matchNote}</p>}
        <ul className="divide-y divide-slate-200 dark:divide-slate-800">
          {detail.lines.map((l) => {
            const status = lineStatus(l);
            const parsed = match?.find((m) => m.index === l.index)?.parsed;
            return (
              <li key={l.index} className="py-2.5 space-y-1">
                <div className="text-sm text-slate-900 dark:text-slate-100 break-words">{l.text}</div>
                {parsed && <div className={`text-xs ${mutedCls}`}>Read as: {parsedText(parsed)}</div>}
                <div className={`text-xs break-words ${
                  status === "linked" ? "text-emerald-700 dark:text-emerald-400"
                    : status === "none" || status === "broken" ? "text-amber-700 dark:text-amber-400" : mutedCls
                }`}>
                  {statusText(l)}
                </div>
                <div className="flex flex-wrap gap-1.5 pt-0.5">
                  <button className={smallBtn} disabled={busy} onClick={() => { setSheetError(""); setSheet({ index: l.index, step: "pick" }); }}
                    aria-label={`${l.foodId ? "Change the food for" : "Link a food to"} ${l.text}`}>
                    {l.foodId ? "Change food" : "Link a food"}
                  </button>
                  {l.foodId && (
                    <button className={smallBtn} disabled={busy} onClick={() => void openAmount(l.index, l.foodId!, l)} aria-label={`Set the amount for ${l.text}`}>
                      Amount{lineAmountText(l) ? `: ${lineAmountText(l)}` : ""}
                    </button>
                  )}
                  {(l.foodId || l.estimated) && (
                    <button className={smallBtn} disabled={busy} onClick={() => unlink(l)} aria-label={`${l.foodId ? "Unlink" : "Clear the estimate for"} ${l.text}`}>
                      {l.foodId ? "Unlink" : "Clear estimate"}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        <p className={`mt-2 text-xs ${mutedCls}`}>
          The pantry and shopping list keep using each line's own ingredient name, whatever food you link.
        </p>
      </section>

      {sheet && sheetLine && (
        <Sheet
          title={sheet.step === "pick" ? "Link a food" : sheet.food.name}
          onClose={() => setSheet(null)}
          back={sheet.step === "amount" ? { label: "Back", onClick: () => { setSheetError(""); setSheet({ index: sheet.index, step: "pick" }); } } : undefined}
        >
          <p className={`text-sm ${mutedCls}`}>For: <span className="text-slate-900 dark:text-slate-100">{sheetLine.text}</span></p>
          {sheet.step === "pick" && (
            <PickFood
              parsed={match?.find((m) => m.index === sheet.index)}
              matchState={matchState}
              scope={detail.scope}
              onCandidate={(c) => void openAmount(sheet.index, c.foodId, c.amount)}
              onFood={(f) => chooseFood(sheet.index, f)}
              error={sheetError}
            />
          )}
          {sheet.step === "amount" && (
            <AmountStep
              key={sheet.food.id}
              food={sheet.food}
              start={sheet.start}
              confirmLabel="Use this food"
              busy={busy}
              error={sheetError}
              above={sheet.approx ? <Notice tone="warn">This amount is a guess from the volume. Check it.</Notice> : undefined}
              onConfirm={(computed) => saveLink(sheet.index, sheet.food, computed.body)}
            />
          )}
        </Sheet>
      )}
    </div>
  );
}

function PickFood({ parsed, matchState, scope, onCandidate, onFood, error }: {
  parsed: MatchLine | undefined;
  matchState: "loading" | "ready" | "failed";
  scope: "joint" | "personal";
  onCandidate: (c: MatchCandidate) => void;
  onFood: (f: Food) => void;
  error: string;
}) {
  const candidates = parsed?.candidates ?? [];
  return (
    <div className="space-y-3">
      {error && <Notice tone="error">{error}</Notice>}
      <section className="space-y-1" aria-label="Best matches">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Best matches</h4>
        {matchState === "loading" && <p className={`text-sm ${mutedCls}`}>Looking for matches…</p>}
        {matchState === "failed" && <p className={`text-sm ${mutedCls}`}>Matches aren't available right now. Search below.</p>}
        {matchState === "ready" && candidates.length === 0 && (
          <p className={`text-sm ${mutedCls}`}>{parsed?.parsed.negligible ? "This line counts as nothing, so it needs no food." : "No close matches. Search below."}</p>
        )}
        <ul className="space-y-0.5">
          {candidates.map((c) => (
            <li key={c.foodId}>
              <button
                onClick={() => onCandidate(c)}
                className="w-full text-left flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <span className="flex-1 min-w-0">
                  <span className="block text-sm font-medium text-slate-900 dark:text-slate-100 break-words">
                    {c.name}
                    {c.scope === "personal" && (
                      <span className="ml-1.5 align-middle px-1.5 py-0.5 rounded bg-slate-200 dark:bg-slate-700 text-[10px] font-medium text-slate-700 dark:text-slate-300">Only me</span>
                    )}
                  </span>
                  <span className={`block text-xs ${mutedCls} truncate`}>
                    {[c.brand, c.confidence === "exact" ? "best match" : c.confidence === "possible" ? "possible match" : "weak match", candidateAmount(c)].filter(Boolean).join(" · ")}
                  </span>
                </span>
                <span className="shrink-0 text-right text-sm text-slate-800 dark:text-slate-200">
                  {Math.round(c.kcal)} kcal
                  <span className={`block text-xs ${mutedCls}`}>{c.basis === "per100g" ? "per 100 g" : "per serving"}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>
      <section className="space-y-1" aria-label="Search for a food">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Or search for a food</h4>
        <SearchTab autoFocus={false} onPick={onFood} only={(foods) => usableFoods(foods, scope)} />
      </section>
      <p className={`text-xs ${mutedCls}`}>
        {scope === "joint" ? "This recipe is shared, so only shared foods can be used (not ones marked Only me). " : ""}
        A recipe can't be an ingredient of another yet.
      </p>
    </div>
  );
}

/** "about 150 g" / "2 servings": what the line would be in this food, when the reader could tell. */
function candidateAmount(c: MatchCandidate): string {
  if (!c.amount) return "";
  const a = c.amount;
  const text = a.grams !== undefined ? `${Math.round(a.grams * 10) / 10} g` : a.quantity !== undefined ? `${Math.round(a.quantity * 100) / 100} serving${a.quantity === 1 ? "" : "s"}` : "";
  return text ? `${a.approx ? "about " : ""}${text}` : "";
}
