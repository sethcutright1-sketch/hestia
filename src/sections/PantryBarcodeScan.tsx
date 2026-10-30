// Barcode scan in/out for Pantry -- a USB/Bluetooth HID scanner (which just
// types digits + Enter into whatever input has focus, like a keyboard) or a
// phone/tablet camera, feeding the same three endpoints in routes/pantry.ts:
// POST /api/pantry/scan/in, /scan/out, and the read-only /barcode/lookup probe
// (used indirectly via scan/in's needsName response). Unlike
// PantryScanSuggestions.tsx's photo-scan checklist, a known barcode writes
// instantly -- matching an already-seen barcode is deterministic, so there's
// nothing to confirm, and the whole point of a barcode gun is speed. The only
// place this asks first is a barcode nobody's seen before, where a wrong
// guess would permanently mislabel it.
import ScannerView from "../ScannerView";
import { useEffect, useRef, useState } from "react";
import { Barcode, Camera, CameraOff, Undo2, X } from "lucide-react";
import { api, type PantryItem, type ScanInResult, type ScanOutResult, type ShoppingList } from "../api.ts";
import { KIOSK } from "../kiosk.ts";
import { useBarcodeCamera } from "../useBarcodeCamera.ts";

type Mode = "in" | "out";

interface LastScan {
  barcode: string;
  itemId: string;
  name: string;
  count: number;
  mode: Mode;
  createdNew: boolean;
}

export default function PantryBarcodeScan({
  onItemChange,
  onItemRemoved,
  onClose,
}: {
  onItemChange: (item: PantryItem) => void;
  onItemRemoved: (id: string) => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<Mode>("in");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [lastScan, setLastScan] = useState<LastScan | null>(null);
  const [needsName, setNeedsName] = useState<{ barcode: string; suggestion: string | null } | null>(null);
  const [notTracked, setNotTracked] = useState<{ barcode: string; suggestion: string | null; closeMatches: string[] } | null>(null);
  const [useCamera, setUseCamera] = useState(false);
  // Deliberately persists across scans rather than clearing after each one --
  // restocking is usually a whole case of the same product with the same
  // date, so leaving it set lets that be scanned as a batch. Only ever sent
  // on scan-in; scan-out never touches expiration.
  const [expirationDate, setExpirationDate] = useState("");
  // Prompted only when a scan-out actually empties an item (hitZero) -- not on
  // every scan-out, which would nag for items that still have plenty left.
  const [groceryPrompt, setGroceryPrompt] = useState<{ name: string } | null>(null);
  const [groceryLists, setGroceryLists] = useState<ShoppingList[] | null>(null);
  const [selectedListId, setSelectedListId] = useState("");
  const [addingToGrocery, setAddingToGrocery] = useState(false);
  const [groceryAdded, setGroceryAdded] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  async function submitScan(raw: string) {
    const barcode = raw.trim();
    if (!barcode || pending) return;
    setPending(true);
    setError("");
    setGroceryPrompt(null);
    setGroceryAdded(false);
    try {
      if (mode === "in") {
        const res = await api.post<ScanInResult>("/api/pantry/scan/in", { barcode, expirationDate: expirationDate || undefined });
        if (res.needsName) {
          setNeedsName({ barcode, suggestion: res.suggestion ?? null });
        } else if (res.item) {
          setNotTracked(null);
          onItemChange(res.item);
          setLastScan({
            barcode,
            itemId: res.item.id,
            name: res.item.name,
            count: res.item.stockCount ?? 0,
            mode: "in",
            createdNew: res.resolved === "created",
          });
        }
      } else {
        const res = await api.post<ScanOutResult>("/api/pantry/scan/out", { barcode });
        if (!res.found) {
          setLastScan(null);
          setNotTracked({ barcode, suggestion: res.suggestion ?? null, closeMatches: res.closeMatches ?? [] });
        } else if (res.item) {
          setNotTracked(null);
          onItemChange(res.item);
          if (res.changed) {
            setLastScan({
              barcode,
              itemId: res.item.id,
              name: res.item.name,
              count: res.item.stockCount ?? 0,
              mode: "out",
              createdNew: false,
            });
            if (res.hitZero) setGroceryPrompt({ name: res.item.name });
          } else {
            // Already at 0 -- the decrement clamped to a no-op, so there's
            // nothing to offer "undo" on.
            setLastScan(null);
            setError(`${res.item.name} is already out of stock.`);
          }
        }
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setPending(false);
      if (!needsName) inputRef.current?.focus();
    }
  }

  // The camera itself lives in useBarcodeCamera (shared with the Food section's scan). A barcode sitting
  // in frame decodes on every video frame, so repeats of the same code within a few seconds are ignored
  // rather than firing the scan handler dozens of times for one physical scan.
  const { videoRef, error: cameraError, torchSupported, torchOn, toggleTorch } = useBarcodeCamera({
    active: useCamera,
    onRead: (read) => submitScan(read.code),
    dedupeMs: 3000,
  });

  async function confirmName(name: string) {
    const trimmed = name.trim();
    if (!needsName || !trimmed || pending) return;
    setPending(true);
    setError("");
    try {
      const res = await api.post<ScanInResult>("/api/pantry/scan/in", {
        barcode: needsName.barcode,
        name: trimmed,
        expirationDate: expirationDate || undefined,
      });
      if (res.item) {
        onItemChange(res.item);
        setLastScan({
          barcode: needsName.barcode,
          itemId: res.item.id,
          name: res.item.name,
          count: res.item.stockCount ?? 0,
          mode: "in",
          createdNew: res.resolved === "created",
        });
      }
      setNeedsName(null);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setPending(false);
    }
  }

  async function undo() {
    if (!lastScan || pending) return;
    setPending(true);
    setError("");
    setGroceryPrompt(null);
    setGroceryAdded(false);
    try {
      if (lastScan.createdNew) {
        // This scan created the row from scratch -- undoing it means the row
        // never existed, not "scan it back to a lingering 0" (which would
        // leave a permanent zero-stock row from a single misfire).
        await api.del(`/api/pantry/${lastScan.itemId}`);
        onItemRemoved(lastScan.itemId);
      } else if (lastScan.mode === "in") {
        const res = await api.post<ScanOutResult>("/api/pantry/scan/out", { barcode: lastScan.barcode });
        if (res.item) onItemChange(res.item);
      } else {
        const res = await api.post<ScanInResult>("/api/pantry/scan/in", { barcode: lastScan.barcode });
        if (res.item) onItemChange(res.item);
      }
      setLastScan(null);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setPending(false);
      inputRef.current?.focus();
    }
  }

  // Fetched lazily on first need, not on mount -- most scan sessions never hit
  // zero, so there's no reason to hit the grocery API up front. Cached for the
  // rest of this panel's lifetime rather than refetched on every prompt.
  useEffect(() => {
    if (!groceryPrompt || groceryLists !== null) return;
    api
      .get<{ lists: ShoppingList[] }>("/api/grocery/lists")
      .then((res) => {
        // Grocery.tsx itself never filters by status either -- some lists in
        // real data predate that field entirely, so filtering to === "active"
        // would silently hide them rather than just leaving archived ones in.
        setGroceryLists(res.lists);
        setSelectedListId((prev) => prev || res.lists[0]?.id || "");
      })
      .catch(() => setGroceryLists([]));
  }, [groceryPrompt, groceryLists]);

  async function addToGroceryList() {
    if (!groceryPrompt || !selectedListId || addingToGrocery) return;
    setAddingToGrocery(true);
    setError("");
    try {
      await api.post(`/api/grocery/lists/${selectedListId}/items`, { name: groceryPrompt.name });
      setGroceryAdded(true);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setAddingToGrocery(false);
    }
  }

  // Keeps the HID scanner's target focused: it doesn't know or care which
  // input has focus, it just fires keystrokes at whatever does. Diverted to
  // the name prompt while that's open, so a scan mid-prompt doesn't leak
  // digits into it.
  useEffect(() => {
    if (needsName) nameInputRef.current?.focus();
    else inputRef.current?.focus();
  }, [needsName]);

  const btnPad = KIOSK ? "px-4 py-2.5" : "px-3 py-1.5";

  return (
    <div className="mt-3 rounded-lg border border-slate-200 dark:border-slate-800 p-3">
      <div className="flex items-center justify-between mb-3">
        <div className="flex rounded-lg overflow-hidden border border-slate-300 dark:border-slate-700">
          <button
            onClick={() => setMode("in")}
            className={`${btnPad} text-xs font-medium ${mode === "in" ? "bg-blue-600 text-white" : "bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300"}`}
          >
            Scan In
          </button>
          <button
            onClick={() => setMode("out")}
            className={`${btnPad} text-xs font-medium ${mode === "out" ? "bg-blue-600 text-white" : "bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300"}`}
          >
            Scan Out
          </button>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setUseCamera((v) => !v)}
            title={useCamera ? "Stop using camera" : "Use camera"}
            className={`${btnPad} rounded-lg text-xs flex items-center gap-1 ${useCamera ? "bg-slate-200 dark:bg-slate-700" : "text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"}`}
          >
            {useCamera ? <CameraOff size={13} /> : <Camera size={13} />}
          </button>
          <button onClick={onClose} className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-300" aria-label="Close barcode scan">
            <X size={15} />
          </button>
        </div>
      </div>

      {useCamera && (
        <div className="mb-3">
          <ScannerView videoRef={videoRef} torchSupported={torchSupported} torchOn={torchOn} onToggleTorch={toggleTorch} className="max-h-56" />
          {cameraError && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{cameraError}</p>}
        </div>
      )}

      {needsName ? (
        <div className="mb-3">
          <p className="text-xs text-slate-500 dark:text-slate-400 mb-1.5">
            {needsName.suggestion
              ? `Open Food Facts suggests "${needsName.suggestion}" for this barcode -- add or edit the name.`
              : "New barcode -- what is this?"}
          </p>
          <div className="flex gap-2">
            <input
              ref={nameInputRef}
              defaultValue={needsName.suggestion || ""}
              className="flex-1 min-w-0 px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
              placeholder="Item name…"
              disabled={pending}
              onKeyDown={(e) => {
                if (e.key === "Enter") confirmName((e.target as HTMLInputElement).value);
              }}
            />
            <button
              onClick={() => confirmName(nameInputRef.current?.value || "")}
              disabled={pending}
              className="px-3 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs disabled:opacity-50"
            >
              Add
            </button>
            <button
              onClick={() => setNeedsName(null)}
              className="px-3 text-xs text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
            >
              Cancel
            </button>
          </div>
          <label className="mt-2 flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
            Exp date (optional)
            <input
              type="date"
              value={expirationDate}
              onChange={(e) => setExpirationDate(e.target.value)}
              className="px-2 py-1 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
            />
          </label>
        </div>
      ) : (
        <div className="flex items-center gap-2 mb-3">
          <Barcode size={16} className="text-slate-400 shrink-0" />
          <input
            ref={inputRef}
            autoFocus
            disabled={pending}
            className="flex-1 min-w-0 px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
            placeholder={mode === "in" ? "Scan or type a barcode to add stock…" : "Scan or type a barcode to use stock…"}
            onBlur={() => {
              if (!needsName) window.setTimeout(() => inputRef.current?.focus(), 50);
            }}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              const el = e.target as HTMLInputElement;
              submitScan(el.value);
              el.value = "";
            }}
          />
          {mode === "in" && (
            <input
              type="date"
              value={expirationDate}
              onChange={(e) => setExpirationDate(e.target.value)}
              title="Optional -- applies to every scan-in until you change it, so a whole case of the same-dated product can be scanned as a batch"
              aria-label="Expiration date for items scanned in"
              className="w-36 px-2 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
            />
          )}
        </div>
      )}

      {notTracked && (
        <p className="mb-2 text-xs text-slate-500 dark:text-slate-400">
          {notTracked.suggestion
            ? `Looked up as "${notTracked.suggestion}" -- not tracked in your pantry yet. Use Scan In first.`
            : "That barcode isn't tracked in your pantry yet. Use Scan In first."}
          {notTracked.closeMatches.length > 0 && (
            <> Closest match already in the pantry: {notTracked.closeMatches.join(", ")}.</>
          )}
        </p>
      )}

      {error && <p className="mb-2 text-sm text-red-600 dark:text-red-400">{error}</p>}

      {lastScan && (
        <div className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
          <span>
            {lastScan.mode === "in" ? "+1" : "-1"} {lastScan.name} — now {lastScan.count}
          </span>
          <button
            onClick={undo}
            disabled={pending}
            className="flex items-center gap-1 text-blue-600 hover:text-blue-700 dark:text-blue-400 disabled:opacity-50"
          >
            <Undo2 size={12} /> Undo
          </button>
        </div>
      )}

      {groceryPrompt && (
        <div className="mt-2 flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
          {groceryAdded ? (
            <span>Added {groceryPrompt.name} to the grocery list.</span>
          ) : groceryLists === null ? (
            <span className="text-slate-400 dark:text-slate-500">Checking grocery lists…</span>
          ) : groceryLists.length === 0 ? (
            <span className="text-slate-400 dark:text-slate-500">
              Out of {groceryPrompt.name} -- no grocery list yet to add it to.
            </span>
          ) : (
            <>
              <span>Add {groceryPrompt.name} to the grocery list?</span>
              {groceryLists.length > 1 && (
                <select
                  value={selectedListId}
                  onChange={(e) => setSelectedListId(e.target.value)}
                  className="text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-1 py-0.5"
                >
                  {groceryLists.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
              )}
              <button
                onClick={addToGroceryList}
                disabled={addingToGrocery}
                className="text-blue-600 hover:text-blue-700 dark:text-blue-400 disabled:opacity-50"
              >
                Add
              </button>
              <button
                onClick={() => setGroceryPrompt(null)}
                className="text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
              >
                No thanks
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
