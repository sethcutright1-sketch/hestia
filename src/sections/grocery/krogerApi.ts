// The Grocery section's calls to /api/grocery/kroger (routes/kroger.ts). Types come straight from the
// server modules (type-only, erased at build), so the screen and the routes can't drift apart.

import { api, ApiError } from "../../api.ts";
import type { KrogerProduct, KrogerStatus, KrogerStore } from "../../../kroger.ts";
import type { Preview } from "../../../krogerMatch.ts";
import type { ShoppingList } from "../../api.ts";

export type { KrogerProduct, KrogerStatus, KrogerStore };
export type { Preview, PreviewItem, QuantityHint } from "../../../krogerMatch.ts";

/** Kroger's cart page. Checkout -- and choosing pickup or delivery -- happens there or in the Kroger app. */
export const KROGER_CART_URL = "https://www.kroger.com/cart";

export interface SendLine {
  itemId: string;
  upc: string;
  quantity: number;
  /** Send an item that's already been sent (Kroger's cart can't be read or undone). */
  again?: boolean;
}

/** One list item's choices on the send screen, as saved. */
export interface SavedRow {
  include: boolean;
  product: KrogerProduct | null;
  quantity: number;
}

export const krogerApi = {
  status: () => api.get<KrogerStatus>("/api/grocery/kroger/status"),
  preview: (listId: string) =>
    api.get<Preview & { store: KrogerStore; connection: KrogerStatus }>(`/api/grocery/kroger/lists/${encodeURIComponent(listId)}/preview`),
  search: (q: string) => api.get<{ products: KrogerProduct[] }>(`/api/grocery/kroger/search?q=${encodeURIComponent(q)}`),
  send: (listId: string, items: SendLine[], remember = true) =>
    api.post<{ added: number; list: ShoppingList }>(`/api/grocery/kroger/lists/${encodeURIComponent(listId)}/send`, { items, remember }),
  /** The saved state of the send screen for a list (null when nothing is saved). */
  draft: (listId: string) =>
    api.get<{ draft: { rows: Record<string, SavedRow>; savedAt: string } | null }>(`/api/grocery/kroger/lists/${encodeURIComponent(listId)}/draft`),
  saveDraft: (listId: string, rows: Record<string, SavedRow>) =>
    api.put<{ savedAt: string }>(`/api/grocery/kroger/lists/${encodeURIComponent(listId)}/draft`, { rows }),
  clearDraft: (listId: string) => api.del<{ ok: true }>(`/api/grocery/kroger/lists/${encodeURIComponent(listId)}/draft`),
  // Admin only (Settings).
  connect: () => api.post<{ url: string }>("/api/grocery/kroger/connect"),
  disconnect: () => api.post<KrogerStatus>("/api/grocery/kroger/disconnect"),
  stores: (zip: string) => api.get<{ stores: KrogerStore[] }>(`/api/grocery/kroger/stores?zip=${encodeURIComponent(zip)}`),
  chooseStore: (locationId: string) => api.put<KrogerStatus>("/api/grocery/kroger/store", { locationId }),
  clearPicks: () => api.del<{ ok: true }>("/api/grocery/kroger/picks"),
};

export function krogerErrorText(err: unknown): string {
  return err instanceof ApiError ? err.message : "Couldn't reach Hestia. Check the connection and try again.";
}

export function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

/** "1 gal", or for an item sold by weight, "≈2.1 lb each". */
export function sizeText(p: KrogerProduct): string {
  if (p.soldBy === "WEIGHT") return p.pieceWeightLb ? `≈${trim(p.pieceWeightLb)} lb each` : "sold by weight";
  return p.size;
}

/** Price as Kroger shows it: per pound for weight items. */
export function priceText(p: KrogerProduct): string {
  if (!p.price) return "No price";
  const now = p.price.promo ?? p.price.regular;
  return `${money(now)}${p.soldBy === "WEIGHT" ? "/lb" : ""}`;
}

function trim(n: number): string {
  return String(Math.round(n * 100) / 100);
}
