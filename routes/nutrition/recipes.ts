// Recipe calories. The recipe book itself is household-app's (/api/mealplan/recipes: typed, pasted,
// uploaded, imported from a link, listed in GET /api/mealplan); these routes add calories on top of
// the same documents and live under /api/nutrition because they need a food diary login (the kiosk
// is refused, and a login that PIN-locks its food diary gets the PIN prompt here too).
//
//   GET  /recipes                  the recipes you can see, each with its calories (or none yet)
//   POST /recipes                  { name, items: [{ foodId, quantity | servingId | grams }], scope?, yieldServings? }
//                                  a NEW recipe from foods that were eaten ("Save as recipe" in the diary): one linked line
//                                  per item, calories added up, joint unless scope is "personal" (default yield 1) -> 201
//   GET  /recipes/:id              one recipe: lines (with what each adds), yield, calories, food id
//   PUT  /recipes/:id              { name?, yieldServings?, servingLabel?, totalCookedG? (null clears),
//                                  sourceUrl?, scope?, lines?, instructions? (steps, or text with one step per
//                                  line; null or [] clears them), tags?, prepMinutes?, cookMinutes?, notes? }
//                                  (the same fields PATCH /api/mealplan/recipes/:id takes, which needs no diary login) -> the calories are re-added and the
//                                  recipe's read-only food rewritten
//   POST /recipes/:id/parse        how each line reads: quantity, unit, ingredient (regex first, the local
//                                  model for lines it can't read). Writes nothing.
//   POST /recipes/:id/match        candidate foods for each line, best first, with the amount each
//                                  would be. Writes nothing.
//   POST /recipes/:id/links        { links: [{ index, foodId, quantity? | servingId? | grams? } | { index, clear: true }] }
//                                  save confirmed links, then re-add
//   POST /recipes/recalculate-all  link every recipe's clear matches (no model, nothing estimated) -> { recipes, before, after, improved }
//   POST /recipes/:id/calculate    { autoLink? (default true), estimate? (default false), reestimate?, yieldServings? }
//                                  link clear matches, optionally estimate the rest with the local model, save.
//                                  -> { recipe, report }
//
// Deleting a recipe is DELETE /api/mealplan/recipes/:id (it also soft-deletes the recipe's food).
// Every route answers with the detail shape of GET /recipes/:id.

import express from "express";
import { NutritionError } from "../../nutrition/data/errors.ts";
import { bodyObject, optNumber } from "../../nutrition/data/input.ts";
import {
  applyRecipePatch, calculateFromLines, createRecipeFromItems, linesOf, listRecipeDocs, parseDocLines, parseLinesInput, proposeMatches,
  recalculateAllRecipes, recipeDetailJson, requireRecipe, saveRecipe,
} from "../../nutrition/data/recipes.ts";
import type { Line, RecipeDoc } from "../../nutrition/recipeModel.ts";
import { h, type Ctx } from "./common.ts";

export function recipeRoutes(ctx: Ctx): express.Router {
  const { db } = ctx;
  const router = express.Router();

  const summary = (d: RecipeDoc, userId: string) => ({
    id: d.id,
    name: d.name,
    scope: d.scope,
    mine: d.createdBy === userId,
    yieldServings: d.yieldServings ?? null,
    kcalPerServing: d.nutrition ? Math.round(d.nutrition.perServing.kcal * 100) / 100 : null,
    nutrition: d.nutrition ?? null,
    foodId: d.foodId ?? null,
    lineCount: d.lines?.length ?? 0,
  });

  router.get("/recipes", h((req, res) => {
    const { user } = ctx.who(req);
    res.json(listRecipeDocs(db, user.id).map((d) => summary(d, user.id)));
  }));

  router.post("/recipes", h((req, res) => {
    const { user } = ctx.who(req);
    const doc = createRecipeFromItems(db, user, req.body);
    res.status(201).json(recipeDetailJson(db, user.id, requireRecipe(db, user.id, doc.id)));
  }));

  // Link every recipe's clear matches in one go (no model, nothing guessed): { recipes, before, after, improved } counts
  // of recipes whose calories were missing or partly estimated before and after.
  router.post("/recipes/recalculate-all", h(async (req, res) => {
    const { user } = ctx.who(req);
    res.json(await recalculateAllRecipes(db, user.id));
  }));

  router.get("/recipes/:id", h((req, res) => {
    const { user } = ctx.who(req);
    res.json(recipeDetailJson(db, user.id, requireRecipe(db, user.id, req.params.id)));
  }));

  router.put("/recipes/:id", h((req, res) => {
    const { user } = ctx.who(req);
    const rec = requireRecipe(db, user.id, req.params.id);
    const { doc } = applyRecipePatch(db, user.id, rec, bodyObject(req.body), "full");
    saveRecipe(db, user.id, doc);
    res.json(recipeDetailJson(db, user.id, requireRecipe(db, user.id, doc.id)));
  }));

  router.post("/recipes/:id/parse", h(async (req, res) => {
    const { user } = ctx.who(req);
    const rec = requireRecipe(db, user.id, req.params.id);
    const lines = linesOf(rec.doc);
    const { parsed, modelError } = await parseDocLines(lines, ctx.recipeModel());
    res.json({
      lines: parsed.map((p, index) => ({
        index, text: p.text, quantity: p.quantity, unit: p.unit, ingredient: p.name, negligible: p.negligible, via: p.via,
      })),
      ...(modelError ? { modelError } : {}),
    });
  }));

  router.post("/recipes/:id/match", h(async (req, res) => {
    const { user } = ctx.who(req);
    const rec = requireRecipe(db, user.id, req.params.id);
    const { proposals, modelError } = await proposeMatches(db, user.id, rec.doc, ctx.recipeModel(), ctx.now().getTime());
    res.json({ lines: proposals, ...(modelError ? { modelError } : {}) });
  }));

  router.post("/recipes/:id/links", h((req, res) => {
    const { user } = ctx.who(req);
    const rec = requireRecipe(db, user.id, req.params.id);
    const b = bodyObject(req.body);
    if (!Array.isArray(b.links) || b.links.length === 0) throw new NutritionError(400, "links must be a non-empty list.");
    const current = linesOf(rec.doc);
    const raw: Array<Record<string, unknown>> = current.map((l) => ({ ...l }));
    for (const [i, link] of (b.links as unknown[]).entries()) {
      if (!link || typeof link !== "object" || Array.isArray(link)) throw new NutritionError(400, `links[${i}] must be an object.`);
      const l = link as Record<string, unknown>;
      const index = l.index;
      if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= current.length) {
        throw new NutritionError(400, `links[${i}].index must be the position of a line (0 to ${current.length - 1}).`);
      }
      const base: Line = current[index];
      if (l.clear === true) {
        raw[index] = { text: base.text, pantryName: base.pantryName };
        continue;
      }
      const { index: _i, clear: _c, ...fields } = l;
      raw[index] = { text: base.text, pantryName: base.pantryName, ...fields };
    }
    const next: RecipeDoc = { ...rec.doc, lines: parseLinesInput(db, user.id, raw, current), updatedAt: new Date().toISOString() };
    saveRecipe(db, user.id, next);
    res.json(recipeDetailJson(db, user.id, requireRecipe(db, user.id, next.id)));
  }));

  router.post("/recipes/:id/calculate", h(async (req, res) => {
    const { user } = ctx.who(req);
    const rec = requireRecipe(db, user.id, req.params.id);
    const b = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? bodyObject(req.body) : {};
    if (b.yieldServings !== undefined) {
      const y = optNumber(b, "yieldServings", 0.01, 1000);
      if (y !== null) {
        const { yieldAssumed: _a, ...rest } = rec.doc;
        saveRecipe(db, user.id, { ...rest, yieldServings: y, updatedAt: new Date().toISOString() });
      }
    }
    const { recipe, report } = await calculateFromLines(db, user.id, rec.doc.id, {
      autoLink: b.autoLink !== false,
      estimate: b.estimate === true,
      reestimate: b.reestimate === true,
      model: ctx.recipeModel(),
      now: ctx.now().getTime(),
    });
    res.json({ recipe: recipeDetailJson(db, user.id, requireRecipe(db, user.id, recipe.id)), report });
  }));

  return router;
}
