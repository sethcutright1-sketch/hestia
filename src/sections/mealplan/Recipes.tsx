// Meal Plan → Recipes. The household's own collection of meals, which the
// assistant draws from when it plans a week.
//
// Find one (search, sort, tags, favourites), add one four ways, and change one: there are four
// ways people actually have a recipe to hand -- it's in their head (type it), it's on a page they
// can copy (paste it), it's a file exported from somewhere else (upload it), or it's a link (fetch it).
//
// Everything except typing goes through a preview first. The parsers make
// judgement calls -- stripping "2 cups" off the front of a line, deciding which
// lines are ingredients at all -- and importing twenty recipes sight unseen
// means finding out afterwards, one wrong shopping list at a time. The preview
// is also what gets saved, so what the user approves is exactly what lands. It is editable.
//
// The row's pieces live in RecipeCard.tsx, the editor in RecipeEditor.tsx, the preview in ImportPreview.tsx, and the
// finding and sorting in recipeList.ts. Changing a recipe goes through recipeApi.ts: a kitchen-screen login is asked for the
// household PIN there (423), and the PIN prompt the app already has is opened.

import { useMemo, useState } from "react";
import { Plus, ChefHat, ClipboardPaste, Upload, Link2, PenLine, Search, Heart, Wand2 } from "lucide-react";
import { api, ApiError, type Recipe, type RecipeCalculateReport, type RecipeMark } from "../../api.ts";
import RecipeLines from "./RecipeLines.tsx";
import RecipeView from "./RecipeView.tsx";
import RecipeEditor from "./RecipeEditor.tsx";
import RecipeCard from "./RecipeCard.tsx";
import ImportPreview, { type ParsedRecipe } from "./ImportPreview.tsx";
import { allTags, filterRecipes, SORT_OPTIONS, sortRecipes, type Marks, type SortKey } from "./recipeList.ts";
import { deleteRecipe, improveAllCalories, isLocked, recipeUsage, setRecipeMark, writeMessage } from "./recipeApi.ts";

type Source = "type" | "paste" | "file" | "url";

const SOURCES: { id: Source; label: string; icon: typeof PenLine }[] = [
  { id: "type", label: "Type it", icon: PenLine },
  { id: "paste", label: "Paste text", icon: ClipboardPaste },
  { id: "file", label: "Upload a file", icon: Upload },
  { id: "url", label: "From a link", icon: Link2 },
];

export default function Recipes({
  recipes,
  marks = {},
  onChanged,
  onRequestUnlock,
  canCalculate = true,
  canEdit = true,
  canMark = true,
}: {
  recipes: Recipe[];
  /** This login's own favourites and ratings by recipe id. */
  marks?: Record<string, RecipeMark>;
  onChanged: () => void;
  /** Opens the PIN prompt: a login that PIN-locks its food diary is told it's locked (423) when it calculates, and the kitchen screen when it changes a recipe. */
  onRequestUnlock?: () => void;
  /** False for the kiosk login, which keeps no food diary. */
  canCalculate?: boolean;
  /** Show the add / edit / delete controls. The kitchen screen has them too and is asked for the household PIN on use. */
  canEdit?: boolean;
  /** False for the kiosk login, which keeps no favourites or ratings. */
  canMark?: boolean;
}) {
  const [source, setSource] = useState<Source>("type");
  const [preview, setPreview] = useState<ParsedRecipe[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [calculating, setCalculating] = useState<string | null>(null);
  const [improving, setImproving] = useState(false);
  // The recipe open in the viewer, and whether it opens straight in the step editor.
  const [viewing, setViewing] = useState<{ id: string; edit: boolean } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ recipe: Recipe; plannedMeals: number; upcoming: number } | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("name");
  const [tag, setTag] = useState("");
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const viewed = viewing ? recipes.find((r) => r.id === viewing.id) : undefined;
  const editing = editingId ? recipes.find((r) => r.id === editingId) : undefined;

  const tags = useMemo(() => allTags(recipes), [recipes]);
  const shown = useMemo(
    () => sortRecipes(filterRecipes(recipes, marks as Marks, { query, tag, favoritesOnly }), marks as Marks, sort),
    [recipes, marks, query, tag, favoritesOnly, sort],
  );
  const filtering = query.trim() !== "" || tag !== "" || favoritesOnly;

  // One tap: link the foods that clearly match each line, and let the local model estimate the rest
  // (flagged as an estimate). Linking lines by hand, setting amounts and servings is the line editor
  // (RecipeLines.tsx), which opens when a recipe is expanded.
  async function calculate(r: Recipe) {
    setCalculating(r.id);
    setError("");
    setNote("");
    try {
      const res = await api.post<{ report: RecipeCalculateReport }>(`/api/nutrition/recipes/${r.id}/calculate`, { estimate: true });
      const { linked, estimated, unresolved, modelAvailable, modelError } = res.report;
      const parts = [`${linked.length} linked to foods`, `${estimated.length} estimated`];
      if (unresolved.length > 0) parts.push(`${unresolved.length} still without calories`);
      setNote(`${r.name}: ${parts.join(", ")}.${!modelAvailable ? " The local model is off, so nothing was estimated." : modelError ? " The local model couldn't be used." : ""}`);
      onChanged();
    } catch (err: any) {
      if (err instanceof ApiError && err.status === 423) {
        setError("Your food diary is PIN-locked. Unlock it, then try again.");
        onRequestUnlock?.();
      } else {
        setError(err.message);
      }
    } finally {
      setCalculating(null);
    }
  }

  // Link every recipe's clear matches at once: no model, nothing guessed, so it is quick and safe to press.
  async function improveAll() {
    setImproving(true);
    setError("");
    setNote("");
    try {
      const out = await improveAllCalories();
      setNote(
        out.before === 0
          ? "Every recipe already has its calories."
          : `${out.improved} recipe${out.improved === 1 ? "" : "s"} improved. Recipes with partly estimated or missing calories: ${out.before} before, ${out.after} now.`,
      );
      onChanged();
    } catch (err: any) {
      if (isLocked(err)) {
        setError("Your food diary is PIN-locked. Unlock it, then try again.");
        onRequestUnlock?.();
      } else {
        setError(err.message);
      }
    } finally {
      setImproving(false);
    }
  }

  async function saveAll(rows: ParsedRecipe[]) {
    setBusy(true);
    setError("");
    try {
      const res = await api.post<{ imported: number; skipped: string[] }>(
        "/api/mealplan/recipes/import",
        { recipes: rows }
      );
      setPreview(null);
      setNote(
        res.skipped.length > 0
          ? `Saved ${res.imported}. Skipped ${res.skipped.length} without a name or ingredients.`
          : `Saved ${res.imported} recipe${res.imported === 1 ? "" : "s"}.`
      );
      onChanged();
    } catch (err) {
      setError(writeMessage(err, onRequestUnlock));
    } finally {
      setBusy(false);
    }
  }

  // Delete asks first: it says how many planned meals use the recipe, because they lose their link to it.
  async function askDelete(r: Recipe) {
    setError("");
    try {
      const usage = await recipeUsage(r.id);
      setConfirmDelete({ recipe: r, ...usage });
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function doDelete() {
    if (!confirmDelete) return;
    const id = confirmDelete.recipe.id;
    setConfirmDelete(null);
    try {
      await deleteRecipe(id);
      onChanged();
    } catch (err) {
      setError(writeMessage(err, onRequestUnlock));
    }
  }

  async function mark(r: Recipe, change: { favorite?: boolean; rating?: number | null }) {
    try {
      await setRecipeMark(r.id, change);
      onChanged();
    } catch (err) {
      setError(writeMessage(err));
    }
  }

  const selectCls = "px-2 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900";

  return (
    <div className="max-w-xl">
      <p className="text-xs text-slate-500 dark:text-slate-400 mb-3">
        Saved meals the assistant can draw from when planning a week.
      </p>

      {canEdit && (
        <>
          <div className="flex flex-wrap gap-1 mb-3">
            {SOURCES.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => { setSource(id); setPreview(null); setError(""); setNote(""); }}
                className={`px-2.5 py-1.5 rounded-lg text-xs flex items-center gap-1.5 ${
                  source === id
                    ? "bg-blue-600 text-white"
                    : "bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700"
                }`}
              >
                <Icon size={13} />
                {label}
              </button>
            ))}
          </div>

          <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3 mb-4">
            {source === "type" && <TypeForm onSaved={(msg) => { setNote(msg); onChanged(); }} onError={(m) => setError(m)} onRequestUnlock={onRequestUnlock} />}
            {source === "paste" && <PasteForm onParsed={setPreview} onError={setError} />}
            {source === "file" && <FileForm onParsed={setPreview} onError={setError} />}
            {source === "url" && <UrlForm onParsed={setPreview} onError={setError} busy={busy} setBusy={setBusy} />}
          </div>
        </>
      )}

      {error && <p className="mb-3 text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>}
      {note && <p className="mb-3 text-sm text-emerald-600 dark:text-emerald-400">{note}</p>}

      {preview && (
        <ImportPreview rows={preview} busy={busy} onCancel={() => setPreview(null)} onConfirm={() => saveAll(preview)} onEdit={setPreview} />
      )}

      <div className="flex items-center justify-between gap-2 mb-2">
        <h3 className="text-sm font-semibold">Saved recipes</h3>
        {canCalculate && recipes.length > 0 && (
          <button
            onClick={improveAll}
            disabled={improving}
            className="px-2 py-1 rounded-lg text-xs flex items-center gap-1 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 disabled:opacity-50"
            title="Link every recipe's clear matches to foods in one go. Nothing is guessed."
          >
            <Wand2 size={12} /> {improving ? "Working…" : "Improve calories"}
          </button>
        )}
      </div>

      {recipes.length > 0 && (
        <div className="mb-3 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex-1 min-w-[10rem] flex items-center gap-1.5 px-2.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900">
              <Search size={14} className="text-slate-400 shrink-0" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by name, ingredient or tag"
                aria-label="Search recipes"
                className="w-full py-1.5 text-sm bg-transparent outline-none"
              />
            </div>
            <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} className={selectCls} aria-label="Sort recipes">
              {SORT_OPTIONS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
            </select>
            {canMark && (
              <button
                onClick={() => setFavoritesOnly(!favoritesOnly)}
                aria-pressed={favoritesOnly}
                className={`px-2 py-1.5 rounded-lg text-xs flex items-center gap-1 ${favoritesOnly ? "bg-rose-500 text-white" : "bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700"}`}
              >
                <Heart size={12} fill={favoritesOnly ? "currentColor" : "none"} /> Favourites
              </button>
            )}
          </div>
          {tags.length > 0 && (
            <div className="flex flex-wrap gap-1" aria-label="Filter by tag">
              {tags.slice(0, 14).map(({ tag: t, count }) => (
                <button
                  key={t}
                  onClick={() => setTag(tag === t ? "" : t)}
                  aria-pressed={tag === t}
                  className={`px-2 py-0.5 rounded-full text-xs ${tag === t ? "bg-blue-600 text-white" : "bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700"}`}
                >
                  {t} <span className="opacity-60">{count}</span>
                </button>
              ))}
            </div>
          )}
          {filtering && (
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Showing {shown.length} of {recipes.length}.{" "}
              <button onClick={() => { setQuery(""); setTag(""); setFavoritesOnly(false); }} className="text-blue-600 dark:text-blue-400 hover:underline">Clear</button>
            </p>
          )}
        </div>
      )}

      {recipes.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-10 text-slate-400 dark:text-slate-500">
          <ChefHat size={28} className="mb-2" />
          <p className="text-sm">Nothing saved yet.</p>
        </div>
      ) : shown.length === 0 ? (
        <p className="py-6 text-sm text-center text-slate-500 dark:text-slate-400">No recipe matches.</p>
      ) : (
        <ul className="divide-y divide-slate-200 dark:divide-slate-800">
          {shown.map((r) => (
            <RecipeCard
              key={r.id}
              recipe={r}
              mark={marks[r.id]}
              canMark={canMark}
              canEdit={canEdit}
              canCalculate={canCalculate}
              calculating={calculating !== null}
              open={open === r.id}
              onToggle={() => setOpen(open === r.id ? null : r.id)}
              onView={() => setViewing({ id: r.id, edit: false })}
              onEdit={() => setEditingId(r.id)}
              onCalculate={() => calculate(r)}
              onDelete={() => askDelete(r)}
              onMark={(change) => mark(r, change)}
              onTag={(t) => setTag(t)}
            >
              {canCalculate ? (
                // The line editor: amounts, linked foods, servings, calories. The kiosk login keeps no food diary, so
                // it gets the read-only list below instead.
                <div className="mt-2 sm:ml-7">
                  <RecipeLines recipeId={r.id} version={r.updatedAt} onChanged={onChanged} onRequestUnlock={onRequestUnlock} />
                  {r.sourceUrl && (
                    <a href={r.sourceUrl} target="_blank" rel="noreferrer" className="inline-block mt-2 text-xs text-blue-600 dark:text-blue-400 hover:underline">
                      Original page
                    </a>
                  )}
                </div>
              ) : (
                <div className="ml-7 mt-2 text-xs text-slate-600 dark:text-slate-300">
                  {r.lines && r.lines.length > 0 ? (
                    <ul className="space-y-0.5">
                      {r.lines.map((l, i) => (
                        <li key={i} className="flex gap-2">
                          <span className="flex-1 min-w-0">{l.text}</span>
                          <span className="text-slate-400 dark:text-slate-500 shrink-0">
                            {l.foodId ? "linked" : l.estimated ? `~${l.estimatedKcal} kcal (estimate)` : ""}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-slate-400 dark:text-slate-500">No ingredient lines saved with amounts.</p>
                  )}
                  {r.sourceUrl && (
                    <a href={r.sourceUrl} target="_blank" rel="noreferrer" className="inline-block mt-1.5 text-blue-600 dark:text-blue-400 hover:underline">
                      Original page
                    </a>
                  )}
                </div>
              )}
            </RecipeCard>
          ))}
        </ul>
      )}

      {viewed && (
        <RecipeView
          recipe={viewed}
          onClose={() => setViewing(null)}
          canEdit={canEdit}
          startEditing={viewing?.edit}
          onSaved={onChanged}
          onRequestUnlock={onRequestUnlock}
          mark={marks[viewed.id]}
          canMark={canMark}
          onOpenEditor={() => { setViewing(null); setEditingId(viewed.id); }}
        />
      )}
      {editing && (
        <RecipeEditor
          recipe={editing}
          tagSuggestions={tags.map((t) => t.tag)}
          onClose={() => setEditingId(null)}
          onSaved={onChanged}
          onRequestUnlock={onRequestUnlock}
        />
      )}
      {confirmDelete && (
        <div className="fixed inset-0 z-[75] bg-slate-950/60 flex items-center justify-center p-4" onClick={() => setConfirmDelete(null)}>
          <div role="alertdialog" aria-modal="true" aria-label={`Delete ${confirmDelete.recipe.name}?`} className="w-full max-w-sm rounded-2xl bg-white dark:bg-slate-900 p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-semibold mb-2">Delete {confirmDelete.recipe.name}?</h3>
            <p className="text-sm text-slate-600 dark:text-slate-300 mb-4">
              {confirmDelete.plannedMeals > 0
                ? `It is planned in ${confirmDelete.plannedMeals} meal${confirmDelete.plannedMeals === 1 ? "" : "s"}${confirmDelete.upcoming > 0 ? ` (${confirmDelete.upcoming} still to come)` : ""}. Those meals keep their name and ingredients but lose their link to the recipe. `
                : "It isn't planned anywhere. "}
              This can't be undone.
            </p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setConfirmDelete(null)} className="px-3 py-1.5 rounded-lg text-sm bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700">Keep it</button>
              <button onClick={doDelete} className="px-3 py-1.5 rounded-lg text-sm bg-red-600 hover:bg-red-700 text-white">Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// --- the four sources -------------------------------------------------------

function TypeForm({ onSaved, onError, onRequestUnlock }: { onSaved: (msg: string) => void; onError: (msg: string) => void; onRequestUnlock?: () => void }) {
  const [name, setName] = useState("");
  const [ingredients, setIngredients] = useState("");
  const [instructions, setInstructions] = useState("");
  const [onlyMe, setOnlyMe] = useState(false);

  // No preview here: the user typed both fields, so there's nothing parsed for
  // them to check.
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api.post("/api/mealplan/recipes", { name, ingredients, instructions, ...(onlyMe ? { scope: "personal" } : {}) });
      setName("");
      setIngredients("");
      setInstructions("");
      onSaved(`Saved ${name.trim()}.`);
    } catch (err) {
      onError(writeMessage(err, onRequestUnlock));
    }
  }

  return (
    <form onSubmit={submit} className="space-y-2">
      <input
        className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
        placeholder="Dish name, e.g. Chicken fajitas"
        value={name}
        onChange={(e) => setName(e.target.value)}
        aria-label="Dish name"
      />
      <input
        className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
        placeholder="Ingredients, separated by commas"
        value={ingredients}
        onChange={(e) => setIngredients(e.target.value)}
        aria-label="Ingredients"
      />
      <textarea
        className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
        rows={4}
        placeholder="How to make it (one step per line)"
        value={instructions}
        onChange={(e) => setInstructions(e.target.value)}
        aria-label="How to make it (one step per line)"
      />
      <label className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
        <input type="checkbox" checked={onlyMe} onChange={(e) => setOnlyMe(e.target.checked)} />
        Only me (keep it out of the household's shared recipes)
      </label>
      <button className="px-3 py-1.5 rounded-lg text-sm bg-blue-600 hover:bg-blue-700 text-white flex items-center gap-1.5">
        <Plus size={14} /> Save recipe
      </button>
    </form>
  );
}

function PasteForm({
  onParsed,
  onError,
}: {
  onParsed: (rows: ParsedRecipe[]) => void;
  onError: (msg: string) => void;
}) {
  const [text, setText] = useState("");

  // Parsed on the server so the browser and the assistant get identical results
  // from the same code -- a second parser here would drift from the one in
  // routes/recipeImport.ts the first time either changed.
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try {
      const res = await api.post<{ recipes: ParsedRecipe[] }>("/api/mealplan/recipes/parse", { text });
      onParsed(res.recipes);
      onError("");
    } catch (err: any) {
      onError(err.message);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-2">
      <textarea
        className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 font-mono"
        rows={8}
        placeholder={"Chicken Fajitas\n\nIngredients:\n- 2 chicken breasts\n- 1 red pepper\n- 1 onion"}
        value={text}
        onChange={(e) => setText(e.target.value)}
        aria-label="Recipe text"
      />
      <p className="text-xs text-slate-500 dark:text-slate-400">
        Title on the first line, then the ingredients, then an Instructions (or Method) heading and the steps. Amounts are kept for calories and ignored when matching the pantry.
      </p>
      <button className="px-3 py-1.5 rounded-lg text-sm bg-blue-600 hover:bg-blue-700 text-white">
        Read it
      </button>
    </form>
  );
}

function FileForm({
  onParsed,
  onError,
}: {
  onParsed: (rows: ParsedRecipe[]) => void;
  onError: (msg: string) => void;
}) {
  const [filename, setFilename] = useState("");

  // The file is read in the browser and its text posted, rather than uploaded:
  // no multipart handling on the server, and nothing is written to disk
  // anywhere along the way.
  async function pick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFilename(file.name);
    if (file.size > 2_000_000) {
      onError("That file is larger than 2MB.");
      return;
    }
    try {
      const content = await file.text();
      const res = await api.post<{ recipes: ParsedRecipe[] }>("/api/mealplan/recipes/parse", {
        filename: file.name,
        content,
      });
      onParsed(res.recipes);
      onError("");
    } catch (err: any) {
      onError(err.message);
    }
  }

  return (
    <div className="space-y-2">
      <input
        type="file"
        accept=".csv,.json,.tsv,text/csv,application/json"
        onChange={pick}
        className="block w-full text-sm text-slate-600 dark:text-slate-300 file:mr-3 file:px-3 file:py-1.5 file:rounded-lg file:border-0 file:text-sm file:bg-blue-600 file:text-white hover:file:bg-blue-700"
        aria-label="Recipe file"
      />
      {filename && <p className="text-xs text-slate-500 dark:text-slate-400">{filename}</p>}
      <p className="text-xs text-slate-500 dark:text-slate-400">
        CSV with <span className="font-mono">name</span> and <span className="font-mono">ingredients</span> columns (and,
        if you have them, <span className="font-mono">instructions</span> and <span className="font-mono">servings</span>),
        or JSON with the same fields.
      </p>
    </div>
  );
}

function UrlForm({
  onParsed,
  onError,
  busy,
  setBusy,
}: {
  onParsed: (rows: ParsedRecipe[]) => void;
  onError: (msg: string) => void;
  busy: boolean;
  setBusy: (busy: boolean) => void;
}) {
  const [url, setUrl] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    onError("");
    try {
      const res = await api.post<{ recipes: ParsedRecipe[] }>("/api/mealplan/recipes/from-url", { url });
      onParsed(res.recipes);
    } catch (err: any) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-2">
      <input
        className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
        placeholder="https://…"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        aria-label="Recipe link"
      />
      <p className="text-xs text-slate-500 dark:text-slate-400">
        Reads the recipe data most cooking sites publish. If a page doesn't have any, paste the text instead.
      </p>
      <button
        disabled={busy}
        className="px-3 py-1.5 rounded-lg text-sm bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white"
      >
        {busy ? "Reading…" : "Read the page"}
      </button>
    </form>
  );
}
