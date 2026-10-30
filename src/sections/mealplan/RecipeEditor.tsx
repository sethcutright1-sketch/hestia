// Editing a recipe: its name, ingredient lines, servings, times, tags, notes, source link, who it is shared with, and its
// photo. A centred panel (a bottom sheet on a phone) like the viewer. Saving is one PATCH (recipeApi.ts patchRecipe).
//
// Ingredient lines are edited as text. Each line remembers the position it came from (`from`), so fixing a typo keeps the
// calorie link that line already had, while changing its amount or the food drops the link; the answer says how many were
// dropped and this panel says so. Steps are edited in the viewer (RecipeView.tsx); here they only change when the person
// adopts a page's steps from "Check the original page".

import { useEffect, useState } from "react";
import { X, Plus, Trash2, Camera, RefreshCw, Copy } from "lucide-react";
import type { Recipe } from "../../api.ts";
import { RECIPE_PHOTO_JPEG_QUALITY, RECIPE_PHOTO_MAX_SIDE, shrinkPhoto } from "../food/imageResize.ts";
import { duplicateRecipe, patchRecipe, refreshFromPage, removeRecipePhoto, setRecipePhoto, writeMessage, type PageRefresh } from "./recipeApi.ts";
import { photoUrl } from "./recipeList.ts";

interface Row {
  text: string;
  /** Where this line was before the edit (absent for a line added now). */
  from?: number;
}

const field = "w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900";
const label = "block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1";

/** The text of the lines a recipe has now (older recipes keep only ingredient names). */
const lineTexts = (r: Recipe): string[] => (r.lines && r.lines.length > 0 ? r.lines.map((l) => l.text) : r.ingredients);
const numberOrNull = (v: string): number | null => (v.trim() === "" ? null : Number(v));

export default function RecipeEditor({
  recipe,
  tagSuggestions,
  onClose,
  onSaved,
  onRequestUnlock,
}: {
  recipe: Recipe;
  /** Tags already in use, to offer as one-tap chips. */
  tagSuggestions: string[];
  onClose: () => void;
  /** Something changed (saved, photo, copy): reload the list. */
  onSaved: () => void;
  onRequestUnlock?: () => void;
}) {
  const [name, setName] = useState(recipe.name);
  const [rows, setRows] = useState<Row[]>(() => lineTexts(recipe).map((text, from) => ({ text, from })));
  const [servings, setServings] = useState(recipe.yieldServings !== undefined ? String(recipe.yieldServings) : "");
  const [prep, setPrep] = useState(recipe.prepMinutes ? String(recipe.prepMinutes) : "");
  const [cook, setCook] = useState(recipe.cookMinutes ? String(recipe.cookMinutes) : "");
  const [tags, setTags] = useState((recipe.tags ?? []).join(", "));
  const [notes, setNotes] = useState(recipe.notes ?? "");
  const [sourceUrl, setSourceUrl] = useState(recipe.sourceUrl ?? "");
  const [scope, setScope] = useState<"joint" | "personal">(recipe.scope);
  const [adoptedSteps, setAdoptedSteps] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [photoAt, setPhotoAt] = useState(recipe.photoAt);
  const [page, setPage] = useState<PageRefresh | null>(null);
  const [pick, setPick] = useState({ lines: true, instructions: true, yieldServings: true });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const tagList = tags.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
  const addTag = (t: string) => { if (!tagList.includes(t)) setTags([...tagList, t].join(", ")); };

  async function save() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const kept = rows.filter((r) => r.text.trim());
      const res = await patchRecipe(recipe.id, {
        name,
        lines: kept.map((r) => ({ text: r.text.trim(), ...(r.from !== undefined ? { from: r.from } : {}) })),
        yieldServings: numberOrNull(servings),
        prepMinutes: numberOrNull(prep),
        cookMinutes: numberOrNull(cook),
        tags: tagList,
        notes: notes.trim() === "" ? null : notes,
        sourceUrl: sourceUrl.trim() === "" ? null : sourceUrl.trim(),
        scope,
        ...(adoptedSteps ? { instructions: adoptedSteps } : {}),
      });
      onSaved();
      if (res.relink > 0) {
        setNotice(`Saved. ${res.relink} ingredient line${res.relink === 1 ? "" : "s"} changed amount or food, so ${res.relink === 1 ? "its" : "their"} calorie link was removed. Use Calculate to link ${res.relink === 1 ? "it" : "them"} again.`);
        setRows(kept.map((r, i) => ({ text: r.text.trim(), from: i })));
      } else {
        onClose();
      }
    } catch (err) {
      setError(writeMessage(err, onRequestUnlock));
    } finally {
      setBusy(false);
    }
  }

  async function choosePhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError("");
    try {
      const shrunk = await shrinkPhoto(file, { maxSide: RECIPE_PHOTO_MAX_SIDE, quality: RECIPE_PHOTO_JPEG_QUALITY });
      const res = await setRecipePhoto(recipe.id, shrunk.base64);
      setPhotoAt(res.recipe.photoAt);
      onSaved();
    } catch (err) {
      setError(writeMessage(err, onRequestUnlock));
    }
  }

  async function removePhoto() {
    setError("");
    try {
      await removeRecipePhoto(recipe.id);
      setPhotoAt(undefined);
      onSaved();
    } catch (err) {
      setError(writeMessage(err, onRequestUnlock));
    }
  }

  async function checkPage() {
    setError("");
    setPage(null);
    try {
      setPage(await refreshFromPage(recipe.id));
    } catch (err) {
      setError(writeMessage(err, onRequestUnlock));
    }
  }

  function usePage() {
    if (!page) return;
    if (pick.lines && page.differs.lines) setRows(page.page.lines.map((text) => ({ text })));
    if (pick.instructions && page.differs.instructions) setAdoptedSteps(page.page.instructions);
    if (pick.yieldServings && page.differs.yieldServings && page.page.yieldServings !== null) setServings(String(page.page.yieldServings));
    setPage(null);
    setNotice("The page's changes are filled in below. Check them, then Save.");
  }

  async function copy() {
    setError("");
    try {
      await duplicateRecipe(recipe.id);
      onSaved();
      onClose();
    } catch (err) {
      setError(writeMessage(err, onRequestUnlock));
    }
  }

  const photo = photoUrl({ id: recipe.id, photoAt });
  const anyDiff = page && (page.differs.lines || page.differs.instructions || page.differs.yieldServings);

  return (
    <div className="fixed inset-0 z-[70] bg-slate-950/60 flex items-end sm:items-center justify-center sm:p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Edit ${recipe.name}`}
        className="w-full sm:max-w-2xl max-h-[92vh] flex flex-col rounded-t-2xl sm:rounded-2xl bg-white dark:bg-slate-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-5 pt-4 pb-3 border-b border-slate-200 dark:border-slate-800">
          <h2 className="flex-1 text-lg font-semibold">Edit recipe</h2>
          <button onClick={copy} className="px-2.5 py-1 rounded-lg text-sm flex items-center gap-1.5 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700" title="Make a copy to change">
            <Copy size={13} /> Duplicate
          </button>
          <button onClick={onClose} className="p-1.5 -mr-1.5 rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800" aria-label="Close">
            <X size={20} />
          </button>
        </div>

        <div className="overflow-y-auto px-5 py-4 space-y-4">
          <div>
            <label className={label} htmlFor="re-name">Name</label>
            <input id="re-name" className={field} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
          </div>

          <div>
            <span className={label}>Photo</span>
            <div className="flex items-center gap-3">
              {photo ? <img src={photo} alt="" className="w-20 h-20 rounded-lg object-cover bg-slate-100 dark:bg-slate-800" /> : <div className="w-20 h-20 rounded-lg bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-400"><Camera size={22} /></div>}
              <div className="flex flex-col gap-1.5">
                <label className="px-3 py-1.5 rounded-lg text-sm bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 cursor-pointer text-center">
                  {photo ? "Change photo" : "Add a photo"}
                  <input type="file" accept="image/*" onChange={choosePhoto} className="sr-only" aria-label="Recipe photo" />
                </label>
                {photo && <button onClick={removePhoto} className="px-3 py-1.5 rounded-lg text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30">Remove photo</button>}
              </div>
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <span className={`${label} mb-0`}>Ingredients</span>
              <span className="text-xs text-slate-400">Amounts first: "2 cups flour"</span>
            </div>
            <ul className="space-y-1.5">
              {rows.map((row, i) => (
                <li key={i} className="flex gap-1.5">
                  <input
                    className={field}
                    value={row.text}
                    aria-label={`Ingredient ${i + 1}`}
                    onChange={(e) => setRows(rows.map((r, at) => (at === i ? { ...r, text: e.target.value } : r)))}
                  />
                  <button onClick={() => setRows(rows.filter((_, at) => at !== i))} className="px-2 text-slate-400 hover:text-red-600 dark:hover:text-red-400" aria-label={`Remove ingredient ${i + 1}`}>
                    <Trash2 size={15} />
                  </button>
                </li>
              ))}
            </ul>
            <button onClick={() => setRows([...rows, { text: "" }])} className="mt-2 px-2.5 py-1 rounded-lg text-sm flex items-center gap-1.5 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700">
              <Plus size={13} /> Add an ingredient
            </button>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className={label} htmlFor="re-servings">Makes (servings)</label>
              <input id="re-servings" className={field} inputMode="decimal" value={servings} onChange={(e) => setServings(e.target.value)} />
            </div>
            <div>
              <label className={label} htmlFor="re-prep">Prep (min)</label>
              <input id="re-prep" className={field} inputMode="numeric" value={prep} onChange={(e) => setPrep(e.target.value)} />
            </div>
            <div>
              <label className={label} htmlFor="re-cook">Cook (min)</label>
              <input id="re-cook" className={field} inputMode="numeric" value={cook} onChange={(e) => setCook(e.target.value)} />
            </div>
          </div>

          <div>
            <label className={label} htmlFor="re-tags">Tags (separated by commas)</label>
            <input id="re-tags" className={field} value={tags} onChange={(e) => setTags(e.target.value)} placeholder="quick, crockpot, kid-friendly" />
            {tagSuggestions.filter((t) => !tagList.includes(t)).length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {tagSuggestions.filter((t) => !tagList.includes(t)).slice(0, 12).map((t) => (
                  <button key={t} onClick={() => addTag(t)} className="px-2 py-0.5 rounded-full text-xs bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700">+ {t}</button>
                ))}
              </div>
            )}
          </div>

          <div>
            <label className={label} htmlFor="re-notes">Notes</label>
            <textarea id="re-notes" className={field} rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Substitutions, who liked it, what to change next time" />
          </div>

          <div>
            <label className={label} htmlFor="re-source">Original page (link)</label>
            <div className="flex gap-1.5">
              <input id="re-source" className={field} value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} placeholder="https://…" />
              {recipe.sourceUrl && (
                <button onClick={checkPage} className="px-2.5 rounded-lg text-sm flex items-center gap-1.5 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 shrink-0" title="Read the page again and see what changed">
                  <RefreshCw size={13} /> Check page
                </button>
              )}
            </div>
            {page && (
              <div className="mt-2 rounded-lg border border-blue-200 dark:border-blue-900 bg-blue-50/50 dark:bg-blue-950/20 p-3 text-sm">
                {anyDiff ? (
                  <>
                    <p className="font-medium mb-1.5">The page now says something different. Use:</p>
                    {([["lines", "its ingredients", page.differs.lines], ["instructions", "its steps", page.differs.instructions], ["yieldServings", "its servings", page.differs.yieldServings]] as const).map(([key, text, differs]) =>
                      differs ? (
                        <label key={key} className="flex items-center gap-2 py-0.5">
                          <input type="checkbox" checked={pick[key]} onChange={(e) => setPick({ ...pick, [key]: e.target.checked })} /> {text}
                        </label>
                      ) : null,
                    )}
                    <div className="mt-2 flex gap-2">
                      <button onClick={usePage} className="px-3 py-1 rounded-lg text-sm bg-blue-600 hover:bg-blue-700 text-white">Fill them in</button>
                      <button onClick={() => setPage(null)} className="px-3 py-1 rounded-lg text-sm bg-slate-100 dark:bg-slate-800">Ignore</button>
                    </div>
                  </>
                ) : (
                  <p>The page still matches this recipe.</p>
                )}
              </div>
            )}
          </div>

          <fieldset>
            <legend className={label}>Who can see it</legend>
            <label className="flex items-center gap-2 text-sm py-0.5"><input type="radio" checked={scope === "joint"} onChange={() => setScope("joint")} /> The household (can go on the meal plan)</label>
            <label className="flex items-center gap-2 text-sm py-0.5"><input type="radio" checked={scope === "personal"} onChange={() => setScope("personal")} /> Only me</label>
          </fieldset>

          {error && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>}
          {notice && <p className="text-sm text-emerald-600 dark:text-emerald-400">{notice}</p>}
        </div>

        <div className="flex gap-2 px-5 py-3 border-t border-slate-200 dark:border-slate-800">
          <button onClick={save} disabled={busy || !name.trim()} className="px-4 py-2 rounded-lg text-sm bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white">{busy ? "Saving…" : "Save"}</button>
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700">Close</button>
        </div>
      </div>
    </div>
  );
}
