// "Use from pantry?": asked right after a planned meal with a recipe is logged. The recipe's lines matched to
// pantry items are pre-filled; one tap confirms and takes them out of the pantry, or the person skips it.
// The server allows one confirm per logged entry (a second is a 409) and never lets stock go below zero.

import { useState } from "react";
import { foodApi, errorText } from "./api.ts";
import type { PantrySuggestions } from "./types.ts";
import { Notice, Sheet, btnPrimary, btnSecondary, inputCls, mutedCls } from "./ui.tsx";

/** Is there anything worth asking about? Something that was matched AND can be counted, on an entry not already used. */
export const worthAsking = (s: PantrySuggestions): boolean => !s.alreadyUsed && s.items.some((i) => i.countable);

interface Props {
  suggestions: PantrySuggestions;
  /** "1 of 2" when several meals were logged together. */
  position?: string;
  onClose: () => void;
  /** Said back to the diary as a toast. */
  onDone: (message: string) => void;
}

export default function PantryUsePrompt({ suggestions, position, onClose, onDone }: Props) {
  const countable = suggestions.items.filter((i) => i.countable);
  const [checked, setChecked] = useState<Record<string, boolean>>(() => Object.fromEntries(countable.map((i) => [i.pantryItemId, i.suggested > 0])));
  const [amounts, setAmounts] = useState<Record<string, string>>(() => Object.fromEntries(countable.map((i) => [i.pantryItemId, String(i.suggested)])));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function confirm() {
    const picked = countable.filter((i) => checked[i.pantryItemId]);
    const items: Array<{ pantryItemId: string; amount: number }> = [];
    for (const i of picked) {
      const amount = Number(amounts[i.pantryItemId]);
      if (!Number.isFinite(amount) || amount <= 0) return setError(`Enter an amount above 0 for ${i.name}, or untick it.`);
      items.push({ pantryItemId: i.pantryItemId, amount });
    }
    if (items.length === 0) return setError("Tick at least one item, or choose Skip.");
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await foodApi.usePantry(suggestions.entryId, items);
      const clamped = res.updated.filter((u) => u.clamped).map((u) => u.name);
      onDone(
        `Took ${res.updated.length} ${res.updated.length === 1 ? "item" : "items"} out of the pantry for ${suggestions.recipeName}.` +
          (clamped.length ? ` ${clamped.join(", ")} ran out, so it is now 0.` : ""),
      );
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <Sheet title="Use from pantry?" onClose={onClose}>
      <p className="text-sm text-slate-800 dark:text-slate-200">
        You logged <strong>{suggestions.recipeName}</strong>
        {position ? <span className={mutedCls}> ({position})</span> : null}. Take these out of the pantry?
      </p>
      <ul className="space-y-2">
        {suggestions.items.map((i) => (
          <li key={i.pantryItemId} className="flex items-center gap-3 rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-2">
            {i.countable ? (
              <>
                <input
                  type="checkbox"
                  aria-label={`Use ${i.name}`}
                  checked={!!checked[i.pantryItemId]}
                  onChange={(e) => setChecked({ ...checked, [i.pantryItemId]: e.target.checked })}
                />
                <span className="flex-1 min-w-0">
                  <span className="block text-sm font-medium text-slate-900 dark:text-slate-100 break-words">{i.name}</span>
                  <span className={`block text-xs ${mutedCls}`}>
                    {i.stock !== null ? `${i.stock} in stock` : ""}
                    {i.lines.length ? ` · ${i.lines.join("; ")}` : ""}
                  </span>
                </span>
                <input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="any"
                  aria-label={`Amount of ${i.name}`}
                  className={`${inputCls.replace("w-full ", "")} w-20 shrink-0`}
                  value={amounts[i.pantryItemId]}
                  disabled={!checked[i.pantryItemId]}
                  onChange={(e) => setAmounts({ ...amounts, [i.pantryItemId]: e.target.value })}
                />
              </>
            ) : (
              <span className="flex-1 min-w-0">
                <span className="block text-sm font-medium text-slate-900 dark:text-slate-100 break-words">{i.name}</span>
                <span className={`block text-xs ${mutedCls}`}>Not counted in the pantry (its quantity is words), so it can't be reduced here.</span>
              </span>
            )}
          </li>
        ))}
      </ul>
      {suggestions.unmatchedLines > 0 && (
        <p className={`text-xs ${mutedCls}`}>
          {suggestions.unmatchedLines} {suggestions.unmatchedLines === 1 ? "ingredient isn't" : "ingredients aren't"} in your pantry.
        </p>
      )}
      {error && <Notice tone="error">{error}</Notice>}
      <div className="flex gap-2">
        <button className={`${btnPrimary} flex-1`} disabled={busy} onClick={confirm}>Use these</button>
        <button className={`${btnSecondary} flex-1`} disabled={busy} onClick={onClose}>Skip</button>
      </div>
    </Sheet>
  );
}
