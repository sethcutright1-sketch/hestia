// Foods, their servings, and search.
//
// Who sees a food follows db.ts's joint/personal convention instead of the calorie app's
// household table:
//   - owner_user_id NULL            joint: every login sees it, any tracker may edit it
//   - owner_user_id = a user's id   personal: only that login sees or edits it
//   - source 'usda_generic'         the shared catalogue: everyone sees it, nobody edits it
//     (it is also owner-less, which is why the source column, not the owner, marks it)
//
//   - source 'recipe'               a recipe materialized as a food (nutrition/data/recipes.ts): visible
//     like any food (joint or personal, following the recipe), but read-only here -- it changes by
//     editing the recipe, so editing or deleting it answers 409 "edit the recipe instead"

import crypto from "node:crypto";
import { canonicalGtin } from "../barcode.ts";
import { NUTRIENT_KEYS, round2, type Nutrients } from "../nutrients.ts";
import { NutritionError } from "./errors.ts";
import { bodyObject, oneOf, optString, parseJson, reqString, type Body } from "./input.ts";
import { all, get, run, tx, type Db } from "./sql.ts";
import { assertCanTrack, type Tracker } from "./access.ts";

export type Basis = "per100g" | "per_serving";
export type FoodSource = "usda_generic" | "off" | "fdc" | "custom" | "import_loseit" | "quick" | "recipe";
/** Who can see a food a person is creating. (A stored food can also be the read-only 'generic' catalogue.) */
export type Scope = "joint" | "personal";
export type FoodScope = Scope | "generic";

export interface FoodRow {
  id: string;
  owner_user_id: string | null;
  created_by_user_id: string | null;
  name: string;
  brand: string | null;
  gtin14: string | null;
  basis: Basis;
  nutrients: string;
  source: FoodSource;
  source_ref: string | null;
  usage_count: number;
  last_used_at: string | null;
  created_at: string;
  deleted_at: string | null;
  /** The recipe this food is the materialized form of (source = 'recipe'), else null. */
  recipe_id: string | null;
}

export interface ServingRow {
  id: string;
  food_id: string;
  label: string;
  grams: number | null;
  is_default: number;
}

export interface ServingInput {
  label: string;
  grams: number | null;
  isDefault: boolean;
}

export const servingsOf = (db: Db, foodId: string): ServingRow[] =>
  all<ServingRow>(db, "SELECT * FROM nutrition_food_servings WHERE food_id = ? ORDER BY is_default DESC, rowid", foodId);

export const foodScope = (f: Pick<FoodRow, "source" | "owner_user_id">): FoodScope =>
  f.source === "usda_generic" ? "generic" : f.owner_user_id === null ? "joint" : "personal";

export function foodJson(db: Db, f: FoodRow) {
  return {
    id: f.id,
    name: f.name,
    brand: f.brand,
    gtin14: f.gtin14,
    basis: f.basis,
    nutrients: parseJson<Nutrients>(f.nutrients),
    source: f.source,
    sourceRef: f.source_ref,
    recipeId: f.recipe_id ?? null,
    scope: foodScope(f),
    ownerUserId: f.owner_user_id,
    createdByUserId: f.created_by_user_id,
    usageCount: f.usage_count,
    lastUsedAt: f.last_used_at,
    servings: servingsOf(db, f.id).map((s) => ({ id: s.id, label: s.label, grams: s.grams, isDefault: s.is_default === 1 })),
  };
}

/** The catalogue and joint foods are visible to every login; a personal food only to its owner. A deleted food to no one. */
export function canSee(f: FoodRow, userId: string): boolean {
  if (f.deleted_at) return false;
  return f.source === "usda_generic" || f.owner_user_id === null || f.owner_user_id === userId;
}

/** The shared USDA catalogue and recipe foods are read-only here; every other food is editable by whoever can see it. */
export function canEdit(f: FoodRow, userId: string): boolean {
  return canSee(f, userId) && f.source !== "usda_generic" && f.source !== "recipe";
}

/** 404 if invisible, 409 for a recipe's food ("edit the recipe"), 403 if read-only. Shared by everything that changes a food. */
export function assertFoodEditable(f: FoodRow | undefined, userId: string, what = "edited"): FoodRow {
  if (!f || !canSee(f, userId)) throw new NutritionError(404, "Food not found.");
  if (f.source === "recipe") {
    throw new NutritionError(409, `This food is a recipe, so it can't be ${what} here: edit the recipe instead.`, { recipeId: f.recipe_id });
  }
  if (!canEdit(f, userId)) throw new NutritionError(403, `This food can't be ${what}.`);
  return f;
}

export function getFood(db: Db, id: string): FoodRow | undefined {
  return get<FoodRow>(db, "SELECT * FROM nutrition_foods WHERE id = ?", id);
}

/** The food, or a 404 -- also when it exists but is someone else's personal food. */
export function requireVisibleFood(db: Db, userId: string, id: unknown): FoodRow {
  const food = getFood(db, String(id));
  if (!food || !canSee(food, userId)) throw new NutritionError(404, "Food not found.");
  return food;
}

export function parseNutrients(raw: unknown, field = "nutrients"): Nutrients {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new NutritionError(400, `${field} must be an object.`);
  const o = raw as Record<string, unknown>;
  const out = {} as Nutrients;
  for (const k of NUTRIENT_KEYS) {
    const v = o[k] ?? 0;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100_000) {
      throw new NutritionError(400, `${field}.${k} must be a number between 0 and 100000.`);
    }
    out[k] = round2(v);
  }
  if (o.kcal === undefined) throw new NutritionError(400, `${field}.kcal is required.`);
  return out;
}

export function parseServings(raw: unknown, basis: Basis, fallbackLabel?: string | null): ServingInput[] {
  if (raw === undefined || raw === null || (Array.isArray(raw) && raw.length === 0)) {
    return basis === "per100g"
      ? [{ label: "100 g", grams: 100, isDefault: true }]
      : [{ label: fallbackLabel || "1 serving", grams: null, isDefault: true }];
  }
  if (!Array.isArray(raw) || raw.length > 40) throw new NutritionError(400, "servings must be an array of at most 40 items.");
  const list = raw.map((s, i): ServingInput => {
    if (!s || typeof s !== "object") throw new NutritionError(400, `servings[${i}] must be an object.`);
    const b = s as Body;
    const grams = b.grams === undefined || b.grams === null ? null : b.grams;
    if (grams !== null && (typeof grams !== "number" || !(grams > 0) || grams > 100_000)) {
      throw new NutritionError(400, `servings[${i}].grams must be a positive number.`);
    }
    if (basis === "per100g" && grams === null) throw new NutritionError(400, `servings[${i}].grams is required for per100g foods.`);
    return { label: reqString(b, "label", 80), grams, isDefault: b.isDefault === true };
  });
  if (basis === "per_serving" && list.length !== 1) {
    throw new NutritionError(400, "per_serving foods have exactly one serving (the one the nutrients describe).");
  }
  // Exactly one default: keep the first flagged one, or fall back to the first serving.
  const defaultIdx = Math.max(0, list.findIndex((s) => s.isDefault));
  return list.map((s, i) => ({ ...s, isDefault: i === defaultIdx }));
}

export function parseGtin(v: unknown): string | null {
  if (v === undefined || v === null || v === "") return null;
  const canon = canonicalGtin(String(v));
  if (!canon) throw new NutritionError(400, "gtin14 is not a valid UPC/EAN barcode.");
  return canon.gtin14;
}

export function parseScope(v: unknown, fallback: Scope = "joint"): Scope {
  return v === undefined ? fallback : oneOf(v, "scope", ["joint", "personal"] as const);
}

export interface NewFood {
  name: string;
  brand: string | null;
  gtin14: string | null;
  basis: Basis;
  nutrients: Nutrients;
  servings: ServingInput[];
  scope: Scope;
  source: FoodSource;
  sourceRef?: string | null;
}

export function parseNewFood(b: Body): Omit<NewFood, "source"> {
  const basis = oneOf(b.basis, "basis", ["per100g", "per_serving"] as const);
  return {
    name: reqString(b, "name", 200),
    brand: optString(b, "brand", 100),
    gtin14: parseGtin(b.gtin14),
    basis,
    nutrients: parseNutrients(b.nutrients),
    servings: parseServings(b.servings, basis, typeof b.servingLabel === "string" ? b.servingLabel : null),
    scope: parseScope(b.scope),
  };
}

function insertServings(db: Db, foodId: string, servings: ServingInput[]): void {
  for (const s of servings) {
    run(db, "INSERT INTO nutrition_food_servings (id, food_id, label, grams, is_default) VALUES (?, ?, ?, ?, ?)",
      crypto.randomUUID(), foodId, s.label, s.grams, s.isDefault ? 1 : 0);
  }
}

/**
 * Replace a food's servings, keeping the id of any serving whose label is unchanged: saved meals
 * refer to serving rows by id, and an edit that only changes a gram weight (or adds another
 * serving) must not orphan them. Runs inside the caller's transaction.
 */
function replaceServings(db: Db, foodId: string, servings: ServingInput[]): void {
  const keep = new Map<string, string>();
  for (const s of servingsOf(db, foodId)) if (!keep.has(s.label)) keep.set(s.label, s.id);
  run(db, "DELETE FROM nutrition_food_servings WHERE food_id = ?", foodId);
  for (const s of servings) {
    const id = keep.get(s.label) ?? crypto.randomUUID();
    keep.delete(s.label);
    run(db, "INSERT INTO nutrition_food_servings (id, food_id, label, grams, is_default) VALUES (?, ?, ?, ?, ?)", id, foodId, s.label, s.grams, s.isDefault ? 1 : 0);
  }
}

const isDuplicateBarcode = (err: unknown): boolean => /UNIQUE constraint failed/i.test(String((err as Error)?.message));

/**
 * INSERT a food made by `userId` (personal ones are owned by them, joint ones by no one).
 * Caller owns the transaction. A duplicate barcode surfaces as 409: one food per barcode.
 */
export function insertFood(db: Db, userId: string, f: NewFood): FoodRow {
  const id = crypto.randomUUID();
  try {
    run(db,
      `INSERT INTO nutrition_foods (id, owner_user_id, created_by_user_id, name, brand, gtin14, basis, nutrients, source, source_ref, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, f.scope === "personal" ? userId : null, userId, f.name, f.brand, f.gtin14, f.basis,
      JSON.stringify(f.nutrients), f.source, f.sourceRef ?? null, new Date().toISOString());
  } catch (err) {
    if (isDuplicateBarcode(err)) throw new NutritionError(409, "A food with that barcode already exists.");
    throw err;
  }
  insertServings(db, id, f.servings);
  return getFood(db, id)!;
}

/** A custom food from a request body: name, basis, nutrients, servings?, brand?, gtin14?, scope?. */
export function createFood(db: Db, user: Tracker, input: unknown): FoodRow {
  assertCanTrack(user);
  const parsed = parseNewFood(bodyObject(input));
  return tx(db, () => insertFood(db, user.id, { ...parsed, source: "custom" }));
}

/**
 * Partial update (only the fields present change). Anyone who can see a joint food can edit it;
 * a personal food is its owner's alone. Changing who it is shared with is the creator's call, so
 * one person can't quietly pull a food the other added out of sight: personal -> the creator,
 * joint -> no one. Foods already logged are untouched either way -- diary entries are snapshots.
 */
export function updateFood(db: Db, user: Tracker, id: string, input: unknown): FoodRow {
  const food = assertFoodEditable(getFood(db, id), user.id, "edited");
  const b = bodyObject(input);
  tx(db, () => {
    let owner = food.owner_user_id;
    if (b.scope !== undefined) {
      const scope = parseScope(b.scope);
      if (scope !== foodScope(food)) {
        if (food.created_by_user_id !== user.id) throw new NutritionError(403, "Only the person who added a food can change who it's shared with.");
        owner = scope === "personal" ? user.id : null;
      }
    }
    try {
      run(db, "UPDATE nutrition_foods SET name = ?, brand = ?, gtin14 = ?, nutrients = ?, owner_user_id = ? WHERE id = ?",
        b.name === undefined ? food.name : reqString(b, "name", 200),
        b.brand === undefined ? food.brand : optString(b, "brand", 100),
        b.gtin14 === undefined ? food.gtin14 : parseGtin(b.gtin14),
        b.nutrients === undefined ? food.nutrients : JSON.stringify(parseNutrients(b.nutrients)),
        owner,
        food.id);
    } catch (err) {
      if (isDuplicateBarcode(err)) throw new NutritionError(409, "Another food already has that barcode.");
      throw err;
    }
    // Diary entries never point at a serving row, but saved meals do: replaceServings keeps a
    // serving's id when its label stays.
    if (b.servings !== undefined) replaceServings(db, food.id, parseServings(b.servings, food.basis));
  });
  return getFood(db, food.id)!;
}

/** Soft delete: past diary entries keep their food_id and snapshots. */
export function deleteFood(db: Db, user: Tracker, id: string): void {
  const food = assertFoodEditable(getFood(db, id), user.id, "deleted");
  run(db, "UPDATE nutrition_foods SET deleted_at = ? WHERE id = ?", new Date().toISOString(), food.id);
}

// ---- search ranking -------------------------------------------------------
//
// FTS5 gives us bm25 (more negative = better text match; weighted so a hit in the name counts
// 1.0 and in the brand 0.3, and shorter names win ties). Text match alone is the wrong order for
// a diary: typing "oat" should offer *your* rolled oats before the 40th USDA oat product. So the
// final score (lower = first) is
//
//   bm25  - tier  - usage  - recency
//
//   tier     a food you added 4, a food someone else added (joint, or yours to see) 3, the shared
//            USDA catalogue 0. Large enough to beat any text-score difference between reasonable
//            matches, small enough that a joint food that barely matches the query still loses to
//            an exact generic one.
//   usage    0.6 * ln(1 + usage_count), capped at 3: the fifth time you log it the food
//            climbs, but a thousand logs can't bury everything else.
//   recency  1 if used in the last 14 days, 0.5 if in the last 60.
//
// Two queries (own/joint and the USDA catalogue) are merged in JS because a single
// bm25-ordered LIMIT over the whole catalogue could cut off your own foods when a generic term
// like "chicken" matches thousands of USDA rows.

const DAY_MS = 86_400_000;

interface Scored extends FoodRow {
  rank: number;
}

// Words that say nothing about which food it is; in "any word" mode they would match half the library.
const FILLER = new Set(["the", "and", "of", "with", "in", "for", "a", "an"]);

function ftsQuery(q: string, anyWord = false): string | null {
  let tokens = q.toLowerCase().match(/[\p{L}\p{N}]+/gu)?.slice(0, 8);
  if (anyWord) tokens = [...new Set(tokens?.filter((t) => t.length > 1 && !FILLER.has(t)))];
  if (!tokens?.length) return null;
  // Quoted so user input can never be parsed as FTS operators; trailing * = prefix match.
  // Normal search wants every word (typing narrows); matching a product name against your
  // own foods wants any word, because "Cheerios Cereal" should still find your "Cheerios".
  return tokens.map((t) => `"${t}"*`).join(anyWord ? " OR " : " ");
}

function score(f: Scored, userId: string, now: number): number {
  const tier = f.source === "usda_generic" ? 0 : f.created_by_user_id === userId ? 4 : 3;
  const usage = Math.min(3, 0.6 * Math.log(1 + f.usage_count));
  const age = f.last_used_at ? now - Date.parse(f.last_used_at) : Infinity;
  const recency = age < 14 * DAY_MS ? 1 : age < 60 * DAY_MS ? 0.5 : 0;
  return f.rank - tier - usage - recency;
}

export interface SearchOptions {
  /** Skip the shared USDA catalogue: only joint foods and the person's own. */
  skipGeneric?: boolean;
  /** Only foods with no barcode yet (the ones a scanned code can still be attached to). */
  withoutBarcode?: boolean;
  /** Match any word of the query instead of all of them. */
  anyWord?: boolean;
}

/** Foods matching `q`, best first: your own and joint foods and the ones you use often, then the USDA catalogue. */
export function searchFoods(db: Db, userId: string, q: string, limit: number, now = Date.now(), opts: SearchOptions = {}): FoodRow[] {
  const match = ftsQuery(q, opts.anyWord);
  if (!match) return [];
  const base = `SELECT f.*, bm25(nutrition_foods_fts, 1.0, 0.3) AS rank FROM nutrition_foods_fts JOIN nutrition_foods f ON f.id = nutrition_foods_fts.food_id
                WHERE nutrition_foods_fts MATCH ? AND f.deleted_at IS NULL ${opts.withoutBarcode ? "AND f.gtin14 IS NULL AND f.source <> 'recipe' " : ""}AND `;
  const mine = all<Scored>(db,
    base + "f.source <> 'usda_generic' AND (f.owner_user_id IS NULL OR f.owner_user_id = ?) ORDER BY rank LIMIT 60",
    match, userId);
  const generic = opts.skipGeneric ? [] : all<Scored>(db, base + "f.source = 'usda_generic' ORDER BY rank LIMIT 100", match);
  return [...mine, ...generic]
    .map((f) => ({ f, s: score(f, userId, now) }))
    .sort((a, b) => a.s - b.s)
    .slice(0, limit)
    .map(({ f }) => {
      const { rank: _rank, ...row } = f;
      return row;
    });
}

/**
 * The "Recent" tab of the add-food sheet: distinct foods this person actually ate in the last 60
 * days, newest first (more logs break ties). Only logged entries count, so a plan you never ate
 * doesn't show up, and canSee() drops foods that were deleted or made personal to someone else since.
 */
export function recentFoods(db: Db, user: Tracker, today: string, limit = 20): FoodRow[] {
  const since = new Date(Date.parse(`${today}T00:00:00Z`) - 60 * DAY_MS).toISOString().slice(0, 10);
  const rows = all<{ food_id: string }>(db,
    `SELECT food_id FROM nutrition_diary_entries
      WHERE user_id = ? AND status = 'logged' AND deleted_at IS NULL AND food_id IS NOT NULL AND local_date >= ?
      GROUP BY food_id ORDER BY MAX(logged_at) DESC, COUNT(*) DESC LIMIT ?`,
    user.id, since, limit * 2); // over-fetch: some may be invisible now
  const foods: FoodRow[] = [];
  for (const r of rows) {
    const f = getFood(db, r.food_id);
    if (f && canSee(f, user.id)) foods.push(f);
    if (foods.length >= limit) break;
  }
  return foods;
}
