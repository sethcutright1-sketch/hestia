// The recipe viewer: what a planned meal's recipe is and how to make it. A bottom sheet on a phone and a
// centered panel on a PC or the kitchen screen, with big readable text; it scrolls, and closes on the X,
// Escape or a tap on the dim area behind it.
//
// It shows the photo, tags, times, notes, YOUR favourite and rating (per person), the ingredients with a servings stepper
// that scales the amounts (display only: nothing is saved), and the steps, with a Cook button for the full-screen cook view.
// With `canEdit` the steps become a list editor (move, remove, add, paste a block) saved through PATCH
// /api/mealplan/recipes/:id, which needs no food diary login; a kiosk login is asked for the household PIN there (423) and
// the PIN prompt is opened. The words come from recipeView.ts and the list operations from stepsEdit.ts.

import { useEffect, useState } from "react";
import { X, ChefHat, Pencil, Plus, ExternalLink, ArrowUp, ArrowDown, Trash2, Play, Minus, SlidersHorizontal } from "lucide-react";
import type { Recipe, RecipeMark } from "../../api.ts";
import { recipeViewModel } from "./recipeView.ts";
import { addStep, appendPasted, moveStep, removeStep, sameSteps, stepsToSave, updateStep } from "./stepsEdit.ts";
import { adjustServings, scaledIngredients, servingsFactor } from "./cookMode.ts";
import { patchRecipe, setRecipeMark, writeMessage } from "./recipeApi.ts";
import { FavoriteButton, RatingStars } from "./StarRating.tsx";
import CookMode from "./CookMode.tsx";

export default function RecipeView({
  recipe,
  onClose,
  canEdit = false,
  startEditing = false,
  onSaved,
  onRequestUnlock,
  mark,
  canMark = false,
  onOpenEditor,
}: {
  recipe: Recipe;
  onClose: () => void;
  /** Show Add / Edit for the steps. */
  canEdit?: boolean;
  /** Open straight in the step editor. */
  startEditing?: boolean;
  /** The recipe changed: the parent should reload its list. */
  onSaved?: () => void;
  onRequestUnlock?: () => void;
  /** This login's own favourite and rating for the recipe. */
  mark?: RecipeMark;
  /** False for the kiosk login, which keeps no favourites. */
  canMark?: boolean;
  /** Open the full recipe editor (name, ingredients, tags, photo...). */
  onOpenEditor?: () => void;
}) {
  const vm = recipeViewModel(recipe);
  const [editing, setEditing] = useState(canEdit && startEditing);
  const [draft, setDraft] = useState<string[]>(recipe.instructions ?? []);
  const [paste, setPaste] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [servings, setServings] = useState(recipe.yieldServings ?? 4);
  const [cooking, setCooking] = useState(false);
  const [myMark, setMyMark] = useState<RecipeMark>(mark ?? { favorite: false, rating: null });

  useEffect(() => setMyMark(mark ?? { favorite: false, rating: null }), [mark?.favorite, mark?.rating]);

  useEffect(() => {
    if (cooking) return; // Cook mode owns Escape while it is open
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !(e.target instanceof HTMLTextAreaElement)) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, cooking]);

  const factor = servingsFactor(recipe.yieldServings, servings);
  const ingredients = scaledIngredients(vm.ingredients, factor);

  function startEdit() {
    setDraft(recipe.instructions?.length ? [...recipe.instructions] : [""]);
    setPaste("");
    setError("");
    setEditing(true);
  }

  async function save() {
    setBusy(true);
    setError("");
    try {
      await patchRecipe(recipe.id, { instructions: stepsToSave(draft) });
      setEditing(false);
      onSaved?.();
    } catch (err) {
      setError(writeMessage(err, onRequestUnlock));
    } finally {
      setBusy(false);
    }
  }

  async function changeMark(change: { favorite?: boolean; rating?: number | null }) {
    const before = myMark;
    setMyMark({ ...myMark, ...change } as RecipeMark);
    try {
      const res = await setRecipeMark(recipe.id, change);
      setMyMark(res.mark);
      onSaved?.();
    } catch (err) {
      setMyMark(before);
      setError(writeMessage(err));
    }
  }

  const heading = "text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-2";
  const iconBtn = "p-1.5 rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-30";

  return (
    <>
      <div className="fixed inset-0 z-[70] bg-slate-950/60 flex items-end sm:items-center justify-center sm:p-4" onClick={onClose}>
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`${vm.title}: ingredients and instructions`}
          className="w-full sm:max-w-2xl max-h-[92vh] flex flex-col rounded-t-2xl sm:rounded-2xl bg-white dark:bg-slate-900 shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-start gap-3 px-5 pt-4 pb-3 border-b border-slate-200 dark:border-slate-800">
            <ChefHat size={22} className="mt-1 shrink-0 text-slate-400" />
            <div className="flex-1 min-w-0">
              <h2 className="text-xl sm:text-2xl font-semibold leading-tight">{vm.title}</h2>
              <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                {[vm.servings, vm.calories, vm.times].filter(Boolean).join(" · ")}
              </p>
              {canMark && (
                <div className="mt-1 flex items-center gap-1">
                  <FavoriteButton favorite={myMark.favorite} onChange={(favorite) => changeMark({ favorite })} label={vm.title} />
                  <RatingStars rating={myMark.rating} onChange={(rating) => changeMark({ rating })} label={vm.title} />
                </div>
              )}
            </div>
            {canEdit && onOpenEditor && (
              <button onClick={onOpenEditor} className="px-2.5 py-1.5 rounded-lg text-sm flex items-center gap-1.5 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700" title="Change the name, ingredients, tags, photo…">
                <SlidersHorizontal size={14} /> <span className="hidden sm:inline">Edit recipe</span>
              </button>
            )}
            <button onClick={onClose} className="p-1.5 -mr-1.5 rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800" aria-label="Close">
              <X size={22} />
            </button>
          </div>

          <div className="overflow-y-auto px-5 py-4 space-y-6 text-base sm:text-lg leading-relaxed">
            {vm.photo && <img src={vm.photo} alt={`${vm.title}`} className="w-full max-h-64 object-cover rounded-xl bg-slate-100 dark:bg-slate-800" />}

            {(vm.tags.length > 0 || vm.notes) && (
              <div className="space-y-2">
                {vm.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {vm.tags.map((t) => <span key={t} className="px-2 py-0.5 rounded-full text-xs bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300">{t}</span>)}
                  </div>
                )}
                {vm.notes && <p className="text-sm sm:text-base text-slate-600 dark:text-slate-300 whitespace-pre-line">{vm.notes}</p>}
              </div>
            )}

            <section>
              <div className="flex items-center justify-between mb-2">
                <h3 className={`${heading} mb-0`}>Ingredients</h3>
                {recipe.yieldServings !== undefined && vm.ingredients.length > 0 && (
                  <div className="flex items-center gap-1 text-sm" aria-label="Servings">
                    <button onClick={() => setServings(adjustServings(servings, -1))} className={iconBtn} aria-label="Fewer servings"><Minus size={14} /></button>
                    <span className="min-w-[4.5rem] text-center">{servings} serving{servings === 1 ? "" : "s"}</span>
                    <button onClick={() => setServings(adjustServings(servings, 1))} className={iconBtn} aria-label="More servings"><Plus size={14} /></button>
                  </div>
                )}
              </div>
              {ingredients.length === 0 ? (
                <p className="text-slate-500 dark:text-slate-400">No ingredients saved.</p>
              ) : (
                <ul className="list-disc pl-5 space-y-1">
                  {ingredients.map((text, i) => <li key={i}>{text}</li>)}
                </ul>
              )}
              {factor !== 1 && <p className="mt-1.5 text-xs text-slate-400">Scaled for {servings}; the saved recipe is unchanged.</p>}
            </section>

            <section>
              <div className="flex items-center justify-between mb-2">
                <h3 className={`${heading} mb-0`}>Steps</h3>
                <div className="flex gap-2">
                  {!editing && (
                    <button onClick={() => setCooking(true)} className="px-2.5 py-1 rounded-lg text-sm flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white">
                      <Play size={13} /> Cook
                    </button>
                  )}
                  {canEdit && !editing && vm.steps.length > 0 && (
                    <button onClick={startEdit} className="px-2.5 py-1 rounded-lg text-sm flex items-center gap-1.5 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700">
                      <Pencil size={13} /> Edit steps
                    </button>
                  )}
                </div>
              </div>

              {editing ? (
                <div className="space-y-2">
                  <ol className="space-y-2">
                    {draft.map((s, i) => (
                      <li key={i} className="flex gap-1.5 items-start">
                        <span className="w-6 pt-2 text-sm text-slate-400 text-right shrink-0">{i + 1}.</span>
                        <textarea
                          className="flex-1 px-3 py-2 text-base rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                          rows={2}
                          value={s}
                          aria-label={`Step ${i + 1}`}
                          onChange={(e) => setDraft(updateStep(draft, i, e.target.value))}
                        />
                        <div className="flex flex-col">
                          <button onClick={() => setDraft(moveStep(draft, i, -1))} disabled={i === 0} className={iconBtn} aria-label={`Move step ${i + 1} up`}><ArrowUp size={14} /></button>
                          <button onClick={() => setDraft(moveStep(draft, i, 1))} disabled={i === draft.length - 1} className={iconBtn} aria-label={`Move step ${i + 1} down`}><ArrowDown size={14} /></button>
                        </div>
                        <button onClick={() => setDraft(removeStep(draft, i))} className={`${iconBtn} hover:text-red-600`} aria-label={`Remove step ${i + 1}`}><Trash2 size={15} /></button>
                      </li>
                    ))}
                  </ol>
                  <button onClick={() => setDraft(addStep(draft))} className="px-2.5 py-1 rounded-lg text-sm flex items-center gap-1.5 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700">
                    <Plus size={13} /> Add a step
                  </button>
                  <details className="text-sm">
                    <summary className="cursor-pointer text-slate-500 dark:text-slate-400">Paste a block of steps</summary>
                    <textarea
                      className="mt-2 w-full px-3 py-2 text-base rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                      rows={5}
                      value={paste}
                      onChange={(e) => setPaste(e.target.value)}
                      placeholder={"1. Heat the oven to 200°C.\n2. Mix the flour and eggs.\n3. Bake for 25 minutes."}
                      aria-label="Steps to paste"
                    />
                    <button onClick={() => { setDraft(appendPasted(draft, paste)); setPaste(""); }} disabled={!paste.trim()} className="mt-1.5 px-2.5 py-1 rounded-lg text-sm bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 disabled:opacity-50">
                      Split into steps
                    </button>
                  </details>
                  {error && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>}
                  <div className="flex gap-2">
                    <button onClick={save} disabled={busy || sameSteps(draft, recipe.instructions)} className="px-3 py-1.5 rounded-lg text-sm bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white">
                      {busy ? "Saving…" : "Save steps"}
                    </button>
                    <button onClick={() => { setEditing(false); setError(""); }} className="px-3 py-1.5 rounded-lg text-sm bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700">
                      Cancel
                    </button>
                  </div>
                </div>
              ) : vm.steps.length > 0 ? (
                <ol className="list-decimal pl-6 space-y-3">
                  {vm.steps.map((s, i) => <li key={i} className="pl-1">{s}</li>)}
                </ol>
              ) : (
                <div className="rounded-lg border border-dashed border-slate-300 dark:border-slate-700 p-4">
                  <p className="text-slate-600 dark:text-slate-300">No instructions saved yet</p>
                  {canEdit && (
                    <button onClick={startEdit} className="mt-2 px-3 py-1.5 rounded-lg text-sm flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 text-white">
                      <Plus size={14} /> Add instructions
                    </button>
                  )}
                </div>
              )}
              {!editing && error && <p className="mt-2 text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>}
            </section>

            {vm.sourceUrl && (
              <a href={vm.sourceUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-sm text-blue-600 dark:text-blue-400 hover:underline">
                <ExternalLink size={14} /> Original page
              </a>
            )}
          </div>
        </div>
      </div>
      {cooking && <CookMode recipe={recipe} onClose={() => setCooking(false)} onAddSteps={canEdit ? () => { setCooking(false); startEdit(); } : undefined} />}
    </>
  );
}
