import express from "express";
import { getScopedItems, getScopedItem, putScopedItem, deleteScopedItem, newId } from "../db.ts";
import { currentUserId } from "../auth.ts";
import type { ItemCalories } from "../itemCalories.ts";
import { runFill } from "./itemCaloriesFill.ts";

export interface ShoppingItem {
  id: string;
  name: string;
  quantity: string;
  category: string;
  notes: string;
  checked: boolean;
  addedBy: string;
  /** When this item was last added to the household's Kroger cart (routes/kroger.ts). Kroger's cart
   *  can't be read or undone, so this is what stops the same item being sent twice by accident. */
  sentToKroger?: string;
  /** Set by POST /lists/:id/calories/fill (itemCalories.ts); cleared when the item is renamed. */
  calories?: ItemCalories;
}

export interface ShoppingList {
  id: string;
  name: string;
  scope: "joint" | "personal";
  status: "active" | "archived";
  items: ShoppingItem[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export const groceryRoutes = express.Router();

// Shared so the meal-plan route and the assistant's tools add items through the
// same defaults this route uses -- a forgotten `checked: false` in one of four
// copies is the kind of drift that only shows up as a mystery later.
export function newShoppingItem(userId: string, name: string, quantity = ""): ShoppingItem {
  return {
    id: newId("item"),
    name: String(name).trim(),
    quantity: String(quantity || "").trim(),
    category: "Other",
    notes: "",
    checked: false,
    addedBy: userId,
  };
}

function touch(list: ShoppingList): ShoppingList {
  list.updatedAt = new Date().toISOString();
  return list;
}

// Reads the list only if it's joint or belongs to this user; anything else is a
// 404 rather than a 403, so one member can't probe for the other's personal lists.
function loadList(req: express.Request, res: express.Response): ShoppingList | null {
  const list = getScopedItem("shopping_lists", currentUserId(req), req.params.id) as ShoppingList | undefined;
  if (!list) {
    res.status(404).json({ error: "List not found" });
    return null;
  }
  return list;
}

groceryRoutes.get("/lists", (req, res) => {
  const lists = getScopedItems("shopping_lists", currentUserId(req)) as ShoppingList[];
  lists.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  res.json({ lists });
});

groceryRoutes.post("/lists", (req, res) => {
  const userId = currentUserId(req);
  const { name, scope } = req.body || {};
  if (!name || typeof name !== "string") {
    return res.status(400).json({ error: "name is required" });
  }

  const now = new Date().toISOString();
  const list: ShoppingList = {
    id: newId("list"),
    name: name.trim(),
    scope: scope === "personal" ? "personal" : "joint",
    status: "active",
    items: [],
    createdBy: userId,
    createdAt: now,
    updatedAt: now,
  };
  putScopedItem("shopping_lists", userId, list);
  res.json({ list });
});

groceryRoutes.get("/lists/:id", (req, res) => {
  const list = loadList(req, res);
  if (list) res.json({ list });
});

groceryRoutes.put("/lists/:id", (req, res) => {
  const list = loadList(req, res);
  if (!list) return;

  const { name, scope, status } = req.body || {};
  if (typeof name === "string" && name.trim()) list.name = name.trim();
  if (scope === "personal" || scope === "joint") list.scope = scope;
  if (status === "active" || status === "archived") list.status = status;

  putScopedItem("shopping_lists", currentUserId(req), touch(list));
  res.json({ list });
});

groceryRoutes.delete("/lists/:id", (req, res) => {
  const deleted = deleteScopedItem("shopping_lists", currentUserId(req), req.params.id);
  if (deleted) deleteScopedItem("kroger_drafts", currentUserId(req), req.params.id);
  if (!deleted) return res.status(404).json({ error: "List not found" });
  res.json({ success: true });
});

groceryRoutes.post("/lists/:id/items", (req, res) => {
  const list = loadList(req, res);
  if (!list) return;

  const { name, quantity, category, notes } = req.body || {};
  if (!name || typeof name !== "string") {
    return res.status(400).json({ error: "name is required" });
  }

  const item: ShoppingItem = {
    id: newId("item"),
    name: name.trim(),
    quantity: typeof quantity === "string" ? quantity.trim() : "",
    category: typeof category === "string" ? category.trim() : "Other",
    notes: typeof notes === "string" ? notes.trim() : "",
    checked: false,
    addedBy: currentUserId(req),
  };
  list.items.push(item);

  putScopedItem("shopping_lists", currentUserId(req), touch(list));
  res.json({ list, item });
});

groceryRoutes.put("/lists/:id/items/:itemId", (req, res) => {
  const list = loadList(req, res);
  if (!list) return;

  const item = list.items.find((i) => i.id === req.params.itemId);
  if (!item) return res.status(404).json({ error: "Item not found" });

  const { name, quantity, category, notes, checked } = req.body || {};
  if (typeof name === "string" && name.trim()) {
    // A figure belongs to what the item is called: a renamed item gets filled again.
    if (item.name !== name.trim()) delete item.calories;
    item.name = name.trim();
  }
  if (typeof quantity === "string") item.quantity = quantity.trim();
  if (typeof category === "string") item.category = category.trim();
  if (typeof notes === "string") item.notes = notes.trim();
  if (typeof checked === "boolean") item.checked = checked;

  putScopedItem("shopping_lists", currentUserId(req), touch(list));
  res.json({ list, item });
});

// Gives every item on this list without one a calorie figure: a catalogue food of the same name,
// then -- only if the body names a `provider` -- that model's labelled estimate (itemCalories.ts).
groceryRoutes.post("/lists/:id/calories/fill", async (req, res) => {
  const list = loadList(req, res);
  if (!list) return;
  const outcome = await runFill(req, res, list.items);
  if (!outcome) return;
  putScopedItem("shopping_lists", currentUserId(req), list);
  res.json({ list, ...outcome });
});

groceryRoutes.delete("/lists/:id/items", (req, res) => {
  const list = loadList(req, res);
  if (!list) return;

  list.items = [];

  putScopedItem("shopping_lists", currentUserId(req), touch(list));
  res.json({ list });
});

groceryRoutes.delete("/lists/:id/items/:itemId", (req, res) => {
  const list = loadList(req, res);
  if (!list) return;

  const before = list.items.length;
  list.items = list.items.filter((i) => i.id !== req.params.itemId);
  if (list.items.length === before) {
    return res.status(404).json({ error: "Item not found" });
  }

  putScopedItem("shopping_lists", currentUserId(req), touch(list));
  res.json({ list });
});
