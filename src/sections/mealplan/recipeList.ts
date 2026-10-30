// Finding a recipe: the search, tag / favourites / rating filters and the sort orders the Recipes tab and the meal plan's
// recipe picker share, as plain functions so they can be tested without a browser. Nothing here fetches or changes anything.
// `marks` are THIS login's own favourites and ratings (the server sends only those), by recipe id.

import type { Recipe, RecipeMark } from "../../api.ts";

export type Marks = Record<string, RecipeMark | undefined>;

export type SortKey = "name" | "newest" | "rating" | "favorites" | "kcal" | "quickest";

export const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: "name", label: "Name" },
  { key: "favorites", label: "Favourites first" },
  { key: "rating", label: "Best rated" },
  { key: "newest", label: "Newest" },
  { key: "kcal", label: "Fewest calories" },
  { key: "quickest", label: "Quickest" },
];

export interface RecipeFilter {
  /** Words that must each appear in the name, an ingredient or a tag (any order, any case). */
  query?: string;
  /** Only recipes with this tag. */
  tag?: string;
  favoritesOnly?: boolean;
  /** Only recipes this login rated at least this many stars. */
  minRating?: number;
}

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();

/** Everything a search looks through for one recipe, lower case. */
function haystack(r: Recipe): string {
  const lines = (r.lines ?? []).map((l) => l.text);
  return norm([r.name, ...r.ingredients, ...lines, ...(r.tags ?? [])].join(" \n "));
}

export function matchesQuery(r: Recipe, query: string | undefined): boolean {
  const words = norm(query ?? "").split(" ").filter(Boolean);
  if (words.length === 0) return true;
  const text = haystack(r);
  return words.every((w) => text.includes(w));
}

export function filterRecipes(recipes: Recipe[], marks: Marks, f: RecipeFilter): Recipe[] {
  const tag = f.tag ? norm(f.tag) : "";
  return recipes.filter((r) => {
    if (!matchesQuery(r, f.query)) return false;
    if (tag && !(r.tags ?? []).includes(tag)) return false;
    if (f.favoritesOnly && !marks[r.id]?.favorite) return false;
    if (f.minRating && (marks[r.id]?.rating ?? 0) < f.minRating) return false;
    return true;
  });
}

/** Prep plus cook time, or null when neither is set. */
export function totalMinutes(r: Pick<Recipe, "prepMinutes" | "cookMinutes">): number | null {
  const sum = (r.prepMinutes ?? 0) + (r.cookMinutes ?? 0);
  return sum > 0 ? sum : null;
}

export const kcalOf = (r: Recipe): number | null => (r.nutrition ? Math.round(r.nutrition.perServing.kcal) : null);

/** Smaller first; a recipe without the figure goes last. */
const byNumber = (a: number | null, b: number | null): number => (a === null ? (b === null ? 0 : 1) : b === null ? -1 : a - b);

/** A new list, in the order asked for. Ties fall back to the name, so the order never jumps around. */
export function sortRecipes(recipes: Recipe[], marks: Marks, key: SortKey): Recipe[] {
  const byName = (a: Recipe, b: Recipe) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  const cmp: Record<SortKey, (a: Recipe, b: Recipe) => number> = {
    name: byName,
    newest: (a, b) => b.createdAt.localeCompare(a.createdAt),
    // Highest first; unrated counts as 0, so it comes last.
    rating: (a, b) => (marks[b.id]?.rating ?? 0) - (marks[a.id]?.rating ?? 0),
    favorites: (a, b) => Number(!!marks[b.id]?.favorite) - Number(!!marks[a.id]?.favorite),
    kcal: (a, b) => byNumber(kcalOf(a), kcalOf(b)),
    quickest: (a, b) => byNumber(totalMinutes(a), totalMinutes(b)),
  };
  return [...recipes].sort((a, b) => cmp[key](a, b) || byName(a, b));
}

/** Every tag in use, most-used first (then alphabetical), for the filter chips and the tag editor's suggestions. */
export function allTags(recipes: Recipe[]): { tag: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const r of recipes) for (const t of r.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/** "45 min", "1 h", "1 h 15 min". */
export function minutesText(n: number): string {
  const h = Math.floor(n / 60);
  const m = n % 60;
  return [h > 0 ? `${h} h` : "", m > 0 ? `${m} min` : ""].filter(Boolean).join(" ");
}

/** "Prep 15 min · Cook 1 h 5 min", or null when no time is set. */
export function timesText(r: Pick<Recipe, "prepMinutes" | "cookMinutes">): string | null {
  const parts = [r.prepMinutes ? `Prep ${minutesText(r.prepMinutes)}` : "", r.cookMinutes ? `Cook ${minutesText(r.cookMinutes)}` : ""].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** The address of a recipe's photo, or null when it has none. `photoAt` busts the cache when the photo changes. */
export function photoUrl(r: Pick<Recipe, "id" | "photoAt">): string | null {
  return r.photoAt ? `/api/mealplan/recipes/${encodeURIComponent(r.id)}/photo?v=${encodeURIComponent(r.photoAt)}` : null;
}
