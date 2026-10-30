// Add food: a sheet over the diary, opened from "+ Add" on a meal. It defaults to that meal and day.
//
// Tabs: Search, Recent, Scan, Meals (saved + previous), Recipes, Quick add, Create food. A food ends in the
// amount step; a meal or a quick add logs in one go. Whatever is logged, the sheet closes and hands the
// diary a message (and, where it can be taken back, an Undo) through onLogged.

import { useState } from "react";
import { foodApi, errorText } from "./api.ts";
import { startAmount, type AmountInput, type ComputedAmount } from "./amount.ts";
import AmountStep from "./AmountStep.tsx";
import { CreateFoodTab, QuickAddTab, type CreateFoodPrefill } from "./FoodForms.tsx";
import { RecentTab, RecipesTab, SearchTab } from "./FoodPickers.tsx";
import MealsTab from "./MealsTab.tsx";
import ScanTab, { ShareSwitch, type ChooseOpts } from "./ScanTab.tsx";
import { newId } from "./meals.ts";
import type { Food } from "./types.ts";
import { Notice, Sheet, btnSecondary } from "./ui.tsx";
import { Barcode } from "lucide-react";

export interface Logged {
  message: string;
  /** Takes the logging back. Absent when it can't be. */
  undo?: () => Promise<void>;
}

type TabId = "search" | "recent" | "scan" | "meals" | "recipes" | "quick" | "create";

const TABS: Array<[TabId, string]> = [
  ["search", "Search"], ["recent", "Recent"], ["scan", "Scan"], ["meals", "Meals"], ["recipes", "Recipes"], ["quick", "Quick add"], ["create", "Create food"],
];

interface Props {
  date: string;
  today: string;
  /** The meal "+ Add" was tapped on. */
  slot: string;
  /** Meals food can be added to (switched on). */
  slots: Array<{ key: string; label: string }>;
  onClose: () => void;
  onLogged: (logged: Logged) => void;
}

interface Step {
  food: Food;
  source: "manual" | "scan";
  opts: ChooseOpts;
}

export default function AddFood({ date, today, slot, slots, onClose, onLogged }: Props) {
  const [tab, setTab] = useState<TabId>("search");
  const [step, setStep] = useState<Step | null>(null);
  const [createPrefill, setCreatePrefill] = useState<CreateFoodPrefill | undefined>(undefined);
  // Each visit to the scan tab is a fresh ScanTab (its own camera), so leaving it ends it; this key restarts it.
  const [scan, setScan] = useState<{ key: number; autostart: boolean; message: string }>({ key: 0, autostart: false, message: "" });
  const [slotKey, setSlotKey] = useState(slot);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const slotLabel = (key: string) => slots.find((s) => s.key === key)?.label ?? key;
  const planned = date > today;

  function show(next: TabId, extra?: { prefill?: CreateFoodPrefill }) {
    setStep(null);
    setError("");
    setCreatePrefill(extra?.prefill);
    setTab(next);
  }

  function chooseFood(food: Food, source: "manual" | "scan", opts: ChooseOpts = {}) {
    setError("");
    setStep({ food, source, opts });
  }

  function scanAgain(autostart: boolean, message = "") {
    setStep(null);
    setScan((s) => ({ key: s.key + 1, autostart, message }));
    setTab("scan");
  }

  async function log(step: Step, computed: ComputedAmount, _input: AmountInput, chosenSlot: string | null) {
    if (busy) return;
    const into = chosenSlot ?? slotKey;
    const id = newId();
    setBusy(true);
    setError("");
    try {
      await foodApi.addEntry(date, { id, slot: into, source: step.source === "scan" ? "scan" : "manual", foodId: step.food.id, ...computed.body });
      onLogged({
        message: `${planned ? "Planned" : "Added"} ${step.food.name} ${planned ? "for" : "to"} ${slotLabel(into)}.`,
        undo: async () => { await foodApi.deleteEntry(id); },
      });
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  const title = step ? step.food.name : `Add to ${slotLabel(slotKey)}`;

  return (
    <Sheet title={title} onClose={onClose} back={step ? { label: "Back", onClick: () => setStep(null) } : undefined}>
      {step ? (
        <AmountStep
          key={step.food.id}
          food={step.food}
          start={startAmount(step.food)}
          slots={slots}
          slot={slotKey}
          confirmLabel={planned ? "Add to plan" : "Add to diary"}
          busy={busy}
          error={error}
          onConfirm={(c, input, s) => {
            if (s) setSlotKey(s);
            void log(step, c, input, s);
          }}
          above={
            <>
              {step.opts.note && <Notice tone="ok">{step.opts.note}</Notice>}
              {step.opts.undo && (
                <UndoLink
                  label={step.opts.undo.label}
                  run={step.opts.undo.run}
                  onDone={(message) => scanAgain(false, message)}
                />
              )}
              {step.opts.created && (
                <ShareSwitch food={step.food} onChange={(food) => setStep((cur) => (cur ? { ...cur, food } : cur))} />
              )}
            </>
          }
          below={
            step.source === "scan" && (
              <button onClick={() => scanAgain(true)} className={`${btnSecondary} w-full inline-flex items-center justify-center gap-1.5`}>
                <Barcode size={16} /> Scan another
              </button>
            )
          }
        />
      ) : (
        <>
          <div role="tablist" className="flex flex-wrap gap-1">
            {TABS.map(([id, label]) => (
              <button
                key={id}
                role="tab"
                aria-selected={tab === id}
                onClick={() => (id === "scan" ? scanAgain(false) : show(id))}
                className={`px-3 py-1.5 rounded-full text-sm ${
                  tab === id
                    ? "bg-blue-600 text-white font-medium"
                    : "bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {tab === "search" && <SearchTab onPick={(f) => chooseFood(f, "manual")} />}
          {tab === "recent" && <RecentTab onPick={(f) => chooseFood(f, "manual")} />}
          {tab === "recipes" && <RecipesTab onPick={(f) => chooseFood(f, "manual")} />}
          {tab === "meals" && (
            <MealsTab date={date} today={today} slot={slotKey} slotLabel={slotLabel(slotKey)} onLogged={onLogged} />
          )}
          {tab === "quick" && (
            <QuickAddTab date={date} today={today} slot={slotKey} slotLabel={slotLabel(slotKey)} onLogged={onLogged} />
          )}
          {tab === "create" && (
            <CreateFoodTab
              key={createPrefill?.barcode ?? "plain"}
              prefill={createPrefill}
              onCreated={(food) => chooseFood(food, createPrefill?.barcode ? "scan" : "manual")}
            />
          )}
          {tab === "scan" && (
            <ScanTab
              key={scan.key}
              autostart={scan.autostart}
              message={scan.message}
              onChooseFood={(food, opts) => chooseFood(food, "scan", opts)}
              onCreateFood={(prefill) => show("create", { prefill })}
              onQuickAdd={() => show("quick")}
              onScanAnother={() => scanAgain(true)}
            />
          )}
        </>
      )}
    </Sheet>
  );
}

/** "Wrong food? Take the barcode off it": runs the undo and sends the person back to the scan tab with what happened. */
function UndoLink({ label, run, onDone }: { label: string; run: () => Promise<string>; onDone: (message: string) => void }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="space-y-1">
      <button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError("");
          try {
            onDone(await run());
          } catch (err) {
            setError(errorText(err));
            setBusy(false);
          }
        }}
        className="text-sm text-blue-600 dark:text-blue-400 hover:underline disabled:opacity-50"
      >
        {label}
      </button>
      {error && <p role="alert" className="text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
