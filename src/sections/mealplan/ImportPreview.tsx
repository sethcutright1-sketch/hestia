// The preview everything but typing goes through (paste, upload, link): what the parsers found, which a person can now CORRECT
// before it is saved, not only drop. Name, ingredients (one per line), steps (one per line) and servings are editable. Editing a
// recipe's ingredient text drops the amounts-and-lines the parser kept for it, so the server rebuilds the lines from what is
// written here. What the person approves is exactly what gets saved.

import { useState } from "react";
import { X, Pencil } from "lucide-react";

export interface ParsedRecipe {
  name: string;
  ingredients: string[];
  // Present for pasted text and web pages (see routes/recipeImport.ts): the lines as written, the
  // servings, the page it came from and the page's own calories per serving.
  lines?: { text: string; pantryName: string }[];
  yieldServings?: number;
  // The method: a page's recipeInstructions, a file's instructions column, or what followed the Instructions heading in pasted text.
  instructions?: string[];
  sourceUrl?: string;
  nutrition?: { siteKcalPerServing: number };
}

const input = "w-full px-2.5 py-1.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900";

/** The ingredient text a row shows: the lines as written when the parser kept them, else the names. */
export const ingredientText = (row: ParsedRecipe): string => (row.lines?.map((l) => l.text) ?? row.ingredients).join("\n");

/** A row with its ingredients replaced by what was typed (one per line); the parser's lines are dropped so they are rebuilt. */
export function withIngredientText(row: ParsedRecipe, text: string): ParsedRecipe {
  const { lines: _dropped, ...rest } = row;
  return { ...rest, ingredients: text.split("\n").map((l) => l.trim()).filter(Boolean) };
}

export default function ImportPreview({
  rows,
  busy,
  onCancel,
  onConfirm,
  onEdit,
}: {
  rows: ParsedRecipe[];
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  onEdit: (rows: ParsedRecipe[]) => void;
}) {
  const [editing, setEditing] = useState<number | null>(null);
  const update = (i: number, row: ParsedRecipe) => onEdit(rows.map((r, at) => (at === i ? row : r)));

  return (
    <div className="mb-4 rounded-lg border border-blue-200 dark:border-blue-900 bg-blue-50/50 dark:bg-blue-950/20 p-3">
      <p className="text-sm font-medium mb-2">
        Found {rows.length} recipe{rows.length === 1 ? "" : "s"} — check, fix anything wrong, then save
      </p>
      <ul className="space-y-2 mb-3 max-h-96 overflow-y-auto">
        {rows.map((row, i) => (
          <li key={i} className="text-sm">
            <div className="flex items-center gap-2">
              <span className="font-medium flex-1 min-w-0 truncate">{row.name || "(no name)"}</span>
              <button
                onClick={() => setEditing(editing === i ? null : i)}
                className="text-slate-400 hover:text-blue-600 dark:hover:text-blue-400 shrink-0"
                aria-label={`${editing === i ? "Stop editing" : "Edit"} ${row.name}`}
                aria-expanded={editing === i}
              >
                <Pencil size={14} />
              </button>
              <button
                onClick={() => { setEditing(null); onEdit(rows.filter((_, at) => at !== i)); }}
                className="text-slate-400 hover:text-red-600 dark:hover:text-red-400 shrink-0"
                aria-label={`Don't import ${row.name}`}
              >
                <X size={14} />
              </button>
            </div>
            {editing === i ? (
              <div className="mt-1.5 space-y-1.5">
                <input className={input} value={row.name} onChange={(e) => update(i, { ...row, name: e.target.value })} aria-label="Name" />
                <textarea className={input} rows={5} value={ingredientText(row)} onChange={(e) => update(i, withIngredientText(row, e.target.value))} aria-label="Ingredients, one per line" />
                <textarea
                  className={input}
                  rows={4}
                  value={(row.instructions ?? []).join("\n")}
                  onChange={(e) => update(i, { ...row, instructions: e.target.value.split("\n") })}
                  placeholder="Steps, one per line"
                  aria-label="Steps, one per line"
                />
                <label className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                  Makes
                  <input
                    className="w-20 px-2 py-1 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                    inputMode="numeric"
                    value={row.yieldServings ?? ""}
                    onChange={(e) => {
                      const n = Math.round(Number(e.target.value));
                      const { yieldServings: _y, ...rest } = row;
                      update(i, e.target.value.trim() !== "" && n >= 1 && n <= 1000 ? { ...rest, yieldServings: n } : rest);
                    }}
                    aria-label="Servings"
                  />
                  servings
                </label>
              </div>
            ) : (
              <>
                {/* The lines as the source wrote them (quantities kept) when it had them. */}
                <div className="text-xs text-slate-500 dark:text-slate-400">{(row.lines?.map((l) => l.text) ?? row.ingredients).join(", ")}</div>
                {(row.yieldServings !== undefined || row.nutrition || row.instructions) && (
                  <div className="text-xs text-slate-500 dark:text-slate-400">
                    {[
                      row.yieldServings !== undefined && `Makes ${row.yieldServings}`,
                      row.nutrition && `the site says ${Math.round(row.nutrition.siteKcalPerServing)} kcal per serving`,
                      row.instructions && row.instructions.filter((s) => s.trim()).length > 0 && `${row.instructions.filter((s) => s.trim()).length} step${row.instructions.filter((s) => s.trim()).length === 1 ? "" : "s"}`,
                    ].filter(Boolean).join(" · ")}
                  </div>
                )}
              </>
            )}
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        <button
          onClick={onConfirm}
          disabled={busy || rows.length === 0 || rows.some((r) => !r.name.trim() || (r.ingredients.length === 0 && !(r.lines && r.lines.length > 0)))}
          className="px-3 py-1.5 rounded-lg text-sm bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white"
        >
          {busy ? "Saving…" : `Save ${rows.length}`}
        </button>
        <button onClick={onCancel} className="px-3 py-1.5 rounded-lg text-sm bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700">
          Cancel
        </button>
      </div>
    </div>
  );
}
