import { useEffect, useState } from "react";
import { Plus, Trash2, Users, Lock, ShoppingCart, ListX, Send, ScanBarcode } from "lucide-react";
import { api, type CalorieFillOutcome, type ShoppingList } from "../api.ts";
import { useLiveRefresh } from "../useLiveRefresh.ts";
import { KIOSK } from "../kiosk.ts";
import { CalorieFill, CalorieBadge } from "../CalorieFill.tsx";
import { useConfirm } from "./budget/components/ConfirmDialog.tsx";
import GroceryScan from "./grocery/GroceryScan.tsx";
import KrogerSendSheet from "./grocery/KrogerSendSheet.tsx";
import { krogerApi, type KrogerStatus } from "./grocery/krogerApi.ts";

export default function Grocery() {
  const [lists, setLists] = useState<ShoppingList[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newListName, setNewListName] = useState("");
  const [newItem, setNewItem] = useState("");
  const [newQuantity, setNewQuantity] = useState("");
  const [error, setError] = useState("");
  const { confirm, dialog } = useConfirm();
  // Kroger is offered once an admin has connected it and picked a store (Settings -> Groceries). The
  // status route refuses the kiosk login, which is what keeps the button off the fridge.
  const [kroger, setKroger] = useState<KrogerStatus | null>(null);
  const [krogerOpen, setKrogerOpen] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);

  const selected = lists.find((l) => l.id === selectedId) || null;

  async function refresh(keepId?: string) {
    try {
      const res = await api.get<{ lists: ShoppingList[] }>("/api/grocery/lists");
      setLists(res.lists);
      const target = keepId ?? selectedId;
      setSelectedId(res.lists.some((l) => l.id === target) ? target! : res.lists[0]?.id ?? null);
    } catch (err: any) {
      setError(err.message);
    }
  }

  useEffect(() => { refresh(); }, []);
  useEffect(() => {
    if (!KIOSK) krogerApi.status().then(setKroger).catch(() => setKroger(null));
  }, []);

  // Picks up an item another device (or the assistant) added/checked off
  // without needing App.tsx's dataVersion remount, which would throw away
  // whatever's selected here. refresh() already preserves the current
  // selection by id, so this is safe to call on a plain tab-focus/interval.
  useLiveRefresh(() => refresh(), KIOSK ? 30_000 : 60_000);

  // Every mutation returns the updated list, so the local copy is replaced from
  // the server's version rather than patched -- no chance of the two diverging.
  function applyList(list: ShoppingList) {
    setLists((prev) => prev.map((l) => (l.id === list.id ? list : l)));
  }

  async function createList(e: React.FormEvent) {
    e.preventDefault();
    if (!newListName.trim()) return;
    try {
      const res = await api.post<{ list: ShoppingList }>("/api/grocery/lists", { name: newListName });
      setNewListName("");
      await refresh(res.list.id);
    } catch (err: any) { setError(err.message); }
  }

  async function addItem(e: React.FormEvent) {
    e.preventDefault();
    if (!selected || !newItem.trim()) return;
    try {
      const res = await api.post<{ list: ShoppingList }>(`/api/grocery/lists/${selected.id}/items`, {
        name: newItem,
        quantity: newQuantity,
      });
      setNewItem("");
      setNewQuantity("");
      applyList(res.list);
    } catch (err: any) { setError(err.message); }
  }

  async function toggleItem(itemId: string, checked: boolean) {
    if (!selected) return;
    try {
      const res = await api.put<{ list: ShoppingList }>(`/api/grocery/lists/${selected.id}/items/${itemId}`, { checked });
      applyList(res.list);
    } catch (err: any) { setError(err.message); }
  }

  async function removeItem(itemId: string) {
    if (!selected) return;
    try {
      const res = await api.del<{ list: ShoppingList }>(`/api/grocery/lists/${selected.id}/items/${itemId}`);
      applyList(res.list);
    } catch (err: any) { setError(err.message); }
  }

  async function clearList() {
    if (!selected || selected.items.length === 0) return;
    const ok = await confirm({
      title: "Clear list?",
      message: `Remove all ${selected.items.length} item${selected.items.length === 1 ? "" : "s"} from "${selected.name}". This can't be undone.`,
      confirmLabel: "Clear list",
      tone: "danger",
    });
    if (!ok) return;
    try {
      const res = await api.del<{ list: ShoppingList }>(`/api/grocery/lists/${selected.id}/items`);
      applyList(res.list);
    } catch (err: any) { setError(err.message); }
  }

  return (
    <div className="grid md:grid-cols-[260px_1fr] gap-6">
      {dialog}
      <aside className="space-y-3">
        <form onSubmit={createList} className="flex gap-2">
          <input
            className="flex-1 min-w-0 px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
            placeholder="New list…"
            value={newListName}
            onChange={(e) => setNewListName(e.target.value)}
          />
          <button className="px-3 rounded-lg bg-blue-600 hover:bg-blue-700 text-white" aria-label="Create list">
            <Plus size={16} />
          </button>
        </form>

        {lists.length === 0 && (
          <p className="text-sm text-slate-500 dark:text-slate-400 px-1">No lists yet.</p>
        )}

        <ul className="space-y-1">
          {lists.map((list) => {
            const remaining = list.items.filter((i) => !i.checked).length;
            return (
              <li key={list.id}>
                <button
                  onClick={() => setSelectedId(list.id)}
                  className={`w-full text-left px-3 py-2 rounded-lg text-sm flex items-center gap-2 ${
                    list.id === selectedId
                      ? "bg-blue-600 text-white"
                      : "hover:bg-slate-200 dark:hover:bg-slate-800"
                  }`}
                >
                  {list.scope === "personal" ? <Lock size={13} /> : <Users size={13} />}
                  <span className="flex-1 truncate">{list.name}</span>
                  <span className="text-xs opacity-70">{remaining}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </aside>

      <section>
        {error && <p className="mb-3 text-sm text-red-600 dark:text-red-400">{error}</p>}

        {!selected ? (
          <div className="flex flex-col items-center justify-center py-16 text-slate-400 dark:text-slate-500">
            <ShoppingCart size={32} className="mb-3" />
            <p className="text-sm">Create a list to get started.</p>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between gap-2 mb-3">
              <h2 className="text-lg font-semibold min-w-0 truncate">{selected.name}</h2>
              <div className="flex items-center gap-1 shrink-0">
                {kroger?.connected && kroger.store && selected.items.some((i) => !i.checked) && (
                  <button
                    onClick={() => setKrogerOpen(true)}
                    className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium bg-blue-600 hover:bg-blue-700 text-white"
                  >
                    <Send size={13} />
                    Send to Kroger
                  </button>
                )}
                {selected.items.length > 0 && (
                  <button
                    onClick={clearList}
                    className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-slate-500 hover:text-red-600 dark:text-slate-400 dark:hover:text-red-400"
                  >
                    <ListX size={14} />
                    Clear list
                  </button>
                )}
              </div>
            </div>
            {scanOpen && <GroceryScan list={selected} onList={applyList} onClose={() => setScanOpen(false)} />}
            {krogerOpen && <KrogerSendSheet list={selected} onClose={() => setKrogerOpen(false)} onSent={applyList} />}

            <form onSubmit={addItem} className="flex gap-2 mb-4">
              <input
                className="flex-1 min-w-0 px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                placeholder="Add an item…"
                value={newItem}
                onChange={(e) => setNewItem(e.target.value)}
              />
              <input
                className="w-24 px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                placeholder="Qty"
                value={newQuantity}
                onChange={(e) => setNewQuantity(e.target.value)}
              />
              <button className="px-3 rounded-lg bg-blue-600 hover:bg-blue-700 text-white" aria-label="Add item">
                <Plus size={16} />
              </button>
              <button
                type="button"
                onClick={() => setScanOpen((v) => !v)}
                className={`px-3 rounded-lg border border-slate-300 dark:border-slate-700 ${scanOpen ? "bg-slate-200 dark:bg-slate-700" : "bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800"}`}
                aria-label="Scan items"
                title="Scan items onto this list"
              >
                <ScanBarcode size={16} />
              </button>
            </form>

            {selected.items.length === 0 ? (
              <p className="text-sm text-slate-500 dark:text-slate-400">Nothing on this list yet.</p>
            ) : (
              <>
              <CalorieFill<CalorieFillOutcome & { list: ShoppingList }>
                endpoint={`/api/grocery/lists/${encodeURIComponent(selected.id)}/calories/fill`}
                onDone={(r) => applyList(r.list)}
              />
              <ul className="divide-y divide-slate-200 dark:divide-slate-800">
                {selected.items.map((item) => (
                  <li key={item.id} className="flex items-center gap-3 py-2.5">
                    <input
                      type="checkbox"
                      checked={item.checked}
                      onChange={(e) => toggleItem(item.id, e.target.checked)}
                      className="size-4 accent-blue-600"
                    />
                    <span className={`flex-1 text-sm ${item.checked ? "line-through text-slate-400 dark:text-slate-600" : ""}`}>
                      {item.name}
                      {item.quantity && (
                        <span className="ml-2 text-xs text-slate-500 dark:text-slate-400">{item.quantity}</span>
                      )}
                      <CalorieBadge calories={item.calories} />
                      {item.sentToKroger && !item.checked && (
                        <span
                          className="ml-2 text-[11px] px-1.5 py-0.5 rounded bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300"
                          title={`Added to the Kroger cart ${new Date(item.sentToKroger).toLocaleString()}`}
                        >
                          In Kroger cart
                        </span>
                      )}
                    </span>
                    <button
                      onClick={() => removeItem(item.id)}
                      className="text-slate-400 hover:text-red-600 dark:hover:text-red-400"
                      aria-label={`Remove ${item.name}`}
                    >
                      <Trash2 size={15} />
                    </button>
                  </li>
                ))}
              </ul>
              </>
            )}
          </>
        )}
      </section>
    </div>
  );
}
