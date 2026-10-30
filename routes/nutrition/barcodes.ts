// Barcodes: the scan, attaching a code to a food you already have, the offline list, and the
// miss log.
//
//   POST   /barcodes/lookup         { code, format? } a scan: your food with that code, else the
//                                   shared lookup cascade (Open Food Facts -> USDA -> UPCitemdb)
//   GET    /barcodes/misses?limit=  scans that ended without nutrition (the "is a paid database worth it?" list)
//   POST   /foods/:id/barcode       { code, format?, replaceFoodId? } attach a scanned code to a food
//   DELETE /foods/:id/barcode       detach it
//   GET    /foods/barcodes          every barcoded food you can see, for the phone's offline copy
//   GET    /foods/link-candidates   "is this one of your foods?" (q, limit)
//
// What POST /barcodes/lookup answers:
//   200 { created: false, food }     a food you can see already owns the code (no upstream lookup)
//   201 { created: true,  food, lookupHit: true }   nutrition found: made a joint food (source off | fdc)
//   404 { error, gtin14, lookupHit: false, lookup }  no nutrition. A miss is logged and `lookup` carries
//                                    what is known (maybe just a name) so the UI can offer "create food"
//   503 { unavailable: true, ... }   a source was down: "try again", NOT logged as a miss
//   422 { randomWeight: true, ... }  an in-store price/weight label, which identifies a package, not a product
//   400                              not a valid UPC/EAN
// A name-only answer is deliberately NOT a hit (lookupHit in nutrition/lookup.ts).
//
// The same cascade and cache serve Pantry's scanner (barcodeLookup.ts).
//
// Registered before the food routes: "/foods/barcodes" and "/foods/link-candidates" must not be
// read as "/foods/:id".

import express from "express";
import { canonicalGtin, isRandomWeight } from "../../nutrition/barcode.ts";
import { listMisses, recordMiss } from "../../nutrition/data/barcodeMisses.ts";
import { attachBarcode, detachBarcode, findFoodByBarcode, linkCandidates, listBarcodedFoods } from "../../nutrition/data/foodBarcodes.ts";
import { assertCanTrack } from "../../nutrition/data/access.ts";
import { NutritionError } from "../../nutrition/data/errors.ts";
import {
  foodJson, insertFood, type ServingInput,
} from "../../nutrition/data/foods.ts";
import { bodyObject, optString, reqString } from "../../nutrition/data/input.ts";
import { tx } from "../../nutrition/data/sql.ts";
import type { Nutrients } from "../../nutrition/nutrients.ts";
import { InvalidBarcodeError, lookupHit, type Nutrition } from "../../nutrition/lookup.ts";
import { clampInt, h, queryString, type Ctx } from "./common.ts";

// The lookup cascade reports null for nutrients a source didn't list; foods store 0.
const zero = (v: number | null | undefined): number => v ?? 0;
const lookupNutrients = (n: Nutrition): Nutrients => ({
  kcal: zero(n.kcal), protein: zero(n.protein), carbs: zero(n.carbs), fat: zero(n.fat), satFat: zero(n.satFat),
  sugars: zero(n.sugars), fiber: zero(n.fiber), cholesterolMg: 0, sodiumMg: zero(n.sodiumMg),
});

export function barcodeRoutes(ctx: Ctx): express.Router {
  const { db } = ctx;
  const router = express.Router();

  router.post("/barcodes/lookup", h(async (req, res) => {
    const { user } = ctx.who(req);
    assertCanTrack(user);
    const b = bodyObject(req.body);
    const code = reqString(b, "code", 40);
    const format = optString(b, "format", 20) ?? undefined;
    const canon = canonicalGtin(code, format);
    if (!canon) throw new NutritionError(400, "Not a valid UPC/EAN barcode (length or check digit is wrong).");

    // A food you can already use for this barcode wins (your own personal one first); it also saves an upstream lookup.
    const existing = findFoodByBarcode(db, user.id, canon.gtin14);
    if (existing) {
      res.json({ created: false, food: foodJson(db, existing) });
      return;
    }

    // A store-printed price/weight label (deli, produce, meat) identifies one package, not a
    // product: nothing upstream can know it, so don't spend a lookup (or log a "miss") on it.
    if (isRandomWeight(canon.gtin14)) {
      throw new NutritionError(422, "That looks like an in-store price/weight label, not a product barcode.",
        { gtin14: canon.gtin14, randomWeight: true });
    }

    let result;
    try {
      result = await ctx.lookup(code, format);
    } catch (err) {
      if (err instanceof InvalidBarcodeError) throw new NutritionError(400, err.message);
      throw err;
    }

    if (!lookupHit(result)) {
      // A source that was down could have known: that is "try again", not "not found", and it
      // must not count against the databases in the miss log.
      if (result.sourcesErrored.length > 0) {
        throw new NutritionError(503, "Couldn't reach the food databases. Try again in a moment, or enter it by hand.",
          { gtin14: canon.gtin14, unavailable: true, lookupHit: false, lookup: result });
      }
      recordMiss(db, canon.gtin14, { name: result.name, brand: result.brand }, ctx.now());
      // Not enough to build a food, but hand back what we learned so the UI can prefill the custom-food form.
      throw new NutritionError(404, "No nutrition data found for that barcode.", { gtin14: canon.gtin14, lookupHit: false, lookup: result });
    }

    // Open Food Facts reports drink servings in ml and the label says so (the number is stored as grams).
    const unit = result.servingUnit === "ml" ? "ml" : "g";
    const servings: ServingInput[] = result.servingGrams
      ? [
          { label: result.servingText || `${result.servingGrams} ${unit}`, grams: result.servingGrams, isDefault: true },
          { label: `100 ${unit}`, grams: 100, isDefault: false },
        ]
      : [{ label: "100 g", grams: 100, isDefault: true }];
    try {
      const food = tx(db, () =>
        insertFood(db, user.id, {
          name: result.name || `Product ${canon.gtin14}`,
          brand: result.brand,
          gtin14: canon.gtin14,
          basis: "per100g",
          nutrients: lookupNutrients(result.per100g!),
          servings,
          // Joint: the whole household can scan it. Someone's PERSONAL food with the same code does not
          // get in the way (barcodes are unique per scope), so this works even when only a personal food holds it.
          scope: "joint",
          source: result.source as "off" | "fdc",
          sourceRef: canon.gtin14,
        }));
      res.status(201).json({ created: true, lookupHit: true, food: foodJson(db, food) });
    } catch (err) {
      // Two scans of one new product racing: the second finds the first's food.
      const raced = err instanceof NutritionError && err.status === 409 ? findFoodByBarcode(db, user.id, canon.gtin14) : undefined;
      if (!raced) throw err;
      res.json({ created: false, food: foodJson(db, raced) });
    }
  }));

  router.get("/barcodes/misses", h((req, res) => {
    const { user } = ctx.who(req);
    res.json(listMisses(db, user, clampInt(req.query.limit, 100, 1, 500)));
  }));

  router.get("/foods/barcodes", h((req, res) => {
    res.json(listBarcodedFoods(db, ctx.who(req).user));
  }));

  router.get("/foods/link-candidates", h((req, res) => {
    const { user } = ctx.who(req);
    res.json(linkCandidates(db, user, queryString(req, "q"), clampInt(req.query.limit, 5, 1, 10)).map((f) => foodJson(db, f)));
  }));

  router.post("/foods/:id/barcode", h((req, res) => {
    const { user } = ctx.who(req);
    res.json(attachBarcode(db, user, String(req.params.id), req.body));
  }));

  router.delete("/foods/:id/barcode", h((req, res) => {
    const { user } = ctx.who(req);
    res.json(detachBarcode(db, user, String(req.params.id)));
  }));

  return router;
}
