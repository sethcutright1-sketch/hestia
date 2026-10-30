// Turning a grocery list into a Kroger send: which items go, which product each one is, and how
// many. Pure functions -- no database, no network -- so every rule is testable on its own;
// routes/kroger.ts fetches what these ask for and stores what they decide.
//
// Rules (owner, 2026-10-16):
//   - Checked items are left out entirely: they're bought or not needed.
//   - An item whose name matches an IN-STOCK Pantry item is skipped, but listed so it can be ticked
//     back on. In stock = a scanned count above 0, or (no count) a typed quantity that isn't blank
//     or "0". Matching is ingredients.ts's head-noun rule, so "rice" covers "white rice" but not
//     "rice vinegar".
//   - The product: the household's remembered pick for that item name first; otherwise a product
//     the household scanned into the Pantry under a matching name (its exact barcode), pre-selected;
//     otherwise the person chooses from Kroger's search results.
//   - An item already sent to the Kroger cart is listed as sent and left out unless the person
//     says to send it again -- Kroger's cart can't be read or undone.
//   - Quantity: a plain count ("2", "3 cans"). Kroger's cart counts PIECES even for items sold by
//     weight (a real cart test, 2026-10-16: quantity 2 of bananas was 2 bunches, not 2 lb), so
//     "2 lb" of a weight item is divided by Kroger's average weight per piece (bananas 2.1 lb ->
//     1 bunch). Anything else is 1, to adjust on the send screen. quantityFor() is shared with the
//     screen, which recomputes it when a different product is picked.
import { matchesAny, normalizeName } from "./ingredients.ts";
import { canonicalGtin, isRandomWeight } from "./nutrition/barcode.ts";
import type { KrogerProduct } from "./kroger.ts";
import type { ShoppingItem, ShoppingList } from "./routes/grocery.ts";
import type { PantryItem } from "./routes/pantry.ts";

/** A scanned barcode as the 13-digit code Kroger uses: the GTIN without its check digit, zero-padded
 *  (Kroger 2% milk: UPC-A 011110417008 becomes 0001111041700). Built on nutrition/barcode.ts, so an
 *  8-digit code is read as EAN-8 -- a UPC-E scan, which looks the same, simply gets no suggestion.
 *  Null for anything that isn't a valid GTIN, and for an in-store random-weight label (deli, meat),
 *  whose code carries that package's price rather than naming a product. */
export function toKrogerUpc(barcode: string): string | null {
  const gtin = canonicalGtin(String(barcode || "").trim());
  if (!gtin || isRandomWeight(gtin.gtin14)) return null;
  return gtin.gtin14.slice(0, 13);
}

export interface KrogerPick {
  upc: string;
  /** Kroger's description and size when it was picked, e.g. "Kroger® 2% Reduced Fat Milk Gallon, 1 gal". */
  label: string;
  pickedAt: string;
}

/** app_config `grocery.krogerPicks`: normalised list-item name -> the household's chosen product. */
export type KrogerPicks = Record<string, KrogerPick>;

export type PreviewState = "ready" | "choose" | "inPantry" | "sent";

export interface PreviewItem {
  itemId: string;
  name: string;
  quantityText: string;
  /** Suggested cart quantity (pieces) for `product`: quantityFor(hint, product). */
  quantity: number;
  /** What the item's quantity text says, for quantityFor() when another product is picked. */
  hint: QuantityHint;
  /** ready: has a product and will be sent. choose: needs the person to pick a product.
   *  inPantry: skipped because the Pantry has it. sent: already in the Kroger cart. */
  state: PreviewState;
  product: KrogerProduct | null;
  productSource: "remembered" | "pantryScan" | null;
  /** The remembered product isn't carried at the store any more (or Kroger couldn't find it). */
  rememberedUnavailable: boolean;
  /** Kroger's search results, for an item still to choose. */
  options: KrogerProduct[];
  pantryName: string | null;
  sentAt: string | null;
}

export interface Preview {
  items: PreviewItem[];
  /** Over the "ready" items only, at promo prices where Kroger has one; weight items at their
   *  average weight per piece, so it's an estimate like Kroger's own "about $2.06". */
  estimate: { total: number; pricedItems: number; unpricedItems: number };
}

/** What has to be fetched from Kroger for one item before the preview can be finished. */
export interface ItemPlan {
  item: ShoppingItem;
  state: "send" | "inPantry" | "sent";
  pantryName: string | null;
  rememberedUpc: string | null;
  scannedUpc: string | null;
}

export function pickKey(itemName: string): string {
  return normalizeName(itemName).replace(/\s+/g, " ");
}

/** In stock: a scanned count above 0; with no count, a typed quantity other than blank or "0". */
export function pantryInStock(item: PantryItem): boolean {
  if (typeof item.stockCount === "number") return item.stockCount > 0;
  const qty = String(item.quantity ?? "").trim();
  return qty !== "" && !/^0+(\.0+)?$/.test(qty);
}

/** The Pantry items whose name covers this list item, in-stock ones first. */
function pantryMatches(itemName: string, pantry: PantryItem[]): PantryItem[] {
  const matches = pantry.filter((p) => matchesAny(itemName, [p.name]));
  return [...matches.filter(pantryInStock), ...matches.filter((p) => !pantryInStock(p))];
}

/** Step 1: decide each unchecked item's state and which product codes to look up. */
export function planItems(list: ShoppingList, pantry: PantryItem[], picks: KrogerPicks): ItemPlan[] {
  return list.items
    .filter((item) => !item.checked && item.name.trim())
    .map((item) => {
      const matches = pantryMatches(item.name, pantry);
      const inStock = matches.find(pantryInStock) ?? null;
      const scanned = matches.map((p) => (p.barcode ? toKrogerUpc(p.barcode) : null)).find((u): u is string => !!u) ?? null;
      return {
        item,
        state: item.sentToKroger ? "sent" : inStock ? "inPantry" : "send",
        pantryName: inStock?.name ?? null,
        rememberedUpc: picks[pickKey(item.name)]?.upc ?? null,
        scannedUpc: scanned,
      };
    });
}

/** Product codes step 2 must look up live: every remembered and scanned code. */
export function codesToLookUp(plans: ItemPlan[]): string[] {
  return [...new Set(plans.flatMap((p) => [p.rememberedUpc, p.scannedUpc]).filter((u): u is string => !!u))];
}

/** Items that will need Kroger's search results: being sent, with no usable product found. */
export function itemsNeedingSearch(plans: ItemPlan[], products: Map<string, KrogerProduct>): ItemPlan[] {
  return plans.filter((p) => p.state === "send" && !resolveProduct(p, products).product);
}

function resolveProduct(plan: ItemPlan, products: Map<string, KrogerProduct>) {
  const remembered = plan.rememberedUpc ? products.get(plan.rememberedUpc) ?? null : null;
  if (remembered) return { product: remembered, source: "remembered" as const, rememberedUnavailable: false };
  const scanned = plan.scannedUpc ? products.get(plan.scannedUpc) ?? null : null;
  return {
    product: scanned,
    source: scanned ? ("pantryScan" as const) : null,
    rememberedUnavailable: !!plan.rememberedUpc,
  };
}

const UNIT_WORDS = "x|ct|count|each|ea|pk|packs?|packages?|cans?|bags?|boxes?|bottles?|jars?|cartons?|bunch(?:es)?|heads?|loaf|loaves|dozen";

export interface QuantityHint {
  /** A plain count from the text ("2", "3 cans"), else 1. "1 dozen" is one carton: the product carries the size. */
  count: number;
  /** Pounds, when the text gives a weight ("2 lb", "1.5 pounds", "24 oz"); else null. */
  pounds: number | null;
}

export function quantityHint(quantityText: string): QuantityHint {
  const text = String(quantityText || "").trim().toLowerCase();
  const count = text.match(new RegExp(`^(\\d{1,2})\\s*(?:${UNIT_WORDS})?\\.?$`));
  const lb = text.match(/^(\d{1,3}(?:\.\d+)?)\s*(?:lb|lbs|pounds?)\.?$/);
  const oz = text.match(/^(\d{1,3}(?:\.\d+)?)\s*(?:oz|ounces?)\.?$/);
  return {
    count: count ? Math.min(99, Math.max(1, Number(count[1]))) : 1,
    pounds: lb ? Number(lb[1]) : oz ? Number(oz[1]) / 16 : null,
  };
}

/** The cart quantity, in pieces, for a product. A weight given in the text is turned into pieces
 *  by Kroger's weight per piece, rounded, at least 1; otherwise the plain count. */
export function quantityFor(hint: QuantityHint, product: Pick<KrogerProduct, "soldBy" | "pieceWeightLb"> | null): number {
  if (product?.soldBy === "WEIGHT" && hint.pounds !== null && product.pieceWeightLb) {
    return Math.min(99, Math.max(1, Math.round(hint.pounds / product.pieceWeightLb)));
  }
  return hint.count;
}

/** Step 3: the finished preview, from step 1's plans and what Kroger returned. */
export function finishPreview(
  plans: ItemPlan[],
  products: Map<string, KrogerProduct>,
  searchResults: Map<string, KrogerProduct[]>
): Preview {
  const items: PreviewItem[] = plans.map((plan) => {
    const { product, source, rememberedUnavailable } = resolveProduct(plan, products);
    const state: PreviewState = plan.state === "send" ? (product ? "ready" : "choose") : plan.state;
    const hint = quantityHint(plan.item.quantity);
    return {
      itemId: plan.item.id,
      name: plan.item.name,
      quantityText: plan.item.quantity,
      quantity: quantityFor(hint, product),
      hint,
      state,
      product,
      productSource: source,
      rememberedUnavailable,
      options: state === "choose" ? searchResults.get(plan.item.id) ?? [] : [],
      pantryName: plan.pantryName,
      sentAt: plan.item.sentToKroger ?? null,
    };
  });

  return { items, estimate: estimateFor(items.filter((i) => i.state === "ready")) };
}

/** What a set of picks should cost, at sale prices where Kroger has one. Shared with the send screen,
 *  which recomputes it as products and quantities change. */
export function estimateFor(lines: { product: KrogerProduct | null; quantity: number }[]): Preview["estimate"] {
  let total = 0;
  let pricedItems = 0;
  let unpricedItems = 0;
  for (const { product, quantity } of lines) {
    const price = product?.price;
    if (!price) {
      unpricedItems++;
      continue;
    }
    // A weight item's price is per pound and its quantity is pieces: a 2.1 lb bunch at $0.49/lb.
    const perPiece = product.soldBy === "WEIGHT" && product.pieceWeightLb ? product.pieceWeightLb : 1;
    total += (price.promo ?? price.regular) * perPiece * quantity;
    pricedItems++;
  }
  return { total: Math.round(total * 100) / 100, pricedItems, unpricedItems };
}

/** The label a remembered pick is stored with. */
export function pickLabel(product: KrogerProduct): string {
  return [product.description, product.size].filter(Boolean).join(", ").slice(0, 200);
}
