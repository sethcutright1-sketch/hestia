// krogerMatch.ts -- which list items go to Kroger, as which product, and how many. Pure rules, so
// these run without a database or a network. The rules are Alex's (2026-10-16).

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  toKrogerUpc,
  pantryInStock,
  planItems,
  codesToLookUp,
  itemsNeedingSearch,
  quantityHint,
  quantityFor,
  finishPreview,
  pickKey,
  pickLabel,
  type KrogerPicks,
} from "../krogerMatch.ts";
import type { KrogerProduct } from "../kroger.ts";
import type { ShoppingItem, ShoppingList } from "../routes/grocery.ts";
import type { PantryItem } from "../routes/pantry.ts";

const MILK_UPC = "0001111041700";

function product(upc: string, over: Partial<KrogerProduct> = {}): KrogerProduct {
  return {
    upc,
    description: `Product ${upc}`,
    brand: "Kroger",
    size: "1 ct",
    price: { regular: 2, promo: null },
    stockLevel: "HIGH",
    curbside: true,
    delivery: true,
    imageUrl: null,
    soldBy: "UNIT",
    pieceWeightLb: null,
    ...over,
  };
}

function item(name: string, over: Partial<ShoppingItem> = {}): ShoppingItem {
  return { id: `item-${name}`, name, quantity: "", category: "Other", notes: "", checked: false, addedBy: "u", ...over };
}

function list(items: ShoppingItem[]): ShoppingList {
  return { id: "list-1", name: "Groceries", scope: "joint", status: "active", items, createdBy: "u", createdAt: "", updatedAt: "" };
}

function pantry(name: string, over: Partial<PantryItem> = {}): PantryItem {
  return { id: `pantry-${name}`, name, quantity: "", scope: "joint", updatedAt: "", updatedBy: "u", ...over } as PantryItem;
}

describe("barcodes to Kroger's 13-digit codes", () => {
  test("UPC-A, as a scanner reads it (Kroger 2% milk)", () => {
    assert.equal(toKrogerUpc("011110417008"), MILK_UPC);
  });

  test("the same product as a GTIN-14 gives the same code", () => {
    assert.equal(toKrogerUpc("00011110417008"), MILK_UPC);
  });

  test("EAN-13 and EAN-8", () => {
    assert.equal(toKrogerUpc("4006381333931"), "0400638133393");
    assert.equal(toKrogerUpc("96385074"), "0000009638507");
  });

  test("an in-store random-weight label (price built into the code) is never a product", () => {
    assert.equal(toKrogerUpc("212345678909"), null);
  });

  test("a wrong check digit, letters, or the wrong length is not a barcode", () => {
    for (const bad of ["011110417009", "01111041700X", "12345", "", "  ", "0111104170080000"]) {
      assert.equal(toKrogerUpc(bad), null, bad);
    }
  });
});

describe("what counts as in the Pantry", () => {
  test("a scanned count wins over the typed quantity", () => {
    assert.equal(pantryInStock(pantry("milk", { stockCount: 2, quantity: "0" })), true);
    assert.equal(pantryInStock(pantry("milk", { stockCount: 0, quantity: "3" })), false);
  });

  test("with no count, any typed quantity except blank or zero", () => {
    assert.equal(pantryInStock(pantry("rice", { quantity: "half a bag" })), true);
    assert.equal(pantryInStock(pantry("rice", { quantity: "1" })), true);
    for (const q of ["", "  ", "0", "00", "0.0"]) assert.equal(pantryInStock(pantry("rice", { quantity: q })), false, JSON.stringify(q));
  });
});

describe("planning the items", () => {
  test("checked and blank items are left out entirely", () => {
    const plans = planItems(list([item("milk", { checked: true }), item("   "), item("eggs")]), [], {});
    assert.deepEqual(plans.map((p) => p.item.name), ["eggs"]);
  });

  test("an in-stock Pantry match skips the item and names it; an empty one doesn't", () => {
    const plans = planItems(
      list([item("white rice"), item("milk")]),
      [pantry("Rice", { quantity: "1 bag" }), pantry("milk", { stockCount: 0 })],
      {}
    );
    assert.deepEqual(plans.map((p) => [p.item.name, p.state, p.pantryName]), [
      ["white rice", "inPantry", "Rice"],
      ["milk", "send", null],
    ]);
  });

  test("Pantry matching is by head noun: rice doesn't cover rice vinegar", () => {
    const [plan] = planItems(list([item("rice vinegar")]), [pantry("rice", { quantity: "1" })], {});
    assert.equal(plan.state, "send");
  });

  test("an item already sent stays sent, even if the Pantry has it now", () => {
    const [plan] = planItems(list([item("milk", { sentToKroger: "2026-10-16T00:00:00.000Z" })]), [pantry("milk", { stockCount: 1 })], {});
    assert.equal(plan.state, "sent");
  });

  test("a remembered pick is found by the item's name, however it's typed", () => {
    const picks: KrogerPicks = { [pickKey("Milk")]: { upc: MILK_UPC, label: "milk", pickedAt: "" } };
    const [plan] = planItems(list([item("  milk ")]), [], picks);
    assert.equal(plan.rememberedUpc, MILK_UPC);
    assert.equal(pickKey("Bananas"), pickKey("banana"));
  });

  test("a scanned Pantry product is offered for the item, from an empty Pantry entry too", () => {
    const plans = planItems(list([item("milk")]), [pantry("milk", { stockCount: 0, barcode: "011110417008" })], {});
    assert.equal(plans[0].scannedUpc, MILK_UPC);
    assert.deepEqual(codesToLookUp(plans), [MILK_UPC]);
  });

  test("a scanned barcode that isn't valid is ignored", () => {
    const [plan] = planItems(list([item("milk")]), [pantry("milk", { stockCount: 0, barcode: "not-a-code" })], {});
    assert.equal(plan.scannedUpc, null);
  });
});

describe("quantities (Kroger's cart counts pieces, even for items sold by weight)", () => {
  const unit = { soldBy: "UNIT" as const, pieceWeightLb: null };
  const bunch = { soldBy: "WEIGHT" as const, pieceWeightLb: 2.1 };

  test("a plain count from the text, for anything sold by the unit", () => {
    const cases: [string, number][] = [
      ["", 1], ["2", 2], ["3 cans", 3], ["2 ct", 2], ["4x", 4], ["1 dozen", 1], ["2 boxes", 2],
      ["2 lb", 1], ["a few", 1], ["1/2", 1], ["0", 1], ["150", 1],
    ];
    for (const [text, expected] of cases) assert.equal(quantityFor(quantityHint(text), unit), expected, text);
  });

  test("a weight in the text becomes pieces at Kroger's weight per piece (the real cart test: 2 lb of bananas is 1 bunch)", () => {
    const cases: [string, number][] = [["2 lb", 1], ["5 lbs", 2], ["7 pounds", 3], ["0.2 lb", 1], ["32 oz", 1], ["2", 2], ["", 1], ["2 bunches", 2]];
    for (const [text, expected] of cases) assert.equal(quantityFor(quantityHint(text), bunch), expected, text);
  });

  test("a weight item with no known piece weight, or no product yet, falls back to the plain count", () => {
    assert.equal(quantityFor(quantityHint("2 lb"), { soldBy: "WEIGHT", pieceWeightLb: null }), 1);
    assert.equal(quantityFor(quantityHint("3"), null), 3);
    assert.equal(quantityFor(quantityHint("2 lb"), null), 1);
  });

  test("the hint keeps both readings of the text", () => {
    assert.deepEqual(quantityHint("2 lb"), { count: 1, pounds: 2 });
    assert.deepEqual(quantityHint("24 oz"), { count: 1, pounds: 1.5 });
    assert.deepEqual(quantityHint("3 cans"), { count: 3, pounds: null });
  });
});

describe("the finished preview", () => {
  const picks: KrogerPicks = { milk: { upc: MILK_UPC, label: "", pickedAt: "" } };

  test("remembered beats scanned; a gone remembered product falls back to the scan, and says so", () => {
    const scanned = "0000000004011";
    const pantryItems = [pantry("milk", { stockCount: 0, barcode: "011110417008" })];
    const plans = planItems(list([item("milk")]), pantryItems, { milk: { upc: "0009999999999", label: "", pickedAt: "" } });
    const preview = finishPreview(plans, new Map([[MILK_UPC, product(MILK_UPC)]]), new Map());
    const [p] = preview.items;
    assert.equal(p.state, "ready");
    assert.equal(p.productSource, "pantryScan");
    assert.equal(p.rememberedUnavailable, true);

    const both = finishPreview(
      planItems(list([item("milk")]), [pantry("milk", { stockCount: 0, barcode: "011110417008" })], picks),
      new Map([[MILK_UPC, product(MILK_UPC)], [scanned, product(scanned)]]),
      new Map()
    );
    assert.equal(both.items[0].productSource, "remembered");
  });

  test("an item with no product needs a choice, and only those carry search results", () => {
    const plans = planItems(list([item("milk"), item("eggs")]), [], picks);
    const products = new Map([[MILK_UPC, product(MILK_UPC)]]);
    assert.deepEqual(itemsNeedingSearch(plans, products).map((p) => p.item.name), ["eggs"]);

    const eggs = [product("0001111060903")];
    const preview = finishPreview(plans, products, new Map([["item-eggs", eggs], ["item-milk", [product("0000000000001")]]]));
    assert.deepEqual(preview.items.map((i) => [i.name, i.state, i.options.length]), [
      ["milk", "ready", 0],
      ["eggs", "choose", 1],
    ]);
  });

  test("Pantry and already-sent items are never searched", () => {
    const plans = planItems(
      list([item("rice"), item("milk", { sentToKroger: "2026-10-16T00:00:00.000Z" })]),
      [pantry("rice", { quantity: "1" })],
      {}
    );
    assert.deepEqual(itemsNeedingSearch(plans, new Map()), []);
  });

  test("the estimate counts ready items only, at the sale price, times quantity", () => {
    const plans = planItems(
      list([item("milk", { quantity: "2" }), item("bananas", { quantity: "5 lb" }), item("bread"), item("eggs"), item("rice")]),
      [pantry("rice", { quantity: "1" })],
      {
        milk: { upc: MILK_UPC, label: "", pickedAt: "" },
        banana: { upc: "0000000004011", label: "", pickedAt: "" },
        bread: { upc: "0000000000002", label: "", pickedAt: "" },
        rice: { upc: "0000000000003", label: "", pickedAt: "" },
      }
    );
    const products = new Map([
      [MILK_UPC, product(MILK_UPC, { price: { regular: 2.89, promo: 2.5 } })],
      ["0000000004011", product("0000000004011", { price: { regular: 0.49, promo: null }, soldBy: "WEIGHT", pieceWeightLb: 2.1 })],
      ["0000000000002", product("0000000000002", { price: null })],
      ["0000000000003", product("0000000000003", { price: { regular: 100, promo: null } })],
    ]);
    const preview = finishPreview(plans, products, new Map());
    assert.deepEqual(preview.items.map((i) => [i.name, i.state, i.quantity]), [
      ["milk", "ready", 2],
      ["bananas", "ready", 2],
      ["bread", "ready", 1],
      ["eggs", "choose", 1],
      ["rice", "inPantry", 1],
    ]);
    // milk 2 x $2.50 + bananas 2 bunches x 2.1 lb x $0.49/lb = 5 + 2.058
    assert.deepEqual(preview.estimate, { total: 7.06, pricedItems: 2, unpricedItems: 1 });
  });

  test("an item still to choose carries its quantity hint, for whichever product gets picked", () => {
    const plans = planItems(list([item("bananas", { quantity: "2 lb" })]), [], {});
    const [p] = finishPreview(plans, new Map(), new Map()).items;
    assert.equal(p.state, "choose");
    assert.deepEqual(p.hint, { count: 1, pounds: 2 });
    assert.equal(quantityFor(p.hint, { soldBy: "WEIGHT", pieceWeightLb: 2.1 }), 1);
  });

  test("a pick's label is Kroger's description and size", () => {
    assert.equal(pickLabel(product(MILK_UPC, { description: "Kroger® 2% Reduced Fat Milk Gallon", size: "1 gal" })), "Kroger® 2% Reduced Fat Milk Gallon, 1 gal");
  });
});
