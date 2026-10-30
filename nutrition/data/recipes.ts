// Recipes with calories: the part that touches the database.
//
// There is ONE recipe book: household-app's `recipes` table (item_id, owner_user_id, data), whose
// JSON documents the meal plan, shopping list, pantry matching and the assistant already read.
// nutrition/recipeModel.ts defines the optional fields added on top (lines, yield, nutrition...);
// this file reads and writes those documents with the same ownership rules db.ts's scoped items
// use (owner_user_id NULL = joint, a user id = personal, nobody writes another person's row), and
// keeps the recipe's materialized FOOD in step.
//
// Why these functions take a Db handle instead of calling db.ts's getScopedItems: nutrition/data
// can't import db.ts (db.ts imports the nutrition schema at boot), and tests run it against a
// private database. In the app, routes pass db.ts's one handle, so a document written here is
// exactly what getScopedItems("recipes") reads.
//
// THE FOOD. A recipe with nutrition is also a row in nutrition_foods (source 'recipe', recipe_id):
//   - per_serving; nutrients are ONE serving; one serving row "1 <servingLabel>"
//   - when the cook weighed the finished dish (totalCookedG) that one serving carries
//     grams = totalCookedG / yieldServings. A second gram-sized serving row would be wrong: for a
//     per_serving food the diary scales by `quantity` whichever serving row is named, so putting the
//     weight on the single serving lets "150 g of a 300 g serving" be 0.5 servings through the
//     ordinary serving math
//   - it follows the recipe's scope (joint recipe = joint food; personal = the recipe's owner)
//   - read-only through the food routes (foods.ts assertFoodEditable answers 409)
//   - rewritten whenever the recipe's lines, yield or name change; soft-deleted when the recipe is
//     deleted or loses all its calories. Past diary entries are snapshots and are never touched.
// A recipe is not allowed to be an ingredient of another (a food with source 'recipe' is refused as
// a line's food): sub-recipes are left for later.

import crypto from "node:crypto";
import { round2, type Nutrients } from "../nutrients.ts";
import {
  DEFAULT_SERVING_LABEL, DEFAULT_YIELD, MAX_LINES, UNIT_TABLE, buildNutrition, calculateNutrition, cleanInstructions, cleanMinutes,
  cleanNotes, cleanTags, hasWordAmount, ingredientsOfLines, isNegligible, linesFromNames, matchConfidence, parseIngredientLine,
  pantryNameOf, pickConfident, resolveAmount, sameLineMeaning, siteFiguresOf, type CandidateLike, type Line, type MatchConfidence,
  type ParsedLine, type RecipeDoc, type RecipeScope, type ResolvedAmount, type SiteFigures,
} from "../recipeModel.ts";
import { MAX_ESTIMATE_KCAL, type RecipeModel } from "../recipeAi.ts";
import { assertCanTrack, type Tracker } from "./access.ts";
import { computeFromFood } from "./diary.ts";
import { NutritionError } from "./errors.ts";
import { getFood, requireVisibleFood, searchFoods, servingsOf, foodScope, type FoodRow } from "./foods.ts";
import { camelKeys, optNumber, optString, reqString } from "./input.ts";
import { computeStored } from "./mealItems.ts";
import { syncPlannedMeals } from "./recipePlanSync.ts";
import { assertShareable } from "./savedMeals.ts";
import { all, get, run, tx, type Db } from "./sql.ts";

// ---- reading and writing the documents ------------------------------------------------------

interface RecipeRowRaw {
  item_id: string;
  owner_user_id: string | null;
  data: string;
}

export interface RecipeRecord {
  doc: RecipeDoc;
  ownerUserId: string | null;
}

const toRecord = (r: RecipeRowRaw): RecipeRecord => ({ doc: JSON.parse(r.data) as RecipeDoc, ownerUserId: r.owner_user_id });

export function getRecipeRecord(db: Db, id: string): RecipeRecord | undefined {
  const row = get<RecipeRowRaw>(db, "SELECT item_id, owner_user_id, data FROM recipes WHERE item_id = ?", id);
  return row ? toRecord(row) : undefined;
}

export const canSeeRecipe = (r: RecipeRecord, userId: string): boolean => r.ownerUserId === null || r.ownerUserId === userId;

/** Every recipe `userId` can see (joint ones and their own personal ones), by name. */
export function listRecipeDocs(db: Db, userId: string): RecipeDoc[] {
  return all<RecipeRowRaw>(db, "SELECT item_id, owner_user_id, data FROM recipes WHERE owner_user_id IS NULL OR owner_user_id = ?", userId)
    .map((r) => toRecord(r).doc)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** 404 unless the recipe exists and `userId` may see it. */
export function requireRecipe(db: Db, userId: string, id: unknown): RecipeRecord {
  const rec = getRecipeRecord(db, String(id));
  if (!rec || !canSeeRecipe(rec, userId)) throw new NutritionError(404, "Recipe not found.");
  return rec;
}

// ---- amounts and recomputation --------------------------------------------------------------

/** What a linked line adds, or null when its food is gone or the amount no longer fits it. */
export function lineNutrients(db: Db, line: Line): Nutrients | null {
  if (!line.foodId) return null;
  const food = getFood(db, line.foodId);
  if (!food) return null;
  if (line.quantity === undefined && line.grams === undefined) return null;
  try {
    return computeStored(db, food, { quantity: line.quantity ?? 1, serving_id: line.servingId ?? null, grams: line.grams ?? null }).nutrients;
  } catch {
    return null;
  }
}

export const yieldOf = (doc: Pick<RecipeDoc, "yieldServings">): number => doc.yieldServings ?? DEFAULT_YIELD;

/** Re-add the recipe from its lines and the foods' CURRENT values. A recipe without lines keeps its nutrition as it is. */
export function recomputeNutrition(db: Db, doc: RecipeDoc): RecipeDoc {
  if (!doc.lines) return doc;
  const calc = calculateNutrition(doc.lines, yieldOf(doc), (line) => lineNutrients(db, line));
  const nutrition = buildNutrition(calc, siteFiguresOf(doc.nutrition));
  const next = { ...doc };
  if (nutrition) next.nutrition = nutrition;
  else delete next.nutrition;
  return next;
}

// ---- the recipe's food ----------------------------------------------------------------------

function servingFor(doc: RecipeDoc): { label: string; grams: number | null } {
  const y = yieldOf(doc);
  return { label: `1 ${doc.servingLabel || DEFAULT_SERVING_LABEL}`, grams: doc.totalCookedG && y > 0 ? round2(doc.totalCookedG / y) : null };
}

/** The live food for a recipe, whether or not the document remembers its id. */
function foodOfRecipe(db: Db, doc: RecipeDoc): FoodRow | undefined {
  return (
    get<FoodRow>(db, "SELECT * FROM nutrition_foods WHERE recipe_id = ? ORDER BY deleted_at IS NOT NULL, created_at DESC", doc.id) ??
    (doc.foodId ? getFood(db, doc.foodId) : undefined)
  );
}

/** The recipe's live food (what a plan meal's diary entries point at), or undefined while it has no calories. */
export function liveRecipeFood(db: Db, recipeId: string): FoodRow | undefined {
  return get<FoodRow>(db, "SELECT * FROM nutrition_foods WHERE recipe_id = ? AND deleted_at IS NULL", recipeId);
}

/**
 * Make the recipe's food match the recipe. Returns the food id (or undefined when the recipe has no
 * calories and never had a food). Caller owns the transaction.
 */
export function syncRecipeFood(db: Db, doc: RecipeDoc, ownerUserId: string | null): string | undefined {
  const food = foodOfRecipe(db, doc);
  const now = new Date().toISOString();
  if (!doc.nutrition) {
    // No calories (any more): the food leaves search, but keeps its id in case calories come back.
    if (food && !food.deleted_at) run(db, "UPDATE nutrition_foods SET deleted_at = ? WHERE id = ?", now, food.id);
    return food?.id;
  }
  const s = servingFor(doc);
  const nutrients = JSON.stringify(doc.nutrition.perServing);
  const owner = doc.scope === "personal" ? ownerUserId : null;
  if (!food) {
    const id = crypto.randomUUID();
    run(db,
      `INSERT INTO nutrition_foods (id, owner_user_id, created_by_user_id, name, brand, gtin14, basis, nutrients, source, source_ref, created_at, recipe_id)
       VALUES (?, ?, ?, ?, NULL, NULL, 'per_serving', ?, 'recipe', NULL, ?, ?)`,
      id, owner, doc.createdBy, doc.name, nutrients, now, doc.id);
    run(db, "INSERT INTO nutrition_food_servings (id, food_id, label, grams, is_default) VALUES (?, ?, ?, ?, 1)", crypto.randomUUID(), id, s.label, s.grams);
    return id;
  }
  run(db, "UPDATE nutrition_foods SET name = ?, owner_user_id = ?, nutrients = ?, deleted_at = NULL WHERE id = ?", doc.name, owner, nutrients, food.id);
  // Updated in place so the serving's id stays valid for saved meals.
  const row = servingsOf(db, food.id)[0];
  if (row) run(db, "UPDATE nutrition_food_servings SET label = ?, grams = ? WHERE id = ?", s.label, s.grams, row.id);
  else run(db, "INSERT INTO nutrition_food_servings (id, food_id, label, grams, is_default) VALUES (?, ?, ?, ?, 1)", crypto.randomUUID(), food.id, s.label, s.grams);
  return food.id;
}

// ---- saving ---------------------------------------------------------------------------------

/** A joint recipe is read by both logins, so it may not newly name a personal food (a link it already had is left alone). */
export function assertRecipeShareable(db: Db, doc: RecipeDoc, previous?: RecipeDoc): void {
  if (doc.scope !== "joint") return;
  // Links count as "already had" only if the recipe was already joint: sharing a personal recipe is
  // exactly when its personal foods would start to leak.
  const had = new Set(previous?.scope === "joint" ? (previous.lines ?? []).map((l) => l.foodId).filter(Boolean) : []);
  for (const l of doc.lines ?? []) {
    if (!l.foodId || had.has(l.foodId)) continue;
    const food = getFood(db, l.foodId);
    if (food) assertShareable(food, "this recipe");
  }
}

/**
 * Write a recipe document and everything that follows from it: `ingredients` derived from the lines,
 * the calories re-added, the recipe's food rewritten. `userId` is who is saving: a personal recipe is
 * theirs, and a row that belongs to someone else is never overwritten (403). Returns the stored document.
 */
export function saveRecipe(db: Db, userId: string, input: RecipeDoc): RecipeDoc {
  return tx(db, () => {
    const prior = getRecipeRecord(db, input.id);
    if (prior && !canSeeRecipe(prior, userId)) throw new NutritionError(403, "That recipe belongs to someone else.");
    let doc: RecipeDoc = { ...input };
    if (doc.lines) {
      doc.lines = doc.lines.slice(0, MAX_LINES);
      doc.ingredients = ingredientsOfLines(doc.lines);
    }
    // The one place steps are capped (60 steps, 2000 characters each), so no route can store more.
    if (doc.instructions) {
      doc.instructions = cleanInstructions(doc.instructions);
      if (doc.instructions.length === 0) delete doc.instructions;
    }
    // Tags, times and notes are cleaned here too, for the same reason: no route can store them uncapped.
    if (doc.tags) {
      doc.tags = cleanTags(doc.tags);
      if (doc.tags.length === 0) delete doc.tags;
    }
    for (const k of ["prepMinutes", "cookMinutes"] as const) {
      const m = cleanMinutes(doc[k]);
      if (m === undefined) delete doc[k];
      else doc[k] = m;
    }
    if (doc.notes !== undefined) {
      const n = cleanNotes(doc.notes);
      if (n === undefined) delete doc.notes;
      else doc.notes = n;
    }
    assertRecipeShareable(db, doc, prior?.doc);
    doc = recomputeNutrition(db, doc);

    const owner = doc.scope === "personal" ? userId : null;
    // Same guard as db.ts putScopedItemAs: the update only lands on a joint row or the saver's own.
    const write = (d: RecipeDoc) =>
      run(db,
        `INSERT INTO recipes (item_id, owner_user_id, data) VALUES (?, ?, ?)
         ON CONFLICT(item_id) DO UPDATE SET owner_user_id = excluded.owner_user_id, data = excluded.data
         WHERE recipes.owner_user_id IS NULL OR recipes.owner_user_id = ?`,
        d.id, owner, JSON.stringify(d), userId).changes;
    if (Number(write(doc)) === 0) throw new NutritionError(403, "That recipe belongs to someone else.");

    const foodId = syncRecipeFood(db, doc, owner);
    if (foodId !== doc.foodId) {
      doc = foodId ? { ...doc, foodId } : (({ foodId: _drop, ...rest }) => rest)(doc);
      write(doc);
    }
    // A rename or an ingredient change reaches the meals planned from this recipe (this week and later).
    syncPlannedMeals(db, doc, prior?.doc);
    return doc;
  });
}

export const newRecipeId = (): string => `recipe-${crypto.randomBytes(8).toString("hex")}`;

export interface RecipeInput {
  name: string;
  /** Ingredient names or lines as typed; used when `lines` isn't given. */
  ingredients: string[];
  /** Lines as an importer read them (original text + pantry name). */
  lines?: Array<{ text: string; pantryName: string }>;
  scope?: RecipeScope;
  yieldServings?: number;
  sourceUrl?: string;
  /** How to make it. Left out = keep what the recipe has; an empty list clears it. */
  instructions?: string[];
  /** Labels to ADD to the recipe's tags (never replaces them: the assistant and an import must not wipe a person's own). */
  tags?: string[];
  /** The page's own calories per serving. */
  site?: SiteFigures;
  /** Only look for an existing recipe among the joint ones (the assistant works for the shared plan). */
  jointOnly?: boolean;
}

const sameName = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();
const sameSet = (a: string[], b: string[]): boolean => {
  const norm = (xs: string[]) => [...new Set(xs.map((x) => x.trim().toLowerCase()))].sort().join("\n");
  return norm(a) === norm(b);
};
const LINK_FIELDS = ["foodId", "quantity", "servingId", "grams", "estimated", "estimatedKcal"] as const;

/**
 * Save one recipe, replacing any existing one with the same name (typing a recipe in, importing it and
 * the assistant saving it all end up in one row). What an existing recipe has that the new input
 * doesn't mention is kept: its yield, its source, and the food links on lines that are unchanged. If the
 * ingredient list is the same as before, nothing about the lines changes at all.
 */
export function upsertRecipeByName(db: Db, userId: string, input: RecipeInput): RecipeDoc {
  const visible = listRecipeDocs(db, userId).filter((r) => !input.jointOnly || r.scope === "joint");
  const existing = visible.find((r) => sameName(r.name, input.name));
  const now = new Date().toISOString();

  const wanted: Line[] = input.lines
    ? input.lines.map((l) => ({ text: l.text, pantryName: l.pantryName }))
    : linesFromNames(input.ingredients);
  let lines: Line[] | undefined;
  if (existing && !input.lines && sameSet(existing.ingredients, wanted.map((l) => l.pantryName))) {
    lines = existing.lines; // the same ingredients again: nothing to rewrite (a legacy recipe stays legacy)
  } else {
    const old = existing?.lines ?? [];
    lines = wanted.map((l) => {
      const prior = old.find((o) => sameName(o.text, l.text));
      return prior ? { ...l, ...pick(prior, LINK_FIELDS) } : l;
    });
  }

  let scope: RecipeScope = existing?.scope ?? "joint";
  if (input.scope && input.scope !== scope && (!existing || existing.createdBy === userId)) scope = input.scope;

  const doc: RecipeDoc = {
    ...(existing ?? {}),
    id: existing?.id ?? newRecipeId(),
    name: existing?.name ?? input.name.trim(),
    ingredients: existing && lines === existing.lines ? existing.ingredients : wanted.map((l) => l.pantryName),
    scope,
    createdBy: existing?.createdBy ?? userId,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  if (lines) doc.lines = lines;
  if (input.yieldServings !== undefined) {
    doc.yieldServings = input.yieldServings;
    delete doc.yieldAssumed;
  }
  if (input.sourceUrl) doc.sourceUrl = input.sourceUrl;
  if (input.tags && input.tags.length > 0) doc.tags = cleanTags([...(existing?.tags ?? []), ...input.tags]);
  if (input.instructions) {
    if (input.instructions.length > 0) doc.instructions = input.instructions;
    else delete doc.instructions;
  }
  if (input.site) {
    // The site's figure stands alone until something is calculated; after that it sits beside it.
    doc.nutrition = !doc.nutrition || doc.nutrition.origin === "site"
      ? { perServing: input.site.nutrients, siteKcalPerServing: input.site.kcal, origin: "site", complete: true }
      : { ...doc.nutrition, siteKcalPerServing: input.site.kcal };
  }
  return saveRecipe(db, userId, doc);
}

// ---- editing: the fields a person can change ------------------------------------------------

const cleanSourceUrl = (v: string): string => {
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new NutritionError(400, "sourceUrl must be a web address.");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new NutritionError(400, "sourceUrl must be an http or https address.");
  return u.toString();
};

/**
 * Lines for an edit that sends TEXT: `[{ text, from? }]`, where `from` is the position of the line this one replaces.
 * A calorie link survives only when the line still means the same thing (same amount and unit, same food apart from a
 * typo: sameLineMeaning); otherwise the new line starts unlinked, and `relink` counts how many links were dropped so the
 * screen can say so. With no `from`, a line is matched to an old one with the same text, else it is new.
 */
export function reconcileLines(raw: unknown, previous: Line[]): { lines: Line[]; relink: number } {
  if (!Array.isArray(raw)) throw new NutritionError(400, "lines must be a list.");
  if (raw.length > MAX_LINES) throw new NutritionError(400, `A recipe can have at most ${MAX_LINES} lines.`);
  const used = new Set<number>();
  let relink = 0;
  const lines = raw.map((entry, i): Line => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new NutritionError(400, `lines[${i}] must be an object.`);
    const b = camelKeys(entry);
    const text = reqString(b, "text", 300);
    let at = -1;
    if (typeof b.from === "number" && Number.isInteger(b.from) && b.from >= 0 && b.from < previous.length && !used.has(b.from)) at = b.from;
    else if (b.from === undefined || b.from === null) at = previous.findIndex((o, k) => !used.has(k) && sameName(o.text, text));
    const old = at >= 0 ? previous[at] : undefined;
    if (at >= 0) used.add(at);
    if (!old) return { text, pantryName: pantryNameOf(text) };
    const same = sameName(old.text, text);
    const line: Line = { text, pantryName: same ? old.pantryName : pantryNameOf(text) };
    const hadCalories = old.foodId !== undefined || old.estimated === true;
    if (same || sameLineMeaning(old.text, text)) Object.assign(line, pick(old, LINK_FIELDS));
    else if (hadCalories) relink++;
    return line;
  });
  return { lines, relink };
}

/**
 * The one place a recipe's editable fields are read from a request body (the calorie routes' PUT and the meal plan's
 * PATCH both use it): name, yield, serving label, cooked weight, source link, steps, scope, tags, times, notes, lines.
 * Everything is optional and left alone when absent; a bad value is a 400. `linesAs` says what `lines` holds: "full"
 * is line objects with their links (the calorie editor), "text" is `[{ text, from? }]` (reconcileLines).
 */
export function applyRecipePatch(
  db: Db, userId: string, rec: RecipeRecord, b: Record<string, unknown>, linesAs: "full" | "text",
): { doc: RecipeDoc; relink: number } {
  const next: RecipeDoc = { ...rec.doc };
  let relink = 0;

  if (b.name !== undefined) {
    if (typeof b.name !== "string" || !b.name.trim() || b.name.length > 120) throw new NutritionError(400, "name must be 1 to 120 characters.");
    const name = b.name.trim();
    if (!sameName(name, rec.doc.name) && listRecipeDocs(db, userId).some((r) => r.id !== rec.doc.id && sameName(r.name, name))) {
      throw new NutritionError(409, `You already have a recipe called "${name}". Pick another name.`);
    }
    next.name = name;
  }
  if (b.yieldServings !== undefined) {
    next.yieldServings = optNumber(b, "yieldServings", 0.01, 1000) ?? undefined;
    delete next.yieldAssumed;
    if (next.yieldServings === undefined) delete next.yieldServings;
  }
  if (b.servingLabel !== undefined) next.servingLabel = optString(b, "servingLabel", 40) ?? DEFAULT_SERVING_LABEL;
  if (b.totalCookedG !== undefined) {
    const g = optNumber(b, "totalCookedG", 0.01, 100_000);
    if (g === null) delete next.totalCookedG;
    else next.totalCookedG = g;
  }
  if (b.sourceUrl !== undefined) {
    const u = optString(b, "sourceUrl", 500);
    if (u === null) delete next.sourceUrl;
    else next.sourceUrl = cleanSourceUrl(u);
  }
  if (b.instructions !== undefined) {
    if (b.instructions !== null && typeof b.instructions !== "string" && !Array.isArray(b.instructions)) {
      throw new NutritionError(400, "instructions must be a list of steps, text, or null.");
    }
    const steps = cleanInstructions(b.instructions);
    if (steps.length > 0) next.instructions = steps;
    else delete next.instructions;
  }
  if (b.tags !== undefined) {
    if (b.tags !== null && typeof b.tags !== "string" && !Array.isArray(b.tags)) throw new NutritionError(400, "tags must be a list, text, or null.");
    const tags = cleanTags(b.tags);
    if (tags.length > 0) next.tags = tags;
    else delete next.tags;
  }
  for (const k of ["prepMinutes", "cookMinutes"] as const) {
    if (b[k] === undefined) continue;
    const m = cleanMinutes(b[k]);
    if (m === undefined && b[k] !== null && b[k] !== "" && b[k] !== 0) throw new NutritionError(400, `${k} must be a whole number of minutes from 1 to 1440, or null.`);
    if (m === undefined) delete next[k];
    else next[k] = m;
  }
  if (b.notes !== undefined) {
    if (b.notes !== null && typeof b.notes !== "string") throw new NutritionError(400, "notes must be text or null.");
    const n = cleanNotes(b.notes);
    if (n === undefined) delete next.notes;
    else next.notes = n;
  }
  if (b.scope !== undefined) {
    if (b.scope !== "joint" && b.scope !== "personal") throw new NutritionError(400, "scope must be joint or personal.");
    if (b.scope !== next.scope && next.createdBy !== userId) {
      throw new NutritionError(403, "Only the person who added a recipe can change who it's shared with.");
    }
    next.scope = b.scope;
  }
  if (b.lines !== undefined) {
    if (linesAs === "full") next.lines = parseLinesInput(db, userId, b.lines, linesOf(rec.doc));
    else {
      const out = reconcileLines(b.lines, linesOf(rec.doc));
      next.lines = out.lines;
      relink = out.relink;
      if (next.lines.length === 0) delete next.nutrition;
    }
  }
  next.updatedAt = new Date().toISOString();
  return { doc: next, relink };
}

/** A name nobody else has: "Tacos (copy)", then "Tacos (copy 2)"... */
function uniqueCopyName(db: Db, userId: string, name: string): string {
  const taken = (n: string) => listRecipeDocs(db, userId).some((r) => sameName(r.name, n));
  const base = `${name.slice(0, 110)} (copy)`;
  if (!taken(base)) return base;
  for (let i = 2; i < 100; i++) {
    const n = `${name.slice(0, 106)} (copy ${i})`;
    if (!taken(n)) return n;
  }
  return `${base} ${crypto.randomBytes(2).toString("hex")}`;
}

/**
 * A copy of a recipe for whoever asks: new id and name, same scope, lines, links, steps and tags, no food of its own yet
 * (saving makes it one) and no photo (routes copy it). Marks (favourite, rating) are per person and never copied.
 */
export function duplicateRecipeDoc(db: Db, userId: string, id: string): RecipeDoc {
  const rec = requireRecipe(db, userId, id);
  const now = new Date().toISOString();
  const { foodId: _food, photoAt: _photo, ...rest } = rec.doc;
  return saveRecipe(db, userId, {
    ...rest,
    id: newRecipeId(),
    name: uniqueCopyName(db, userId, rec.doc.name),
    createdBy: userId,
    createdAt: now,
    updatedAt: now,
  });
}

export interface DishInput {
  name: string;
  /** Ingredient names or lines as written ("200 g chicken breast", "olive oil"). */
  ingredients: string[];
  yieldServings?: number;
  /** How to make it (the assistant may give steps when it saves a dish). */
  instructions?: string[];
  /** Labels to add to the dish's tags. */
  tags?: string[];
}

/**
 * The assistant's "save this dish" path, and everything else that invents a dish (a meal typed into the plan by
 * name): a JOINT recipe saved as lines, then its calories worked out -- foods linked where the match is
 * clearly right, the local model's estimate for the rest, flagged as an estimate. Updates a joint recipe of
 * the same name. Saving never fails because the calorie step did: the failure comes back as `note`.
 * Nothing is estimated when `model` is null (the local model is off); the recipe then says it is incomplete.
 */
export async function saveDishAsRecipe(
  db: Db, userId: string, dish: DishInput, model: RecipeModel | null,
): Promise<{ recipe: RecipeDoc; note?: string }> {
  let recipe = upsertRecipeByName(db, userId, { name: dish.name, ingredients: dish.ingredients, yieldServings: dish.yieldServings, instructions: dish.instructions, tags: dish.tags, jointOnly: true });
  let note: string | undefined;
  if (!recipe.nutrition || !recipe.nutrition.complete) {
    try {
      const out = await calculateFromLines(db, userId, recipe.id, { autoLink: true, estimate: true, model });
      recipe = out.recipe;
      if (!model) note = "The local model is off, so only exact food matches were counted.";
      else if (out.report.modelError) note = `The local model couldn't be used (${out.report.modelError}), so some ingredients have no calories yet.`;
    } catch (err) {
      note = `Calories couldn't be worked out: ${(err as Error).message}`;
    }
  }
  return { recipe, note };
}

/**
 * The joint recipe a planned meal named `dish.name` should point at (merge plan decision 2). A joint recipe of
 * that name that already has ingredients is used AS IT IS -- a plan that says "Tacos" must not rewrite the
 * family's real tacos recipe from a model's guess at its ingredients. Otherwise the dish is saved (and its
 * calories worked out) by saveDishAsRecipe, the path save_recipe takes.
 */
export async function ensureJointRecipe(
  db: Db, userId: string, dish: DishInput, model: RecipeModel | null,
): Promise<{ recipe: RecipeDoc; created: boolean; note?: string }> {
  const existing = listRecipeDocs(db, userId).find((r) => r.scope !== "personal" && sameName(r.name, dish.name));
  if (existing && (existing.ingredients.length > 0 || dish.ingredients.length === 0)) return { recipe: existing, created: false };
  const saved = await saveDishAsRecipe(db, userId, dish, model);
  return { recipe: saved.recipe, created: !existing, note: saved.note };
}

// ---- a recipe from a meal that was eaten ("Save as recipe" in the diary) -----------------------------------

/**
 * The line text for a food eaten in a given amount, written the way a recipe line is ("150 g Greek yogurt",
 * "2 slice Bread") so the line reader understands it again if someone unlinks the line. A serving label that
 * starts with a count ("1 cup", "1 slice") gives that count back to the number; a plain "serving" reads "1 Lasagna".
 */
export function lineTextForAmount(foodName: string, quantity: number, unit: string): string {
  const q = round2(quantity);
  if (unit === "g") return `${q} g ${foodName}`;
  const label = unit.trim().replace(/^[\d./\s¼½¾⅓⅔]+(?=[a-zA-Z])/, "");
  if (!label || /^servings?$/i.test(label)) return q === 1 ? foodName : `${q} servings ${foodName}`;
  return `${q} ${label} ${foodName}`;
}

/**
 * Make a NEW recipe whose lines are food amounts that were actually eaten, each linked to its food, so it has
 * calculated calories straight away. Body: { name, items: [{ foodId, quantity | servingId | grams }], scope? (default
 * "joint", the household's recipe book), yieldServings? (default 1: the meal as eaten is one serving) }.
 *
 *   - It never replaces a recipe: a recipe with that name that you can already see is a 409.
 *   - A joint recipe may only name foods both logins can see. A meal holding a personal food is refused with a
 *     message that says so, unless the caller asks for scope "personal" (then it is theirs alone, and can't go on
 *     the shared meal plan).
 *   - A recipe's own food can't be a line of another recipe yet; such a meal is refused, naming the food.
 *   - The line's pantry name is the food's name, so the pantry and shopping list can still match it.
 * Returns the stored document.
 */
export function createRecipeFromItems(db: Db, user: Tracker, input: unknown): RecipeDoc {
  assertCanTrack(user);
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new NutritionError(400, "Send a JSON object.");
  const b = camelKeys(input);
  const name = reqString(b, "name", 120);
  const scope = b.scope === undefined || b.scope === "joint" ? "joint" : b.scope === "personal" ? "personal" : null;
  if (!scope) throw new NutritionError(400, "scope must be joint or personal.");
  const yieldServings = optNumber(b, "yieldServings", 0.01, 1000) ?? 1;
  const items = b.items;
  if (!Array.isArray(items) || items.length === 0) throw new NutritionError(400, "items must be a non-empty list of foods.");
  if (items.length > MAX_LINES) throw new NutritionError(400, `A recipe can have at most ${MAX_LINES} lines.`);

  return tx(db, () => {
    if (listRecipeDocs(db, user.id).some((r) => sameName(r.name, name))) {
      throw new NutritionError(409, `You already have a recipe called "${name}". Pick another name.`);
    }
    const raw = items.map((entry, i) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new NutritionError(400, `items[${i}] must be an object.`);
      const it = camelKeys(entry);
      if (typeof it.foodId !== "string" || !it.foodId) throw new NutritionError(400, `items[${i}].foodId is required.`);
      const food = requireVisibleFood(db, user.id, it.foodId);
      if (food.source === "recipe") {
        throw new NutritionError(400, `"${food.name}" is itself a recipe. A recipe can't be an ingredient of another yet, so this meal can't be saved as a recipe.`);
      }
      const c = computeFromFood(db, food, it);
      const line: Record<string, unknown> = { text: lineTextForAmount(food.name, c.servingId === null ? c.grams ?? c.quantity : c.quantity, c.servingId === null ? "g" : c.unit), pantryName: food.name, foodId: food.id };
      if (c.servingId === null) line.grams = c.grams ?? c.quantity;
      else {
        line.quantity = c.quantity;
        line.servingId = c.servingId;
      }
      return line;
    });
    const lines = parseLinesInput(db, user.id, raw);
    const now = new Date().toISOString();
    return saveRecipe(db, user.id, {
      id: newRecipeId(), name, ingredients: [], scope, createdBy: user.id, createdAt: now, updatedAt: now, lines, yieldServings,
    });
  });
}

/** Delete a recipe (db.ts's rule: not someone else's personal one) and soft-delete its food. True if it existed. */
export function deleteRecipeDoc(db: Db, userId: string, id: string): boolean {
  return tx(db, () => {
    const gone = run(db, "DELETE FROM recipes WHERE item_id = ? AND (owner_user_id IS NULL OR owner_user_id = ?)", id, userId).changes;
    if (Number(gone) === 0) return false;
    run(db, "UPDATE nutrition_foods SET deleted_at = ? WHERE recipe_id = ? AND deleted_at IS NULL", new Date().toISOString(), id);
    // Its photo and everyone's stars and ratings go with it (plain SQL: recipePhotos.ts and recipeMarks.ts import this file).
    run(db, "DELETE FROM nutrition_recipe_photos WHERE recipe_id = ?", id);
    run(db, "DELETE FROM nutrition_recipe_marks WHERE recipe_id = ?", id);
    return true;
  });
}

/**
 * After an ingredient food's nutrients or servings changed: re-add every recipe that links it, so the
 * calories stay true. Same transaction as the food edit if the caller wraps both.
 */
export function refreshRecipesUsingFood(db: Db, foodId: string): number {
  const rows = all<RecipeRowRaw>(db, "SELECT item_id, owner_user_id, data FROM recipes WHERE data LIKE ?", `%"foodId":${JSON.stringify(foodId)}%`);
  let n = 0;
  for (const row of rows) {
    const { doc, ownerUserId } = toRecord(row);
    if (!doc.lines?.some((l) => l.foodId === foodId)) continue;
    const next = recomputeNutrition(db, doc);
    if (JSON.stringify(next.nutrition) === JSON.stringify(doc.nutrition)) continue;
    run(db, "UPDATE recipes SET data = ? WHERE item_id = ?", JSON.stringify({ ...next, updatedAt: new Date().toISOString() }), doc.id);
    syncRecipeFood(db, next, ownerUserId);
    n++;
  }
  return n;
}

// ---- requests -> lines ----------------------------------------------------------------------

const AMOUNT_FIELDS = ["quantity", "servingId", "grams"] as const;

/**
 * Turn a request's `lines` into stored lines: each needs text; pantryName defaults to what the importer
 * would derive; a foodId must be a food the person can see (unless the recipe already linked it) and the
 * amount must fit it. A line with a food is never `estimated`.
 */
export function parseLinesInput(db: Db, userId: string, raw: unknown, previous: Line[] = []): Line[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new NutritionError(400, "lines must be a non-empty list.");
  if (raw.length > MAX_LINES) throw new NutritionError(400, `A recipe can have at most ${MAX_LINES} lines.`);
  const had = new Set(previous.map((l) => l.foodId).filter(Boolean));
  return raw.map((entry, i): Line => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new NutritionError(400, `lines[${i}] must be an object.`);
    const b = camelKeys(entry);
    const text = reqString(b, "text", 300);
    const line: Line = { text, pantryName: optString(b, "pantryName", 120) ?? pantryNameOf(text) };
    if (b.foodId !== undefined && b.foodId !== null && b.foodId !== "") {
      const foodId = String(b.foodId);
      const trusted = had.has(foodId);
      const food = trusted ? getFood(db, foodId) : requireVisibleFood(db, userId, foodId);
      if (!food) throw new NutritionError(404, `lines[${i}]: food not found.`);
      if (food.source === "recipe" && !trusted) {
        throw new NutritionError(400, `lines[${i}]: "${food.name}" is a recipe. A recipe can't be an ingredient of another yet; link a plain food.`);
      }
      line.foodId = foodId;
      const amount = { quantity: b.quantity, servingId: b.servingId, grams: b.grams };
      if (trusted && !AMOUNT_FIELDS.some((f) => amount[f] !== undefined && amount[f] !== null)) {
        const prev = previous.find((p) => p.foodId === foodId);
        if (prev) Object.assign(line, pick(prev, AMOUNT_FIELDS));
      } else {
        // Strict check (400s for a serving that isn't this food's, grams on a per-serving food...).
        const c = computeFromFood(db, food, { quantity: optNumber(b, "quantity", 0.0001, 100_000) ?? undefined, servingId: optString(b, "servingId", 80) ?? undefined, grams: optNumber(b, "grams", 0.01, 1_000_000) ?? undefined });
        if (c.servingId === null) line.grams = c.grams ?? undefined;
        else {
          line.quantity = c.quantity;
          line.servingId = c.servingId;
        }
      }
    } else if (b.estimated === true) {
      const kcal = optNumber(b, "estimatedKcal", 0, MAX_ESTIMATE_KCAL);
      if (kcal !== null) {
        line.estimated = true;
        line.estimatedKcal = Math.round(kcal);
      }
    }
    return line;
  });
}

function pick<T extends object, K extends keyof T>(o: T, keys: readonly K[]): Partial<T> {
  const out: Partial<T> = {};
  for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
  return out;
}

// ---- finding the food for a line ------------------------------------------------------------

export interface CandidateJson {
  foodId: string;
  name: string;
  brand: string | null;
  scope: "joint" | "personal" | "generic";
  source: string;
  basis: "per100g" | "per_serving";
  /** kcal in 100 g (per100g) or in one serving (per_serving), to show beside the name. */
  kcal: number;
  confidence: MatchConfidence;
  /** What this line would be in this food, or null when the line has no amount that fits. `approx`: a density guess was involved. */
  amount: ResolvedAmount | null;
}

export interface LineProposal {
  index: number;
  text: string;
  parsed: Pick<ParsedLine, "quantity" | "unit" | "name" | "negligible" | "via">;
  candidates: CandidateJson[];
  /** The food the auto-link rule would take (exact match, exact amount), if any. */
  suggestedFoodId: string | null;
}

const CONFIDENCE_ORDER: Record<MatchConfidence, number> = { exact: 0, possible: 1, weak: 2 };

function candidatesFor(db: Db, userId: string, doc: RecipeDoc, parsed: ParsedLine, now: number): CandidateJson[] {
  const q = parsed.name;
  if (!q.trim()) return [];
  let foods = searchFoods(db, userId, q, 12, now);
  if (foods.length === 0) foods = searchFoods(db, userId, q, 12, now, { anyWord: true });
  const out = foods
    // Recipes can't be ingredients yet; a joint recipe can't lean on someone's personal food.
    .filter((f) => f.source !== "recipe" && (doc.scope === "personal" || f.owner_user_id === null))
    .map((f): CandidateJson => {
      const servings = servingsOf(db, f.id).map((s) => ({ id: s.id, label: s.label, grams: s.grams, isDefault: s.is_default === 1 }));
      const nutrients = JSON.parse(f.nutrients) as Nutrients;
      return {
        foodId: f.id, name: f.name, brand: f.brand, scope: foodScope(f), source: f.source, basis: f.basis,
        kcal: nutrients.kcal, confidence: matchConfidence(q, f.name), amount: resolveAmount(parsed, { basis: f.basis, servings }),
      };
    });
  // Stable sort: better text matches first, search order (own foods, then popular) within a grade.
  return out.map((c, i) => ({ c, i })).sort((a, b) => CONFIDENCE_ORDER[a.c.confidence] - CONFIDENCE_ORDER[b.c.confidence] || a.i - b.i).map((x) => x.c).slice(0, 5);
}

// ---- what this household usually links an ingredient to -------------------------------------

const historyKey = (name: string): string => name.toLowerCase().replace(/\s+/g, " ").trim().replace(/s$/, "");

/**
 * The food this household has most often linked each ingredient name to, across every recipe the person can see (a link
 * someone already confirmed). Used only to break a tie the name match alone can't: "egg" with three egg foods in the
 * catalogue has no single clearly-right answer, but if the household's recipes already link "egg" to one of them, that
 * is the answer. A name whose links are split evenly between two foods has no usual food, so it is left out.
 */
export function householdFoodHistory(db: Db, userId: string): Map<string, string> {
  const counts = new Map<string, Map<string, number>>();
  for (const doc of listRecipeDocs(db, userId)) {
    for (const line of doc.lines ?? []) {
      if (!line.foodId) continue;
      const key = historyKey(parseIngredientLine(line.text).name);
      if (!key) continue;
      const byFood = counts.get(key) ?? new Map<string, number>();
      byFood.set(line.foodId, (byFood.get(line.foodId) ?? 0) + 1);
      counts.set(key, byFood);
    }
  }
  const usual = new Map<string, string>();
  for (const [key, byFood] of counts) {
    const ranked = [...byFood.entries()].sort((a, b) => b[1] - a[1]);
    if (ranked.length === 1 || ranked[0][1] > ranked[1][1]) usual.set(key, ranked[0][0]);
  }
  return usual;
}

/** The household's usual food for this line, as a candidate, when that food is still there and this person can use it. */
function historyCandidate(db: Db, userId: string, doc: RecipeDoc, parsed: ParsedLine, history: Map<string, string>): CandidateJson | null {
  const foodId = history.get(historyKey(parsed.name));
  if (!foodId || parsed.negligible) return null;
  const f = getFood(db, foodId);
  if (!f || f.deleted_at || f.source === "recipe") return null;
  if (f.owner_user_id !== null && f.owner_user_id !== userId) return null;
  if (doc.scope === "joint" && f.owner_user_id !== null) return null;
  const servings = servingsOf(db, f.id).map((s) => ({ id: s.id, label: s.label, grams: s.grams, isDefault: s.is_default === 1 }));
  const nutrients = JSON.parse(f.nutrients) as Nutrients;
  return {
    foodId: f.id, name: f.name, brand: f.brand, scope: foodScope(f), source: f.source, basis: f.basis,
    kcal: nutrients.kcal, confidence: "possible", amount: resolveAmount(parsed, { basis: f.basis, servings }),
  };
}

/** The line's parse, with the model's second opinion where the regex couldn't read an amount in words. */
export async function parseDocLines(lines: Line[], model: RecipeModel | null): Promise<{ parsed: ParsedLine[]; modelError?: string }> {
  const parsed = lines.map((l) => parseIngredientLine(l.text));
  const need = parsed.map((p, i) => ((p.quantity === null && hasWordAmount(p.text)) || !p.name.trim() ? i : -1)).filter((i) => i >= 0);
  if (!model || need.length === 0) return { parsed };
  try {
    const got = await model.parseLines(need.map((i) => lines[i].text));
    need.forEach((i, k) => {
      const m = got[k];
      if (!m) return;
      const info = m.unit ? UNIT_TABLE[m.unit] : undefined;
      parsed[i] = {
        ...parsed[i], quantity: m.quantity, unit: info?.key ?? null, unitKind: info?.kind ?? null, name: m.ingredient,
        negligible: parsed[i].negligible || (info !== undefined && (info.key === "pinch" || info.key === "dash")), via: "model",
      };
    });
    return { parsed };
  } catch (err) {
    return { parsed, modelError: (err as Error).message };
  }
}

/** The lines as written, or the ingredient names made into lines when the recipe never had any. */
export const linesOf = (doc: RecipeDoc): Line[] => doc.lines ?? linesFromNames(doc.ingredients);

/** Candidate foods for every line, for a person to confirm. Writes nothing. */
export async function proposeMatches(db: Db, userId: string, doc: RecipeDoc, model: RecipeModel | null, now = Date.now()) {
  const lines = linesOf(doc);
  const { parsed, modelError } = await parseDocLines(lines, model);
  const history = householdFoodHistory(db, userId);
  const proposals: LineProposal[] = lines.map((l, index) => {
    const p = parsed[index];
    const candidates = p.negligible ? [] : candidatesFor(db, userId, doc, p, now);
    const picked = pickConfident(p.name, candidates.map((c): CandidateLike => ({ id: c.foodId, name: c.name, source: c.source })));
    let chosen = candidates.find((c) => c.foodId === picked);
    if (!chosen) {
      // No clearly-right match by name: fall back on the food this household already uses for this ingredient.
      const usual = historyCandidate(db, userId, doc, p, history);
      if (usual) {
        const present = candidates.find((c) => c.foodId === usual.foodId);
        if (!present) candidates.unshift(usual);
        chosen = present ?? usual;
      }
    }
    return {
      index, text: l.text,
      parsed: { quantity: p.quantity, unit: p.unit, name: p.name, negligible: p.negligible, via: p.via },
      candidates,
      suggestedFoodId: chosen && chosen.amount && !chosen.amount.approx ? chosen.foodId : null,
    };
  });
  return { proposals, modelError };
}

// ---- calculate ------------------------------------------------------------------------------

export interface CalculateOptions {
  /** Link a line to a food when the match is clearly right (default true). */
  autoLink?: boolean;
  /** Ask the local model for a kcal figure for lines still without a food (default false). */
  estimate?: boolean;
  /** Estimate again for lines that already carry an estimate. */
  reestimate?: boolean;
  model: RecipeModel | null;
  now?: number;
}

export interface CalculateReport {
  linked: number[];
  estimated: number[];
  /** Lines still without a food or an estimate that count for calories. */
  unresolved: number[];
  modelAvailable: boolean;
  /** Set when the model was asked and failed (not running, bad answer). */
  modelError?: string;
}

/**
 * The whole "calculate from lines" flow: read each line (regex first, the model for what it can't read),
 * link the ones whose food is clearly right, optionally estimate the rest with the model, re-add, save.
 * Existing confirmed links are never changed. With no model it still links what it can; nothing is
 * estimated, the recipe says it is incomplete, and the report says why.
 */
export async function calculateFromLines(
  db: Db, userId: string, recipeId: string, opts: CalculateOptions,
): Promise<{ recipe: RecipeDoc; report: CalculateReport }> {
  const rec = requireRecipe(db, userId, recipeId);
  const doc: RecipeDoc = structuredClone(rec.doc);
  const lines = structuredClone(linesOf(doc));
  const now = opts.now ?? Date.now();
  const report: CalculateReport = { linked: [], estimated: [], unresolved: [], modelAvailable: opts.model !== null };

  const { parsed, modelError } = await parseDocLines(lines, opts.model);
  if (modelError) report.modelError = modelError;

  if (opts.autoLink !== false) {
    const history = householdFoodHistory(db, userId);
    lines.forEach((line, i) => {
      const p = parsed[i];
      if (line.foodId || p.negligible || p.quantity === null) return;
      const candidates = candidatesFor(db, userId, doc, p, now);
      const picked = pickConfident(p.name, candidates.map((c): CandidateLike => ({ id: c.foodId, name: c.name, source: c.source })));
      // A tie the name can't break is broken by the food the household's other recipes already use for this ingredient.
      const chosen = candidates.find((c) => c.foodId === picked) ?? historyCandidate(db, userId, doc, p, history);
      if (!chosen?.amount || chosen.amount.approx) return;
      line.foodId = chosen.foodId;
      if (chosen.amount.grams !== undefined) line.grams = chosen.amount.grams;
      else {
        line.quantity = chosen.amount.quantity;
        if (chosen.amount.servingId) line.servingId = chosen.amount.servingId;
      }
      delete line.estimated;
      delete line.estimatedKcal;
      report.linked.push(i);
    });
  }

  if (opts.estimate) {
    const need = Array.from(lines.keys()).filter((i) => !lines[i].foodId && !parsed[i].negligible && (opts.reestimate || !lines[i].estimated));
    if (need.length > 0 && opts.model) {
      try {
        const got = await opts.model.estimateKcal({
          recipeName: doc.name, servings: yieldOf(doc), ingredients: need.map((i) => ({ index: i, text: lines[i].text })),
        });
        for (const i of need) {
          const kcal = got[i];
          if (typeof kcal === "number" && Number.isFinite(kcal) && kcal >= 0 && kcal <= MAX_ESTIMATE_KCAL) {
            lines[i].estimated = true;
            lines[i].estimatedKcal = Math.round(kcal);
            report.estimated.push(i);
          }
        }
      } catch (err) {
        report.modelError = (err as Error).message;
      }
    }
  }

  doc.lines = lines;
  if (doc.yieldServings === undefined) doc.yieldAssumed = true;
  doc.updatedAt = new Date().toISOString();
  const saved = saveRecipe(db, userId, doc);
  report.unresolved = Array.from((saved.lines ?? []).keys()).filter((i) => {
    const l = saved.lines![i];
    return !isNegligible(l) && !(l.foodId && lineNutrients(db, l)) && !(l.estimated && l.estimatedKcal !== undefined);
  });
  return { recipe: saved, report };
}

/** True while a recipe's calories are missing or partly guessed. */
export const isPartlyEstimated = (d: Pick<RecipeDoc, "nutrition">): boolean => !d.nutrition || !d.nutrition.complete;

/**
 * "Improve calories": for every recipe the person can see whose calories are missing or partly estimated, link the lines
 * whose food is clearly right (the exact-match rule plus the household's usual foods) and re-add. No model is asked and
 * nothing is estimated, so it needs no Ollama and cannot guess. Returns how many were partly estimated before and after.
 */
export async function recalculateAllRecipes(db: Db, userId: string): Promise<{ recipes: number; before: number; after: number; improved: number }> {
  const docs = listRecipeDocs(db, userId);
  const todo = docs.filter(isPartlyEstimated);
  let improved = 0;
  for (const d of todo) {
    const out = await calculateFromLines(db, userId, d.id, { autoLink: true, estimate: false, model: null });
    if (out.report.linked.length > 0) improved++;
  }
  return { recipes: docs.length, before: todo.length, after: listRecipeDocs(db, userId).filter(isPartlyEstimated).length, improved };
}

// ---- how a recipe is shown ------------------------------------------------------------------

/** The recipe plus, per line, what it adds: for the screen that lets a person check the figure. */
export function recipeDetailJson(db: Db, userId: string, rec: RecipeRecord) {
  const doc = rec.doc;
  const lines = linesOf(doc).map((line, index) => {
    const n = lineNutrients(db, line);
    const food = line.foodId ? getFood(db, line.foodId) : undefined;
    return {
      index, ...line,
      foodName: food?.name ?? null,
      kcal: n ? n.kcal : line.estimated && line.estimatedKcal !== undefined ? line.estimatedKcal : null,
      negligible: isNegligible(line),
    };
  });
  return { ...doc, lines, yieldServings: doc.yieldServings ?? null, mine: doc.createdBy === userId, kcalPerServing: doc.nutrition ? round2(doc.nutrition.perServing.kcal) : null };
}

