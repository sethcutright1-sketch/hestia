// "Fill calories" for the Pantry and for a shopping list: pick which model may guess the figures
// that no label or catalogue food could supply, run it, and show how each number was arrived at.
//
// The model picker is this screen's own (the Assistant's lives only on that screen). It lists the
// same providers as the chat drop-down. Only item names are sent to the chosen model, so a cloud
// model is fine here; the button names the model that will run, and every guessed figure is shown
// as an estimate with that model's name.

import { useEffect, useState } from "react";
import { Flame } from "lucide-react";
import { api, type CalorieFillOutcome, type ItemCalories } from "./api.ts";

interface ProviderInfo {
  id: "ollama" | "anthropic" | "gemini";
  label: string;
  available: boolean;
  reason?: string;
}

const NO_MODEL = "";

/** One line for an outcome: what was filled, from where, and what is still blank. */
export function fillMessage(o: CalorieFillOutcome): string {
  const { barcode, foodDb, estimated, stillMissing } = o.summary;
  const parts = [
    barcode ? `${barcode} from barcode data` : "",
    foodDb ? `${foodDb} from the food catalogue` : "",
    estimated ? `${estimated} estimated by ${o.model ?? "the model"}` : "",
  ].filter(Boolean);
  const done = parts.length ? `Filled ${parts.join(", ")}.` : "Nothing new to fill.";
  return `${done}${stillMissing ? ` ${stillMissing} still without calories.` : ""}${o.warning ? ` ${o.warning}` : ""}`;
}

export function CalorieFill<R extends CalorieFillOutcome>({ endpoint, onDone }: { endpoint: string; onDone: (result: R) => void }) {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [provider, setProvider] = useState(NO_MODEL);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .get<{ providers: ProviderInfo[] }>("/api/assistant/providers")
      .then((d) => setProviders(d.providers.filter((p) => p.available)))
      .catch(() => setProviders([]));
  }, []);

  async function run() {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await api.post<R>(endpoint, provider ? { provider } : {});
      onDone(result);
      setMessage(fillMessage(result));
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const chosen = providers.find((p) => p.id === provider);
  return (
    <div className="mb-3 text-xs">
      <div className="flex items-center gap-2 flex-wrap text-slate-500 dark:text-slate-400">
        <span>Estimate missing calories with</span>
        <select
          className="rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-1.5 py-1 text-xs"
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
          disabled={busy}
          aria-label="Model for calorie estimates"
        >
          <option value={NO_MODEL}>No model (only known data)</option>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>
        <button
          onClick={run}
          disabled={busy}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg font-medium bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 disabled:opacity-50"
        >
          <Flame size={13} />
          {busy ? "Working…" : "Fill calories"}
        </button>
      </div>
      {chosen && chosen.id !== "ollama" && (
        <p className="mt-1 text-slate-500 dark:text-slate-400">Item names (nothing else) are sent to {chosen.label} to make the estimates.</p>
      )}
      {message && <p className="mt-1 text-slate-600 dark:text-slate-300">{message}</p>}
      {error && <p className="mt-1 text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}

/** The figure beside an item. An estimate is marked "~", worded as an estimate, and names its model. */
export function CalorieBadge({ calories }: { calories?: ItemCalories }) {
  if (!calories) return null;
  const per = calories.serving ? ` per ${calories.serving}` : " per serving";
  const estimate = calories.source === "estimate";
  const origin = estimate
    ? `Estimated${calories.model ? ` by ${calories.model}` : ""} from the item's name — not measured`
    : calories.source === "barcode"
      ? "From barcode data"
      : "From the food catalogue";
  return (
    <span
      className={`ml-2 text-[11px] px-1.5 py-0.5 rounded ${
        estimate
          ? "bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300"
          : "bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-300"
      }`}
      title={origin}
    >
      {estimate ? "~" : ""}{calories.kcal} calories{per}{estimate ? " · estimate" : ""}
    </span>
  );
}
