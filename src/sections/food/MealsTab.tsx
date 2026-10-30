// The Meals tab of Add food: saved meals and previous meals, each one tap to log into the meal and day the
// sheet is for. One bulk diary write with client ids and a shared groupId, so the whole thing can be undone.
// A saved meal can also be renamed or deleted from its "..." (phase 5c).

import { useEffect, useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { foodApi, errorText } from "./api.ts";
import { kcalText } from "./calories.ts";
import { whenLabel } from "./dates.ts";
import { bulkBody, loggable, mealKcal, mealNameProblem, newId, previousFor } from "./meals.ts";
import type { MealItem, PreviousMeal, SavedMeal } from "./types.ts";
import type { Logged } from "./AddFood.tsx";
import { Notice, btnDanger, btnPrimary, btnSecondary, inputCls, mutedCls } from "./ui.tsx";

interface Props {
  date: string;
  today: string;
  slot: string;
  slotLabel: string;
  onLogged: (logged: Logged) => void;
}

const names = (items: MealItem[]) => items.map((i) => i.name).join(", ");
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export default function MealsTab({ date, today, slot, slotLabel, onLogged }: Props) {
  const [saved, setSaved] = useState<SavedMeal[] | null>(null);
  const [previous, setPrevious] = useState<PreviousMeal[] | null>(null);
  const [savedError, setSavedError] = useState("");
  const [previousError, setPreviousError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    foodApi.savedMeals().then(setSaved).catch((e) => setSavedError(errorText(e)));
    foodApi.previousMeals().then(setPrevious).catch((e) => setPreviousError(errorText(e)));
  }, []);

  async function log(items: MealItem[], skippedCount: number) {
    const todo = loggable(items);
    if (todo.length === 0) {
      setError("Nothing in that meal can be logged.");
      return;
    }
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const groupId = newId();
      const res = await foodApi.bulk(date, bulkBody({ slot, items: todo, groupId, ids: todo.map(() => newId()) }));
      const planned = date > today;
      const skipNote = skippedCount > 0 ? ` (${plural(skippedCount, "item")} couldn't be logged)` : "";
      onLogged({
        message: `${planned ? "Planned" : "Added"} ${plural(res.created || todo.length, "item")} ${planned ? "for" : "to"} ${slotLabel}${skipNote}.`,
        undo: async () => { await foodApi.deleteGroup(groupId); },
      });
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  const previousList = previous ? previousFor(previous, date, slot) : null;

  return (
    <div className="space-y-4">
      {error && <Notice tone="error">{error}</Notice>}

      <section className="space-y-1">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Saved meals</h4>
        {savedError && <Notice tone="error">{savedError}</Notice>}
        {!saved && !savedError && <p className={`text-sm ${mutedCls}`}>Loading…</p>}
        {saved && saved.length === 0 && (
          <p className={`text-sm ${mutedCls}`}>No saved meals yet. Open a meal's … menu in your diary and choose Save as meal.</p>
        )}
        <ul className="space-y-0.5">
          {saved?.map((m) => {
            const gone = m.items.length - loggable(m.items).length;
            return (
              <SavedMealRow
                key={m.id}
                meal={m}
                warn={gone > 0 ? `${plural(gone, "item")} can't be logged (food removed).` : null}
                disabled={busy}
                onLog={() => log(m.items, gone)}
                onRenamed={(renamed) =>
                  setSaved((cur) => cur && cur.map((x) => (x.id === renamed.id ? { ...x, name: renamed.name } : x)).sort((a, b) => a.name.localeCompare(b.name)))}
                onDeleted={() => setSaved((cur) => cur && cur.filter((x) => x.id !== m.id))}
              />
            );
          })}
        </ul>
      </section>

      <section className="space-y-1">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Previous meals</h4>
        {previousError && <Notice tone="error">{previousError}</Notice>}
        {!previous && !previousError && <p className={`text-sm ${mutedCls}`}>Loading…</p>}
        {previousList && previousList.length === 0 && <p className={`text-sm ${mutedCls}`}>Meals you log will show up here.</p>}
        <ul className="space-y-0.5">
          {previousList?.map((m) => (
            <li key={m.key}>
              <MealRowBody
                title={`${whenLabel(m.date, today)} - ${m.slotLabel}`}
                scopeTag={null}
                detail={names(m.items)}
                warn={
                  [
                    m.quickAddCount > 0 ? `${plural(m.quickAddCount, "quick add")} won't be logged again.` : "",
                    m.unavailableCount > 0 ? `${plural(m.unavailableCount, "item")} can't be logged (food removed).` : "",
                  ].filter(Boolean).join(" ") || null
                }
                kcal={m.kcal}
                count={loggable(m.items).length}
                disabled={busy}
                onClick={() => log(m.items, m.quickAddCount + m.unavailableCount)}
              />
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

/**
 * A saved meal: one tap logs it; the "..." opens Rename and Delete. The server lets anyone who can see a saved
 * meal rename or delete it, a shared one included (only changing WHO it is shared with is its saver's), so the
 * screen offers both to everyone and says so before deleting a shared one. Meals already logged from it never change.
 */
function SavedMealRow({ meal, warn, disabled, onLog, onRenamed, onDeleted }: {
  meal: SavedMeal;
  warn: string | null;
  disabled: boolean;
  onLog: () => void;
  onRenamed: (meal: SavedMeal) => void;
  onDeleted: () => void;
}) {
  const [mode, setMode] = useState<"closed" | "menu" | "rename" | "delete">("closed");
  const [name, setName] = useState(meal.name);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const shared = meal.scope === "joint";

  function close() {
    setMode("closed");
    setError("");
    setBusy(false);
  }

  async function rename() {
    const problem = mealNameProblem(name);
    if (problem) return setError(problem);
    if (busy) return;
    if (name.trim() === meal.name) return close();
    setBusy(true);
    setError("");
    try {
      onRenamed(await foodApi.renameSavedMeal(meal.id, name.trim()));
      close();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  async function remove() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await foodApi.deleteSavedMeal(meal.id);
      onDeleted();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <li>
      <div className="flex items-start">
        <div className="flex-1 min-w-0">
          <MealRowBody
            title={meal.name}
            scopeTag={meal.scope === "personal" ? "Only me" : null}
            detail={names(meal.items)}
            warn={warn}
            kcal={mealKcal(meal.items)}
            count={loggable(meal.items).length}
            disabled={disabled}
            onClick={onLog}
          />
        </div>
        <button
          onClick={() => (mode === "closed" ? setMode("menu") : close())}
          aria-label={`Rename or delete ${meal.name}`}
          aria-expanded={mode !== "closed"}
          className="shrink-0 mt-1 p-2.5 rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
        >
          <MoreHorizontal size={18} />
        </button>
      </div>

      {mode !== "closed" && (
        <div className="mx-3 mb-2 p-3 rounded-lg bg-slate-50 dark:bg-slate-800/60 space-y-2">
          {mode === "menu" && (
            <div className="flex flex-wrap gap-2">
              <button className={btnSecondary} onClick={() => { setName(meal.name); setMode("rename"); }}>Rename</button>
              <button className={btnDanger} onClick={() => setMode("delete")}>Delete</button>
            </div>
          )}
          {mode === "rename" && (
            <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); void rename(); }}>
              <input
                type="text"
                maxLength={120}
                autoFocus
                className={inputCls}
                value={name}
                aria-label={`New name for ${meal.name}`}
                onChange={(e) => setName(e.target.value)}
                onFocus={(e) => e.currentTarget.select()}
              />
              <div className="flex gap-2">
                <button className={btnPrimary} disabled={busy}>Save name</button>
                <button type="button" className={btnSecondary} onClick={close}>Cancel</button>
              </div>
            </form>
          )}
          {mode === "delete" && (
            <div className="space-y-2">
              <p className="text-sm text-slate-800 dark:text-slate-200">
                Delete "{meal.name}"? {shared ? "It is shared with the household, so it goes for everyone. " : ""}
                Meals you already logged from it stay as they are.
              </p>
              <div className="flex gap-2">
                <button className={btnDanger} disabled={busy} onClick={remove}>Delete</button>
                <button className={btnSecondary} onClick={close}>Keep</button>
              </div>
            </div>
          )}
          {error && <Notice tone="error">{error}</Notice>}
        </div>
      )}
    </li>
  );
}

function MealRowBody(p: {
  title: string;
  scopeTag: string | null;
  detail: string;
  warn: string | null;
  kcal: number;
  count: number;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={p.onClick}
      disabled={p.disabled}
      className="w-full text-left flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-60"
    >
      <span className="flex-1 min-w-0">
        <span className="block text-sm font-medium text-slate-900 dark:text-slate-100 break-words">
          {p.title}
          {p.scopeTag && (
            <span className="ml-1.5 align-middle px-1.5 py-0.5 rounded bg-slate-200 dark:bg-slate-700 text-[10px] font-medium text-slate-700 dark:text-slate-300">
              {p.scopeTag}
            </span>
          )}
        </span>
        <span className={`block text-xs ${mutedCls} line-clamp-2`}>{p.detail}</span>
        {p.warn && <span className="block text-xs text-amber-700 dark:text-amber-400">{p.warn}</span>}
      </span>
      <span className="shrink-0 text-right text-sm text-slate-800 dark:text-slate-200">
        {kcalText(p.kcal)} kcal
        <span className={`block text-xs ${mutedCls}`}>{plural(p.count, "item")}</span>
      </span>
    </button>
  );
}
