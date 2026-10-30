// The Search, Recent and Recipes tabs of Add food: lists of foods you tap to go to the amount step.

import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { foodApi, errorText } from "./api.ts";
import { defaultKcal, defaultServingLabel } from "./amount.ts";
import type { Food, RecipeListItem } from "./types.ts";
import { Notice, inputCls, mutedCls } from "./ui.tsx";

/** One result: name, brand, a tag for a recipe or a food only you can see, and kcal per default serving. */
export function FoodRow({ food, onPick }: { food: Food; onPick: (food: Food) => void }) {
  return (
    <li>
      <button
        onClick={() => onPick(food)}
        className="w-full text-left flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800"
      >
        <span className="flex-1 min-w-0">
          <span className="block text-sm font-medium text-slate-900 dark:text-slate-100 break-words">
            {food.name}
            {food.recipeId && <Tag>Recipe</Tag>}
            {food.scope === "personal" && <Tag>Only me</Tag>}
          </span>
          {food.brand && <span className={`block text-xs ${mutedCls} truncate`}>{food.brand}</span>}
        </span>
        <span className="shrink-0 text-right text-sm text-slate-800 dark:text-slate-200">
          {defaultKcal(food)} kcal
          <span className={`block text-xs ${mutedCls}`}>{defaultServingLabel(food)}</span>
        </span>
      </button>
    </li>
  );
}

const Tag = ({ children }: { children: string }) => (
  <span className="ml-1.5 align-middle px-1.5 py-0.5 rounded bg-slate-200 dark:bg-slate-700 text-[10px] font-medium text-slate-700 dark:text-slate-300">
    {children}
  </span>
);

/**
 * The Search tab: your foods and the household's first, then the USDA list (the server orders them).
 * `only` drops results from the list (the recipe line editor uses it to leave out foods a recipe can't use).
 */
export function SearchTab({ onPick, only, autoFocus = true }: { onPick: (food: Food) => void; only?: (foods: Food[]) => Food[]; autoFocus?: boolean }) {
  const [q, setQ] = useState("");
  const [foods, setFoods] = useState<Food[] | null>(null);
  const [error, setError] = useState("");
  const seq = useRef(0);

  useEffect(() => {
    const term = q.trim();
    const mine = ++seq.current;
    if (!term) {
      setFoods(null);
      setError("");
      return;
    }
    const timer = window.setTimeout(() => {
      foodApi
        .search(term)
        .then((r) => {
          if (mine !== seq.current) return;
          setFoods(r);
          setError("");
        })
        .catch((err) => {
          if (mine !== seq.current) return;
          setFoods(null);
          setError(errorText(err));
        });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [q]);

  const shown = foods && only ? only(foods) : foods;
  return (
    <div className="space-y-2">
      <div className="relative">
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
        <input
          type="search"
          autoFocus={autoFocus}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search foods"
          aria-label="Search foods"
          enterKeyHint="search"
          autoComplete="off"
          className={`${inputCls} pl-9`}
        />
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {!error && foods === null && <p className={`text-sm ${mutedCls}`}>Type to search your foods, the household's, then the USDA list.</p>}
      {shown && shown.length === 0 && <p className={`text-sm ${mutedCls}`}>{only ? "No matches you can use here." : "No matches. Try Scan, or Create food."}</p>}
      {shown && shown.length > 0 && <ul className="space-y-0.5">{shown.map((f) => <FoodRow key={f.id} food={f} onPick={onPick} />)}</ul>}
    </div>
  );
}

/** The Recent tab: foods you actually ate in the last 60 days. */
export function RecentTab({ onPick }: { onPick: (food: Food) => void }) {
  const [foods, setFoods] = useState<Food[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    foodApi.recent().then(setFoods).catch((err) => setError(errorText(err)));
  }, []);

  if (error) return <Notice tone="error">{error}</Notice>;
  if (!foods) return <p className={`text-sm ${mutedCls}`}>Loading…</p>;
  if (foods.length === 0) return <p className={`text-sm ${mutedCls}`}>Foods you log will show up here.</p>;
  return <ul className="space-y-0.5">{foods.map((f) => <FoodRow key={f.id} food={f} onPick={onPick} />)}</ul>;
}

/**
 * The Recipes tab: the household's recipes with calories. A recipe is a read-only food, so tapping one goes
 * to the same amount step as any food. Making or editing a recipe happens in Meal Plan > Recipes.
 */
export function RecipesTab({ onPick }: { onPick: (food: Food) => void }) {
  const [recipes, setRecipes] = useState<RecipeListItem[] | null>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const [opening, setOpening] = useState<string | null>(null);

  useEffect(() => {
    foodApi.recipes().then(setRecipes).catch((err) => setError(errorText(err)));
  }, []);

  const shown = useMemo(() => {
    const term = filter.trim().toLowerCase();
    return (recipes ?? []).filter((r) => r.name.toLowerCase().includes(term));
  }, [recipes, filter]);

  async function open(r: RecipeListItem) {
    if (!r.foodId || opening) return;
    setOpening(r.id);
    setError("");
    try {
      onPick(await foodApi.food(r.foodId));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setOpening(null);
    }
  }

  if (error && !recipes) return <Notice tone="error">{error}</Notice>;
  if (!recipes) return <p className={`text-sm ${mutedCls}`}>Loading…</p>;
  return (
    <div className="space-y-2">
      <input
        type="search"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Search your recipes"
        aria-label="Search your recipes"
        className={inputCls}
      />
      {error && <Notice tone="error">{error}</Notice>}
      {recipes.length === 0 && <p className={`text-sm ${mutedCls}`}>No recipes yet. Add one in Meal Plan, under Recipes.</p>}
      {recipes.length > 0 && shown.length === 0 && <p className={`text-sm ${mutedCls}`}>No recipe matches that.</p>}
      <ul className="space-y-0.5">
        {shown.map((r) => {
          const usable = r.foodId !== null && r.kcalPerServing !== null;
          return (
            <li key={r.id}>
              <button
                disabled={!usable || opening !== null}
                onClick={() => open(r)}
                className="w-full text-left flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-60 disabled:hover:bg-transparent"
              >
                <span className="flex-1 min-w-0">
                  <span className="block text-sm font-medium text-slate-900 dark:text-slate-100 break-words">
                    {r.name}
                    <Tag>Recipe</Tag>
                    {r.scope === "personal" && <Tag>Only me</Tag>}
                  </span>
                  <span className={`block text-xs ${mutedCls}`}>
                    {usable
                      ? `Makes ${r.yieldServings ?? "?"} ${r.yieldServings === 1 ? "serving" : "servings"}${r.mine ? "" : " - shared"}`
                      : "No calories yet. Calculate them in Meal Plan > Recipes."}
                  </span>
                </span>
                {usable && (
                  <span className="shrink-0 text-right text-sm text-slate-800 dark:text-slate-200">
                    {Math.round(r.kcalPerServing!)} kcal
                    <span className={`block text-xs ${mutedCls}`}>per serving</span>
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
