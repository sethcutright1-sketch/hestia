// The Scan tab of Add food: camera (or typed digits) -> a food in the amount step. The decisions live in
// scanFlow.ts (tested); this is the screens around them. One scan, start to finish:
//
//   read      the camera is released the moment a code is accepted, whatever happens next
//   check     a code that isn't a barcode is refused here; an in-store price/weight label is never looked up
//   look up   POST /barcodes/lookup. Its answer is one of:
//               food         -> a food already linked to this code goes straight to the amount step. A brand-new
//                               food made from Open Food Facts / USDA first asks "Or is this one of your foods?"
//                               when there are likely matches; "Use the scanned product" stays the fast path
//               miss         -> "Is this one of your foods?" (your own foods by name), Create food, or Quick add
//               unavailable  -> a database couldn't be reached: try again. A different screen from "not found"
//               label / invalid / network / error -> a dead end with Scan another
//   again     "Scan another" restarts the camera from the amount step or any dead end
//
// Camera scanning only works over HTTPS or on localhost (getUserMedia); elsewhere the tab says so and the
// typed-digits box still works. Scans are not reported to a scan log (household-app has none).

import ScannerView from "../../ScannerView";
import { useEffect, useRef, useState } from "react";
import { Barcode, Camera, CameraOff } from "lucide-react";
import { useBarcodeCamera } from "../../useBarcodeCamera.ts";
import { ApiError, errorText, foodApi } from "./api.ts";
import { defaultKcal, defaultServingLabel } from "./amount.ts";
import { FoodRow } from "./FoodPickers.tsx";
import type { CreateFoodPrefill } from "./FoodForms.tsx";
import { candidateQuery, checkCode, createPrefill, digitsOnly, isScannableRead, lookupOutcome } from "./scanFlow.ts";
import type { BarcodeLookupInfo, Food } from "./types.ts";
import { Notice, btnPrimary, btnSecondary, inputCls, mutedCls } from "./ui.tsx";

/** How long a slow "is this one of your foods?" search may hold up logging a product you just scanned. */
const CANDIDATE_WAIT_MS = 2500;

const withTimeout = <T,>(promise: Promise<T>, ms: number, fallback: T): Promise<T> =>
  Promise.race([promise, new Promise<T>((resolve) => window.setTimeout(() => resolve(fallback), ms))]);

export interface ChooseOpts {
  /** A line above the amount step. */
  note?: string;
  /** "Wrong food? Take the barcode off it": run() undoes the link and resolves to the message the scan tab then shows. */
  undo?: { label: string; run: () => Promise<string> };
  /** This food was just made from a database lookup (so the "Only me" switch is offered). */
  created?: boolean;
}

interface Scan {
  raw: string;
  format?: string;
  gtin14: string;
}

type Screen =
  | { kind: "idle" }
  | { kind: "looking"; code: string }
  | { kind: "found"; scan: Scan; food: Food; candidates: Food[] }
  | { kind: "miss"; scan: Scan; info: BarcodeLookupInfo | null }
  | { kind: "unavailable"; scan: Scan; info: BarcodeLookupInfo | null }
  | { kind: "label" }
  | { kind: "dead"; text: string; retry?: Scan };

interface Props {
  onChooseFood: (food: Food, opts?: ChooseOpts) => void;
  onCreateFood: (prefill: CreateFoodPrefill) => void;
  onQuickAdd: () => void;
  /** Restart the scan tab with the camera already running. */
  onScanAnother: () => void;
  autostart?: boolean;
  message?: string;
}

export default function ScanTab({ onChooseFood, onCreateFood, onQuickAdd, onScanAnother, autostart = false, message = "" }: Props) {
  const secure = typeof window !== "undefined" && window.isSecureContext;
  const [camera, setCamera] = useState(autostart && secure);
  const [screen, setScreen] = useState<Screen>({ kind: "idle" });
  const [typed, setTyped] = useState("");
  const token = useRef(0); // bumped to abandon an in-flight lookup (tab left, a new scan)

  useEffect(() => () => { token.current++; }, []);

  const { videoRef, error: cameraError, torchSupported, torchOn, toggleTorch } = useBarcodeCamera({
    active: camera,
    accept: (r) => isScannableRead(r.code, r.format),
    stopOnRead: true,
    onRead: (r) => {
      setCamera(false);
      void handleCode(r.code, r.format);
    },
  });
  // A camera that couldn't start (permission refused, no camera) goes back to "Start camera".
  useEffect(() => {
    if (cameraError) setCamera(false);
  }, [cameraError]);

  async function handleCode(raw: string, format?: string) {
    const mine = ++token.current;
    setCamera(false); // before anything on screen changes: the camera is never left running behind a result
    const check = checkCode(raw, format);
    if (check.kind === "invalid") {
      setScreen({ kind: "dead", text: "That doesn't look like a valid barcode. Check the digits, or scan again." });
      return;
    }
    if (check.kind === "label") {
      setScreen({ kind: "label" });
      return;
    }
    const scan: Scan = { raw, format, gtin14: check.gtin14 };
    setScreen({ kind: "looking", code: raw });
    try {
      const res = await foodApi.lookupBarcode(raw, format);
      if (mine !== token.current) return;
      if (!res.created) {
        onChooseFood(res.food); // already linked to a food you can use: straight to the amount
        return;
      }
      // A product made from a database a moment ago may really be a food you already have (imported history
      // has no barcodes). Look, but never make the fast path wait long for it.
      const candidates = await withTimeout(findCandidates(candidateQuery(res.food)), CANDIDATE_WAIT_MS, [] as Food[]);
      if (mine !== token.current) return;
      if (candidates.length) setScreen({ kind: "found", scan, food: res.food, candidates });
      else onChooseFood(res.food, { created: true });
    } catch (err) {
      if (mine !== token.current) return;
      const body = err instanceof ApiError ? err.body : null;
      const outcome = lookupOutcome(err instanceof ApiError ? { status: err.status, body } : null);
      const info: BarcodeLookupInfo | null = body?.lookup ?? null;
      switch (outcome) {
        case "miss": setScreen({ kind: "miss", scan, info }); break;
        case "unavailable": setScreen({ kind: "unavailable", scan, info }); break;
        case "label": setScreen({ kind: "label" }); break;
        case "invalid": setScreen({ kind: "dead", text: "That doesn't look like a valid barcode. Check the digits, or scan again." }); break;
        case "network": setScreen({ kind: "dead", text: "Couldn't reach the server. Check your connection, then try again.", retry: scan }); break;
        default: setScreen({ kind: "dead", text: `Couldn't look that up: ${errorText(err)}`, retry: scan });
      }
    }
  }

  const scanAnother = (
    <button onClick={onScanAnother} className="inline-flex items-center gap-1.5 text-sm text-blue-600 dark:text-blue-400 hover:underline">
      <Barcode size={15} /> Scan another
    </button>
  );

  // ---- the screens after a read --------------------------------------------------------------

  if (screen.kind === "looking") {
    return <p className={`text-sm ${mutedCls}`} role="status">Read {screen.code}. Looking it up…</p>;
  }

  if (screen.kind === "label") {
    return (
      <div className="space-y-3">
        <Notice tone="warn">That's an in-store label (it holds a price or weight, not a product), so there's nothing to look up.</Notice>
        <p className={`text-sm ${mutedCls}`}>Log it with Quick add, or save it as a food if you'll eat it again.</p>
        <div className="flex gap-2">
          <button className={btnPrimary} onClick={onQuickAdd}>Quick add</button>
          <button className={btnSecondary} onClick={() => onCreateFood({})}>Create food</button>
        </div>
        {scanAnother}
      </div>
    );
  }

  if (screen.kind === "dead") {
    return (
      <div className="space-y-3">
        <Notice tone="error">{screen.text}</Notice>
        {screen.retry && (
          <button className={btnPrimary} onClick={() => void handleCode(screen.retry!.raw, screen.retry!.format)}>Try again</button>
        )}
        {scanAnother}
      </div>
    );
  }

  if (screen.kind === "unavailable") {
    const { scan, info } = screen;
    return (
      <div className="space-y-3">
        <Notice tone="error">Couldn't reach the food databases just now. That's not the same as "not found".</Notice>
        <p className={`text-sm ${mutedCls}`}>The barcode was read fine ({scan.raw}). Try again in a moment, or enter the food yourself.</p>
        <div className="flex gap-2 flex-wrap">
          <button className={btnPrimary} onClick={() => void handleCode(scan.raw, scan.format)}>Try again</button>
          <button className={btnSecondary} onClick={() => onCreateFood(createPrefill(scan.gtin14, info))}>Enter manually</button>
        </div>
        {scanAnother}
      </div>
    );
  }

  if (screen.kind === "miss") {
    const { scan, info } = screen;
    return (
      <div className="space-y-3">
        <Notice tone="warn">
          {info?.name
            ? `"${info.name}"${info.brand ? ` (${info.brand})` : ""} is listed, but with no nutrition facts.`
            : "No food database knows this barcode yet."}
        </Notice>
        <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Is this one of your foods?</h4>
        <p className={`text-sm ${mutedCls}`}>Pick it to save this barcode to that food, so scanning finds it next time.</p>
        <CandidatePicker scan={scan} initialQuery={candidateQuery(info ?? {})} onLinked={onChooseFood} />
        <div className="flex gap-2 flex-wrap">
          <button
            className={btnPrimary}
            onClick={() =>
              onCreateFood({
                ...createPrefill(scan.gtin14, info),
                note: info?.name
                  ? "We found the name but no nutrition facts. Type them in from the package label and it will be saved for next time."
                  : "Type the nutrition facts in from the package label and it will be saved for next time.",
              })}
          >
            Create food
          </button>
          <button className={btnSecondary} onClick={onQuickAdd}>Quick add</button>
        </div>
        {scanAnother}
      </div>
    );
  }

  if (screen.kind === "found") {
    const { scan, food, candidates } = screen;
    return (
      <div className="space-y-3">
        <div className="rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-2.5">
          <strong className="text-sm text-slate-900 dark:text-slate-100">{food.name}</strong>
          {food.brand && <span className={`text-sm ${mutedCls}`}> {food.brand}</span>}
          <div className={`text-sm ${mutedCls}`}>{defaultKcal(food)} kcal / {defaultServingLabel(food)}</div>
        </div>
        <button className={`${btnPrimary} w-full`} onClick={() => onChooseFood(food, { created: true })}>Use the scanned product</button>
        <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Or is this one of your foods?</h4>
        <p className={`text-sm ${mutedCls}`}>Pick it to save this barcode to your food instead of the scanned product.</p>
        <CandidatePicker scan={scan} initialQuery={candidateQuery(food)} candidates={candidates} replaceFoodId={food.id} onLinked={onChooseFood} />
        {scanAnother}
      </div>
    );
  }

  // ---- idle: the camera or typed digits ------------------------------------------------------

  const typedDigits = digitsOnly(typed);
  return (
    <div className="space-y-3">
      {message && <Notice tone="ok">{message}</Notice>}
      {!secure && (
        <Notice tone="warn">The camera only works over HTTPS or on localhost. You can still type the digits below.</Notice>
      )}
      {camera && (
        <ScannerView videoRef={videoRef} torchSupported={torchSupported} torchOn={torchOn} onToggleTorch={toggleTorch} />
      )}
      {camera && <p className={`text-sm ${mutedCls}`} role="status">Hold the barcode about a hand-width from the camera.</p>}
      {cameraError && <Notice tone="error">Camera unavailable: {cameraError}. Type the digits instead.</Notice>}
      <div className="flex gap-2">
        <button
          className={`${camera ? btnSecondary : btnPrimary} inline-flex items-center justify-center gap-1.5 flex-1`}
          disabled={!secure && !camera}
          onClick={() => setCamera((v) => !v)}
        >
          {camera ? <CameraOff size={16} /> : <Camera size={16} />}
          {camera ? "Stop camera" : "Start camera"}
        </button>
      </div>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (typedDigits) void handleCode(typedDigits);
        }}
      >
        <input
          type="search"
          inputMode="numeric"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder="Type barcode digits"
          aria-label="Barcode digits"
          className={inputCls}
        />
        <button type="submit" disabled={!typedDigits} className={`${btnSecondary} shrink-0`}>Look up</button>
      </form>
    </div>
  );
}

async function findCandidates(q: string): Promise<Food[]> {
  if (!q) return [];
  try {
    return await foodApi.linkCandidates(q);
  } catch {
    return []; // the scan carries on without the suggestion
  }
}

/** A search box over your own foods that can take this barcode (never the USDA list); picking one saves the barcode to it. */
function CandidatePicker({ scan, initialQuery, replaceFoodId, candidates, onLinked }: {
  scan: Scan;
  initialQuery: string;
  replaceFoodId?: string;
  candidates?: Food[];
  onLinked: (food: Food, opts: ChooseOpts) => void;
}) {
  const [q, setQ] = useState(initialQuery);
  const [foods, setFoods] = useState<Food[] | null>(candidates ?? null);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const seq = useRef(0);
  const first = useRef(true);

  useEffect(() => {
    // With candidates in hand (the found screen) show them as they are until the person types.
    if (first.current && candidates) {
      first.current = false;
      return;
    }
    first.current = false;
    const term = q.trim();
    const mine = ++seq.current;
    if (!term) {
      setFoods([]);
      setNote("Type part of the food's name to find it.");
      return;
    }
    const timer = window.setTimeout(async () => {
      const found = await findCandidates(term);
      if (mine !== seq.current) return;
      setFoods(found);
      setNote(found.length ? "" : "None of your foods match. Create food to add this one.");
    }, 250);
    return () => window.clearTimeout(timer);
  }, [q, candidates]);

  async function linkTo(food: Food) {
    setError("");
    setNote(`Saving the barcode to ${food.name}…`);
    try {
      const { food: linked } = await foodApi.linkBarcode(food.id, { code: scan.raw, format: scan.format, replaceFoodId });
      onLinked(linked, {
        note: `Barcode saved to ${linked.name}. Scanning it will find this food from now on.`,
        undo: {
          label: "Wrong food? Take the barcode off it.",
          run: async () => {
            await foodApi.unlinkBarcode(linked.id);
            return `Barcode removed from ${linked.name}.`;
          },
        },
      });
    } catch (err) {
      setNote("");
      setError(errorText(err));
    }
  }

  return (
    <div className="space-y-2">
      {foods && foods.length > 0 && <ul className="space-y-0.5">{foods.map((f) => <FoodRow key={f.id} food={f} onPick={linkTo} />)}</ul>}
      {note && <p className={`text-sm ${mutedCls}`}>{note}</p>}
      {error && <Notice tone="error">{error}</Notice>}
      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search your foods"
        aria-label="Search your foods"
        autoComplete="off"
        className={inputCls}
      />
    </div>
  );
}

/** "Only me": a food just made from a database lookup is shared with the household; this takes it back to private (or shares it again). */
export function ShareSwitch({ food, onChange }: { food: Food; onChange: (food: Food) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const onlyMe = food.scope === "personal";

  async function toggle(next: boolean) {
    setBusy(true);
    setError("");
    try {
      onChange(await foodApi.setFoodScope(food.id, next ? "personal" : "joint"));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-1">
      <label className="flex items-start gap-2.5 text-sm text-slate-800 dark:text-slate-200">
        <input type="checkbox" className="mt-1" checked={onlyMe} disabled={busy} onChange={(e) => void toggle(e.target.checked)} />
        <span>
          <span className="font-medium">Only me</span>
          <span className={`block text-xs ${mutedCls}`}>Off: the household can find and log this scanned food. On: only you can.</span>
        </span>
      </label>
      {error && <p role="alert" className="text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
