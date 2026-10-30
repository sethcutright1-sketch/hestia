// Shopping-list tools. See ./README.md for the contract every domain module follows.

import type { DomainTool, ToolContext, ToolModule } from "../registry.ts";
import { getScopedItems, putScopedItem, newId } from "../../db.ts";
import { type ShoppingList } from "../../routes/grocery.ts";
import { findByName, closestNames, suggestNames, notFound } from "./shared.ts";
import { gateBulkDelete } from "../confirmations.ts";

function groceryTools(userId: string, _unlocked = true, ctx: ToolContext = {}): DomainTool[] {
  const activeLists = () =>
    (getScopedItems("shopping_lists", userId) as ShoppingList[]).filter((l) => l.status === "active");

  return [
    {
      name: "list_shopping_lists",
      description: "The household's active shopping lists, with how many items each has.",
      parameters: { type: "object", properties: {} },
      run: async () =>
        activeLists().map((l) => ({
          name: l.name,
          scope: l.scope,
          totalItems: l.items.length,
          remaining: l.items.filter((i) => !i.checked).length,
        })),
    },

    {
      name: "get_shopping_list",
      description: "The items on one shopping list. Use the list's name.",
      parameters: {
        type: "object",
        properties: { list: { type: "string", description: "Name of the list, e.g. \"Weekly Groceries\"." } },
        required: ["list"],
      },
      run: async ({ list }) => {
        const lists = activeLists();
        const found = findByName(lists, list);
        if (!found) return notFound("shopping list", list, closestNames(lists, list));
        return {
          name: found.name,
          items: found.items.map((i) => ({
            name: i.name,
            quantity: i.quantity,
            category: i.category,
            checked: i.checked,
          })),
        };
      },
    },

    {
      name: "create_shopping_list",
      mutates: true,
      description: "Start a new shopping list.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "What to call the list." },
          scope: { type: "string", description: '"joint" (both members) or "personal". Defaults to joint.' },
        },
        required: ["name"],
      },
      run: async ({ name, scope }) => {
        const now = new Date().toISOString();
        const list: ShoppingList = {
          id: newId("list"),
          name: String(name).trim(),
          scope: scope === "personal" ? "personal" : "joint",
          status: "active",
          items: [],
          createdBy: userId,
          createdAt: now,
          updatedAt: now,
        };
        putScopedItem("shopping_lists", userId, list);
        return { created: list.name, scope: list.scope };
      },
    },

    {
      name: "add_shopping_item",
      mutates: true,
      description: "Add an item to a shopping list.",
      parameters: {
        type: "object",
        properties: {
          list: { type: "string", description: "Name of the list to add to." },
          name: { type: "string", description: "The item, e.g. \"milk\"." },
          quantity: { type: "string", description: 'Amount, e.g. "2 gal". Optional.' },
          category: { type: "string", description: 'Aisle, e.g. "Dairy". Optional.' },
        },
        required: ["list", "name"],
      },
      run: async ({ list, name, quantity, category }) => {
        const lists = activeLists();
        // Exact list name: a partial one ("Groceries") would otherwise drop the item on the first list containing it.
        const found = findByName(lists, list, { exact: true });
        if (!found) return notFound("shopping list", list, suggestNames(lists, list));

        found.items.push({
          id: newId("item"),
          name: String(name).trim(),
          quantity: typeof quantity === "string" ? quantity.trim() : "",
          category: typeof category === "string" ? category.trim() : "Other",
          notes: "",
          checked: false,
          addedBy: userId,
        });
        found.updatedAt = new Date().toISOString();
        putScopedItem("shopping_lists", userId, found);
        return { added: name, to: found.name, totalItems: found.items.length };
      },
    },

    {
      name: "remove_shopping_item",
      mutates: true,
      description:
        "Remove one item from one shopping list, e.g. \"take milk off the weekly groceries list\". Both the list name and " +
        "the item name must match exactly. It only ever changes that one list: it never touches other lists, chores, the " +
        "calendar or the pantry. To empty a whole list use clear_shopping_list instead.",
      parameters: {
        type: "object",
        properties: {
          list: { type: "string", description: "Exact name of the list to remove the item from, e.g. \"Costco Run\"." },
          item: { type: "string", description: "Exact name of the item to remove, e.g. \"milk\"." },
        },
        required: ["list", "item"],
      },
      run: async ({ list, item }) => {
        const lists = activeLists();
        // Exact on both names: a partial one must never remove the first thing that happens to contain it (the same rule
        // as add_shopping_item and the pantry writes). A miss goes back with the real names so the model can ask or retry.
        const found = findByName(lists, list, { exact: true });
        if (!found) return notFound("shopping list", list, suggestNames(lists, list));
        const target = findByName(found.items, item, { exact: true });
        if (!target) return notFound(`item on the "${found.name}" list`, item, suggestNames(found.items, item));

        // Same as the Grocery screen: every row has its own id, and the delete button removes only the row you pressed. So
        // a name that appears twice loses ONE row here, and the result says how many are left so the model can tell the
        // person (or call again to take the others off) instead of silently removing duplicates they may have wanted.
        found.items = found.items.filter((i) => i.id !== target.id);
        const needle = target.name.toLowerCase();
        const sameNameLeft = found.items.filter((i) => i.name.toLowerCase() === needle).length;
        found.updatedAt = new Date().toISOString();
        putScopedItem("shopping_lists", userId, found);
        return {
          removed: target.name,
          from: found.name,
          remainingItems: found.items.length,
          ...(sameNameLeft > 0
            ? { note: `${sameNameLeft} more item${sameNameLeft === 1 ? "" : "s"} called "${target.name}" ${sameNameLeft === 1 ? "is" : "are"} still on this list; only one was removed.` }
            : {}),
        };
      },
    },

    {
      name: "clear_shopping_list",
      mutates: true,
      description:
        "Remove EVERY item from one shopping list, e.g. \"get rid of everything on the costco list\". The list itself stays, " +
        "just empty. It never touches other lists, chores, the calendar or the pantry. To remove a single item use " +
        "remove_shopping_item. This is a bulk delete: the first call deletes nothing and returns a confirmation to ask the " +
        "person about. Pass that confirmation back only after they say yes in their next message.",
      parameters: {
        type: "object",
        properties: {
          list: { type: "string", description: "Exact name of the list to empty, e.g. \"Costco Run\"." },
          confirmation: {
            type: "string",
            description: "The confirmation returned by the first call. Only pass it after the person has said yes in a new message.",
          },
        },
        required: ["list"],
      },
      run: async ({ list, confirmation }) => {
        const lists = activeLists();
        const found = findByName(lists, list, { exact: true });
        if (!found) return notFound("shopping list", list, suggestNames(lists, list));
        if (found.items.length === 0) return { cleared: found.name, removedCount: 0, note: "The list was already empty." };

        const names = found.items.map((i) => i.name);
        const shown = names.slice(0, 8).join(", ") + (names.length > 8 ? `, and ${names.length - 8} more` : "");
        // Keyed on the list's id (not the typed name) and its current item ids, so the token cannot be spent on another
        // list, or on this one after its contents changed.
        const gate = gateBulkDelete({
          userId,
          tool: "clear_shopping_list",
          args: { list: found.id },
          scopeIds: found.items.map((i) => i.id),
          summary: `This will remove all ${names.length} item${names.length === 1 ? "" : "s"} from the shopping list "${found.name}" (${shown}). The list itself stays.`,
          ctx,
          confirmation,
        });
        if (gate) return gate;

        found.items = [];
        found.updatedAt = new Date().toISOString();
        putScopedItem("shopping_lists", userId, found);
        return { cleared: found.name, removedCount: names.length, remainingItems: 0 };
      },
    },
  ];
}

export const groceryModule: ToolModule = {
  domain: "grocery",
  sensitivity: "household",
  label: "shopping lists",
  promptRules: [
    "To take one thing off a shopping list use remove_shopping_item; it only touches that list. To empty a whole list use " +
      "clear_shopping_list -- never delete chores or calendar events to \"clear a list\". clear_shopping_list is a bulk " +
      "delete: its first call deletes nothing and returns a confirmation. Tell the person exactly what would be removed and " +
      "wait for their yes in a separate message; never pass the confirmation in the same reply you asked for it.",
  ],
  build: groceryTools,
};
