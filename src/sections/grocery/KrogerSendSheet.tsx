// "Send to Kroger": turns a grocery list into items in the household's Kroger cart (routes/kroger.ts).
// The server works out the starting point -- which items go, the remembered or Pantry-scanned product,
// a quantity -- and this sheet lets the person check and change it before anything is sent. Kroger's
// cart can only be added to, never read or undone here, so nothing is sent until the button is pressed,
// and items already sent are left off unless ticked again.

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, ChevronUp, ExternalLink, Minus, Plus, Search, ShoppingCart } from "lucide-react";
import { estimateFor, quantityFor } from "../../../krogerMatch.ts";
import type { ShoppingList } from "../../api.ts";
import { Notice, Sheet, btnPrimary, btnSecondary, inputCls, mutedCls } from "../food/ui.tsx";
import {
  KROGER_CART_URL,
  krogerApi,
  krogerErrorText,
  money,
  priceText,
  sizeText,
  type KrogerProduct,
  type Preview,
  type PreviewItem,
  type KrogerStatus,
  type KrogerStore,
  type SavedRow,
} from "./krogerApi.ts";

interface Props {
  list: ShoppingList;
  onClose: () => void;
  /** The list as the server stamped it after a send (items marked sent). */
  onSent: (list: ShoppingList) => void;
}

interface Row {
  include: boolean;
  product: KrogerProduct | null;
  quantity: number;
}

type Loaded = Preview & { store: KrogerStore; connection: KrogerStatus };

export default function KrogerSendSheet({ list, onClose, onSent }: Props) {
  const [preview, setPreview] = useState<Loaded | null>(null);
  const [rows, setRows] = useState<Record<string, Row>>({});
  const [openPicker, setOpenPicker] = useState<string | null>(null);
  const [loadError, setLoadError] = useState("");
  const [sendError, setSendError] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<number | null>(null);
  // The saved choices came back from an earlier visit; and whether the person has changed anything since
  // opening (only then is the screen saved, so just looking never overwrites a draft).
  const [restored, setRestored] = useState(false);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    let alive = true;
    // A failed draft read is not worth failing the screen over: it just opens fresh.
    Promise.all([krogerApi.preview(list.id), krogerApi.draft(list.id).catch(() => ({ draft: null }))])
      .then(([p, { draft }]) => {
        if (!alive) return;
        setPreview(p);
        const fresh = Object.fromEntries(p.items.map((i) => [i.itemId, { include: i.state === "ready", product: i.product, quantity: i.quantity } as Row]));
        let used = false;
        if (draft) {
          for (const i of p.items) {
            const saved = draft.rows[i.itemId];
            if (!saved?.product) continue;
            // Product and quantity come back for any item; a tick only where the item can still be sent
            // as it stands (not one that was sent or covered by the Pantry since).
            fresh[i.itemId] = { product: saved.product, quantity: saved.quantity, include: saved.include && (i.state === "ready" || i.state === "choose") };
            used = true;
          }
        }
        setRows(fresh);
        setRestored(used);
      })
      .catch((err) => alive && setLoadError(krogerErrorText(err)));
    return () => { alive = false; };
  }, [list.id]);

  // Save the screen a moment after the last change.
  useEffect(() => {
    if (!touched || !preview) return;
    const timer = setTimeout(() => {
      const payload: Record<string, SavedRow> = {};
      for (const [id, r] of Object.entries(rows)) if (r.product) payload[id] = r;
      krogerApi.saveDraft(list.id, payload).catch(() => {});
    }, 800);
    return () => clearTimeout(timer);
  }, [rows, touched]);

  // Closing the sheet within that moment must not lose the last change: save on the way out.
  const latest = useRef({ rows, touched, ready: false });
  latest.current = { rows, touched, ready: !!preview && sent === null };
  useEffect(() => () => {
    const { rows: last, touched: t, ready } = latest.current;
    if (!t || !ready) return;
    const payload: Record<string, SavedRow> = {};
    for (const [id, r] of Object.entries(last)) if (r.product) payload[id] = r;
    krogerApi.saveDraft(list.id, payload).catch(() => {});
  }, []);

  function startOver() {
    krogerApi.clearDraft(list.id).catch(() => {});
    setPreview(null);
    setRestored(false);
    setTouched(false);
    krogerApi.preview(list.id).then((p) => {
      setPreview(p);
      setRows(Object.fromEntries(p.items.map((i) => [i.itemId, { include: i.state === "ready", product: i.product, quantity: i.quantity }])));
    }).catch((err) => setLoadError(krogerErrorText(err)));
  }

  const items = preview?.items ?? [];
  const main = items.filter((i) => i.state === "ready" || i.state === "choose");
  const skipped = items.filter((i) => i.state === "inPantry" || i.state === "sent");
  const chosen = items.filter((i) => rows[i.itemId]?.include && rows[i.itemId]?.product);
  const estimate = estimateFor(chosen.map((i) => rows[i.itemId]));
  const canSend = !!preview?.connection.connected && !preview.connection.needsReconnect;
  const needChoice = main.filter((i) => !rows[i.itemId]?.product).length;

  function update(itemId: string, patch: Partial<Row>) {
    setTouched(true);
    setRows((r) => ({ ...r, [itemId]: { ...r[itemId], ...patch } }));
  }

  function pick(item: PreviewItem, product: KrogerProduct) {
    update(item.itemId, { product, quantity: quantityFor(item.hint, product), include: true });
    setOpenPicker(null);
  }

  async function send() {
    if (sending || chosen.length === 0) return;
    setSending(true);
    setSendError("");
    try {
      const res = await krogerApi.send(
        list.id,
        chosen.map((i) => ({ itemId: i.itemId, upc: rows[i.itemId].product!.upc, quantity: rows[i.itemId].quantity, again: i.state === "sent" }))
      );
      setSent(res.added);
      setTouched(false); // the server dropped what was sent from the saved screen
      onSent(res.list);
    } catch (err) {
      setSendError(krogerErrorText(err));
    } finally {
      setSending(false);
    }
  }

  if (sent !== null) {
    return (
      <Sheet title="Sent to Kroger" onClose={onClose}>
        <div className="flex flex-col items-center text-center gap-3 py-4">
          <div className="size-12 rounded-full bg-emerald-100 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-300 flex items-center justify-center">
            <Check size={24} />
          </div>
          <p className="font-medium">
            Added {sent} product{sent === 1 ? "" : "s"} to your Kroger cart.
          </p>
          <p className={`text-sm ${mutedCls}`}>
            Choose pickup or delivery and check out in the Kroger app. Hestia can't remove items from your Kroger cart, so
            make any changes there.
          </p>
          <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto pt-1">
            <a href={KROGER_CART_URL} target="_blank" rel="noopener noreferrer" className={`${btnPrimary} inline-flex items-center justify-center gap-2`}>
              Open Kroger cart <ExternalLink size={15} />
            </a>
            <button onClick={onClose} className={btnSecondary}>
              Done
            </button>
          </div>
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet title={`Send to Kroger: ${list.name}`} onClose={onClose}>
      {loadError && <Notice tone="error">{loadError}</Notice>}
      {!preview && !loadError && <p className={`text-sm ${mutedCls}`}>Checking Kroger for “{list.name}”…</p>}

      {preview && (
        <>
          <div className="rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-2">
            <p className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">Sending list</p>
            <p className="font-semibold">{list.name}</p>
            <p className={`text-xs ${mutedCls}`}>
              {list.scope === "joint" ? "Household list" : "Personal list"} · {list.items.length} item{list.items.length === 1 ? "" : "s"}
              {" · "}updated {new Date(list.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
            </p>
          </div>
          <p className={`text-xs ${mutedCls}`}>
            Prices and stock from {preview.store.name}. Kroger may substitute or adjust at checkout.
          </p>
          {restored && (
            <Notice>
              Picked up where you left off.{" "}
              <button onClick={startOver} className="underline font-medium">Start over</button>
            </Notice>
          )}
          {!canSend && (
            <Notice tone="warn">Kroger needs to be connected again by an admin (Settings → Groceries) before anything can be sent.</Notice>
          )}
          {items.length === 0 && <Notice>Nothing to send: every item on this list is checked off.</Notice>}

          {main.length > 0 && (
            <ul className="divide-y divide-slate-200 dark:divide-slate-800 -mx-1">
              {main.map((item) => (
                <ItemRow
                  key={item.itemId}
                  item={item}
                  row={rows[item.itemId]}
                  open={openPicker === item.itemId}
                  onToggleOpen={() => setOpenPicker(openPicker === item.itemId ? null : item.itemId)}
                  onUpdate={(patch) => update(item.itemId, patch)}
                  onPick={(p) => pick(item, p)}
                />
              ))}
            </ul>
          )}

          {skipped.length > 0 && (
            <div className="pt-1">
              <h4 className={`text-xs font-semibold uppercase tracking-wide ${mutedCls} mb-1`}>Left off</h4>
              <ul className="divide-y divide-slate-200 dark:divide-slate-800 -mx-1">
                {skipped.map((item) => (
                  <ItemRow
                    key={item.itemId}
                    item={item}
                    row={rows[item.itemId]}
                    open={openPicker === item.itemId}
                    onToggleOpen={() => setOpenPicker(openPicker === item.itemId ? null : item.itemId)}
                    onUpdate={(patch) => update(item.itemId, patch)}
                    onPick={(p) => pick(item, p)}
                  />
                ))}
              </ul>
            </div>
          )}

          <div className="sticky -bottom-4 -mx-4 px-4 pt-3 pb-4 bg-white dark:bg-slate-900 border-t border-slate-200 dark:border-slate-800 space-y-2">
            {sendError && <Notice tone="error">{sendError}</Notice>}
            <div className="flex items-baseline justify-between text-sm">
              <span className={mutedCls}>
                {chosen.length} item{chosen.length === 1 ? "" : "s"}
                {needChoice > 0 && ` · ${needChoice} still to choose`}
              </span>
              <span className="font-semibold">
                ≈ {money(estimate.total)}
                {estimate.unpricedItems > 0 && <span className={`font-normal ${mutedCls}`}> + {estimate.unpricedItems} unpriced</span>}
              </span>
            </div>
            <button onClick={send} disabled={!canSend || sending || chosen.length === 0} className={`${btnPrimary} w-full inline-flex items-center justify-center gap-2`}>
              <ShoppingCart size={16} />
              {sending ? "Adding to Kroger cart…" : `Add ${chosen.length} to Kroger cart`}
            </button>
          </div>
        </>
      )}
    </Sheet>
  );
}

function ItemRow({
  item,
  row,
  open,
  onToggleOpen,
  onUpdate,
  onPick,
}: {
  item: PreviewItem;
  row: Row | undefined;
  open: boolean;
  onToggleOpen: () => void;
  onUpdate: (patch: Partial<Row>) => void;
  onPick: (p: KrogerProduct) => void;
}) {
  if (!row) return null;
  const product = row.product;
  const weight = product?.soldBy === "WEIGHT";
  const note =
    item.state === "inPantry"
      ? `In the Pantry${item.pantryName && item.pantryName.toLowerCase() !== item.name.toLowerCase() ? ` (${item.pantryName})` : ""}. Tick to send anyway.`
      : item.state === "sent"
        ? `Already sent ${item.sentAt ? new Date(item.sentAt).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : ""}. Tick to send again.`
        : item.rememberedUnavailable
          ? "Your usual product isn't available at this store. Choose another."
          : !product
            ? "Choose a product."
            : item.productSource === "pantryScan" && product.upc === item.product?.upc
              ? "From your Pantry scan."
              : null;

  return (
    <li className="px-1 py-3 space-y-2">
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={row.include}
          disabled={!product}
          onChange={(e) => onUpdate({ include: e.target.checked })}
          className="mt-1 size-4 accent-blue-600 shrink-0"
          aria-label={`Send ${item.name}`}
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="font-medium text-sm truncate">{item.name}</span>
            {item.quantityText && <span className={`text-xs ${mutedCls} shrink-0`}>{item.quantityText}</span>}
          </div>
          {note && <p className={`text-xs ${item.rememberedUnavailable ? "text-amber-700 dark:text-amber-400" : mutedCls}`}>{note}</p>}

          {product && (
            <div className={`mt-2 flex items-center gap-3 ${row.include ? "" : "opacity-60"}`}>
              <ProductImage product={product} />
              <div className="flex-1 min-w-0">
                <p className="text-sm leading-snug line-clamp-2">{product.description}</p>
                <ProductMeta product={product} />
              </div>
            </div>
          )}

          <div className="mt-2 flex items-center justify-between gap-2">
            <button onClick={onToggleOpen} className="text-xs font-medium text-blue-600 dark:text-blue-400 inline-flex items-center gap-1">
              {product ? "Change" : "Choose product"}
              {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>
            {product && (
              <div className="flex items-center gap-2">
                {weight && product.pieceWeightLb && (
                  <span className={`text-xs ${mutedCls}`}>≈{Math.round(row.quantity * product.pieceWeightLb * 10) / 10} lb</span>
                )}
                <Stepper value={row.quantity} onChange={(quantity) => onUpdate({ quantity })} label={item.name} />
              </div>
            )}
          </div>
        </div>
      </div>
      {open && <Picker item={item} current={product} onPick={onPick} />}
    </li>
  );
}

function ProductImage({ product }: { product: KrogerProduct }) {
  return product.imageUrl ? (
    // no-referrer: Kroger's image server doesn't need to know which page showed it.
    <img src={product.imageUrl} alt="" referrerPolicy="no-referrer" loading="lazy" className="size-12 rounded-md object-contain bg-white border border-slate-200 dark:border-slate-700 shrink-0" />
  ) : (
    <div className="size-12 rounded-md bg-slate-100 dark:bg-slate-800 shrink-0" />
  );
}

function ProductMeta({ product }: { product: KrogerProduct }) {
  const out = product.stockLevel === "TEMPORARILY_OUT_OF_STOCK";
  return (
    <p className={`text-xs ${mutedCls} flex flex-wrap gap-x-2`}>
      <span>{sizeText(product)}</span>
      <span className="font-medium text-slate-700 dark:text-slate-300">
        {priceText(product)}
        {product.price?.promo && <span className={`ml-1 line-through font-normal ${mutedCls}`}>{money(product.price.regular)}</span>}
      </span>
      {product.calories && (
        <span>
          {product.calories.kcal} calories{product.calories.serving ? ` per ${product.calories.serving}` : " per serving"}
        </span>
      )}
      {out && <span className="text-amber-700 dark:text-amber-400">Out of stock</span>}
      {product.stockLevel === "LOW" && <span>Low stock</span>}
    </p>
  );
}

function Stepper({ value, onChange, label }: { value: number; onChange: (n: number) => void; label: string }) {
  return (
    <div className="inline-flex items-center rounded-lg border border-slate-300 dark:border-slate-700">
      <button onClick={() => onChange(Math.max(1, value - 1))} disabled={value <= 1} className="p-1.5 disabled:opacity-30" aria-label={`Fewer ${label}`}>
        <Minus size={14} />
      </button>
      <span className="w-7 text-center text-sm tabular-nums" aria-live="polite">{value}</span>
      <button onClick={() => onChange(Math.min(99, value + 1))} disabled={value >= 99} className="p-1.5 disabled:opacity-30" aria-label={`More ${label}`}>
        <Plus size={14} />
      </button>
    </div>
  );
}

/** Kroger's matches for the item, and a box to search for something else. Out-of-stock products sort last. */
function Picker({ item, current, onPick }: { item: PreviewItem; current: KrogerProduct | null; onPick: (p: KrogerProduct) => void }) {
  const [query, setQuery] = useState(item.name);
  const [results, setResults] = useState<KrogerProduct[] | null>(item.options.length ? item.options : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function run(q: string) {
    if (!q.trim()) return;
    setBusy(true);
    setError("");
    try {
      setResults((await krogerApi.search(q.trim())).products);
    } catch (err) {
      setError(krogerErrorText(err));
    } finally {
      setBusy(false);
    }
  }

  // An item with a product already (remembered or scanned) arrives without options: fetch them on open.
  useEffect(() => {
    if (results === null) run(item.name);
  }, []);

  const sorted = (results ?? []).slice().sort((a, b) => Number(a.stockLevel === "TEMPORARILY_OUT_OF_STOCK") - Number(b.stockLevel === "TEMPORARILY_OUT_OF_STOCK"));

  return (
    <div className="ml-7 space-y-2 rounded-lg bg-slate-50 dark:bg-slate-800/50 p-2">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          run(query);
        }}
        className="flex gap-2"
      >
        <input value={query} onChange={(e) => setQuery(e.target.value)} className={inputCls} aria-label={`Search Kroger for ${item.name}`} />
        <button className="px-3 rounded-lg bg-blue-600 hover:bg-blue-700 text-white shrink-0" aria-label="Search Kroger">
          <Search size={15} />
        </button>
      </form>
      {busy && <p className={`text-xs ${mutedCls}`}>Searching…</p>}
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
      {results && results.length === 0 && !busy && <p className={`text-xs ${mutedCls}`}>Nothing found at this store. Try other words.</p>}
      <ul className="space-y-1">
        {sorted.map((p) => {
          const selected = current?.upc === p.upc;
          const out = p.stockLevel === "TEMPORARILY_OUT_OF_STOCK";
          return (
            <li key={p.upc}>
              <button
                onClick={() => onPick(p)}
                className={`w-full flex items-center gap-3 p-2 rounded-lg text-left ${
                  selected ? "bg-blue-50 dark:bg-blue-950/40 ring-1 ring-blue-500" : "hover:bg-white dark:hover:bg-slate-800"
                } ${out ? "opacity-60" : ""}`}
              >
                <ProductImage product={p} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm leading-snug line-clamp-2">{p.description}</p>
                  <ProductMeta product={p} />
                </div>
                {selected && <Check size={16} className="text-blue-600 dark:text-blue-400 shrink-0" />}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
