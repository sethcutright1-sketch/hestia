// Settings -> Groceries (admin only): the household's Kroger connection (kroger.ts, routes/kroger.ts).
// Connect the one Kroger account every list sends to, pick the store whose prices and stock the send
// screen shows, and forget the products remembered for list items. Kept out of AdminSettings.tsx the
// way the Food tab is.

import { useEffect, useState } from "react";
import { ExternalLink, MapPin } from "lucide-react";
import { krogerApi, krogerErrorText, type KrogerStatus, type KrogerStore } from "./sections/grocery/krogerApi.ts";

/** What /api/grocery/kroger/callback sent the browser back with (`?kroger=...&reason=...`). */
export interface KrogerReturn {
  result: "connected" | "failed";
  reason: string | null;
}

const FAILURES: Record<string, string> = {
  session: "The Kroger sign-in came back to a browser that didn't start it, or the session ended. Press Connect again here.",
  expired: "The Kroger sign-in took longer than 10 minutes. Press Connect again.",
  state: "The Kroger sign-in didn't match the one started here. Press Connect again.",
  denied: "Kroger access wasn't allowed on Kroger's page.",
  code: "Kroger didn't finish the sign-in. Press Connect again.",
  exchange: "Kroger didn't finish the sign-in. Press Connect again.",
  admin: "Only an admin can connect Kroger.",
};

export function krogerReturnText(r: KrogerReturn): { tone: "ok" | "error"; text: string } {
  if (r.result === "connected") return { tone: "ok", text: "Kroger is connected. Lists can now be sent to the household's Kroger cart." };
  return { tone: "error", text: FAILURES[r.reason ?? ""] ?? "Connecting Kroger didn't work. Press Connect again." };
}

const label = "block text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wide";
const help = "text-xs text-slate-500 dark:text-slate-400 leading-normal";
const card = "p-3 bg-slate-50 dark:bg-slate-800/50 border border-slate-100 dark:border-slate-800 rounded-lg";
const btnSoft =
  "py-2 px-3 bg-blue-50 dark:bg-blue-950/20 hover:bg-blue-100 dark:hover:bg-blue-950/40 border border-blue-200 dark:border-blue-800/60 rounded-lg text-xs font-bold text-blue-700 dark:text-blue-400 disabled:opacity-50";
const btnPlain = "py-2 px-3 border border-slate-300 dark:border-slate-700 rounded-lg text-xs font-bold text-slate-600 dark:text-slate-400 disabled:opacity-50";
const input = "w-full px-3 py-2 border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 rounded-lg text-sm";

export function GroceriesAdminTab({ notice }: { notice?: KrogerReturn | null }) {
  const [status, setStatus] = useState<KrogerStatus | null>(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [confirmForget, setConfirmForget] = useState(false);
  const [zip, setZip] = useState("");
  const [stores, setStores] = useState<KrogerStore[] | null>(null);
  const [changingStore, setChangingStore] = useState(false);

  useEffect(() => {
    krogerApi.status().then(setStatus).catch((err) => setError(krogerErrorText(err)));
  }, []);

  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      await action();
    } catch (err) {
      setError(krogerErrorText(err));
    } finally {
      setBusy(false);
    }
  }

  if (!status) {
    return error ? <p className="text-xs font-medium text-rose-600 dark:text-rose-400">{error}</p> : <p className="text-xs text-slate-400">Loading…</p>;
  }

  if (!status.configured) {
    return (
      <div className="space-y-2 max-w-sm">
        <label className={label}>Kroger</label>
        <p className={help}>
          Kroger isn't set up on this server. It needs KROGER_CLIENT_ID, KROGER_CLIENT_SECRET and KROGER_REDIRECT_URI in .env.local (see
          .env.example), then a restart.
        </p>
      </div>
    );
  }

  const wrongAddress = !!status.connectOrigin && window.location.origin !== status.connectOrigin;
  const returned = notice ? krogerReturnText(notice) : null;

  return (
    <div className="space-y-6 max-w-sm">
      <div className="space-y-2">
        <label className={label}>Kroger account</label>
        <p className={help}>
          Grocery lists can be added to one household Kroger account's cart. Checkout, payment, and pickup or delivery all happen in the Kroger
          app; Hestia can only add items, never order or remove them. List item names and the products picked are sent to Kroger.
        </p>

        {returned && (
          <p className={`text-xs font-medium ${returned.tone === "ok" ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}>{returned.text}</p>
        )}

        <div className={card}>
          <span className="text-xs font-medium text-slate-700 dark:text-slate-300">
            {status.needsReconnect ? (
              <span className="text-amber-700 dark:text-amber-400">The Kroger sign-in has expired. Connect again to keep sending lists.</span>
            ) : status.connected ? (
              <>Connected{status.connectedAt ? ` since ${new Date(status.connectedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}` : ""}.</>
            ) : (
              "Not connected."
            )}
          </span>
        </div>

        {wrongAddress && (
          <p className={help}>
            To connect, open Hestia at{" "}
            <a href={status.connectOrigin!} className="text-blue-600 dark:text-blue-400 underline">
              {status.connectOrigin}
            </a>
            : Kroger only sends the sign-in back to that address.
          </p>
        )}

        {confirmDisconnect ? (
          <div className="space-y-2 p-3 border border-slate-200 dark:border-slate-700 rounded-lg">
            <p className="text-xs text-slate-600 dark:text-slate-400">
              Lists can't be sent to Kroger until someone connects again. Items already in the Kroger cart stay there.
            </p>
            <div className="flex gap-2">
              <button onClick={() => setConfirmDisconnect(false)} className={`flex-1 ${btnPlain}`}>
                Cancel
              </button>
              <button
                onClick={() =>
                  run(async () => {
                    setStatus(await krogerApi.disconnect());
                    setConfirmDisconnect(false);
                    setSuccess("Kroger disconnected.");
                  })
                }
                disabled={busy}
                className="flex-1 py-1.5 bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white rounded-lg text-xs font-bold"
              >
                Disconnect
              </button>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() =>
                run(async () => {
                  const { url } = await krogerApi.connect();
                  window.location.href = url;
                })
              }
              disabled={busy || wrongAddress}
              className={`${btnSoft} inline-flex items-center justify-center gap-1.5`}
            >
              {status.connected ? "Reconnect" : "Connect Kroger"} <ExternalLink size={12} />
            </button>
            <button onClick={() => setConfirmDisconnect(true)} disabled={!status.connected} className={btnPlain}>
              Disconnect
            </button>
          </div>
        )}
      </div>

      <div className="space-y-2">
        <label className={label}>Store</label>
        <p className={help}>The send screen shows this store's prices and stock, and only offers what it carries.</p>
        <div className={`${card} flex items-start gap-2`}>
          <MapPin size={14} className="mt-0.5 text-slate-400 shrink-0" />
          <span className="text-xs font-medium text-slate-700 dark:text-slate-300">
            {status.store ? (
              <>
                {status.store.name}
                <span className="block font-normal text-slate-500 dark:text-slate-400">{status.store.address}</span>
              </>
            ) : (
              "No store chosen yet."
            )}
          </span>
        </div>

        {changingStore || !status.store ? (
          <div className="space-y-2">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                run(async () => setStores((await krogerApi.stores(zip.trim())).stores));
              }}
              className="flex gap-2"
            >
              <input value={zip} onChange={(e) => setZip(e.target.value)} inputMode="numeric" maxLength={5} placeholder="ZIP code" className={input} />
              <button disabled={busy} className={`${btnSoft} shrink-0`}>
                Find stores
              </button>
            </form>
            {stores && stores.length === 0 && <p className={help}>No Kroger stores found near that ZIP code.</p>}
            {stores && stores.length > 0 && (
              <ul className="space-y-1 max-h-64 overflow-y-auto">
                {stores.map((s) => (
                  <li key={s.locationId}>
                    <button
                      onClick={() =>
                        run(async () => {
                          setStatus(await krogerApi.chooseStore(s.locationId));
                          setStores(null);
                          setChangingStore(false);
                          setSuccess(`Store set to ${s.name}.`);
                        })
                      }
                      disabled={busy}
                      className={`w-full text-left p-2 rounded-lg border text-xs ${
                        status.store?.locationId === s.locationId
                          ? "border-blue-500 bg-blue-50 dark:bg-blue-950/30"
                          : "border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/60"
                      }`}
                    >
                      <span className="font-medium text-slate-800 dark:text-slate-200">{s.name}</span>
                      <span className="block text-slate-500 dark:text-slate-400">{s.address}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {status.store && (
              <button onClick={() => { setChangingStore(false); setStores(null); }} className={btnPlain}>
                Cancel
              </button>
            )}
          </div>
        ) : (
          <button onClick={() => setChangingStore(true)} className={btnPlain}>
            Change store
          </button>
        )}
      </div>

      <div className="space-y-2">
        <label className={label}>Remembered products</label>
        <p className={help}>
          When a list item is sent, Hestia remembers which Kroger product was picked for it ("milk" → the gallon you chose) and suggests it next
          time. Forgetting them means choosing again.
        </p>
        {confirmForget ? (
          <div className="flex gap-2">
            <button onClick={() => setConfirmForget(false)} className={`flex-1 ${btnPlain}`}>
              Cancel
            </button>
            <button
              onClick={() =>
                run(async () => {
                  await krogerApi.clearPicks();
                  setConfirmForget(false);
                  setSuccess("Remembered products forgotten.");
                })
              }
              disabled={busy}
              className="flex-1 py-1.5 bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white rounded-lg text-xs font-bold"
            >
              Forget all
            </button>
          </div>
        ) : (
          <button onClick={() => setConfirmForget(true)} className={btnPlain}>
            Forget remembered products
          </button>
        )}
      </div>

      {error && <p className="text-xs font-medium text-rose-600 dark:text-rose-400">{error}</p>}
      {success && <p className="text-xs font-medium text-emerald-600 dark:text-emerald-400">{success}</p>}
    </div>
  );
}
