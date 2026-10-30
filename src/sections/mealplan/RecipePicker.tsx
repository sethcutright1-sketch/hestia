// A searchable recipe picker for the meal plan, in place of a long unsorted <select>. Type to narrow the list (name, ingredient
// or tag); favourites come first, then A to Z; each row shows the calories, your rating and the tags. Arrow keys and Enter work,
// Escape closes. `special` rows (like "A new dish…" or "Create one from this meal") sit above the recipes and are never filtered
// out. It only chooses: what happens next is the caller's, through onChange.

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Heart, Search, Star } from "lucide-react";
import type { Recipe } from "../../api.ts";
import { filterRecipes, kcalOf, sortRecipes, type Marks } from "./recipeList.ts";

export interface SpecialOption {
  id: string;
  label: string;
}

export default function RecipePicker({
  recipes,
  marks,
  value,
  onChange,
  special = [],
  placeholder,
  ariaLabel,
  compact = false,
  className = "",
}: {
  /** The recipes that may be chosen (the caller passes joint ones only for a shared plan). */
  recipes: Recipe[];
  marks: Marks;
  /** The chosen recipe id, or the id of a special row, or "". */
  value: string;
  onChange: (id: string) => void;
  special?: SpecialOption[];
  /** Shown on the button when nothing (or only a special row) is chosen. */
  placeholder: string;
  ariaLabel: string;
  compact?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);

  const shown = useMemo(() => sortRecipes(filterRecipes(recipes, marks, { query }), marks, "favorites"), [recipes, marks, query]);
  const rows = useMemo(() => [...(query.trim() ? [] : special).map((s) => ({ kind: "special" as const, ...s })), ...shown.map((r) => ({ kind: "recipe" as const, id: r.id, label: r.name, recipe: r }))], [shown, special, query]);
  const chosen = recipes.find((r) => r.id === value) ?? special.find((s) => s.id === value && s.id !== "");
  const buttonText = chosen ? ("name" in chosen ? chosen.name : chosen.label) : placeholder;

  useEffect(() => { if (open) search.current?.focus(); }, [open]);
  useEffect(() => setActive(0), [query, open]);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  function choose(id: string) {
    onChange(id);
    setOpen(false);
    setQuery("");
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(rows.length - 1, a + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); if (rows[active]) choose(rows[active].id); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setOpen(false); }
  }

  const size = compact ? "px-1.5 py-1 text-xs" : "px-2 py-1.5 text-sm";

  return (
    <div ref={root} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        className={`w-full flex items-center justify-between gap-1 text-left rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 ${size}`}
      >
        <span className="truncate">{buttonText}</span>
        <ChevronDown size={compact ? 12 : 14} className="shrink-0 text-slate-400" />
      </button>

      {open && (
        <div className="absolute z-40 mt-1 w-72 max-w-[85vw] rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-xl">
          <div className="flex items-center gap-1.5 px-2 border-b border-slate-200 dark:border-slate-800">
            <Search size={14} className="text-slate-400 shrink-0" />
            <input
              ref={search}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKey}
              placeholder="Search recipes…"
              aria-label="Search recipes"
              className="w-full py-2 text-sm bg-transparent outline-none"
            />
          </div>
          <ul role="listbox" aria-label={ariaLabel} className="max-h-64 overflow-y-auto py-1">
            {rows.length === 0 && <li className="px-3 py-2 text-sm text-slate-500 dark:text-slate-400">No recipe matches "{query}".</li>}
            {rows.map((row, i) => {
              const mark = row.kind === "recipe" ? marks[row.id] : undefined;
              const kcal = row.kind === "recipe" ? kcalOf(row.recipe) : null;
              return (
                <li
                  key={`${row.kind}-${row.id}`}
                  role="option"
                  aria-selected={row.id === value}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(row.id)}
                  className={`px-3 py-1.5 cursor-pointer text-sm ${i === active ? "bg-blue-50 dark:bg-slate-800" : ""} ${row.kind === "special" ? "text-slate-600 dark:text-slate-300 italic" : ""}`}
                >
                  <div className="flex items-center gap-1.5">
                    {mark?.favorite && <Heart size={12} className="text-rose-500 shrink-0" fill="currentColor" />}
                    <span className="flex-1 min-w-0 truncate">{row.label}</span>
                    {mark?.rating ? <span className="flex items-center text-xs text-amber-500 shrink-0"><Star size={11} fill="currentColor" />{mark.rating}</span> : null}
                    {kcal !== null && <span className="text-xs text-slate-400 shrink-0">{kcal} kcal</span>}
                  </div>
                  {row.kind === "recipe" && row.recipe.tags && row.recipe.tags.length > 0 && (
                    <div className="text-xs text-slate-400 truncate">{row.recipe.tags.join(" · ")}</div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
