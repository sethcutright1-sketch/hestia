// Cook mode: a full-screen view for cooking. One step in very large type, "Step 3 of 8", big Previous / Next buttons (the arrow
// keys, Space and Page Up/Down work too), the ingredients one tap away with tick boxes that only live on this screen, and a
// servings stepper that scales the amounts. Read-only, so the kitchen screen may use it without a PIN. On a phone it asks
// the browser to keep the screen awake while it is open (where the browser allows that). The logic is in cookMode.ts.

import { useEffect, useState } from "react";
import { X, ChevronLeft, ChevronRight, Minus, Plus, ListChecks } from "lucide-react";
import type { Recipe } from "../../api.ts";
import { recipeViewModel } from "./recipeView.ts";
import { adjustServings, clampStep, keyAction, scaledIngredients, servingsFactor, stepLabel } from "./cookMode.ts";

export default function CookMode({ recipe, onClose, onAddSteps }: { recipe: Recipe; onClose: () => void; onAddSteps?: () => void }) {
  const vm = recipeViewModel(recipe);
  const base = recipe.yieldServings ?? 4;
  const [step, setStep] = useState(0);
  const [servings, setServings] = useState(base);
  const [showIngredients, setShowIngredients] = useState(vm.steps.length === 0);
  const [ticked, setTicked] = useState<Set<number>>(new Set());
  const count = vm.steps.length;
  const ingredients = scaledIngredients(vm.ingredients, servingsFactor(recipe.yieldServings, servings));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      // Space on a focused button is that button's own click (a servings button, Next...), not "next step" too.
      if (e.key === " " && tag === "BUTTON") return;
      const action = keyAction(e.key);
      if (!action) return;
      e.preventDefault();
      if (action === "close") onClose();
      else setStep((s) => clampStep(s + (action === "next" ? 1 : -1), count));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, count]);

  // Keep the screen on while cooking, where the browser lets us; ignored everywhere else.
  useEffect(() => {
    let lock: { release: () => Promise<void> } | null = null;
    (navigator as any).wakeLock?.request?.("screen").then((l: any) => { lock = l; }).catch(() => {});
    return () => { lock?.release().catch(() => {}); };
  }, []);

  const toggleTick = (i: number) => setTicked((t) => { const n = new Set(t); if (n.has(i)) n.delete(i); else n.add(i); return n; });

  return (
    <div className="fixed inset-0 z-[80] bg-white dark:bg-slate-950 flex flex-col" role="dialog" aria-modal="true" aria-label={`Cooking ${vm.title}`}>
      <div className="flex items-center gap-3 px-4 sm:px-6 py-3 border-b border-slate-200 dark:border-slate-800">
        <h2 className="flex-1 min-w-0 truncate text-lg sm:text-2xl font-semibold">{vm.title}</h2>
        <div className="flex items-center gap-1" aria-label="Servings">
          <button onClick={() => setServings(adjustServings(servings, -1))} className="p-2 rounded-lg bg-slate-100 dark:bg-slate-800" aria-label="Fewer servings"><Minus size={18} /></button>
          <span className="min-w-[5.5rem] text-center text-sm sm:text-base">{servings} serving{servings === 1 ? "" : "s"}</span>
          <button onClick={() => setServings(adjustServings(servings, 1))} className="p-2 rounded-lg bg-slate-100 dark:bg-slate-800" aria-label="More servings"><Plus size={18} /></button>
        </div>
        <button onClick={() => setShowIngredients(!showIngredients)} aria-pressed={showIngredients} className={`px-3 py-2 rounded-lg text-sm flex items-center gap-1.5 ${showIngredients ? "bg-blue-600 text-white" : "bg-slate-100 dark:bg-slate-800"}`}>
          <ListChecks size={16} /> <span className="hidden sm:inline">Ingredients</span>
        </button>
        <button onClick={onClose} className="p-2 rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800" aria-label="Close cook mode"><X size={24} /></button>
      </div>

      <div className="flex-1 min-h-0 flex flex-col sm:flex-row">
        {showIngredients && (
          <aside className="sm:w-80 sm:border-r border-b sm:border-b-0 border-slate-200 dark:border-slate-800 overflow-y-auto p-4 max-h-[45vh] sm:max-h-none" aria-label="Ingredients">
            <ul className="space-y-1.5">
              {ingredients.map((text, i) => (
                <li key={i}>
                  <label className={`flex items-start gap-2.5 text-base sm:text-lg ${ticked.has(i) ? "line-through text-slate-400" : ""}`}>
                    <input type="checkbox" className="mt-1.5 w-4 h-4" checked={ticked.has(i)} onChange={() => toggleTick(i)} /> {text}
                  </label>
                </li>
              ))}
            </ul>
          </aside>
        )}

        <main className="flex-1 min-w-0 overflow-y-auto flex flex-col justify-center p-6 sm:p-10">
          {count === 0 ? (
            <div className="text-center text-slate-500 dark:text-slate-400">
              <p className="text-xl">No instructions saved yet.</p>
              {onAddSteps && <button onClick={onAddSteps} className="mt-4 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white">Add instructions</button>}
            </div>
          ) : (
            <>
              <p className="text-sm sm:text-base font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-3">{stepLabel(step, count)}</p>
              <p className="text-2xl sm:text-4xl leading-snug sm:leading-snug">{vm.steps[clampStep(step, count)]}</p>
            </>
          )}
        </main>
      </div>

      {count > 0 && (
        <div className="flex gap-3 px-4 sm:px-6 py-3 border-t border-slate-200 dark:border-slate-800">
          <button onClick={() => setStep(clampStep(step - 1, count))} disabled={step <= 0} className="flex-1 py-4 rounded-xl text-lg flex items-center justify-center gap-2 bg-slate-100 dark:bg-slate-800 disabled:opacity-40">
            <ChevronLeft size={22} /> Previous
          </button>
          {step >= count - 1 ? (
            <button onClick={onClose} className="flex-1 py-4 rounded-xl text-lg bg-emerald-600 hover:bg-emerald-700 text-white">Done</button>
          ) : (
            <button onClick={() => setStep(clampStep(step + 1, count))} className="flex-1 py-4 rounded-xl text-lg flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 text-white">
              Next <ChevronRight size={22} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
