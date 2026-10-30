// The simplest full section component -- pairs with routes/pantry.ts as one
// vertical slice of the app (table -> route -> UI). Every section follows
// this same shape: local `items` state, a `refresh()` that GETs the current
// list on mount, and handlers that call the API then update `items` directly
// from what the server echoes back (never assume the request worked and
// guess the new state locally -- `applyItem`/`setItems` below only change
// once the response has actually arrived).
import { useEffect, useState } from "react";
import { Plus, Trash2, Refrigerator, AlertTriangle, Upload, Barcode, Search } from "lucide-react";
import { api, type CalorieFillOutcome, type PantryItem, type VisionConfig, type PantryScanSuggestion } from "../api.ts";
import PantryScanSuggestions from "./PantryScanSuggestions.tsx";
import PantryBarcodeScan from "./PantryBarcodeScan.tsx";
import { useLiveRefresh } from "../useLiveRefresh.ts";
import { KIOSK } from "../kiosk.ts";
import { CalorieFill, CalorieBadge } from "../CalorieFill.tsx";

// Reads a File as base64 without the "data:image/...;base64," prefix, which
// is what the vision endpoints expect.
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Days-until-expiration thresholds for the visual flag below -- expired is
// always red regardless of how far past, "soon" is a fixed 3-day window.
const EXPIRING_SOON_DAYS = 3;

function expiryStatus(expirationDate?: string): "expired" | "soon" | null {
  if (!expirationDate) return null;
  const today = new Date().toISOString().slice(0, 10);
  if (expirationDate < today) return "expired";
  const soonCutoff = new Date();
  soonCutoff.setDate(soonCutoff.getDate() + EXPIRING_SOON_DAYS);
  if (expirationDate <= soonCutoff.toISOString().slice(0, 10)) return "soon";
  return null;
}

// Short "Sep 27" form for the "scanned in" badge -- this is a passive status
// note, not something anyone edits, so it doesn't need the full YYYY-MM-DD
// precision the expiration date field does.
function formatScannedDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export default function Pantry() {
  const [items, setItems] = useState<PantryItem[]>([]);
  const [newName, setNewName] = useState("");
  const [search, setSearch] = useState("");
  const [newQuantity, setNewQuantity] = useState("");
  const [newExpiration, setNewExpiration] = useState("");
  const [error, setError] = useState("");
  const [visionProviderLabel, setVisionProviderLabel] = useState("");
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState("");
  const [suggestions, setSuggestions] = useState<PantryScanSuggestion[] | null>(null);
  // The photo just scanned, shown alongside its suggestions so it's obvious
  // which picture the results came from -- previously nothing was shown at
  // all, which read as if a leftover Fridge photo might be involved.
  const [scannedPhotoUrl, setScannedPhotoUrl] = useState<string | null>(null);
  const [barcodeOpen, setBarcodeOpen] = useState(false);

  async function refresh() {
    try {
      const res = await api.get<{ items: PantryItem[] }>("/api/pantry");
      setItems(res.items);
    } catch (err: any) {
      setError(err.message);
    }
  }

  useEffect(() => {
    refresh();
    api.get<VisionConfig>("/api/vision/config").then((cfg) => {
      if (cfg.provider === "auto") setVisionProviderLabel("Auto");
      else setVisionProviderLabel(cfg.providers.find((p) => p.id === cfg.provider)?.label || cfg.provider);
    }).catch(() => {});
  }, []);

  // Keeps this in sync with pantry changes made elsewhere (another device,
  // the assistant) without needing App.tsx's dataVersion remount.
  useLiveRefresh(() => refresh(), KIOSK ? 30_000 : 60_000);

  async function scanPhoto(file: File) {
    setScanning(true);
    setScanError("");
    // Revoke any previous scan's preview URL before making a new one, so these
    // don't accumulate for the life of the tab.
    setScannedPhotoUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return URL.createObjectURL(file);
    });
    try {
      const image = await fileToBase64(file);
      const res = await api.post<{ items: PantryScanSuggestion[] }>("/api/vision/scan", { image, mediaType: file.type });
      setSuggestions(res.items);
    } catch (err: any) {
      setScanError(err.message);
    } finally {
      setScanning(false);
    }
  }

  function dismissScan() {
    setSuggestions(null);
    if (scannedPhotoUrl) URL.revokeObjectURL(scannedPhotoUrl);
    setScannedPhotoUrl(null);
  }

  // Every mutation returns the updated item, so the local copy is replaced from
  // the server's version rather than patched -- same convention as Grocery.
  function applyItem(item: PantryItem) {
    setItems((prev) => {
      const exists = prev.some((i) => i.id === item.id);
      return exists ? prev.map((i) => (i.id === item.id ? item : i)) : [...prev, item].sort((a, b) => a.name.localeCompare(b.name));
    });
  }

  async function addItem(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    try {
      const res = await api.post<{ item: PantryItem }>("/api/pantry", {
        name: newName,
        quantity: newQuantity,
        expirationDate: newExpiration,
      });
      setNewName("");
      setNewQuantity("");
      setNewExpiration("");
      applyItem(res.item);
    } catch (err: any) { setError(err.message); }
  }

  async function updateQuantity(item: PantryItem, quantity: string) {
    try {
      const res = await api.put<{ item: PantryItem }>(`/api/pantry/${item.id}`, { quantity });
      applyItem(res.item);
    } catch (err: any) { setError(err.message); }
  }

  async function updateExpiration(item: PantryItem, expirationDate: string) {
    try {
      const res = await api.put<{ item: PantryItem }>(`/api/pantry/${item.id}`, { expirationDate });
      applyItem(res.item);
    } catch (err: any) { setError(err.message); }
  }

  async function removeItem(id: string) {
    try {
      await api.del(`/api/pantry/${id}`);
      setItems((prev) => prev.filter((i) => i.id !== id));
    } catch (err: any) { setError(err.message); }
  }

  // The search matches any part of a name, ignoring case; an empty box shows everything.
  const needle = search.trim().toLowerCase();
  const shown = needle ? items.filter((i) => i.name.toLowerCase().includes(needle)) : items;

  return (
    <div className="max-w-xl">
      <h2 className="text-lg font-semibold mb-3">Pantry</h2>
      {error && <p className="mb-3 text-sm text-red-600 dark:text-red-400">{error}</p>}

      {items.length > 0 && (
        <CalorieFill<CalorieFillOutcome & { items: PantryItem[] }> endpoint="/api/pantry/calories/fill" onDone={(r) => setItems(r.items)} />
      )}

      <div className="mb-4 flex items-center gap-2 flex-wrap">
        <label className="text-xs px-2 py-1 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 cursor-pointer flex items-center gap-1">
          <Upload size={12} /> {scanning ? "Scanning…" : "Scan a photo"}
          <input
            type="file"
            accept="image/*"
            className="hidden"
            disabled={scanning}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) scanPhoto(file);
              e.target.value = "";
            }}
          />
        </label>
        {visionProviderLabel && (
          <span className="text-xs text-slate-400 dark:text-slate-500">
            Using {visionProviderLabel} (change in Fridge)
          </span>
        )}
        <button
          onClick={() => setBarcodeOpen((v) => !v)}
          className={`text-xs px-2 py-1 rounded-lg flex items-center gap-1 ${
            barcodeOpen ? "bg-blue-600 text-white" : "bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700"
          }`}
        >
          <Barcode size={12} /> Barcode scan
        </button>
      </div>
      {scanError && <p className="mb-3 text-sm text-red-600 dark:text-red-400">{scanError}</p>}
      {suggestions && (
        <PantryScanSuggestions
          items={suggestions}
          photoUrl={scannedPhotoUrl || undefined}
          onCancel={dismissScan}
          onDone={(added) => {
            dismissScan();
            for (const item of added) applyItem(item);
          }}
        />
      )}
      {barcodeOpen && (
        <PantryBarcodeScan
          onItemChange={applyItem}
          onItemRemoved={(id) => setItems((prev) => prev.filter((i) => i.id !== id))}
          onClose={() => setBarcodeOpen(false)}
        />
      )}

      <form onSubmit={addItem} className="flex gap-2 mb-4 mt-4">
        <input
          className="flex-1 min-w-0 px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
          placeholder="Add an item…"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
        />
        <input
          className="w-28 px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
          placeholder="Qty"
          value={newQuantity}
          onChange={(e) => setNewQuantity(e.target.value)}
        />
        <input
          type="date"
          className="w-36 px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
          value={newExpiration}
          onChange={(e) => setNewExpiration(e.target.value)}
          aria-label="Expiration date"
        />
        <button className="px-3 rounded-lg bg-blue-600 hover:bg-blue-700 text-white" aria-label="Add to pantry">
          <Plus size={16} />
        </button>
      </form>

      {items.length > 0 && (
        <div className="relative mb-3">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
          <input
            type="search"
            className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
            placeholder="Search the pantry…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search the pantry"
          />
        </div>
      )}

      {items.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-slate-400 dark:text-slate-500">
          <Refrigerator size={32} className="mb-3" />
          <p className="text-sm">Nothing recorded yet.</p>
        </div>
      ) : shown.length === 0 ? (
        <p className="text-sm text-slate-500 dark:text-slate-400 py-6 text-center">Nothing in the pantry matches “{search.trim()}”.</p>
      ) : (
        <ul className="divide-y divide-slate-200 dark:divide-slate-800">
          {shown.map((item) => {
            const status = expiryStatus(item.expirationDate);
            return (
              <li key={item.id} className="flex items-center gap-3 py-2.5">
                <span className="flex-1 text-sm flex items-center gap-1.5">
                  {item.name}
                  <CalorieBadge calories={item.calories} />
                  {status && (
                    <span
                      className={`text-xs px-2 py-0.5 rounded-full flex items-center gap-1 ${
                        status === "expired"
                          ? "bg-red-100 dark:bg-red-950/40 text-red-700 dark:text-red-300"
                          : "bg-amber-100 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300"
                      }`}
                    >
                      <AlertTriangle size={11} />
                      {status === "expired" ? "Expired" : "Expiring soon"}
                    </span>
                  )}
                  {/* Only barcode-tracked items get a real 0 -- a manually
                      typed quantity of "0" doesn't set stockCount, so it never
                      shows this badge. */}
                  {item.stockCount === 0 && (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400">
                      Out of stock
                    </span>
                  )}
                  {item.lastScannedInAt && (
                    <span className="text-xs text-slate-400 dark:text-slate-500">
                      Scanned {formatScannedDate(item.lastScannedInAt)}
                    </span>
                  )}
                </span>
                <input
                  // Keyed on quantity so a change from elsewhere (a barcode
                  // scan, the assistant) remounts this uncontrolled input with
                  // the fresh defaultValue -- without this, an external update
                  // to the same item would leave the box showing a stale
                  // number until the page reloads.
                  key={item.quantity}
                  className="w-28 px-2 py-1 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                  placeholder="Qty"
                  defaultValue={item.quantity}
                  onBlur={(e) => { if (e.target.value !== item.quantity) updateQuantity(item, e.target.value); }}
                />
                <input
                  type="date"
                  className="w-36 px-2 py-1 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                  defaultValue={item.expirationDate || ""}
                  onBlur={(e) => { if (e.target.value !== (item.expirationDate || "")) updateExpiration(item, e.target.value); }}
                  aria-label={`${item.name} expiration date`}
                />
                <button
                  onClick={() => removeItem(item.id)}
                  className="text-slate-400 hover:text-red-600 dark:hover:text-red-400"
                  aria-label={`Remove ${item.name}`}
                >
                  <Trash2 size={15} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
