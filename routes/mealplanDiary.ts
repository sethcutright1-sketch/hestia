// The meal plan's link to the food diaries (merge plan phase 4): who a planned meal is for, saving a plan change
// together with the diary entries it causes, and leftovers.
//
// The plan itself is household-app's (routes/mealplan.ts: one `meal_plans` JSON document per week). This file is
// the glue between that and nutrition/data/mealPlanSync.ts, which knows diaries but not the plan:
//
//   - WHO. A "family" meal is for every admin/parent login (everyone who can keep a diary). An "individual" meal
//     is for the roster member's linked login (HouseholdMember.userId, set by an admin in the Family tab). A member
//     with no linked login has no diary: the meal still exists, nobody gets an entry, and the answer says so.
//   - SAVING. commitPlanChange writes the plan document and re-syncs the diary entries of the meals that changed
//     inside ONE transaction, so a plan change and its entries happen together or not at all.
//   - LEFTOVERS. A recipe that makes more servings than the household eats at a meal leaves some over; the plan
//     can offer them as a later lunch or dinner in the same week, with no shopping-list ingredients of its own.
//
// Nothing here reads the grocery money budget or a person's calorie budget.

import { db as appDb, putScopedItem, deleteScopedItem, getScopedItems } from "../db.ts";
import { NutritionError } from "../nutrition/data/errors.ts";
import {
  dropMealsEntries, emptySyncReport, syncMealEntries, type SyncMeal, type SyncReport,
} from "../nutrition/data/mealPlanSync.ts";
import { planDayDate } from "../nutrition/data/planDocs.ts";
import { slotKind, type SlotKind } from "../nutrition/data/planSlots.ts";
import { DAY_NAMES, cellRank, dayIndex } from "../nutrition/planCells.ts";
import { getRecipeRecord, yieldOf } from "../nutrition/data/recipes.ts";
import { all, tx } from "../nutrition/data/sql.ts";
import type { RecipeDoc } from "../nutrition/recipeModel.ts";
import type { HouseholdMember } from "./members.ts";
import type { MealPlan, PlannedMeal } from "./mealplan.ts";

/** Every login that keeps a food diary (admin and parent), oldest account first. */
export function trackerLoginIds(): string[] {
  return all<{ id: string }>(appDb, "SELECT id FROM users WHERE role IN ('admin', 'parent') ORDER BY created_at, rowid").map((r) => r.id);
}

/** The logins a meal is for, and the reasons part of its audience can't be reached. */
export function mealTargets(meal: PlannedMeal, members: HouseholdMember[]): { userIds: string[]; notTargeted: string[] } {
  if ((meal.audience ?? "family") !== "individual") return { userIds: trackerLoginIds(), notTargeted: [] };
  const member = members.find((m) => m.id === meal.memberId);
  if (!member) return { userIds: [], notTargeted: ["The person this meal is for isn't on the Family list any more, so it went to nobody's food diary."] };
  if (!member.userId) {
    return { userIds: [], notTargeted: [`${member.name} isn't linked to a login, so there is no food diary to put this in. Link them in the Family tab.`] };
  }
  return { userIds: [member.userId], notTargeted: [] };
}

/** A planned meal as the diaries need it. */
export function toSyncMeal(plan: Pick<MealPlan, "weekStart">, meal: PlannedMeal, members: HouseholdMember[]): SyncMeal {
  const t = mealTargets(meal, members);
  return {
    id: meal.id,
    date: planDayDate(plan.weekStart, meal.day),
    slotKey: meal.slot,
    recipeId: meal.recipeId ?? null,
    status: meal.status,
    targetUserIds: t.userIds,
    notTargeted: t.notTargeted,
  };
}

export function mergeReports(reports: SyncReport[]): SyncReport {
  const out = emptySyncReport();
  for (const r of reports) {
    out.created.push(...r.created);
    out.removed += r.removed;
    out.kept += r.kept;
    out.alreadyLogged.push(...r.alreadyLogged);
    out.skipped.push(...r.skipped);
    out.slotFallbacks.push(...r.slotFallbacks);
    if (r.note) out.note = out.note ? `${out.note} ${r.note}` : r.note;
  }
  return out;
}

export interface MealChange {
  prev: PlannedMeal | null;
  next: PlannedMeal | null;
}

/**
 * Save `plan` and bring the diaries in line with `changes`, all in one transaction. The diary side is checked
 * before it writes, and a failure there (a recipe that is gone or personal) rolls the plan write back too, so
 * the caller can turn the NutritionError into a 400 and nothing has changed. `removedMeals` are meals that left
 * the plan with it (a replaced week): their still-planned entries are removed.
 */
export function commitPlanChange(
  userId: string, plan: MealPlan, changes: MealChange[], members: HouseholdMember[], opts: { removedMeals?: PlannedMeal[]; now?: Date } = {},
): SyncReport {
  return tx(appDb, () => {
    putScopedItem("meal_plans", userId, plan);
    const reports = changes.map((c) =>
      syncMealEntries(appDb, {
        prev: c.prev ? toSyncMeal(plan, c.prev, members) : null,
        next: c.next ? toSyncMeal(plan, c.next, members) : null,
        now: opts.now,
      }));
    if (opts.removedMeals?.length) reports.push(dropMealsEntries(appDb, opts.removedMeals.map((m) => m.id), opts.now));
    return mergeReports(reports);
  });
}

/** Delete a whole plan document and the still-planned entries of its meals (what people logged stays). */
export function removePlanAndEntries(userId: string, plan: MealPlan): boolean {
  return tx(appDb, () => {
    const gone = deleteScopedItem("meal_plans", userId, plan.id);
    if (gone) dropMealsEntries(appDb, plan.meals.map((m) => m.id));
    return gone;
  });
}

/**
 * The roster changed (a member linked to a login, unlinked, or removed): re-sync every approved individual
 * meal of the members whose audience just moved. Failures of one meal (a recipe deleted long ago) are reported,
 * never thrown, so a roster edit can't be blocked by a stale plan.
 */
export function resyncAfterRosterChange(userId: string, before: HouseholdMember[], after: HouseholdMember[]): { problems: string[] } {
  const problems: string[] = [];
  for (const plan of getScopedItems("meal_plans", userId) as MealPlan[]) {
    for (const meal of plan.meals) {
      if (meal.status !== "approved" || (meal.audience ?? "family") !== "individual") continue;
      const prev = toSyncMeal(plan, meal, before);
      const next = toSyncMeal(plan, meal, after);
      if (prev.targetUserIds.join() === next.targetUserIds.join()) continue;
      try {
        syncMealEntries(appDb, { prev, next });
      } catch (err) {
        if (!(err instanceof NutritionError)) throw err;
        problems.push(`${meal.name} (${meal.day}): ${err.message}`);
      }
    }
  }
  return { problems };
}

// ---- leftovers (decision 6) --------------------------------------------------------------------------

/** How many people eat a meal: the whole roster for a family meal (else the diary logins if there is no roster), one for an individual one. */
export function headcountOf(meal: Pick<PlannedMeal, "audience">, members: HouseholdMember[]): number {
  if ((meal.audience ?? "family") === "individual") return 1;
  return members.length || trackerLoginIds().length || 1;
}

const LEFTOVER_SLOTS: SlotKind[] = ["lunch", "dinner"];

export interface LeftoverOffer {
  mealId: string;
  name: string;
  recipeId: string;
  /** Servings the recipe makes, and whether that is only the assumed default. */
  yieldServings: number;
  yieldAssumed: boolean;
  /** How many people eat the meal itself. */
  headcount: number;
  /** Servings still unclaimed after the meal and any leftover meals already planned from it. */
  servingsLeft: number;
  /** Why there is no offer, when there isn't. */
  reason?: string;
  /** The first free later lunch or dinner in the same week, and the other free ones. */
  suggestion: { day: string; slot: string } | null;
  alternatives: Array<{ day: string; slot: string }>;
}

/** Is the day/slot cell free for a meal with this audience? A denied meal doesn't occupy it. */
function cellFree(plan: MealPlan, day: string, slot: string, audience: "family" | "individual", memberId?: string): boolean {
  return !plan.meals.some((m) => {
    if (m.day !== day || m.slot !== slot || m.status === "denied") return false;
    const a = m.audience ?? "family";
    if (audience === "family") return a === "family";
    return a === "family" || m.memberId === memberId; // a person's own cell is taken by the family meal or their own
  });
}

/** Leftovers a recipe's surplus could become: nothing is written. */
export function leftoverOffer(plan: MealPlan, meal: PlannedMeal, recipe: RecipeDoc, members: HouseholdMember[]): LeftoverOffer {
  const base = {
    mealId: meal.id, name: meal.name, recipeId: recipe.id, yieldServings: yieldOf(recipe), yieldAssumed: recipe.yieldServings === undefined,
    headcount: headcountOf(meal, members),
  };
  const none = (reason: string, servingsLeft = 0): LeftoverOffer => ({ ...base, servingsLeft, reason, suggestion: null, alternatives: [] });
  if (meal.leftoverOf) return none("This is already a leftover meal.");
  if (meal.status === "denied") return none("This meal was denied.");
  const claimed = plan.meals
    .filter((m) => m.leftoverOf === meal.id && m.status !== "denied")
    .reduce((n, m) => n + headcountOf(m, members), 0);
  const servingsLeft = base.yieldServings - base.headcount - claimed;
  if (servingsLeft < 1) return none(`The recipe makes ${base.yieldServings}, and ${base.headcount + claimed} are already eating it.`, Math.max(0, servingsLeft));

  const from = cellRank(meal.day, meal.slot);
  const cells: Array<{ day: string; slot: string }> = [];
  for (const day of DAY_NAMES) {
    for (const slot of LEFTOVER_SLOTS) {
      if (cellRank(day, slot) > from && cellFree(plan, day, slot, meal.audience ?? "family", meal.memberId)) cells.push({ day, slot });
    }
  }
  if (cells.length === 0) return { ...none("There is no free lunch or dinner later this week.", servingsLeft), servingsLeft };
  return { ...base, servingsLeft, suggestion: cells[0], alternatives: cells.slice(1, 7) };
}

/** Validate a chosen leftover cell: a free lunch or dinner, later in the week than the meal itself. */
export function checkLeftoverCell(plan: MealPlan, meal: PlannedMeal, day: string, slot: string): string | null {
  if (dayIndex(day) < 0) return "day must be a day of the week.";
  if (!LEFTOVER_SLOTS.includes(slotKind(slot)) || !["lunch", "dinner"].includes(slot)) return "Leftovers go on a later lunch or dinner.";
  if (cellRank(day, slot) <= cellRank(meal.day, meal.slot)) return "Leftovers go on a later meal than the one they come from.";
  if (!cellFree(plan, day, slot, meal.audience ?? "family", meal.memberId)) return `${day} ${slot} already has a meal.`;
  return null;
}

export function recipeOfMeal(meal: PlannedMeal) {
  return meal.recipeId ? getRecipeRecord(appDb, meal.recipeId) : undefined;
}
