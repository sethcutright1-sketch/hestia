import crypto from "node:crypto";
import express from "express";
import { db, getUserById, getScopedItem, getScopedItems, putScopedItem, deleteScopedItem } from "../db.ts";
import { lookupBarcode } from "../nutrition/lookup.ts";
import { previewWithCalories, productsWithCalories, type CalorieLookup } from "../krogerNutrition.ts";
import { requireAuth, requireAdmin, requireRealSession, forbidKiosk, currentUserId } from "../auth.ts";
import {
  KrogerError,
  type KrogerProduct,
  type KrogerStore,
  getProducts,
  searchProducts,
  addToCart,
  loadPicks,
  rememberPicks,
  clearPicks,
  krogerStatus,
  newPkce,
  newState,
  authorizeUrl,
  exchangeCode,
  disconnectKroger,
  findStores,
  chooseStore,
} from "../kroger.ts";
import { planItems, codesToLookUp, itemsNeedingSearch, finishPreview, pickKey, pickLabel } from "../krogerMatch.ts";
import type { ShoppingList } from "./grocery.ts";
import type { PantryItem } from "./pantry.ts";

// The household's Kroger connection (kroger.ts). Mounted at /api/grocery/kroger in server.ts,
// ahead of the grocery router, and WITHOUT a router-wide requireAuth: Kroger's redirect back to
// /callback is a browser navigation, and a failure there must land the admin back in the app
// with a message rather than on a raw 401 JSON page. Every other route gates itself.
//
// Connecting is admin-only, from a signed-in browser (not a watch token), because it decides
// which Kroger account every household member's lists fill. The callback only works in the same
// browser that started it -- the PKCE verifier and state live in that session -- so the admin has
// to open Hestia at the address registered as KROGER_REDIRECT_URI (your-domain.example on the live app).

declare module "express-session" {
  interface SessionData {
    // Set by POST /connect, used once by GET /callback.
    krogerAuth?: { state: string; verifier: string; createdAt: number };
  }
}

// Long enough to sign in to Kroger, short enough that a forgotten tab can't be finished later.
const CONNECT_WINDOW_MS = 10 * 60 * 1000;

export const krogerRoutes = express.Router();

function sendError(res: express.Response, err: unknown) {
  if (err instanceof KrogerError) return res.status(err.status).json({ error: err.message, reconnect: err.reconnect });
  console.error("Kroger request failed:", err instanceof Error ? err.message : err);
  return res.status(500).json({ error: "Something went wrong talking to Kroger." });
}

function sameString(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Parents see this too: it decides whether the Grocery screen offers "Send to Kroger".
krogerRoutes.get("/status", requireAuth, forbidKiosk, (_req, res) => {
  res.json(krogerStatus());
});

krogerRoutes.post("/connect", requireAuth, requireRealSession, requireAdmin, (req, res) => {
  try {
    const { verifier, challenge } = newPkce();
    const state = newState();
    const url = authorizeUrl(state, challenge);
    req.session.krogerAuth = { state, verifier, createdAt: Date.now() };
    res.json({ url });
  } catch (err) {
    sendError(res, err);
  }
});

// Kroger sends the browser here after sign-in. Always answers with a redirect into the app:
// /?kroger=connected, or /?kroger=failed&reason=<one of a fixed set> -- never anything copied
// from the request, and never the code itself.
krogerRoutes.get("/callback", async (req, res) => {
  const pending = req.session.krogerAuth;
  delete req.session.krogerAuth; // one use, whatever happens next
  const fail = (reason: string) => res.redirect(303, `/?kroger=failed&reason=${reason}`);

  const userId = req.session.userId;
  if (!pending || !userId) return fail("session");
  if (Date.now() - pending.createdAt > CONNECT_WINDOW_MS) return fail("expired");
  const state = typeof req.query.state === "string" ? req.query.state : "";
  if (!state || !sameString(state, pending.state)) return fail("state");
  if (req.query.error !== undefined) return fail("denied");
  const code = typeof req.query.code === "string" ? req.query.code : "";
  if (!code) return fail("code");
  // Re-checked here: the session started as an admin, but the role could have changed since.
  if (getUserById(userId)?.role !== "admin") return fail("admin");

  try {
    await exchangeCode(code, pending.verifier);
  } catch (err) {
    console.error("Kroger connect failed:", err instanceof KrogerError ? err.message : "unexpected error");
    return fail("exchange");
  }
  console.log("Kroger connected for the household.");
  res.redirect(303, "/?kroger=connected");
});

krogerRoutes.post("/disconnect", requireAuth, requireRealSession, requireAdmin, (_req, res) => {
  disconnectKroger();
  console.log("Kroger disconnected.");
  res.json(krogerStatus());
});

krogerRoutes.get("/stores", requireAuth, requireAdmin, async (req, res) => {
  try {
    const zip = typeof req.query.zip === "string" ? req.query.zip.trim() : "";
    res.json({ stores: await findStores(zip) });
  } catch (err) {
    sendError(res, err);
  }
});

krogerRoutes.put("/store", requireAuth, requireRealSession, requireAdmin, async (req, res) => {
  try {
    const locationId = typeof req.body?.locationId === "string" ? req.body.locationId.trim() : "";
    await chooseStore(locationId);
    res.json(krogerStatus());
  } catch (err) {
    sendError(res, err);
  }
});

// ---------------------------------------------------------------------------------------------
// Sending a list (any real member; never the kiosk). Matching rules live in krogerMatch.ts.

/** A fixed-window count per login, in memory. Not a security limit (only signed-in members get
 *  here) -- it keeps one stuck screen or script from spending the household's daily Kroger quota
 *  (Products 10,000 calls/day, Cart 5,000). */
class CallBudget {
  private readonly windows = new Map<string, { start: number; count: number }>();
  constructor(private readonly limit: number, private readonly windowMs: number, private readonly now = Date.now) {}

  take(key: string): boolean {
    const now = this.now();
    const w = this.windows.get(key);
    if (!w || now - w.start >= this.windowMs) {
      this.windows.set(key, { start: now, count: 1 });
      return true;
    }
    if (w.count >= this.limit) return false;
    w.count++;
    return true;
  }

  reset(): void {
    this.windows.clear();
  }
}

// A preview of a 40-item list is up to ~45 Kroger calls; 60 previews or searches an hour is a lot
// of shopping. Sends are rarer still.
const lookupBudget = new CallBudget(60, 60 * 60 * 1000);
const sendBudget = new CallBudget(20, 60 * 60 * 1000);
// Kroger is asked about at most this many items at once.
const SEARCH_CONCURRENCY = 4;
const MAX_SEND_ITEMS = 100;

// Calories per serving come from the Nutrition section's barcode lookup (krogerNutrition.ts). A
// failure there never fails a preview or search: the products just arrive without calories.
let calorieLookup: CalorieLookup = (upc) => lookupBarcode(db, upc);

/** Test seam: swap the calorie lookup (the default reaches Open Food Facts and USDA). */
export function setCalorieLookupForTests(lookup: CalorieLookup | null): void {
  calorieLookup = lookup ?? ((upc) => lookupBarcode(db, upc));
}

function tooMany(res: express.Response) {
  return res.status(429).json({ error: "That's a lot of Kroger requests in a short time. Try again in a bit." });
}

/** The chosen store, or answers the request with why there isn't one. */
function storeOrRefuse(res: express.Response): KrogerStore | null {
  const status = krogerStatus();
  if (!status.configured) {
    res.status(503).json({ error: "Kroger isn't set up on this server." });
    return null;
  }
  if (!status.store) {
    res.status(409).json({ error: "Pick a Kroger store in Settings first." });
    return null;
  }
  return status.store;
}

function loadList(req: express.Request, res: express.Response): ShoppingList | null {
  const list = getScopedItem("shopping_lists", currentUserId(req), req.params.id) as ShoppingList | undefined;
  if (!list) {
    res.status(404).json({ error: "List not found" });
    return null;
  }
  return list;
}

async function inBatches<T, R>(inputs: T[], size: number, fn: (input: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < inputs.length; i += size) out.push(...(await Promise.all(inputs.slice(i, i + size).map(fn))));
  return out;
}

krogerRoutes.get("/lists/:id/preview", requireAuth, forbidKiosk, async (req, res) => {
  const list = loadList(req, res);
  if (!list) return;
  const store = storeOrRefuse(res);
  if (!store) return;
  if (!lookupBudget.take(currentUserId(req))) return tooMany(res);

  try {
    const pantry = getScopedItems("pantry_items", currentUserId(req)) as PantryItem[];
    const plans = planItems(list, pantry, loadPicks());
    const products = await getProducts(codesToLookUp(plans), store.locationId);
    const toSearch = itemsNeedingSearch(plans, products);
    // One failed search (Kroger has the odd hiccup under parallel calls) mustn't sink the preview:
    // that item just arrives with no options, and the screen searches again when it's opened.
    const results = await inBatches(toSearch, SEARCH_CONCURRENCY, (p) =>
      searchProducts(p.item.name, store.locationId, 5).catch((): KrogerProduct[] => [])
    );
    const searchResults = new Map(toSearch.map((p, i) => [p.item.id, results[i]] as [string, KrogerProduct[]]));
    const preview = await previewWithCalories(finishPreview(plans, products, searchResults), calorieLookup);
    res.json({ ...preview, store, connection: krogerStatus() });
  } catch (err) {
    sendError(res, err);
  }
});

// "Search again" / "see other matches" on the send screen.
krogerRoutes.get("/search", requireAuth, forbidKiosk, async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 100) : "";
  if (!q) return res.status(400).json({ error: "Type something to search for." });
  const store = storeOrRefuse(res);
  if (!store) return;
  if (!lookupBudget.take(currentUserId(req))) return tooMany(res);
  try {
    res.json({ products: await productsWithCalories(await searchProducts(q, store.locationId, 10), calorieLookup) });
  } catch (err) {
    sendError(res, err);
  }
});

interface SendLine {
  itemId: string;
  upc: string;
  quantity: number;
  again: boolean;
}

function parseLines(raw: unknown): SendLine[] | string {
  if (!Array.isArray(raw) || raw.length === 0) return "Nothing to send.";
  if (raw.length > MAX_SEND_ITEMS) return `Send at most ${MAX_SEND_ITEMS} items at a time.`;
  const lines: SendLine[] = [];
  for (const r of raw) {
    if (!r || typeof r.itemId !== "string" || typeof r.upc !== "string" || !/^\d{13}$/.test(r.upc)) return "One of the items has no valid product.";
    if (!Number.isInteger(r.quantity) || r.quantity < 1 || r.quantity > 99) return "Quantities must be whole numbers from 1 to 99.";
    lines.push({ itemId: r.itemId, upc: r.upc, quantity: r.quantity, again: r.again === true });
  }
  if (new Set(lines.map((l) => l.itemId)).size !== lines.length) return "The same list item was sent twice.";
  return lines;
}

// Adds the chosen products to the household's Kroger cart, stamps each list item as sent, and
// remembers the picks. Kroger's cart can't be read or undone, so an item already stamped is
// refused unless the request says `again` for it.
krogerRoutes.post("/lists/:id/send", requireAuth, requireRealSession, forbidKiosk, async (req, res) => {
  const list = loadList(req, res);
  if (!list) return;
  const lines = parseLines(req.body?.items);
  if (typeof lines === "string") return res.status(400).json({ error: lines });

  const byId = new Map(list.items.map((item) => [item.id, item]));
  const missing = lines.filter((l) => !byId.get(l.itemId) || byId.get(l.itemId)!.checked);
  if (missing.length) return res.status(400).json({ error: "Some items aren't on this list any more, or are checked off. Refresh and try again." });
  const alreadySent = lines.filter((l) => byId.get(l.itemId)!.sentToKroger && !l.again).map((l) => byId.get(l.itemId)!.name);
  if (alreadySent.length) {
    return res.status(409).json({ error: `Already in the Kroger cart: ${alreadySent.join(", ")}. Tick "send again" to add them again.`, alreadySent });
  }

  const store = storeOrRefuse(res);
  if (!store) return;
  const status = krogerStatus();
  if (!status.connected || status.needsReconnect) {
    return res.status(409).json({ error: "Kroger isn't connected. An admin can connect it in Settings.", reconnect: true });
  }
  if (!sendBudget.take(currentUserId(req))) return tooMany(res);

  try {
    // Checked against Kroger, not taken on the client's word: the label that gets remembered comes
    // from here, and a product the store doesn't carry is caught before anything is added.
    const products = await getProducts(lines.map((l) => l.upc), store.locationId);
    const notCarried = lines.filter((l) => !products.has(l.upc)).map((l) => byId.get(l.itemId)!.name);
    if (notCarried.length) {
      return res.status(400).json({ error: `Your Kroger doesn't carry the product picked for: ${notCarried.join(", ")}. Pick another.` });
    }

    // One cart line per product: two list items that picked the same product are added together.
    const merged = new Map<string, number>();
    for (const l of lines) merged.set(l.upc, Math.min(99, (merged.get(l.upc) ?? 0) + l.quantity));
    await addToCart([...merged].map(([upc, quantity]) => ({ upc, quantity })));

    // Re-read: the list may have changed while Kroger was answering.
    const fresh = (getScopedItem("shopping_lists", currentUserId(req), list.id) as ShoppingList | undefined) ?? list;
    const now = new Date().toISOString();
    const sentIds = new Set(lines.map((l) => l.itemId));
    for (const item of fresh.items) if (sentIds.has(item.id)) item.sentToKroger = now;
    fresh.updatedAt = now;
    putScopedItem("shopping_lists", currentUserId(req), fresh);

    // What was just sent no longer needs saving; whatever was left unticked stays for next time.
    const draft = getScopedItem("kroger_drafts", currentUserId(req), list.id) as KrogerDraft | undefined;
    if (draft) {
      for (const id of sentIds) delete draft.rows[id];
      if (Object.keys(draft.rows).length === 0) deleteScopedItem("kroger_drafts", currentUserId(req), list.id);
      else putScopedItem("kroger_drafts", currentUserId(req), draft);
    }

    if (req.body?.remember !== false) {
      rememberPicks(lines.map((l) => ({ key: pickKey(byId.get(l.itemId)!.name), upc: l.upc, label: pickLabel(products.get(l.upc)!) })));
    }
    console.log(`Kroger: added ${merged.size} product(s) to the household cart.`);
    res.json({ added: merged.size, list: fresh });
  } catch (err) {
    sendError(res, err);
  }
});

// --- A saved send screen ------------------------------------------------------------------------
//
// What the person had chosen on the screen (which items are ticked, the product and quantity for each)
// is kept per list, so closing the sheet, or leaving and coming back from another device, resumes it.
// It is only a convenience: the send re-checks every product with Kroger, so nothing in here is trusted.

export interface KrogerDraft {
  id: string; // the list id
  scope: "joint" | "personal";
  createdBy: string;
  rows: Record<string, { include: boolean; product: unknown; quantity: number }>;
  savedAt: string;
}

const MAX_DRAFT_ROWS = 300;
const MAX_DRAFT_BYTES = 400_000;

function cleanDraftRows(raw: unknown, itemIds: Set<string>): KrogerDraft["rows"] | string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "rows must be an object";
  const rows: KrogerDraft["rows"] = {};
  for (const [itemId, r] of Object.entries(raw as Record<string, any>)) {
    if (!itemIds.has(itemId)) continue; // an item that left the list
    const quantity = Number.isInteger(r?.quantity) && r.quantity >= 1 && r.quantity <= 99 ? r.quantity : 1;
    const product = r?.product && typeof r.product === "object" && typeof r.product.upc === "string" ? r.product : null;
    rows[itemId] = { include: r?.include === true && product !== null, product, quantity };
  }
  if (Object.keys(rows).length > MAX_DRAFT_ROWS) return "Too many items to save.";
  return rows;
}

krogerRoutes.get("/lists/:id/draft", requireAuth, forbidKiosk, (req, res) => {
  const list = loadList(req, res);
  if (!list) return;
  const draft = getScopedItem("kroger_drafts", currentUserId(req), list.id) as KrogerDraft | undefined;
  res.json({ draft: draft ? { rows: draft.rows, savedAt: draft.savedAt } : null });
});

krogerRoutes.put("/lists/:id/draft", requireAuth, requireRealSession, forbidKiosk, (req, res) => {
  const list = loadList(req, res);
  if (!list) return;
  const rows = cleanDraftRows(req.body?.rows, new Set(list.items.map((i) => i.id)));
  if (typeof rows === "string") return res.status(400).json({ error: rows });
  if (JSON.stringify(rows).length > MAX_DRAFT_BYTES) return res.status(413).json({ error: "Too much to save." });
  const draft: KrogerDraft = { id: list.id, scope: list.scope === "personal" ? "personal" : "joint", createdBy: currentUserId(req), rows, savedAt: new Date().toISOString() };
  putScopedItem("kroger_drafts", currentUserId(req), draft);
  res.json({ savedAt: draft.savedAt });
});

krogerRoutes.delete("/lists/:id/draft", requireAuth, requireRealSession, forbidKiosk, (req, res) => {
  deleteScopedItem("kroger_drafts", currentUserId(req), req.params.id);
  res.json({ ok: true });
});

krogerRoutes.delete("/picks", requireAuth, requireRealSession, requireAdmin, (_req, res) => {
  clearPicks();
  res.json({ ok: true });
});

/** Test seam: fresh per-login call budgets, as after a restart. */
export function resetKrogerBudgetsForTests(): void {
  lookupBudget.reset();
  sendBudget.reset();
}
