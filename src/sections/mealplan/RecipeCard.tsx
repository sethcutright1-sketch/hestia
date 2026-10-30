// One recipe in the Recipes tab's list: photo, name, your favourite and rating, tags, times, calories, and the row's actions
// (view, edit, calculate, delete). The expanded part (the calorie line editor, or the read-only lines for the kitchen screen) is
// the parent's, passed as children, so this stays about the row.

import type { ReactNode } from "react";
import { ChevronDown, ChevronRight, BookOpen, Pencil, Calculator, Trash2, Camera } from "lucide-react";
import type { Recipe, RecipeMark } from "../../api.ts";
import { photoUrl, timesText } from "./recipeList.ts";
import { FavoriteButton, RatingStars } from "./StarRating.tsx";

/** "320 kcal" with the one-word honesty the figure deserves. */
function Calories({ recipe }: { recipe: Recipe }) {
  const n = recipe.nutrition;
  if (!n) return <span className="text-slate-400 dark:text-slate-500">no calories yet</span>;
  const kcal = Math.round(n.perServing.kcal);
  const site = n.siteKcalPerServing !== undefined ? Math.round(n.siteKcalPerServing) : null;
  return (
    <span>
      <span className="font-medium text-slate-700 dark:text-slate-200">{kcal} kcal</span> per serving
      {n.origin === "site" && " (from the website)"}
      {n.origin !== "site" && !n.complete && (
        <span className="ml-1.5 px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-300">calories partly estimated</span>
      )}
      {n.origin !== "site" && site !== null && <span className="ml-1.5">· website says {site}</span>}
    </span>
  );
}

const rowBtn = "px-2 py-1 rounded-lg text-xs flex items-center gap-1 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 shrink-0";

export default function RecipeCard({
  recipe: r,
  mark,
  canMark,
  canEdit,
  canCalculate,
  calculating,
  open,
  onToggle,
  onView,
  onEdit,
  onCalculate,
  onDelete,
  onMark,
  onTag,
  children,
}: {
  recipe: Recipe;
  mark?: RecipeMark;
  canMark: boolean;
  canEdit: boolean;
  canCalculate: boolean;
  calculating: boolean;
  /** Something else is being calculated: every Calculate button waits. */
  open: boolean;
  onToggle: () => void;
  onView: () => void;
  onEdit: () => void;
  onCalculate: () => void;
  onDelete: () => void;
  onMark: (change: { favorite?: boolean; rating?: number | null }) => void;
  /** A tag was tapped: filter the list by it. */
  onTag: (tag: string) => void;
  children?: ReactNode;
}) {
  const photo = photoUrl(r);
  const times = timesText(r);
  return (
    <li className="py-2.5">
      {/* On a phone the actions drop to their own line under the details; from sm up everything shares one row. */}
      <div className="flex flex-wrap sm:flex-nowrap items-start gap-x-3 gap-y-2">
        <button
          onClick={onToggle}
          className="mt-0.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 shrink-0"
          aria-label={open ? `Hide ${r.name} details` : `Show ${r.name} details`}
          aria-expanded={open}
        >
          {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        </button>
        {photo ? (
          <img src={photo} alt="" loading="lazy" className="w-14 h-14 rounded-lg object-cover bg-slate-100 dark:bg-slate-800 shrink-0" />
        ) : (
          <div className="w-14 h-14 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-300 dark:text-slate-600 flex items-center justify-center shrink-0 hidden sm:flex" aria-hidden="true">
            <Camera size={18} />
          </div>
        )}
        <div className="flex-1 min-w-0 basis-0 sm:basis-auto">
          <div className="text-sm flex items-center flex-wrap gap-x-1">
            <span>{r.name}</span>
            {r.scope === "personal" && (
              <span className="ml-1 px-1.5 py-0.5 rounded text-[10px] bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400">only me</span>
            )}
            {canMark && (
              <span className="inline-flex items-center ml-1">
                <FavoriteButton favorite={!!mark?.favorite} onChange={(favorite) => onMark({ favorite })} label={r.name} size={14} />
                <RatingStars rating={mark?.rating ?? null} onChange={(rating) => onMark({ rating })} label={r.name} size={13} />
              </span>
            )}
          </div>
          {r.tags && r.tags.length > 0 && (
            <div className="mt-0.5 flex flex-wrap gap-1">
              {r.tags.map((t) => (
                <button key={t} onClick={() => onTag(t)} className="px-1.5 py-0.5 rounded-full text-[10px] bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700" title={`Show only ${t}`}>
                  {t}
                </button>
              ))}
            </div>
          )}
          <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{r.ingredients.join(", ")}</div>
          <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            <Calories recipe={r} />
            {r.yieldServings !== undefined && <span> · makes {r.yieldServings}{r.yieldAssumed ? " (assumed)" : ""}</span>}
            {times && <span> · {times}</span>}
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0 basis-full sm:basis-auto pl-7 sm:pl-0">
        <button onClick={onView} className={rowBtn} aria-label={`View ${r.name}`}>
          <BookOpen size={12} /> View
        </button>
        {canEdit && (
          <button onClick={onEdit} className={rowBtn} aria-label={`Edit ${r.name}`}>
            <Pencil size={12} /> Edit
          </button>
        )}
        {canCalculate && (
          <button onClick={onCalculate} disabled={calculating} className={`${rowBtn} disabled:opacity-50`} aria-label={`Calculate calories for ${r.name}`}>
            <Calculator size={12} />
            {calculating ? "Working…" : "Calculate"}
          </button>
        )}
        {canEdit && (
          <button onClick={onDelete} className="ml-auto sm:ml-1 p-1 text-slate-400 hover:text-red-600 dark:hover:text-red-400 shrink-0" aria-label={`Delete ${r.name}`}>
            <Trash2 size={15} />
          </button>
        )}
        </div>
      </div>
      {open && children}
    </li>
  );
}
