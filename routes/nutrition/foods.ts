// Foods: search, recent, create, read, edit, delete. A food's servings travel inside it (create
// takes `servings`, PATCH replaces them, keeping the id of any serving whose label is unchanged).
//
//   GET    /foods/search?q=&limit=    your foods and joint ones first, then the USDA catalogue
//   GET    /foods/recent?limit=       what you actually ate in the last 60 days
//   POST   /foods                     { name, basis, nutrients, servings?, brand?, gtin14?, scope? }
//   GET    /foods/:id    PATCH /foods/:id    DELETE /foods/:id (soft)
//
// A recipe's food (source "recipe") is read-only here: PATCH and DELETE answer 409 "edit the recipe
// instead". It is changed through the recipe (routes/nutrition/recipes.ts).
//
// `scope` is "joint" (every login sees it) or "personal" (only you); the read-only USDA catalogue
// reports "generic". Registered AFTER the barcode routes, which own /foods/barcodes and
// /foods/link-candidates, so those are not read as /foods/:id.

import express from "express";
import {
  createFood, deleteFood, foodJson, requireVisibleFood, recentFoods, searchFoods, updateFood,
} from "../../nutrition/data/foods.ts";
import { refreshRecipesUsingFood } from "../../nutrition/data/recipes.ts";
import { tx } from "../../nutrition/data/sql.ts";
import { clampInt, h, queryString, type Ctx } from "./common.ts";

export function foodRoutes(ctx: Ctx): express.Router {
  const { db } = ctx;
  const router = express.Router();

  router.get("/foods/search", h((req, res) => {
    const { user } = ctx.who(req);
    const limit = clampInt(req.query.limit, 25, 1, 100);
    res.json(searchFoods(db, user.id, queryString(req, "q"), limit, ctx.now().getTime()).map((f) => foodJson(db, f)));
  }));

  router.get("/foods/recent", h((req, res) => {
    const { user, today } = ctx.who(req);
    res.json(recentFoods(db, user, today, clampInt(req.query.limit, 20, 1, 100)).map((f) => foodJson(db, f)));
  }));

  router.post("/foods", h((req, res) => {
    const { user } = ctx.who(req);
    res.status(201).json(foodJson(db, createFood(db, user, req.body)));
  }));

  router.get("/foods/:id", h((req, res) => {
    const { user } = ctx.who(req);
    res.json(foodJson(db, requireVisibleFood(db, user.id, req.params.id)));
  }));

  router.patch("/foods/:id", h((req, res) => {
    const { user } = ctx.who(req);
    // Recipes that use this food are re-added in the same transaction, so their calories stay true.
    const food = tx(db, () => {
      const updated = updateFood(db, user, String(req.params.id), req.body);
      refreshRecipesUsingFood(db, updated.id);
      return updated;
    });
    res.json(foodJson(db, food));
  }));

  router.delete("/foods/:id", h((req, res) => {
    const { user } = ctx.who(req);
    deleteFood(db, user, String(req.params.id));
    res.json({ ok: true });
  }));

  return router;
}
