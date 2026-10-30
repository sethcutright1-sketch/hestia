// Pantry tools -- the smallest domain module, good starting point for how the
// assistant reaches app data. See ./README.md for the full contract every
// module follows, and note what this file *doesn't* do: no HTTP call, no
// import from routes/pantry.ts. It calls the exact same db.ts functions the
// route does, directly, because it runs inside the same server process --
// the tool loop (assistant/registry.ts -> a provider in assistant/providers/)
// calls `tool.run(args)` as a plain function call, not a network request. The
// assistant reading/writing pantry data and a person clicking around
// Pantry.tsx are two front ends on the same data layer, not two systems that
// happen to agree.

import type { DomainTool, ToolModule } from "../registry.ts";
import { getScopedItems, putScopedItem, deleteScopedItem, newId } from "../../db.ts";
import type { PantryItem } from "../../routes/pantry.ts";
import { findByName, suggestNames, notFound } from "./shared.ts";

function pantryTools(userId: string): DomainTool[] {
  const items = () => getScopedItems("pantry_items", userId) as PantryItem[];

  return [
    {
      name: "list_pantry_items",
      description:
        "What the household currently has in the pantry, with quantities and expiration dates " +
        "(expirationDate is omitted for items with none on file). stockCount is the exact count " +
        "for items tracked by barcode scan-in/scan-out; omitted for items only ever added by hand.",
      parameters: { type: "object", properties: {} },
      run: async () =>
        items().map((i) => ({
          name: i.name,
          quantity: i.quantity,
          ...(i.expirationDate ? { expirationDate: i.expirationDate } : {}),
          ...(typeof i.stockCount === "number" ? { stockCount: i.stockCount } : {}),
        })),
    },

    {
      name: "add_pantry_item",
      mutates: true,
      description:
        "Record that the household has an item in stock. If that item is already in the " +
        "pantry this updates its quantity/expiration instead of adding a duplicate.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: 'The item, e.g. "rice".' },
          quantity: { type: "string", description: 'How much is on hand, e.g. "2 boxes". Optional.' },
          expirationDate: {
            type: "string",
            description: "When it expires, as YYYY-MM-DD. Optional -- leave unset if unknown or not perishable.",
          },
        },
        required: ["name"],
      },
      run: async ({ name, quantity, expirationDate }) => {
        // Exact name only: "flour" is not "Almond flour", and a substring hit here would overwrite the wrong item's
        // quantity and date instead of adding the one asked for.
        const existing = findByName(items(), name, { exact: true });
        const item: PantryItem = {
          id: existing?.id || newId("pantry"),
          name: existing?.name || String(name).trim(),
          quantity: typeof quantity === "string" ? quantity.trim() : existing?.quantity || "",
          expirationDate:
            typeof expirationDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(expirationDate)
              ? expirationDate
              : existing?.expirationDate,
          scope: "joint",
          updatedAt: new Date().toISOString(),
          updatedBy: userId,
        };
        putScopedItem("pantry_items", userId, item);
        return {
          name: item.name,
          quantity: item.quantity,
          expirationDate: item.expirationDate,
          action: existing ? "updated" : "added",
        };
      },
    },

    {
      name: "remove_pantry_item",
      mutates: true,
      description: "Record that the household has run out of an item.",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "The item to remove." } },
        required: ["name"],
      },
      run: async ({ name }) => {
        const all = items();
        // Deleting: exact name only, never the first item that merely contains it. A miss lists the near names so the
        // model can ask which one was meant.
        const found = findByName(all, name, { exact: true });
        if (!found) return notFound("item in the pantry", name, suggestNames(all, name));
        deleteScopedItem("pantry_items", userId, found.id);
        return { removed: found.name };
      },
    },
  ];
}

export const pantryModule: ToolModule = {
  domain: "pantry",
  sensitivity: "household",
  label: "the pantry",
  build: pantryTools,
};
