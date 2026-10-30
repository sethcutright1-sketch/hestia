// What you can do with a whole meal of the diary (the "…" on a meal) or with the whole day: copy it to
// another day or meal, keep a meal as a saved meal, or turn it into a recipe (phase 5c: POST /recipes, one linked
// line per food eaten, so the recipe has calculated calories).
//
// Copying never asks the server how: the day on screen already says how to log each entry again (`relog`),
// so it is one bulk write per meal, with client ids and a shared groupId so the whole copy can be undone.
// A copy to a day after today lands as planned (the server's rule for future days). Only LOGGED entries are
// copied or saved; planned ones are intentions, not a meal.

import { useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import { foodApi, errorText } from "./api.ts";
import { kcalText } from "./calories.ts";
import { addDays, dayLabel, isValidLocalDate } from "./dates.ts";
import { amountOf, bulkBody, copyDayHint, itemsFromEntries, loggedMessage, mealKcal, newId, parseYield, recipeBody, recipeSavedMessage, suggestName } from "./meals.ts";
import type { DaySlot } from "./types.ts";
import type { Logged } from "./AddFood.tsx";
import { Field, Notice, Sheet, btnPrimary, inputCls, mutedCls } from "./ui.tsx";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

interface MenuProps {
  date: string;
  today: string;
  slot: DaySlot;
  /** Meals a copy may go into (switched on). */
  slots: Array<{ key: string; label: string }>;
  onClose: () => void;
  onDone: (logged: Logged) => void;
}

export function SlotMenu({ date, today, slot, slots, onClose, onDone }: MenuProps) {
  const [view, setView] = useState<"home" | "copy" | "save" | "recipe">("home");
  const { items, skipped, plannedLeftOut } = useMemo(() => itemsFromEntries(slot.entries), [slot.entries]);
  const none = items.length === 0;

  return (
    <Sheet
      title={view === "copy" ? `Copy ${slot.label}` : view === "save" ? "Save as meal" : view === "recipe" ? "Save as recipe" : slot.label}
      onClose={onClose}
      back={view === "home" ? undefined : { label: "Back", onClick: () => setView("home") }}
    >
      {view === "home" && (
        <>
          <p className={`text-sm ${mutedCls}`}>
            {none
              ? "Nothing in this meal can be copied or saved yet: only logged foods can (quick adds have no food behind them, and planned entries aren't eaten yet)."
              : `${plural(items.length, "item")}, ${kcalText(mealKcal(items))} kcal.${skipped.length ? ` ${plural(skipped.length, "quick add")} can't be included.` : ""}${plannedLeftOut ? ` ${plural(plannedLeftOut, "planned entry")} left out.` : ""}`}
          </p>
          <MenuButton title="Copy to…" hint="Another day or meal. A future day plans it." disabled={none} onClick={() => setView("copy")} />
          <MenuButton title="Save as meal" hint="Keep it as a one-tap meal in the Meals tab." disabled={none} onClick={() => setView("save")} />
          <MenuButton title="Save as recipe" hint="Add it to the household's recipes, with calories worked out from these foods." disabled={none} onClick={() => setView("recipe")} />
        </>
      )}
      {view === "copy" && <CopyForm date={date} today={today} slot={slot} slots={slots} onDone={onDone} />}
      {view === "save" && <SaveForm date={date} slot={slot} onDone={onDone} />}
      {view === "recipe" && <RecipeForm date={date} slot={slot} onDone={onDone} />}
    </Sheet>
  );
}

function MenuButton({ title, hint, disabled, onClick }: { title: string; hint: string; disabled: boolean; onClick: () => void }) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className="w-full flex items-center gap-3 text-left px-3 py-3 rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50"
    >
      <span className="flex-1 min-w-0">
        <span className="block text-sm font-medium text-slate-900 dark:text-slate-100">{title}</span>
        <span className={`block text-xs ${mutedCls}`}>{hint}</span>
      </span>
      <ChevronRight size={16} className="text-slate-400 shrink-0" />
    </button>
  );
}

/** Copy this meal to another day and meal. Default: tomorrow, the same meal. */
function CopyForm({ date, today, slot, slots, onDone }: Pick<MenuProps, "date" | "today" | "slot" | "slots" | "onDone">) {
  const { items, skipped } = useMemo(() => itemsFromEntries(slot.entries), [slot.entries]);
  const [target, setTarget] = useState(addDays(date, 1));
  const [into, setInto] = useState(slots.some((s) => s.key === slot.key) ? slot.key : slots[0]?.key ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function copy() {
    if (!isValidLocalDate(target)) return setError("Pick a day.");
    if (!into) return setError("Pick a meal.");
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const groupId = newId();
      await foodApi.bulk(target, bulkBody({ slot: into, items, groupId, ids: items.map(() => newId()) }));
      const intoLabel = slots.find((s) => s.key === into)?.label ?? into;
      onDone({
        message: loggedMessage({ count: items.length, skippedCount: skipped.length, where: `${intoLabel}, ${dayLabel(target, today)}`, planned: target > today }),
        undo: async () => { await foodApi.deleteGroup(groupId); },
      });
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <Field label="Copy to day" htmlFor="copy-date">
        <input id="copy-date" type="date" className={inputCls} value={target} onChange={(e) => setTarget(e.target.value)} />
      </Field>
      <Field label="Into meal" htmlFor="copy-slot">
        <select id="copy-slot" className={inputCls} value={into} onChange={(e) => setInto(e.target.value)}>
          {slots.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
      </Field>
      <p className={`text-sm ${mutedCls}`}>{isValidLocalDate(target) ? copyDayHint(target, today) : ""}</p>
      {error && <Notice tone="error">{error}</Notice>}
      <button className={`${btnPrimary} w-full`} disabled={busy} onClick={copy}>
        Copy {plural(items.length, "item")}
      </button>
    </div>
  );
}

/** Save this meal as a saved meal. Shared with the household unless "Only me" is on. */
function SaveForm({ date, slot, onDone }: Pick<MenuProps, "date" | "slot" | "onDone">) {
  const { items } = useMemo(() => itemsFromEntries(slot.entries), [slot.entries]);
  const [name, setName] = useState(suggestName(items));
  const [onlyMe, setOnlyMe] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function save() {
    const n = name.trim();
    if (!n) return setError("Give the meal a name.");
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const meal = await foodApi.saveMeal({
        name: n,
        scope: onlyMe ? "personal" : "joint",
        defaultSlotKey: slot.key,
        items: items.map((i) => ({ foodId: i.foodId!, ...amountOf(i) })),
      });
      onDone({ message: `Saved "${meal.name}" (${plural(meal.items.length, "item")}).` });
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <Field label="Name" htmlFor="sm-name">
        <input id="sm-name" type="text" maxLength={120} className={inputCls} value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <label className="flex items-start gap-2.5 text-sm text-slate-800 dark:text-slate-200">
        <input type="checkbox" className="mt-1" checked={onlyMe} onChange={(e) => setOnlyMe(e.target.checked)} />
        <span>
          <span className="font-medium">Only me</span>
          <span className={`block text-xs ${mutedCls}`}>Off: the household can log this meal too (every food in it must be shared). On: only you.</span>
        </span>
      </label>
      {error && <Notice tone="error">{error}</Notice>}
      <button className={`${btnPrimary} w-full`} disabled={busy} onClick={save}>
        Save meal
      </button>
      <p className={`text-xs ${mutedCls}`}>Saved from {slot.label} on {date}. Meals you already logged are not changed.</p>
    </div>
  );
}

/**
 * Save this meal as a NEW recipe in the household's recipe book: one line per food eaten, each linked to its food
 * at the amount eaten, so the recipe has calculated calories straight away. It never replaces a recipe (the server
 * answers 409 for a name already taken). "Only me" keeps it personal; a meal that holds a personal food needs it
 * (the server says so otherwise), and a personal recipe can't go on the shared meal plan.
 */
function RecipeForm({ date, slot, onDone }: Pick<MenuProps, "date" | "slot" | "onDone">) {
  const { items, skipped } = useMemo(() => itemsFromEntries(slot.entries), [slot.entries]);
  const [name, setName] = useState(suggestName(items));
  const [servings, setServings] = useState("1");
  const [onlyMe, setOnlyMe] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const makes = parseYield(servings);
  const total = mealKcal(items);

  async function save() {
    const n = name.trim();
    if (!n) return setError("Give the recipe a name.");
    if (makes === null) return setError("Say how many servings it makes (a number above 0).");
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const scope = onlyMe ? "personal" : "joint";
      const recipe = await foodApi.createRecipe(recipeBody({ name: n, onlyMe, yieldServings: makes, items }));
      onDone({ message: recipeSavedMessage(recipe, scope) });
    } catch (err) {
      const text = errorText(err);
      setError(/personal food/i.test(text) && !onlyMe ? `${text} Or switch on "Only me" to keep the recipe to yourself.` : text);
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <Field label="Recipe name" htmlFor="sr-name">
        <input id="sr-name" type="text" maxLength={120} className={inputCls} value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="This makes (servings)" htmlFor="sr-servings" hint="1 if this is one portion, as you ate it. More if the foods are a batch.">
        <input id="sr-servings" type="number" inputMode="decimal" min="0.01" step="any" className={inputCls} value={servings} onChange={(e) => setServings(e.target.value)} onFocus={(e) => e.currentTarget.select()} />
      </Field>
      <p className={`text-sm ${mutedCls}`} aria-live="polite">
        {plural(items.length, "line")}, {kcalText(total)} kcal in all{makes !== null ? `, ${kcalText(total / makes)} kcal per serving` : ""}.
        {skipped.length > 0 ? ` ${plural(skipped.length, "quick add")} can't be included (no food behind it), so the recipe leaves ${skipped.length === 1 ? "it" : "them"} out.` : ""}
      </p>
      <label className="flex items-start gap-2.5 text-sm text-slate-800 dark:text-slate-200">
        <input type="checkbox" className="mt-1" checked={onlyMe} onChange={(e) => setOnlyMe(e.target.checked)} />
        <span>
          <span className="font-medium">Only me</span>
          <span className={`block text-xs ${mutedCls}`}>Off: it joins the household's recipes and can go on the meal plan (every food in it must be shared). On: only you can see it, and it can't go on the shared plan.</span>
        </span>
      </label>
      {error && <Notice tone="error">{error}</Notice>}
      <button className={`${btnPrimary} w-full`} disabled={busy} onClick={save}>
        Save recipe
      </button>
      <p className={`text-xs ${mutedCls}`}>Made from {slot.label} on {date}. Your diary is not changed. You'll find it under Meal Plan, Recipes.</p>
    </div>
  );
}

/** Copy every meal of the day on screen to another day, into the same meals. One Undo takes the whole copy back. */
export function CopyDaySheet({ date, today, slots, onClose, onDone }: {
  date: string;
  today: string;
  slots: DaySlot[];
  onClose: () => void;
  onDone: (logged: Logged) => void;
}) {
  const groups = useMemo(
    () => slots.filter((s) => s.enabled).map((s) => ({ slot: s, ...itemsFromEntries(s.entries) })).filter((g) => g.items.length > 0),
    [slots],
  );
  const total = groups.reduce((a, g) => a + g.items.length, 0);
  const skippedCount = slots.reduce((a, s) => a + itemsFromEntries(s.entries).skipped.length, 0);
  const [target, setTarget] = useState(addDays(date, 1));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function copy() {
    if (!isValidLocalDate(target)) return setError("Pick a day.");
    if (target === date) return setError("Pick a different day to copy to.");
    if (busy) return;
    setBusy(true);
    setError("");
    const groupId = newId();
    try {
      for (const g of groups) {
        await foodApi.bulk(target, bulkBody({ slot: g.slot.key, items: g.items, groupId, ids: g.items.map(() => newId()) }));
      }
      onDone({
        message: loggedMessage({ count: total, skippedCount, where: dayLabel(target, today), planned: target > today }),
        undo: async () => { await foodApi.deleteGroup(groupId); },
      });
    } catch (err) {
      // Some meals may already be copied; take them back so a half copy never stays.
      await foodApi.deleteGroup(groupId).catch(() => {});
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <Sheet title="Copy day to…" onClose={onClose}>
      {total === 0 ? (
        <p className={`text-sm ${mutedCls}`}>Nothing on this day can be copied: only logged foods can (quick adds have no food behind them).</p>
      ) : (
        <>
          <p className={`text-sm ${mutedCls}`}>
            {plural(total, "item")} in {plural(groups.length, "meal")} ({groups.map((g) => g.slot.label).join(", ")}) go into the same meals on the day you pick.
          </p>
          <Field label="Copy to day" htmlFor="copyday-date">
            <input id="copyday-date" type="date" className={inputCls} value={target} onChange={(e) => setTarget(e.target.value)} />
          </Field>
          <p className={`text-sm ${mutedCls}`}>{isValidLocalDate(target) ? copyDayHint(target, today) : ""}</p>
          {error && <Notice tone="error">{error}</Notice>}
          <button className={`${btnPrimary} w-full`} disabled={busy} onClick={copy}>
            Copy {plural(total, "item")}
          </button>
        </>
      )}
    </Sheet>
  );
}
