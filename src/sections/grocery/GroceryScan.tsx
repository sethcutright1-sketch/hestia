// Scan a product to put it on the grocery list: a USB/Bluetooth HID scanner (types digits + Enter into
// the focused input) or the camera. The barcode is resolved with the pantry's read-only lookup (an
// item already linked to it, else Open Food Facts), then added straight to the list. Only a barcode
// nobody can name asks for a typed name. Nothing here touches pantry stock.
import { useRef, useState } from "react";
import { Barcode, Camera, CameraOff, Undo2, X } from "lucide-react";
import ScannerView from "../../ScannerView";
import { api, type BarcodeLookupResult, type ShoppingList } from "../../api.ts";
import { KIOSK } from "../../kiosk.ts";
import { useBarcodeCamera } from "../../useBarcodeCamera.ts";

export default function GroceryScan({
  list,
  onList,
  onClose,
}: {
  list: ShoppingList;
  onList: (list: ShoppingList) => void;
  onClose: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [useCamera, setUseCamera] = useState(false);
  const [needsName, setNeedsName] = useState<string | null>(null);
  const [last, setLast] = useState<{ id: string; name: string } | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  // The camera's read callback is captured once per frame, so the list it adds to is read from here.
  const listRef = useRef(list);
  listRef.current = list;

  async function addNamed(name: string) {
    const target = listRef.current;
    const before = new Set(target.items.map((i) => i.id));
    const res = await api.post<{ list: ShoppingList }>(`/api/grocery/lists/${target.id}/items`, { name });
    onList(res.list);
    const added = res.list.items.find((i) => !before.has(i.id));
    setLast(added ? { id: added.id, name: added.name } : null);
  }

  async function submitScan(raw: string) {
    const barcode = raw.trim();
    if (!barcode || pending || needsName) return;
    setPending(true);
    setError("");
    try {
      const found = await api.post<BarcodeLookupResult>("/api/pantry/barcode/lookup", { barcode });
      const name = found.found ? found.item?.name : found.suggestion;
      if (name) await addNamed(name);
      else setNeedsName(barcode);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setPending(false);
    }
  }

  const { videoRef, error: cameraError, torchSupported, torchOn, toggleTorch } = useBarcodeCamera({
    active: useCamera,
    onRead: (read) => submitScan(read.code),
    dedupeMs: 3000,
  });

  async function confirmName(name: string) {
    const trimmed = name.trim();
    if (!trimmed || pending) return;
    setPending(true);
    setError("");
    try {
      await addNamed(trimmed);
      setNeedsName(null);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setPending(false);
    }
  }

  async function undo() {
    if (!last || pending) return;
    setPending(true);
    setError("");
    try {
      const res = await api.del<{ list: ShoppingList }>(`/api/grocery/lists/${listRef.current.id}/items/${last.id}`);
      onList(res.list);
      setLast(null);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setPending(false);
    }
  }

  const btnPad = KIOSK ? "px-4 py-2.5" : "px-3 py-1.5";

  return (
    <div className="mb-4 rounded-lg border border-slate-200 dark:border-slate-800 p-3">
      <div className="flex items-center justify-between mb-3">
        <p className="text-sm font-medium">Scan items onto “{list.name}”</p>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setUseCamera((v) => !v)}
            title={useCamera ? "Stop using camera" : "Use camera"}
            className={`${btnPad} rounded-lg text-xs flex items-center gap-1 ${useCamera ? "bg-slate-200 dark:bg-slate-700" : "text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"}`}
          >
            {useCamera ? <CameraOff size={13} /> : <Camera size={13} />}
            {useCamera ? "Stop camera" : "Camera"}
          </button>
          <button onClick={onClose} className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-300" aria-label="Close scan">
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
        <div className="mb-2">
          <p className="text-xs text-slate-500 dark:text-slate-400 mb-1.5">Couldn't identify that barcode ({needsName}) -- what is it?</p>
          <div className="flex gap-2">
            <input
              ref={nameRef}
              autoFocus
              disabled={pending}
              placeholder="Item name…"
              className="flex-1 min-w-0 px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
              onKeyDown={(e) => {
                if (e.key === "Enter") confirmName((e.target as HTMLInputElement).value);
              }}
            />
            <button
              onClick={() => confirmName(nameRef.current?.value || "")}
              disabled={pending}
              className="px-3 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs disabled:opacity-50"
            >
              Add
            </button>
            <button onClick={() => setNeedsName(null)} className="px-3 text-xs text-slate-500 hover:text-slate-700 dark:hover:text-slate-300">
              Skip
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2 mb-2">
          <Barcode size={16} className="text-slate-400 shrink-0" />
          <input
            // No autoFocus on the kiosk: it would pop the on-screen keyboard over the camera view.
            autoFocus={!KIOSK}
            disabled={pending}
            className="flex-1 min-w-0 px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
            placeholder="Scan or type a barcode…"
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              const el = e.target as HTMLInputElement;
              submitScan(el.value);
              el.value = "";
            }}
          />
        </div>
      )}

      {error && <p className="mb-2 text-sm text-red-600 dark:text-red-400">{error}</p>}

      {last && (
        <div className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
          <span>Added {last.name}</span>
          <button onClick={undo} disabled={pending} className="flex items-center gap-1 text-blue-600 hover:text-blue-700 dark:text-blue-400 disabled:opacity-50">
            <Undo2 size={12} /> Undo
          </button>
        </div>
      )}
    </div>
  );
}
