// The simplest full example of this app's REST convention -- read this file
// first if you're learning the pattern, then see grocery.ts/mealplan.ts/etc.
// for the same shape with more fields. One express.Router() per section
// (mounted in server.ts), four standard verbs mapped onto the four db.ts
// helpers: GET / lists, POST / creates, PUT /:id updates, DELETE /:id
// removes. Every handler calls currentUserId(req) to scope the read/write to
// whoever's signed in -- see db.ts's ScopedTable comment for what "scoped"
// means here (pantry items are always joint, so scoping barely shows, but
// the same four calls work identically for grocery.ts's personal lists).
import express from "express";
import { getScopedItems, getScopedItem, putScopedItem, deleteScopedItem, newId } from "../db.ts";
import { currentUserId } from "../auth.ts";
import { findByBarcode, closestNames } from "../assistant/tools/shared.ts";
import { lookupBarcode } from "../barcodeLookup.ts";
import type { ItemCalories } from "../itemCalories.ts";
import { runFill } from "./itemCaloriesFill.ts";

export interface PantryItem {
  id: string;
  name: string;
  quantity: string;
  // Barcode scan in/out (see the block at the bottom of this file): stockCount
  // is the arithmetic source of truth once a barcode is attached; quantity is
  // kept as a mirrored display string (String(stockCount)) so the existing
  // "Qty" box and the assistant's list_pantry_items keep working unmodified.
  // A person can still hand-edit quantity afterward without corrupting
  // stockCount -- only the scan routes below ever write stockCount.
  stockCount?: number;
  barcode?: string; // permanent barcode -> item link, once resolved by a scan
  lastScannedInAt?: string; // ISO datetime, set only by POST /scan/in -- never by a manual edit
  expirationDate?: string; // YYYY-MM-DD, optional -- not every item is perishable
  calories?: ItemCalories; // set by POST /calories/fill (itemCalories.ts); cleared when the item is renamed
  scope: "joint";
  updatedAt: string;
  updatedBy: string;
}

export const pantryRoutes = express.Router();

// YYYY-MM-DD only, matching the calendar section's date convention -- a
// looser format would make expiring-soon comparisons unreliable.
function isValidDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

// Built field by field, never spread from the request body: putScopedItem reads
// `scope` to decide who owns a row, so a stray "scope":"personal" in a payload
// would quietly hide a pantry item from the other member.
function buildPantryItem(
  userId: string,
  fields: {
    id?: string;
    name: string;
    quantity?: string;
    expirationDate?: string | null;
    barcode?: string;
    stockCount?: number;
    lastScannedInAt?: string;
    calories?: ItemCalories;
  }
): PantryItem {
  return {
    calories: fields.calories,
    id: fields.id || newId("pantry"),
    name: fields.name.trim(),
    quantity: typeof fields.quantity === "string" ? fields.quantity.trim() : "",
    expirationDate: isValidDate(fields.expirationDate) ? fields.expirationDate : undefined,
    barcode: fields.barcode,
    stockCount: fields.stockCount,
    lastScannedInAt: fields.lastScannedInAt,
    scope: "joint",
    updatedAt: new Date().toISOString(),
    updatedBy: userId,
  };
}

function loadItem(req: express.Request, res: express.Response): PantryItem | null {
  const item = getScopedItem("pantry_items", currentUserId(req), req.params.id) as PantryItem | undefined;
  if (!item) {
    res.status(404).json({ error: "Pantry item not found" });
    return null;
  }
  return item;
}

pantryRoutes.get("/", (req, res) => {
  const items = (getScopedItems("pantry_items", currentUserId(req)) as PantryItem[])
    .sort((a, b) => a.name.localeCompare(b.name));
  res.json({ items });
});

// Gives every pantry item without one a calorie figure: barcode data, then a catalogue food of the
// same name, then -- only if the body names a `provider` -- that model's labelled estimate.
pantryRoutes.post("/calories/fill", async (req, res) => {
  const userId = currentUserId(req);
  const items = getScopedItems("pantry_items", userId) as PantryItem[];
  const lacked = new Set(items.filter((i) => !i.calories).map((i) => i.id));
  const outcome = await runFill(req, res, items);
  if (!outcome) return;
  // Only items that gained calories are written back, and only that field changed.
  for (const item of items) if (lacked.has(item.id) && item.calories) putScopedItem("pantry_items", userId, item);
  res.json({ items: items.sort((a, b) => a.name.localeCompare(b.name)), ...outcome });
});

pantryRoutes.post("/", (req, res) => {
  const { name, quantity, expirationDate } = req.body || {};
  if (!name || typeof name !== "string" || !name.trim()) {
    return res.status(400).json({ error: "name is required" });
  }

  const userId = currentUserId(req);
  const item = buildPantryItem(userId, { name, quantity, expirationDate });
  putScopedItem("pantry_items", userId, item);
  res.json({ item });
});

pantryRoutes.put("/:id", (req, res) => {
  const existing = loadItem(req, res);
  if (!existing) return;

  const { name, quantity, expirationDate, barcode } = req.body || {};
  const userId = currentUserId(req);
  const item = buildPantryItem(userId, {
    id: existing.id,
    name: typeof name === "string" && name.trim() ? name : existing.name,
    quantity: typeof quantity === "string" ? quantity : existing.quantity,
    // An explicit "" clears the date; undefined (field omitted) leaves it as-is.
    expirationDate: expirationDate === "" ? null : expirationDate === undefined ? existing.expirationDate : expirationDate,
    // Lets a barcode be attached to an item that was created by hand (e.g. the
    // scan-out "did you mean" suggestion below) -- same "omitted leaves it
    // alone" convention as expirationDate, minus the "" -> clear case, since
    // there's no UI path yet that needs to detach a barcode.
    barcode: typeof barcode === "string" && barcode.trim() ? barcode.trim() : existing.barcode,
    stockCount: existing.stockCount,
    lastScannedInAt: existing.lastScannedInAt,
    // A figure belongs to what the item is called: a renamed item gets filled again.
    calories: existing.name === (typeof name === "string" && name.trim() ? name.trim() : existing.name) ? existing.calories : undefined,
  });

  putScopedItem("pantry_items", userId, item);
  res.json({ item });
});

pantryRoutes.delete("/:id", (req, res) => {
  const deleted = deleteScopedItem("pantry_items", currentUserId(req), req.params.id);
  if (!deleted) return res.status(404).json({ error: "Pantry item not found" });
  res.json({ success: true });
});

// ---- Barcode scan in/out ----------------------------------------------------
//
// A USB/Bluetooth HID scanner or a phone camera resolves to a barcode string;
// these three endpoints are the only things that ever read/write stockCount.
// Resolution order for a barcode not yet linked to a local item: check the
// pantry first (findByBarcode), then Open Food Facts (lookupBarcode), then ask
// the person to type a name -- see barcodeLookup.ts.

function pantryItems(userId: string): PantryItem[] {
  return getScopedItems("pantry_items", userId) as PantryItem[];
}

pantryRoutes.post("/barcode/lookup", async (req, res) => {
  const barcode = String(req.body?.barcode || "").trim();
  if (!barcode) return res.status(400).json({ error: "barcode is required" });

  const existing = findByBarcode(pantryItems(currentUserId(req)), barcode);
  if (existing) return res.json({ found: true, item: existing });

  try {
    const off = await lookupBarcode(barcode);
    res.json({ found: false, suggestion: off?.name ?? null });
  } catch {
    // Open Food Facts unreachable is not the caller's problem to handle
    // differently than "not found" -- either way, the next step is asking
    // the person to type a name.
    res.json({ found: false, suggestion: null });
  }
});

pantryRoutes.post("/scan/in", async (req, res) => {
  const barcode = String(req.body?.barcode || "").trim();
  if (!barcode) return res.status(400).json({ error: "barcode is required" });

  // Optional -- the scan panel shows a date field precisely so an expiration
  // can be logged at the moment of scanning, not hunted down afterward in the
  // list below. Omitted or invalid leaves whatever the item already had alone
  // (same "omitted means unchanged" convention as PUT /:id).
  const expirationDateInput = req.body?.expirationDate;
  const expirationDate = isValidDate(expirationDateInput) ? expirationDateInput : undefined;
  const scannedAt = new Date().toISOString();

  const userId = currentUserId(req);
  const items = pantryItems(userId);
  const existing = findByBarcode(items, barcode);

  if (existing) {
    const stockCount = (existing.stockCount ?? 0) + 1;
    const item: PantryItem = {
      ...existing,
      stockCount,
      quantity: String(stockCount),
      expirationDate: expirationDate ?? existing.expirationDate,
      lastScannedInAt: scannedAt,
      updatedAt: scannedAt,
      updatedBy: userId,
    };
    putScopedItem("pantry_items", userId, item);
    return res.json({ item, resolved: "existing" });
  }

  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  if (!name) {
    const off = await lookupBarcode(barcode).catch(() => null);
    return res.json({ needsName: true, suggestion: off?.name ?? null });
  }

  const item = buildPantryItem(userId, { name, quantity: "1", barcode, stockCount: 1, expirationDate, lastScannedInAt: scannedAt });
  putScopedItem("pantry_items", userId, item);
  res.json({ item, resolved: "created" });
});

pantryRoutes.post("/scan/out", async (req, res) => {
  const barcode = String(req.body?.barcode || "").trim();
  if (!barcode) return res.status(400).json({ error: "barcode is required" });

  const userId = currentUserId(req);
  const items = pantryItems(userId);
  const existing = findByBarcode(items, barcode);

  if (!existing) {
    // Nothing to decrement -- not a 404 (this isn't "GET a resource by id",
    // it's a business-logic outcome the client needs the full body for). Look
    // up a friendly name (best-effort) so the client can suggest attaching
    // this barcode to a close-by pantry item that's tracked manually but not
    // barcode-linked yet, instead of a bare "not found."
    const off = await lookupBarcode(barcode).catch(() => null);
    const closeMatches = off ? closestNames(items, off.name) : [];
    return res.json({
      found: false,
      error: "No pantry item is tracked for that barcode yet.",
      suggestion: off?.name ?? null,
      closeMatches,
    });
  }

  const previousCount = existing.stockCount ?? 0;
  const stockCount = Math.max(0, previousCount - 1);
  const item: PantryItem = { ...existing, stockCount, quantity: String(stockCount), updatedAt: new Date().toISOString(), updatedBy: userId };
  putScopedItem("pantry_items", userId, item);
  // `changed` is false when this was already at 0 -- the clamp made it a
  // no-op. The client needs to know that so it doesn't offer an "undo" that
  // would scan a phantom unit back in.
  res.json({ found: true, item, hitZero: stockCount === 0, changed: stockCount !== previousCount });
});
