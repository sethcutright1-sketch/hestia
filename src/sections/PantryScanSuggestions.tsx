// Shared checklist UI for both scan-a-photo entry points (Fridge's camera
// button and Pantry's file upload) -- same suggest-then-confirm shape either
// way: nothing lands in the pantry until the user checks it and confirms,
// via the same POST /api/pantry the manual add form already uses.
import { useState } from "react";
import { Check } from "lucide-react";
import { api, type PantryScanSuggestion, type PantryItem } from "../api.ts";

export default function PantryScanSuggestions({
  items,
  photoUrl,
  onDone,
  onCancel,
}: {
  items: PantryScanSuggestion[];
  /** The photo this scan actually analyzed, if the caller has one to show --
   *  Fridge shows its own camera preview separately, so this is really only
   *  supplied by Pantry's file-upload scan today. */
  photoUrl?: string;
  onDone: (added: PantryItem[]) => void;
  onCancel: () => void;
}) {
  const [checked, setChecked] = useState<Set<string>>(
    () => new Set(items.filter((i) => !i.alreadyTracked).map((i) => i.name))
  );
  const [adding, setAdding] = useState(false);

  function toggle(name: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  async function addChecked() {
    setAdding(true);
    const added: PantryItem[] = [];
    for (const item of items) {
      if (!checked.has(item.name)) continue;
      try {
        const res = await api.post<{ item: PantryItem }>("/api/pantry", { name: item.name });
        added.push(res.item);
      } catch {
        // Best-effort: one failed add shouldn't block the rest of the batch.
      }
    }
    setAdding(false);
    onDone(added);
  }

  if (items.length === 0) {
    return (
      <div className="mt-3 text-sm text-slate-500 dark:text-slate-400">
        {photoUrl && (
          <img src={photoUrl} alt="The photo that was scanned" className="mb-2 rounded-lg max-h-40 object-cover" />
        )}
        Nothing recognizable in that photo.{" "}
        <button onClick={onCancel} className="underline">
          Dismiss
        </button>
      </div>
    );
  }

  return (
    <div className="mt-3 rounded-lg border border-slate-200 dark:border-slate-800 p-3">
      {photoUrl && (
        <img src={photoUrl} alt="The photo that was scanned" className="mb-2 rounded-lg max-h-40 w-full object-cover" />
      )}
      <p className="text-xs text-slate-500 dark:text-slate-400 mb-2">
        Items spotted in the photo — check the ones to add to the pantry.
      </p>
      <ul className="space-y-1 mb-3">
        {items.map((item) => (
          <li key={item.name} className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={checked.has(item.name)} onChange={() => toggle(item.name)} />
            <span>{item.name}</span>
            {item.alreadyTracked && (
              <span className="text-xs text-slate-400 dark:text-slate-500">already in pantry</span>
            )}
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        <button
          onClick={addChecked}
          disabled={adding || checked.size === 0}
          className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs disabled:opacity-50 flex items-center gap-1"
        >
          <Check size={13} /> {adding ? "Adding…" : `Add checked (${checked.size})`}
        </button>
        <button
          onClick={onCancel}
          className="px-3 py-1.5 rounded-lg text-xs text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
