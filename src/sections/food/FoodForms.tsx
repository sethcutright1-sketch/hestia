// The Quick add and Create food tabs of Add food.

import { useState } from "react";
import { foodApi, errorText } from "./api.ts";
import { NUTRIENT_FIELDS, buildCreateFood, buildQuickAdd, emptyCreateFood, type CreateFoodForm } from "./forms.ts";
import { newId } from "./meals.ts";
import type { Food } from "./types.ts";
import type { Logged } from "./AddFood.tsx";
import { Field, Notice, btnPrimary, inputCls, mutedCls } from "./ui.tsx";

/** Quick add: calories (and optionally macros) plus a name, with no food behind it. */
export function QuickAddTab({ date, slot, slotLabel, today, onLogged }: { date: string; slot: string; slotLabel: string; today: string; onLogged: (l: Logged) => void }) {
  const [f, setF] = useState({ kcal: "", name: "", protein: "", carbs: "", fat: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const built = buildQuickAdd(f, slot, newId());
    if (!built.ok) {
      setError(built.error);
      return;
    }
    setBusy(true);
    setError("");
    try {
      await foodApi.addQuick(date, built.body);
      onLogged({
        message: `${date > today ? "Planned" : "Added"} ${built.body.name ?? "Quick Add"} (${Math.round(built.body.kcal)} kcal) ${date > today ? "for" : "to"} ${slotLabel}.`,
        undo: async () => { await foodApi.deleteEntry(built.body.id); },
      });
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <p className={`text-sm ${mutedCls}`}>Only calories are required.</p>
      <Field label="Calories (kcal)" htmlFor="qa-kcal">
        <input id="qa-kcal" type="number" inputMode="decimal" min="0" step="any" autoFocus className={inputCls} value={f.kcal} onChange={set("kcal")} />
      </Field>
      <Field label="Name (optional)" htmlFor="qa-name">
        <input id="qa-name" type="text" maxLength={200} placeholder="Quick Add" className={inputCls} value={f.name} onChange={set("name")} />
      </Field>
      <div className="grid grid-cols-3 gap-2">
        <Field label="Protein g" htmlFor="qa-p">
          <input id="qa-p" type="number" inputMode="decimal" min="0" step="any" className={inputCls} value={f.protein} onChange={set("protein")} />
        </Field>
        <Field label="Carbs g" htmlFor="qa-c">
          <input id="qa-c" type="number" inputMode="decimal" min="0" step="any" className={inputCls} value={f.carbs} onChange={set("carbs")} />
        </Field>
        <Field label="Fat g" htmlFor="qa-f">
          <input id="qa-f" type="number" inputMode="decimal" min="0" step="any" className={inputCls} value={f.fat} onChange={set("fat")} />
        </Field>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      <button type="submit" disabled={busy} className={`${btnPrimary} w-full`}>
        Add to {slotLabel}
      </button>
    </form>
  );
}

export interface CreateFoodPrefill {
  name?: string;
  brand?: string;
  barcode?: string;
  note?: string;
}

/** Create food: name, brand, serving size and unit, calories and nutrients, an optional barcode, and the "Only me" switch. */
export function CreateFoodTab({ prefill, onCreated }: { prefill?: CreateFoodPrefill; onCreated: (food: Food) => void }) {
  const [f, setF] = useState<CreateFoodForm>(() => ({
    ...emptyCreateFood(), name: prefill?.name ?? "", brand: prefill?.brand ?? "", barcode: prefill?.barcode ?? "",
  }));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const text = (k: "name" | "brand" | "barcode" | "servingLabel" | "servingGrams") => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const per100 = f.basis === "per100g";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const built = buildCreateFood(f);
    if (!built.ok) {
      setError(built.error);
      return;
    }
    setBusy(true);
    setError("");
    try {
      onCreated(await foodApi.createFood(built.body));
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      {prefill?.note && <Notice tone="warn">{prefill.note}</Notice>}
      <Field label="Name" htmlFor="cf-name">
        <input id="cf-name" type="text" maxLength={200} autoFocus={!prefill?.name} className={inputCls} value={f.name} onChange={text("name")} />
      </Field>
      <Field label="Brand (optional)" htmlFor="cf-brand">
        <input id="cf-brand" type="text" maxLength={100} className={inputCls} value={f.brand} onChange={text("brand")} />
      </Field>
      <Field label="Barcode (optional)" htmlFor="cf-code">
        <input id="cf-code" type="text" inputMode="numeric" className={inputCls} value={f.barcode} onChange={text("barcode")} />
      </Field>
      <Field label="Nutrition facts are" htmlFor="cf-basis">
        <select id="cf-basis" className={inputCls} value={f.basis} onChange={(e) => setF({ ...f, basis: e.target.value as CreateFoodForm["basis"] })}>
          <option value="per_serving">Per serving (from the label)</option>
          <option value="per100g">Per 100 g</option>
        </select>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={per100 ? "Extra serving name (optional)" : "Serving size name"} htmlFor="cf-slabel">
          <input id="cf-slabel" type="text" placeholder="e.g. 1 bar, 1 cup" className={inputCls} value={f.servingLabel} onChange={text("servingLabel")} />
        </Field>
        <Field label={per100 ? "Extra serving weight g" : "Serving weight g (optional)"} htmlFor="cf-sgrams">
          <input id="cf-sgrams" type="number" inputMode="decimal" min="0" step="any" className={inputCls} value={f.servingGrams} onChange={text("servingGrams")} />
        </Field>
      </div>
      <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 pt-1">
        Nutrition {per100 ? "per 100 g" : "per serving"}
      </h4>
      <div className="grid grid-cols-2 gap-3">
        {NUTRIENT_FIELDS.map(({ key, label }) => (
          <Field key={key} label={label} htmlFor={`cf-${key}`}>
            <input
              id={`cf-${key}`}
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              className={inputCls}
              value={f.nutrients[key] ?? ""}
              onChange={(e) => setF({ ...f, nutrients: { ...f.nutrients, [key]: e.target.value } })}
            />
          </Field>
        ))}
      </div>
      <label className="flex items-start gap-2.5 text-sm text-slate-800 dark:text-slate-200">
        <input type="checkbox" className="mt-1" checked={f.onlyMe} onChange={(e) => setF({ ...f, onlyMe: e.target.checked })} />
        <span>
          <span className="font-medium">Only me</span>
          <span className={`block text-xs ${mutedCls}`}>
            Off: the whole household can find and log this food. On: only you can see it.
          </span>
        </span>
      </label>
      {error && <Notice tone="error">{error}</Notice>}
      <button type="submit" disabled={busy} className={`${btnPrimary} w-full`}>
        Save and continue
      </button>
    </form>
  );
}
