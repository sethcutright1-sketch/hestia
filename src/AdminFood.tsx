// The admin-only food items in the header settings panel (AdminSettings.tsx):
//
//   KioskFoodAccess   in the Kiosk tab: how much of the food section the shared fridge screen may show
//                     (GET/PUT /api/nutrition/settings/kiosk; admin only on the server, default hidden)
//   FoodAdminTab      the Food tab: "Barcodes we couldn't find", a read-only list from GET /api/nutrition/barcodes/misses.
//   CloudHealthSwitches  "Let Claude / Gemini answer food-diary questions" and "Block spoken questions about food and
//                     health". Defined here with the other food admin items but RENDERED in the Security tab, right
//                     under the cloud-finance switches it mirrors (same password rule; routes/assistant.ts).
//
// Everyone's own food settings (profile, goals, meals, who can see my food data, the food-diary PIN) are in the Food
// section's gear, not here.

import { useEffect, useState } from "react";
import { api, ApiError, type AssistantSettings, type CloudHealthSettings } from "./api.ts";
import { PasswordGatedToggle } from "./PasswordGatedToggle.tsx";
import { foodApi } from "./sections/food/api.ts";
import { longDate } from "./sections/food/dates.ts";
import type { BarcodeMiss, KioskFoodAccess as Access, KioskFoodSetting } from "./sections/food/types.ts";

export const KIOSK_FOOD_OPTIONS: Array<{ value: Access; label: string; detail: string }> = [
  { value: "hidden", label: "Hidden", detail: "The kiosk shows nothing about food. This is the default." },
  { value: "plan_only", label: "Plan only", detail: "The kiosk shows the day's approved meals from the plan and, for each person, their portion of those meals (name, calories, meal). Nothing a person planned privately in their own diary, no totals, no logged food, no weights." },
  { value: "plan_and_quick_log", label: "Plan + quick logging", detail: "As plan only, and the kiosk can also mark a person's planned meal from the plan as eaten, with one tap, on its day or any day before (never a future one). It cannot add or change anything else." },
];

export function KioskFoodAccess() {
  const [setting, setSetting] = useState<KioskFoodSetting | null>(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    foodApi.kioskSetting().then(setSetting).catch((err) => setError(err instanceof ApiError ? err.message : "Couldn't load the setting."));
  }, []);

  async function choose(value: Access) {
    if (busy || !setting || setting.kioskAccess === value) return;
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      setSetting(await foodApi.setKioskSetting(value));
      setSuccess("Saved.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save the setting.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2 border-t border-slate-200 dark:border-slate-800 pt-4">
      <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wide">Kiosk food access</label>
      <p className="text-xs text-slate-500 dark:text-slate-400 leading-normal">
        How much of the food section the kiosk login may show. It only ever works with meals from the household meal plan: whatever you
        choose, it never has a food diary of its own and never sees anyone's diary, daily totals, weight or photos.
      </p>
      {!setting && !error && <p className="text-xs text-slate-400">Loading…</p>}
      {setting && (
        <div role="radiogroup" aria-label="Kiosk food access" className="space-y-2">
          {KIOSK_FOOD_OPTIONS.map((o) => (
            <label
              key={o.value}
              className={`flex items-start gap-2.5 rounded-lg border p-2.5 cursor-pointer ${setting.kioskAccess === o.value ? "border-blue-500 bg-blue-50/60 dark:bg-blue-950/20" : "border-slate-200 dark:border-slate-800"}`}
            >
              <input type="radio" name="kiosk-food-access" className="mt-1" checked={setting.kioskAccess === o.value} disabled={busy} onChange={() => void choose(o.value)} />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-slate-900 dark:text-slate-100">{o.label}</span>
                <span className="block text-xs text-slate-500 dark:text-slate-400 leading-normal">{o.detail}</span>
              </span>
            </label>
          ))}
        </div>
      )}
      {error && <p className="text-xs font-medium text-rose-600 dark:text-rose-400">{error}</p>}
      {success && <p className="text-xs font-medium text-emerald-600 dark:text-emerald-400">{success}</p>}
    </div>
  );
}

export function FoodAdminTab() {
  const [misses, setMisses] = useState<BarcodeMiss[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    foodApi.barcodeMisses().then(setMisses).catch((err) => setError(err instanceof ApiError ? err.message : "Couldn't load the list."));
  }, []);

  return (
    <div className="space-y-4 max-w-sm">
      <div className="space-y-2">
        <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wide">Barcodes we couldn't find</label>
        <p className="text-xs text-slate-500 dark:text-slate-400 leading-normal">
          Scans where the free databases (Open Food Facts, USDA) had no nutrition, most often scanned first. It answers one question: is a paid
          database worth it? A barcode marked "now a food" has since been added or linked to a food, so scanning it works. This list is read-only.
        </p>
        {error && <p className="text-xs font-medium text-rose-600 dark:text-rose-400">{error}</p>}
        {!misses && !error && <p className="text-xs text-slate-400">Loading…</p>}
        {misses && misses.length === 0 && <p className="text-xs text-slate-500 dark:text-slate-400">No missed scans. Every barcode so far had nutrition.</p>}
        {misses && misses.length > 0 && (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-lg">
            {misses.map((m) => (
              <li key={m.gtin14} className="p-2.5 space-y-0.5">
                <div className="flex items-baseline gap-2">
                  <span className="font-mono text-xs text-slate-900 dark:text-slate-100 break-all flex-1">{m.code}</span>
                  <span className="text-xs font-semibold text-slate-700 dark:text-slate-300 shrink-0">{m.count} {m.count === 1 ? "scan" : "scans"}</span>
                </div>
                {(m.name || m.brand) && (
                  <p className="text-xs text-slate-600 dark:text-slate-400 break-words">{[m.brand, m.name].filter(Boolean).join(" · ")}</p>
                )}
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Last scanned {longDate(m.lastSeenAt.slice(0, 10))}
                  {m.resolved && (
                    <span className="ml-2 font-medium text-emerald-700 dark:text-emerald-400">now a food{m.foodName ? `: ${m.foodName}` : ""}</span>
                  )}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/**
 * The health twins of the money switches in the Security tab: whether a cloud model may see food-diary data
 * (what people ate, calorie budgets, weight, steps), one switch per provider and independent of the money ones, off by
 * default; and whether a spoken question about it is refused, on by default. With a switch off, that provider is never
 * even sent the food-diary tools and a food-diary question runs on the local model.
 */
export function CloudHealthSwitches() {
  const [cloudHealth, setCloudHealth] = useState<CloudHealthSettings>({ anthropic: false, gemini: false });
  const [noHealthVoice, setNoHealthVoice] = useState(true);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [voiceError, setVoiceError] = useState("");

  useEffect(() => {
    api
      .get<AssistantSettings>("/api/assistant/settings")
      .then((d) => {
        if (d.allowCloudHealth) setCloudHealth(d.allowCloudHealth);
        if (typeof d.noHealthVoiceData === "boolean") setNoHealthVoice(d.noHealthVoiceData);
      })
      .catch(() => {});
  }, []);

  async function saveCloudHealth(provider: keyof CloudHealthSettings, allow: boolean, password?: string) {
    const d = await api.put<{ allowCloudHealth: CloudHealthSettings }>("/api/assistant/settings/cloud-health", { provider, allow, password });
    setCloudHealth(d.allowCloudHealth);
  }

  async function toggleVoice() {
    const next = !noHealthVoice;
    setVoiceBusy(true);
    setVoiceError("");
    try {
      await api.put("/api/assistant/settings/health-voice", { noHealthVoiceData: next });
      setNoHealthVoice(next);
    } catch (err) {
      setVoiceError(err instanceof ApiError ? err.message : "Failed to save.");
    } finally {
      setVoiceBusy(false);
    }
  }

  return (
    <>
      <div className="space-y-2 pt-3 border-t border-slate-100 dark:border-slate-800">
        <label className="flex items-start gap-2.5 cursor-pointer">
          <input type="checkbox" checked={noHealthVoice} disabled={voiceBusy} onChange={toggleVoice} className="mt-0.5 shrink-0" />
          <span>
            <span className="block text-xs font-bold text-slate-700 dark:text-slate-300">Block spoken questions about food and health</span>
            <span className="block text-xs text-slate-500 dark:text-slate-400 leading-normal mt-0.5">
              When on, a spoken question about someone's food diary, calories, weight or steps from the Wear OS app (whose speech-to-text
              may use Google) is refused before it reaches the assistant — type it instead. The browser's microphone button isn't affected,
              because this PC does that listening. The same rule as the money one in Security.
            </span>
          </span>
        </label>
        {voiceError && <p className="text-xs font-medium text-rose-600 dark:text-rose-400">{voiceError}</p>}
      </div>
      <PasswordGatedToggle
        label="Let Claude answer food-diary questions"
        enabled={cloudHealth.anthropic}
        onSave={(allow, password) => saveCloudHealth("anthropic", allow, password)}
        confirmLabel="Allow Claude to see food and health data"
        enabledNote="Food-diary data can currently leave this machine when Claude is selected."
        description="Off by default: questions about what people ate, calorie budgets, weight and steps always run on the local model, and Claude is not even given the food-diary tools. When on, and Claude is picked in the assistant, that data is sent to Anthropic to answer them. Separate from the money switch. Data already sent can't be recalled by turning this back off."
      />
      <PasswordGatedToggle
        label="Let Gemini answer food-diary questions"
        enabled={cloudHealth.gemini}
        onSave={(allow, password) => saveCloudHealth("gemini", allow, password)}
        confirmLabel="Allow Gemini to see food and health data"
        enabledNote="Food-diary data can currently leave this machine when Gemini is selected."
        description="Off by default. When on, and Gemini is picked in the assistant, what people ate, calorie budgets, weight and steps are sent to Google to answer them. Separate from Claude's switch and from the money switches. Data already sent can't be recalled by turning this back off."
        extraWarning="Only turn this on if your GEMINI_API_KEY's Google Cloud project has billing enabled (shown as the Paid tier under AI Studio → API keys). On the free tier Google may use your prompts, including food and health details, to improve its products and have people review them."
      />
    </>
  );
}
