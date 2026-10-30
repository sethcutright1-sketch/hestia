import express from "express";
import { db as appDb, getScopedItems, putScopedItem, deleteScopedItem, newId, getConfig } from "../db.ts";
import {
  applyRecipePatch, canSeeRecipe, deleteRecipeDoc, duplicateRecipeDoc, ensureJointRecipe, getRecipeRecord, requireRecipe, saveRecipe,
  upsertRecipeByName, type RecipeInput,
} from "../nutrition/data/recipes.ts";
import { recipeUsage } from "../nutrition/data/recipePlanSync.ts";
import { copyRecipePhoto, deleteRecipePhoto, getRecipePhoto, setRecipePhoto } from "../nutrition/data/recipePhotos.ts";
import { listMarks, setMark } from "../nutrition/data/recipeMarks.ts";
import { bodyObject } from "../nutrition/data/input.ts";
import { NutritionError } from "../nutrition/data/errors.ts";
import { STANDARD_SLOT_KEYS, isPlanSlotKey, planSlotOptions } from "../nutrition/data/planSlots.ts";
import { checkMoveCell } from "../nutrition/planCells.ts";
import { getRecipeModel } from "../nutrition/recipeAi.ts";
import { NUTRIENT_KEYS, emptyNutrients } from "../nutrition/nutrients.ts";
import { MAX_LINES, cleanInstructions, kcalPerServing, type RecipeDoc } from "../nutrition/recipeModel.ts";
import { addDays } from "../nutrition/dates.ts";
import { weekCalories } from "../nutrition/data/planCalories.ts";
import { pickReplacement } from "../mealRefill.ts";
import { currentUserId, forbidKiosk, requireKioskPin } from "../auth.ts";
import { computeMissing, computeMissingByMeal, findDislikeConflicts, normalizeName, type DislikeConflict, type MissingForMeal } from "../ingredients.ts";
import { listMembers } from "./members.ts";
import { checkLeftoverCell, commitPlanChange, leftoverOffer, removePlanAndEntries } from "./mealplanDiary.ts";
import { newShoppingItem, type ShoppingList } from "./grocery.ts";
import type { PantryItem } from "./pantry.ts";
import {
  fetchRecipePage,
  extractRecipesFromHtml,
  parseRecipeText,
  parseRecipesFromFile,
  pickPageRecipe,
} from "./recipeImport.ts";

/** How a recipe page is fetched: a property so a test can swap in a canned page instead of the network. */
export const pageFetcher = { fetch: fetchRecipePage };

// A meal slot is a KEY (merge plan decision 11): the four standard ones -- breakfast, lunch, dinner, snacks -- or a
// custom meal someone has ("brunch", "pre-workout"; nutrition/data/planSlots.ts). Meals stored before snacks and
// custom meals existed only ever hold breakfast, lunch or dinner, which are still valid keys.
export type MealSlot = string;
export type MealStatus = "proposed" | "approved" | "denied";

/** The standard slot keys; any custom meal a diary login has switched on is accepted too (see normalizeSlot). */
export const MEAL_SLOTS: MealSlot[] = [...STANDARD_SLOT_KEYS];

/** A slot key as stored (trimmed, lower case) if it is one the household has, else null. */
export function normalizeSlot(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const key = value.trim().toLowerCase();
  return isPlanSlotKey(appDb, key) ? key : null;
}
export const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

// MealPlan.tsx renders the week by exact-matching m.day against DAYS, so a day
// stored in any other form (wrong casing, or not a weekday at all) is a meal
// the grid never draws -- while it still counts toward the shopping list. This
// normalizes any casing to the canonical DAYS spelling and rejects everything else.
export function normalizeDay(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return DAYS.find((d) => d.toLowerCase() === trimmed) || null;
}

// A plan is keyed by the Monday it starts on, but the model does the date
// arithmetic itself and gets it wrong: asked for "this week" on Monday
// 2026-09-07 it sent 2026-09-05, a Saturday. Left alone that silently creates a
// second plan for the same week, so `currentPlan` starts returning whichever
// was touched last and the grid appears to lose meals. Snapping any date in a
// week to that week's Monday is forgiving in the one direction that is safe:
// every day of a week maps to exactly one plan.
export function mondayOf(value: unknown): string | null {
  const text = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const date = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  // getUTCDay: 0 is Sunday, so Sunday belongs to the week that began 6 days ago
  // rather than the one starting tomorrow.
  const shift = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - shift);
  return date.toISOString().slice(0, 10);
}

export interface PlannedMeal {
  id: string;
  day: string;
  slot: MealSlot;
  name: string;
  ingredients: string[];
  status: MealStatus;
  // Whole household by default. "individual" + memberId means this meal is
  // just for one person -- everyone else still gets whatever the household's
  // shared meal is for that day/slot, tracked as a separate PlannedMeal.
  audience: "family" | "individual";
  memberId?: string;
  // The recipe this meal is (merge plan decision 2). Required for every new meal and for approving one; a meal
  // stored before recipes were linked has none, still loads and shows, and can't be approved until a recipe is
  // picked or created. Only JOINT recipes may be named here: a personal recipe's name would leak onto the shared plan.
  // The meal's `name` and `ingredients` are copies taken from the recipe when it was attached; the shopping list,
  // the dislike check and the grocery money budget keep reading those, exactly as before.
  recipeId?: string;
  // Set on a leftover meal: the id of the meal it is the leftovers of. A leftover has no ingredients of its own,
  // so it adds nothing to the shopping list, and its diary entries point at the same recipe food.
  leftoverOf?: string;
}

export interface MealPlan {
  id: string;
  weekStart: string;
  meals: PlannedMeal[];
  scope: "joint";
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * A recipe in the one recipe book. Besides the original name + ingredients it may carry lines, yield,
 * calories and the read-only food it is materialized as -- all optional, so a recipe saved before
 * calories existed is still a valid Recipe. See nutrition/recipeModel.ts for the fields.
 *
 * Personal recipes (scope "personal") belong to whoever saved them: getScopedItems already shows a
 * person only the joint ones and their own. A planned meal names its recipe by `recipeId`, and the plan is
 * shared, so only a JOINT recipe may be named (recipeForMeal below refuses the rest).
 */
export type Recipe = RecipeDoc;

// A meal someone wants on a future plan -- not yet slotted into a day/slot,
// unlike PlannedMeal. Anyone in the household can ask for one; memberId is who
// asked, when that's a tracked household member rather than a signed-in user.
export interface MealRequest {
  id: string;
  name: string;
  notes: string;
  memberId?: string;
  scope: "joint";
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export const mealPlanRoutes = express.Router();

export function listMealRequests(userId: string): MealRequest[] {
  return (getScopedItems("meal_requests", userId) as MealRequest[])
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Snack requests have the same shape as meal requests; they live in their own table and list. */
export function listSnackRequests(userId: string): MealRequest[] {
  return (getScopedItems("snack_requests", userId) as MealRequest[])
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** The plan being worked on -- most recently touched, matching grocery's ordering. */
export function currentPlan(userId: string): MealPlan | undefined {
  return (getScopedItems("meal_plans", userId) as MealPlan[])
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0];
}

/**
 * The plan a request is about: the one for `?weekStart=` (any date in that week) when given -- undefined if that
 * week has no plan yet -- otherwise the most recently touched, as before. Lets the Meal Plan screen page between weeks.
 */
export function planForRequest(req: express.Request, userId: string): MealPlan | undefined {
  const raw = req.query.weekStart;
  if (raw === undefined) return currentPlan(userId);
  const week = mondayOf(raw);
  if (!week) return currentPlan(userId);
  return (getScopedItems("meal_plans", userId) as MealPlan[]).find((p) => p.weekStart === week);
}

export function pantryNames(userId: string): string[] {
  return (getScopedItems("pantry_items", userId) as PantryItem[]).map((i) => i.name);
}

/**
 * A plan is never returned bare: what's missing and what clashes with someone's
 * dislikes are recomputed from current rows every time, so both stay true after
 * the pantry or the family's preferences change underneath a saved plan.
 */
export function describePlan(
  userId: string,
  plan: MealPlan | undefined
): { plan: MealPlan | null; missing: string[]; missingByMeal: MissingForMeal[]; conflicts: DislikeConflict[] } {
  if (!plan) return { plan: null, missing: [], missingByMeal: [], conflicts: [] };
  const pantry = pantryNames(userId);
  return {
    plan,
    missing: computeMissing(plan.meals, pantry),
    missingByMeal: computeMissingByMeal(plan.meals, pantry),
    conflicts: findDislikeConflicts(plan.meals, listMembers(userId)),
  };
}

// --- The one budget figure meal planning is allowed to see ---------------
//
// Everything under /api/budget is `sensitivity: "financial"`: pinned to the
// local model, hidden while the PIN lock is engaged. Meal planning is
// "household", and pulling it across that line to read one number would cost
// it every cloud provider. So instead this is a deliberate, admin-approved
// declassification of exactly one value -- the Groceries category's budgeted
// amount -- and nothing derived from transactions. No spent-so-far, no
// rollover carry (both are sums over real purchases), no other category.
// A limit is a number the household chose; a transaction is something that
// happened, and only the first is allowed out.
export const SHARE_GROCERY_BUDGET_KEY = "mealplan.shareGroceryBudget";

// Matched by name because budgets are keyed by category, with no stable id
// that could say "this one is food". Both spellings, since the category list
// is user-editable.
const GROCERY_CATEGORY_NAMES = ["groceries", "grocery"];

export interface GroceryBudget {
  month: string;
  monthly: number;
  weekly: number;
}

/** The household's grocery budget for `today`'s month, or null when not shared or not set. */
export function groceryBudget(userId: string, today: Date = new Date()): GroceryBudget | null {
  if (getConfig(SHARE_GROCERY_BUDGET_KEY, false) !== true) return null;

  // getScopedItems respects ownership: a Groceries row someone made personal
  // is only ever read on that person's own requests, same as in Budget.
  const row = (getScopedItems("budgets", userId) as { category?: string; limit?: number; monthlyLimits?: Record<string, number> }[])
    .find((b) => GROCERY_CATEGORY_NAMES.includes(String(b.category ?? "").trim().toLowerCase()));
  if (!row) return null;

  // Same resolution as limitFor() in src/sections/budget/budgetMath.ts: this
  // month's one-off override if there is one, otherwise the default limit.
  const month = today.toISOString().slice(0, 7);
  const monthly = Number(row.monthlyLimits?.[month] ?? row.limit);
  if (!Number.isFinite(monthly) || monthly <= 0) return null;

  // 12 months over 52 weeks rather than /4, which would overstate a week by
  // about 8% -- enough to plan one dinner too many every week.
  return { month, monthly: round2(monthly), weekly: round2((monthly * 12) / 52) };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// --- Missing ingredients -> a shopping list --------------------------------
//
// Shared by the UI button and the assistant tool so they can't disagree. Skips
// anything already on the list and not yet ticked off: pressing the button
// twice, or once after the assistant already did it, used to add every item a
// second time. A ticked item doesn't count -- it was bought for something
// else, and this plan still needs its own.
export function addMissingToList(
  userId: string,
  plan: MealPlan,
  list: ShoppingList
): { added: string[]; alreadyOnList: string[] } {
  const missing = computeMissing(plan.meals, pantryNames(userId));
  const onList = new Set(list.items.filter((i) => !i.checked).map((i) => normalizeName(i.name)));

  const added: string[] = [];
  const alreadyOnList: string[] = [];
  for (const name of missing) {
    if (onList.has(normalizeName(name))) {
      alreadyOnList.push(name);
      continue;
    }
    list.items.push(newShoppingItem(userId, name));
    added.push(name);
  }

  if (added.length > 0) {
    list.updatedAt = new Date().toISOString();
    putScopedItem("shopping_lists", userId, list);
  }
  return { added, alreadyOnList };
}

// The full shape the frontend expects everywhere it renders a plan: every
// mutating endpoint below returns this same shape, not just GET, so the UI can
// set its state straight from any response without one route silently omitting
// a field (recipes was missing from the approve/deny endpoint until this fix).
function fullResponse(userId: string, plan: MealPlan | undefined) {
  const recipes = (getScopedItems("recipes", userId) as Recipe[])
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    ...describePlan(userId, plan),
    recipes,
    // This login's own favourites and ratings (per person: nobody else's are ever sent; the kiosk has none).
    marks: listMarks(appDb, userId),
    requests: listMealRequests(userId),
    snackRequests: listSnackRequests(userId),
    groceryBudget: groceryBudget(userId),
    // The meals a planned meal can be put in: the standard four plus any custom meal a diary login has.
    slots: planSlotOptions(appDb),
  };
}

mealPlanRoutes.get("/", (req, res) => {
  const userId = currentUserId(req);
  res.json(fullResponse(userId, planForRequest(req, userId)));
});

/** A NutritionError as the JSON error this router's other routes send. */
function diaryError(res: express.Response, err: unknown) {
  if (err instanceof NutritionError) return res.status(err.status).json({ error: err.message });
  throw err;
}

/**
 * The recipe a meal may point at: one the caller can see AND that is joint. Anything else is an error message
 * (a personal recipe would put its name on the shared plan). Returns the recipe document on success.
 */
function recipeForMeal(userId: string, recipeId: unknown): { recipe: Recipe } | { status: number; error: string } {
  if (typeof recipeId !== "string" || !recipeId.trim()) return { status: 400, error: "recipeId must be a recipe id." };
  const rec = getRecipeRecord(appDb, recipeId);
  if (!rec || !canSeeRecipe(rec, userId)) return { status: 404, error: "Recipe not found" };
  if (rec.ownerUserId !== null) {
    return { status: 400, error: `"${rec.doc.name}" is a personal recipe. Only joint recipes can go on the shared meal plan, because everyone can read it.` };
  }
  return { recipe: rec.doc };
}

/** Point a meal at a recipe: its name and ingredient names follow the recipe (that is what the shopping list reads). */
function attachRecipe(meal: PlannedMeal, recipe: Recipe) {
  meal.recipeId = recipe.id;
  meal.name = recipe.name;
  meal.ingredients = [...recipe.ingredients];
}

const NEEDS_RECIPE = "This meal has no recipe yet. Pick one, or create one from its name, before approving it.";
const SLOT_ERROR = "slot must be breakfast, lunch, dinner, snacks or one of the household's own meals";

mealPlanRoutes.put("/meals/:mealId", async (req, res) => {
  const userId = currentUserId(req);
  const { status, audience, memberId, day, slot, recipeId, createRecipe } = req.body || {};
  if (status !== undefined && status !== "proposed" && status !== "approved" && status !== "denied") {
    return res.status(400).json({ error: "status must be proposed, approved or denied" });
  }
  if (audience !== undefined && audience !== "family" && audience !== "individual") {
    return res.status(400).json({ error: "audience must be family or individual" });
  }
  if (audience === "individual" && !memberId && !req.body?.memberId) {
    return res.status(400).json({ error: "memberId is required when audience is individual" });
  }
  const newDay = day === undefined ? undefined : normalizeDay(day);
  if (day !== undefined && !newDay) return res.status(400).json({ error: "day must be a day of the week" });
  const newSlot = slot === undefined ? undefined : normalizeSlot(slot);
  if (slot !== undefined && !newSlot) return res.status(400).json({ error: SLOT_ERROR });

  const plan = planForRequest(req, userId);
  const meal = plan?.meals.find((m) => m.id === req.params.mealId);
  if (!plan || !meal) return res.status(404).json({ error: "Meal not found" });
  const prev: PlannedMeal = structuredClone(meal);
  const hasLeftovers = plan.meals.some((m) => m.leftoverOf === meal.id);

  // Moving a meal to another day or meal: not onto a cell that already has one, and leftovers stay after the meal
  // they come from (nutrition/planCells.ts -- the Meal Plan screen runs the same check before it asks).
  if ((newDay && newDay !== meal.day) || (newSlot && newSlot !== meal.slot)) {
    const labels = new Map(planSlotOptions(appDb).map((o) => [o.key, o.label]));
    const bad = checkMoveCell(plan.meals, meal, newDay ?? meal.day, newSlot ?? meal.slot, (k) => labels.get(k) ?? k);
    if (bad) return res.status(409).json({ error: bad });
  }

  try {
    if (recipeId !== undefined && recipeId !== meal.recipeId) {
      if (meal.leftoverOf) return res.status(400).json({ error: "A leftover meal follows its original meal's recipe." });
      if (hasLeftovers) return res.status(409).json({ error: "This meal has leftovers planned. Remove them before changing its recipe." });
      const found = recipeForMeal(userId, recipeId);
      if ("error" in found) return res.status(found.status).json({ error: found.error });
      attachRecipe(meal, found.recipe);
    } else if (createRecipe === true && !meal.recipeId) {
      // The recipe flow for a meal that only has a name: a joint recipe from its ingredient names, then its calories.
      const made = await ensureJointRecipe(appDb, userId, { name: meal.name, ingredients: meal.ingredients }, getRecipeModel());
      attachRecipe(meal, made.recipe);
    }

    if (status === "approved" && meal.status !== "approved" && !meal.recipeId) {
      return res.status(400).json({ error: NEEDS_RECIPE });
    }
    if (status !== undefined) meal.status = status;
    if (newDay) meal.day = newDay;
    if (newSlot) meal.slot = newSlot;
    if (audience !== undefined) {
      meal.audience = audience;
      meal.memberId = audience === "individual" ? String(memberId) : undefined;
    }
    plan.updatedAt = new Date().toISOString();
    // The plan and the diary entries it causes are saved together (see commitPlanChange).
    const sync = commitPlanChange(userId, plan, [{ prev, next: meal }], listMembers(userId));
    res.json({ ...fullResponse(userId, plan), sync });
  } catch (err) {
    diaryError(res, err);
  }
});

// Lets a person split one meal off for themselves (or reassign it back to the
// family) directly from the UI, without going through the assistant -- the
// only other way to write meal_plans is create_meal_plan's whole-week replace.
//
// Every meal points at a recipe (decision 2). Send `recipeId` to use one (a joint recipe), or just a `name` (and
// optionally `ingredients`): then a joint recipe of that name is used if there is one, or made through the
// recipe flow -- ingredient lines, foods linked where the match is clearly right, a flagged estimate for the
// rest -- so the meal has calories whenever they can be worked out.
mealPlanRoutes.post("/meals", async (req, res) => {
  const userId = currentUserId(req);
  const { day, slot, name, ingredients, audience, memberId, recipeId } = req.body || {};

  const normalizedDay = normalizeDay(day);
  if (!normalizedDay) return res.status(400).json({ error: "day must be a day of the week" });
  const normalizedSlot = normalizeSlot(slot);
  if (!normalizedSlot) return res.status(400).json({ error: SLOT_ERROR });
  if (recipeId === undefined && (!name || typeof name !== "string" || !name.trim())) {
    return res.status(400).json({ error: "name is required" });
  }
  if (audience === "individual" && !memberId) {
    return res.status(400).json({ error: "memberId is required when audience is individual" });
  }

  // Adding to a week nobody has planned yet starts that week's plan (the calendar's empty slots).
  const week = req.query.weekStart === undefined ? null : mondayOf(req.query.weekStart);
  let plan = planForRequest(req, userId);
  if (!plan && week) {
    const now = new Date().toISOString();
    plan = { id: newId("mealplan"), weekStart: week, meals: [], scope: "joint", createdBy: userId, createdAt: now, updatedAt: now };
  }
  if (!plan) return res.status(404).json({ error: "No meal plan saved yet -- ask the assistant to plan the week first." });

  const meal: PlannedMeal = {
    id: newId("meal"),
    day: normalizedDay,
    slot: normalizedSlot,
    name: typeof name === "string" ? name.trim() : "",
    ingredients: Array.isArray(ingredients) ? ingredients.map((i: unknown) => String(i).trim()).filter(Boolean) : [],
    status: "proposed",
    audience: audience === "individual" ? "individual" : "family",
    memberId: audience === "individual" ? String(memberId) : undefined,
  };
  try {
    if (recipeId !== undefined) {
      const found = recipeForMeal(userId, recipeId);
      if ("error" in found) return res.status(found.status).json({ error: found.error });
      attachRecipe(meal, found.recipe);
    } else {
      const made = await ensureJointRecipe(appDb, userId, { name: meal.name, ingredients: meal.ingredients }, getRecipeModel());
      // A recipe that already existed under this name keeps its own ingredient list; a typed list is kept when
      // the recipe came out empty (a name-only meal).
      meal.recipeId = made.recipe.id;
      meal.name = made.recipe.name;
      if (made.recipe.ingredients.length > 0) meal.ingredients = [...made.recipe.ingredients];
    }
    plan.meals.push(meal);
    plan.updatedAt = new Date().toISOString();
    const sync = commitPlanChange(userId, plan, [{ prev: null, next: meal }], listMembers(userId));
    res.json({ ...fullResponse(userId, plan), sync });
  } catch (err) {
    diaryError(res, err);
  }
});

// Removes one meal from the current plan -- used when merging a split-off
// individual meal back into an existing family meal for the same day/slot
// would otherwise leave two "family" entries for the same slot. Its leftover
// meals go with it (they are leftovers OF it), and whatever is still only
// planned in a food diary for them is removed; anything logged stays.
mealPlanRoutes.delete("/meals/:mealId", (req, res) => {
  const userId = currentUserId(req);
  const plan = planForRequest(req, userId);
  const meal = plan?.meals.find((m) => m.id === req.params.mealId);
  if (!plan || !meal) return res.status(404).json({ error: "Meal not found" });

  const gone = plan.meals.filter((m) => m.id === meal.id || m.leftoverOf === meal.id);
  plan.meals = plan.meals.filter((m) => !gone.includes(m));
  plan.updatedAt = new Date().toISOString();
  try {
    const sync = commitPlanChange(userId, plan, gone.map((m) => ({ prev: m, next: null })), listMembers(userId));
    res.json({ ...fullResponse(userId, plan), sync });
  } catch (err) {
    diaryError(res, err);
  }
});

// Fills a denied meal's slot with one saved recipe (mealRefill.ts has the rules). The replacement is proposed like any
// new meal, in the same day, slot and audience; the denied meal goes, and its leftovers with it (as DELETE does).
// When no recipe qualifies nothing changes. Calorie room is only used to rank: how much room anyone has is never sent.
// Shared by the route below and the assistant's replace_denied_meal tool, so they can't disagree.
export type ReplaceDeniedResult =
  | { ok: true; meal: PlannedMeal; sync: ReturnType<typeof commitPlanChange> }
  | { ok: false; status: number; error: string };

export function replaceDeniedMeal(userId: string, plan: MealPlan, mealId: string): ReplaceDeniedResult {
  const denied = plan.meals.find((m) => m.id === mealId);
  if (!denied) return { ok: false, status: 404, error: "Meal not found" };
  if (denied.status !== "denied") return { ok: false, status: 409, error: "Only a denied meal can be replaced." };
  if (denied.leftoverOf) return { ok: false, status: 400, error: "A leftover follows its original meal. Replace that meal instead." };

  const members = listMembers(userId);
  const recipes = (getScopedItems("recipes", userId) as Recipe[])
    .filter((r) => "recipe" in recipeForMeal(userId, r.id))
    .map((r) => ({ id: r.id, name: r.name, ingredients: r.ingredients, kcalPerServing: kcalPerServing(r) }));

  // The room left that day for the people this meal is for; for the whole family, the tightest of them.
  const date = addDays(plan.weekStart, Math.max(0, DAYS.indexOf(denied.day)));
  const onlyLogin = denied.audience === "individual" ? members.find((m) => m.id === denied.memberId)?.userId : undefined;
  const rooms = weekCalories(appDb, userId, plan.weekStart, new Date(), { everyone: true }).people
    .filter((p) => denied.audience !== "individual" || p.userId === onlyLogin)
    .map((p) => p.days.find((d) => d.date === date)?.roomKcal)
    .filter((r): r is number => typeof r === "number");

  const pick = pickReplacement({
    denied,
    planMeals: plan.meals,
    recipes,
    members,
    pantry: pantryNames(userId),
    roomKcal: rooms.length > 0 ? Math.min(...rooms) : null,
  });
  if (!pick) {
    return { ok: false, status: 409, error: "No saved recipe fits here: each one is already planned this week, was refused, or has an ingredient someone it's for dislikes." };
  }

  const replacement: PlannedMeal = {
    id: newId("meal"),
    day: denied.day,
    slot: denied.slot,
    name: "",
    ingredients: [],
    status: "proposed",
    audience: denied.audience ?? "family",
    memberId: denied.audience === "individual" ? denied.memberId : undefined,
  };
  const found = recipeForMeal(userId, pick.id);
  if ("error" in found) return { ok: false, status: found.status, error: found.error };
  attachRecipe(replacement, found.recipe);

  const gone = plan.meals.filter((m) => m.id === denied.id || m.leftoverOf === denied.id);
  plan.meals = [...plan.meals.filter((m) => !gone.includes(m)), replacement];
  plan.updatedAt = new Date().toISOString();
  const sync = commitPlanChange(
    userId, plan,
    [...gone.map((m) => ({ prev: m, next: null })), { prev: null, next: replacement }],
    members,
  );
  return { ok: true, meal: replacement, sync };
}

mealPlanRoutes.post("/meals/:mealId/replace-denied", (req, res) => {
  const userId = currentUserId(req);
  const plan = planForRequest(req, userId);
  if (!plan) return res.status(404).json({ error: "Meal not found" });
  try {
    const out = replaceDeniedMeal(userId, plan, String(req.params.mealId));
    if (!out.ok) return res.status(out.status).json({ error: out.error });
    res.json({ ...fullResponse(userId, plan), meal: out.meal, sync: out.sync });
  } catch (err) {
    diaryError(res, err);
  }
});

// The meals a planned meal can use: the four standard ones plus any custom meal a diary login has.
mealPlanRoutes.get("/slots", (_req, res) => {
  res.json({ slots: planSlotOptions(appDb) });
});

// Leftovers (decision 6). When a recipe makes more servings than the household eats at that meal, offer the rest
// as a later lunch or dinner in the same week. Nothing is written by the offer.
mealPlanRoutes.get("/meals/:mealId/leftover-offer", (req, res) => {
  const userId = currentUserId(req);
  const plan = planForRequest(req, userId);
  const meal = plan?.meals.find((m) => m.id === req.params.mealId);
  if (!plan || !meal) return res.status(404).json({ error: "Meal not found" });
  const rec = meal.recipeId ? getRecipeRecord(appDb, meal.recipeId) : undefined;
  if (!rec) return res.status(409).json({ error: "This meal has no recipe, so there is no serving count to work leftovers out from." });
  res.json({ offer: leftoverOffer(plan, meal, rec.doc, listMembers(userId)) });
});

// Adds the leftover meal: "Leftover <dish>" on a free later lunch or dinner (default: the offer's suggestion), the
// same recipe, no ingredients (so no shopping), the same audience, proposed like any new meal.
mealPlanRoutes.post("/meals/:mealId/leftovers", (req, res) => {
  const userId = currentUserId(req);
  const plan = planForRequest(req, userId);
  const source = plan?.meals.find((m) => m.id === req.params.mealId);
  if (!plan || !source) return res.status(404).json({ error: "Meal not found" });
  const rec = source.recipeId ? getRecipeRecord(appDb, source.recipeId) : undefined;
  if (!rec) return res.status(409).json({ error: "This meal has no recipe, so there is no serving count to work leftovers out from." });

  const members = listMembers(userId);
  const offer = leftoverOffer(plan, source, rec.doc, members);
  if (offer.servingsLeft < 1) return res.status(409).json({ error: offer.reason ?? "There are no servings left over." });

  let day = offer.suggestion?.day;
  let slot = offer.suggestion?.slot;
  if (req.body?.day !== undefined || req.body?.slot !== undefined) {
    day = normalizeDay(req.body?.day) ?? undefined;
    slot = typeof req.body?.slot === "string" ? req.body.slot.trim().toLowerCase() : undefined;
    if (!day) return res.status(400).json({ error: "day must be a day of the week" });
    if (!slot) return res.status(400).json({ error: "slot must be lunch or dinner" });
    const bad = checkLeftoverCell(plan, source, day, slot);
    if (bad) return res.status(bad.endsWith("already has a meal.") ? 409 : 400).json({ error: bad });
  }
  if (!day || !slot) return res.status(409).json({ error: offer.reason ?? "There is no free lunch or dinner later this week." });

  const leftover: PlannedMeal = {
    id: newId("meal"),
    day,
    slot,
    name: `Leftover ${source.name}`,
    ingredients: [],
    status: "proposed",
    audience: source.audience ?? "family",
    memberId: source.audience === "individual" ? source.memberId : undefined,
    recipeId: rec.doc.id,
    leftoverOf: source.id,
  };
  plan.meals.push(leftover);
  plan.updatedAt = new Date().toISOString();
  try {
    const sync = commitPlanChange(userId, plan, [{ prev: null, next: leftover }], members);
    res.json({ ...fullResponse(userId, plan), meal: leftover, sync });
  } catch (err) {
    diaryError(res, err);
  }
});

// The UI's own "add to shopping list" button. The user already clicked it, so
// there's no reason to route the request through the assistant.
mealPlanRoutes.post("/add-missing", (req, res) => {
  const userId = currentUserId(req);
  const { listId } = req.body || {};

  const plan = planForRequest(req, userId);
  if (!plan) return res.status(404).json({ error: "No meal plan saved yet." });

  if (computeMissing(plan.meals, pantryNames(userId)).length === 0) {
    return res.status(400).json({ error: "Nothing is missing -- the pantry covers this plan." });
  }

  const list = (getScopedItems("shopping_lists", userId) as ShoppingList[]).find((l) => l.id === listId);
  if (!list) return res.status(404).json({ error: "List not found" });

  const { added, alreadyOnList } = addMissingToList(userId, plan, list);
  res.json({ list, added, alreadyOnList });
});

// Meal and snack requests are the same thing in two tables, so one handler pair serves both.
function createRequest(table: "meal_requests" | "snack_requests", idPrefix: string) {
  return (req: express.Request, res: express.Response) => {
  const userId = currentUserId(req);
  const { name, notes, memberId } = req.body || {};
  if (!name || typeof name !== "string" || !name.trim()) {
    return res.status(400).json({ error: "name is required" });
  }
  if (memberId && !listMembers(userId).some((m) => m.id === memberId)) {
    return res.status(400).json({ error: "No household member with that id" });
  }

  const now = new Date().toISOString();
  const request: MealRequest = {
    id: newId(idPrefix),
    name: name.trim(),
    notes: typeof notes === "string" ? notes.trim() : "",
    memberId: memberId ? String(memberId) : undefined,
    scope: "joint",
    createdBy: userId,
    createdAt: now,
    updatedAt: now,
  };
  putScopedItem(table, userId, request);

  res.json(fullResponse(userId, planForRequest(req, userId)));
  };
}

function deleteRequest(table: "meal_requests" | "snack_requests", label: string) {
  return (req: express.Request, res: express.Response) => {
    const userId = currentUserId(req);
    const deleted = deleteScopedItem(table, userId, req.params.id);
    if (!deleted) return res.status(404).json({ error: `${label} request not found` });
    res.json(fullResponse(userId, planForRequest(req, userId)));
  };
}

mealPlanRoutes.post("/requests", createRequest("meal_requests", "mealreq"));
mealPlanRoutes.delete("/requests/:id", deleteRequest("meal_requests", "Meal"));
mealPlanRoutes.post("/snack-requests", createRequest("snack_requests", "snackreq"));
mealPlanRoutes.delete("/snack-requests/:id", deleteRequest("snack_requests", "Snack"));

// Saves one recipe, replacing any existing one with the same name -- the same
// upsert-by-name the assistant's save_recipe tool does, so typing a recipe in
// by hand and having the assistant save it end up in one row, not two.
// (The work lives in nutrition/data/recipes.ts, shared with the assistant: it keeps the
// recipe's lines, yield and food links, and rewrites its read-only food when calories change.)
function upsertRecipe(userId: string, name: string, ingredients: string[], extras: Partial<RecipeInput> = {}): Recipe {
  return upsertRecipeByName(appDb, userId, { name, ingredients, ...extras });
}

/** A NutritionError from the recipe data layer as the JSON error this router's other routes send. */
function recipeError(res: express.Response, err: unknown) {
  if (err instanceof NutritionError) return res.status(err.status).json({ error: err.message });
  throw err;
}

const finite = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/**
 * What an import row may carry beyond a name and ingredient names (the preview the user confirmed
 * sends back what /recipes/parse and /recipes/from-url found): the lines as written, the yield, the
 * page it came from, the steps, and the page's own calories. Anything malformed is just left out.
 */
function importExtras(row: any): Partial<RecipeInput> {
  const out: Partial<RecipeInput> = {};
  if (Array.isArray(row?.lines)) {
    const lines = row.lines
      .slice(0, MAX_LINES)
      .map((l: any) => ({ text: String(l?.text ?? "").trim().slice(0, 300), pantryName: String(l?.pantryName ?? "").trim().slice(0, 120) }))
      .filter((l: { text: string; pantryName: string }) => l.text && l.pantryName);
    if (lines.length > 0) out.lines = lines;
  }
  const y = finite(row?.yieldServings);
  if (y !== undefined && y >= 1 && y <= 1000) out.yieldServings = Math.round(y);
  // Steps as a list (the preview sends back what /recipes/parse found) or as text, one step per line.
  const steps = cleanInstructions(row?.instructions);
  if (steps.length > 0) out.instructions = steps;
  if (typeof row?.sourceUrl === "string" && row.sourceUrl.length <= 500) {
    try {
      const u = new URL(row.sourceUrl);
      if (u.protocol === "http:" || u.protocol === "https:") out.sourceUrl = u.toString();
    } catch {
      // not a web address: leave it out
    }
  }
  const kcal = finite(row?.nutrition?.siteKcalPerServing);
  if (kcal !== undefined && kcal > 0 && kcal <= 5000) {
    const nutrients = { ...emptyNutrients(), kcal };
    for (const k of NUTRIENT_KEYS) {
      const v = finite(row.nutrition?.perServing?.[k]);
      if (k !== "kcal" && v !== undefined && v >= 0 && v <= 100_000) nutrients[k] = v;
    }
    out.site = { kcal, nutrients };
  }
  if (row?.scope === "personal") out.scope = "personal";
  return out;
}

function cleanIngredientList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : String(value ?? "").split(/[,\n;]/);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    const name = String(entry ?? "").trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

mealPlanRoutes.post("/recipes", requireKioskPin, (req, res) => {
  const userId = currentUserId(req);
  const { name, ingredients } = req.body || {};
  const dish = String(name ?? "").trim();
  if (!dish) return res.status(400).json({ error: "A recipe needs a name." });

  const cleaned = cleanIngredientList(ingredients);
  if (cleaned.length === 0) return res.status(400).json({ error: "A recipe needs at least one ingredient." });

  // "How to make it": optional, a list of steps or text with one step per line.
  const steps = cleanInstructions(req.body?.instructions);
  try {
    // scope: "personal" makes it visible to the person who saved it and nobody else.
    res.json({
      recipe: upsertRecipe(userId, dish, cleaned, {
        ...(req.body?.scope === "personal" ? { scope: "personal" as const } : {}),
        ...(steps.length > 0 ? { instructions: steps } : {}),
      }),
    });
  } catch (err) {
    recipeError(res, err);
  }
});

// Bulk import. Takes already-parsed recipes so the three offline sources
// (typed, pasted, uploaded) share one write path, and so the preview the user
// confirms is exactly what gets saved rather than something re-parsed here.
mealPlanRoutes.post("/recipes/import", requireKioskPin, (req, res) => {
  const userId = currentUserId(req);
  const rows = Array.isArray(req.body?.recipes) ? req.body.recipes : null;
  if (!rows) return res.status(400).json({ error: "Expected a list of recipes to import." });
  if (rows.length > 200) return res.status(400).json({ error: "That's more than 200 recipes -- import them in smaller batches." });

  const saved: Recipe[] = [];
  const skipped: string[] = [];
  for (const row of rows) {
    const dish = String(row?.name ?? "").trim();
    const cleaned = cleanIngredientList(row?.ingredients);
    const extras = importExtras(row);
    if (!dish || (cleaned.length === 0 && !extras.lines)) {
      skipped.push(dish || "(unnamed)");
      continue;
    }
    try {
      saved.push(upsertRecipe(userId, dish, cleaned, extras));
    } catch (err) {
      if (!(err instanceof NutritionError)) throw err;
      skipped.push(dish); // e.g. a same-named recipe that is someone else's personal one
    }
  }
  res.json({ imported: saved.length, skipped, recipes: getScopedItems("recipes", userId) });
});

// Parses pasted text or an uploaded file's contents and hands back what it
// found WITHOUT saving. Parsing lives here rather than in the browser so there
// is one implementation of it: a second copy in TSX would drift from this one
// the first time either changed, which is the same failure the duplicated
// member editor produced.
mealPlanRoutes.post("/recipes/parse", (req, res) => {
  const { text, filename, content } = req.body || {};

  try {
    if (typeof content === "string" && content.trim()) {
      const found = parseRecipesFromFile(String(filename ?? ""), content);
      if (found.length === 0) return res.status(422).json({ error: "No recipes found in that file." });
      return res.json({ recipes: found });
    }

    if (typeof text === "string" && text.trim()) {
      const found = parseRecipeText(text);
      if (!found) {
        return res.status(422).json({
          error: "Couldn't read that. Put the dish name on the first line and the ingredients below it.",
        });
      }
      return res.json({ recipes: [found] });
    }

    return res.status(400).json({ error: "Paste a recipe, or choose a file." });
  } catch (err: any) {
    // The parsers throw with a message naming what's wrong with the file (a
    // missing column, invalid JSON) -- worth more to the user than a generic
    // failure, and none of it exposes anything about the server.
    return res.status(422).json({ error: err?.message || "Couldn't read that file." });
  }
});

// Reads a recipe page and hands back what it found WITHOUT saving it -- the
// user confirms the preview, then POSTs to /recipes/import above. A page this
// server fetched on someone's behalf shouldn't write rows on its own.
mealPlanRoutes.post("/recipes/from-url", async (req, res) => {
  const url = String(req.body?.url ?? "").trim();
  if (!url) return res.status(400).json({ error: "Paste a link to a recipe." });

  try {
    const html = await pageFetcher.fetch(url);
    const found = extractRecipesFromHtml(html);
    if (found.length === 0) {
      return res.status(422).json({
        error: "Couldn't find a recipe on that page. Copy the recipe text and paste it instead.",
      });
    }
    // Remember where each came from, so it can be opened again (and re-imported) later.
    res.json({ recipes: found.map((r) => ({ ...r, sourceUrl: url })) });
  } catch (err: any) {
    // These messages are written for the person who pasted the link, and the
    // guard's refusals ("resolves to a private network") are safe to show --
    // they describe the rule, not what is actually running on that address.
    res.status(400).json({ error: err?.message || "Couldn't import from that link." });
  }
});

// What the delete confirmation says: how many planned meals use the recipe (leftovers not counted), and how many of
// those are in a week that is not over yet. Anyone who can see the recipe may ask.
mealPlanRoutes.get("/recipes/:id/usage", (req, res) => {
  try {
    const rec = requireRecipe(appDb, currentUserId(req), req.params.id);
    res.json(recipeUsage(appDb, rec.doc.id));
  } catch (err) {
    recipeError(res, err);
  }
});

// Edit a recipe's own fields: name, ingredient lines (text; `from` is the old position so a typo fix keeps its calorie
// link and a changed amount or food drops it), steps, tags, times, notes, yield, source link, who it is shared with.
// Needs no food diary login (the calorie editor, PUT /api/nutrition/recipes/:id, does). A kiosk login needs the PIN.
// The answer says how many calorie links an edit dropped (`relink`) so the screen can say they need doing again.
mealPlanRoutes.patch("/recipes/:id", requireKioskPin, (req, res) => {
  const userId = currentUserId(req);
  try {
    const rec = requireRecipe(appDb, userId, req.params.id);
    const { doc, relink } = applyRecipePatch(appDb, userId, rec, bodyObject(req.body), "text");
    res.json({ recipe: saveRecipe(appDb, userId, doc), relink });
  } catch (err) {
    recipeError(res, err);
  }
});

// A copy for the caller: "<name> (copy)", same lines, links, steps and tags, no marks.
mealPlanRoutes.post("/recipes/:id/duplicate", requireKioskPin, (req, res) => {
  const userId = currentUserId(req);
  try {
    let copy = duplicateRecipeDoc(appDb, userId, req.params.id);
    const photoAt = copyRecipePhoto(appDb, req.params.id, copy.id);
    if (photoAt) copy = saveRecipe(appDb, userId, { ...copy, photoAt });
    res.status(201).json({ recipe: copy });
  } catch (err) {
    recipeError(res, err);
  }
});

// A recipe's photo. Kept in the database (migration 14); whoever can see the recipe can see its photo, and a personal
// recipe's photo is a 404 to everyone else. PUT { data: <base64>, mime? } (at most 1 MB; the browser shrinks it first).
mealPlanRoutes.get("/recipes/:id/photo", (req, res) => {
  try {
    const photo = getRecipePhoto(appDb, currentUserId(req), req.params.id);
    res.setHeader("Content-Type", photo.mime);
    // "private, no-cache": a browser someone else signs into later never shows it from cache without asking first.
    res.setHeader("Cache-Control", "private, no-cache");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.send(photo.bytes);
  } catch (err) {
    recipeError(res, err);
  }
});

mealPlanRoutes.put("/recipes/:id/photo", requireKioskPin, (req, res) => {
  try {
    res.json({ recipe: setRecipePhoto(appDb, currentUserId(req), req.params.id, req.body) });
  } catch (err) {
    recipeError(res, err);
  }
});

mealPlanRoutes.delete("/recipes/:id/photo", requireKioskPin, (req, res) => {
  try {
    res.json({ recipe: deleteRecipePhoto(appDb, currentUserId(req), req.params.id) });
  } catch (err) {
    recipeError(res, err);
  }
});

// This login's own favourite star and 1-5 rating: { favorite?: boolean, rating?: 1-5 | null }. Per person, so it needs no
// PIN and nobody else sees it; the kiosk has no marks (403).
mealPlanRoutes.put("/recipes/:id/mark", forbidKiosk, (req, res) => {
  try {
    res.json({ mark: setMark(appDb, currentUserId(req), req.params.id, req.body) });
  } catch (err) {
    recipeError(res, err);
  }
});

// Re-reads the page a recipe came from and says what it holds NOW, and what differs from what is saved. A preview only:
// nothing is written (the screen applies the parts someone ticks through PATCH), so no PIN is asked.
mealPlanRoutes.post("/recipes/:id/refresh-from-url", async (req, res) => {
  try {
    const rec = requireRecipe(appDb, currentUserId(req), req.params.id);
    const url = rec.doc.sourceUrl;
    if (!url) return res.status(400).json({ error: "This recipe has no source link to refresh from." });
    const html = await pageFetcher.fetch(url);
    const page = pickPageRecipe(extractRecipesFromHtml(html), rec.doc.name);
    if (!page) return res.status(422).json({ error: "Couldn't find this recipe on that page any more." });
    const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x.trim().toLowerCase() === b[i].trim().toLowerCase());
    const lines = (page.lines ?? page.ingredients.map((i) => ({ text: i, pantryName: i }))).map((l) => l.text);
    const instructions = page.instructions ?? [];
    res.json({
      sourceUrl: url,
      page: { name: page.name, lines, instructions, yieldServings: page.yieldServings ?? null },
      differs: {
        lines: !same(lines, (rec.doc.lines ?? []).map((l) => l.text).length ? (rec.doc.lines ?? []).map((l) => l.text) : rec.doc.ingredients),
        instructions: !same(instructions, rec.doc.instructions ?? []),
        yieldServings: page.yieldServings !== undefined && page.yieldServings !== rec.doc.yieldServings,
      },
    });
  } catch (err: any) {
    if (err instanceof NutritionError) return recipeError(res, err);
    res.status(400).json({ error: err?.message || "Couldn't read that link." });
  }
});

mealPlanRoutes.delete("/recipes/:id", requireKioskPin, (req, res) => {
  // Also soft-deletes the recipe's food; entries already logged keep their snapshots.
  const deleted = deleteRecipeDoc(appDb, currentUserId(req), req.params.id);
  if (!deleted) return res.status(404).json({ error: "Recipe not found" });
  res.json({ success: true });
});

mealPlanRoutes.delete("/:id", (req, res) => {
  const userId = currentUserId(req);
  const plan = (getScopedItems("meal_plans", userId) as MealPlan[]).find((p) => p.id === req.params.id);
  // The plan's meals take their still-planned diary entries with them; what was logged stays.
  const deleted = plan ? removePlanAndEntries(userId, plan) : false;
  if (!deleted) return res.status(404).json({ error: "Meal plan not found" });
  res.json({ success: true });
});

/** Shared with the assistant tool so both build meals the same way. */
export function buildMealPlan(
  userId: string,
  weekStart: string,
  meals: PlannedMeal[],
  existing?: MealPlan
): MealPlan {
  const now = new Date().toISOString();
  return {
    id: existing?.id || newId("mealplan"),
    weekStart: String(weekStart).trim(),
    meals,
    scope: "joint",
    createdBy: existing?.createdBy || userId,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
}
