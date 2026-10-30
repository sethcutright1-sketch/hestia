// Approved meals -> planned diary entries (merge plan decisions 1 and 4), and keeping them in step.
//
// The household meal plan is household-app's: one `meal_plans` JSON document per week, each holding
// PlannedMeals. This file never reads those documents (the routes do; see routes/mealplanDiary.ts). It is
// handed a plain description of a meal before and after a change -- the date, the slot, the recipe, the
// status, and WHICH LOGINS it is for -- and makes the diaries agree:
//
//   - a meal that is APPROVED gives every login in its audience ONE planned entry at 1 serving of the
//     recipe's food, on the meal's date, in the matching slot, source 'plan', carrying meal_plan_id (the
//     PlannedMeal's id) and a group id shared by that meal + person;
//   - a meal that is proposed, denied or deleted gives nobody anything: its entries that are still
//     'planned' are removed;
//   - changing an approved meal (moving its day or slot, swapping its recipe, changing who it is for)
//     re-syncs only THAT meal's entries that are still 'planned'.
//
// What a person has LOGGED is a record of what they ate. It is never touched here, whatever the plan says
// afterwards: not removed, not moved, not edited (the report lists who it left alone, `alreadyLogged`).
// This is the calorie app's Phase 3b machinery (household-suite apps/calories/meal-plan-model.ts) with one
// serving per person and a roster instead of a list of people.
//
// ALL-OR-NOTHING. Everything that can fail (the recipe, each person, each person's slot, the amounts) is
// worked out before the first write, and the writes run in one transaction: a meal's entries all change or
// none do. The route that saves the plan document wraps both in the same transaction, so a plan change and
// its diary entries cannot half-happen either.
//
// A DELETED PLANNED ENTRY. If someone deletes their own planned entry, it stays deleted through every edit
// that doesn't concern their meal (the status, audience and others are unchanged). If the meal itself is
// moved or its recipe changed, or it is approved again, it is a NEW meal for them and they get a fresh
// entry. (The Phase 3b review called this "arguably right: it's a new meal", and it is kept.)
//
// "Budget" anywhere near here is the CALORIE budget; the meal plan's grocery money budget is another
// thing entirely and nothing in this file reads it.

import crypto from "node:crypto";
import { assertCanTrack, canTrack, type Tracker } from "./access.ts";
import { resolveDayCalorieBudget, type EntryRow } from "./days.ts";
import { computeFromFood, insertEntry, updateEntry, type Computed } from "./diary.ts";
import { NutritionError } from "./errors.ts";
import { mapPlanSlot } from "./planSlots.ts";
import { getRecipeRecord, liveRecipeFood } from "./recipes.ts";
import { all, get, run, tx, type Db } from "./sql.ts";
import { getTracker, todayFor } from "./tracker.ts";

export type PlanMealStatus = "proposed" | "approved" | "denied";

/** What the diaries need to know about one planned meal. The caller works out `date` and `targetUserIds`. */
export interface SyncMeal {
  /** The PlannedMeal id: what meal_plan_id on a diary entry holds. */
  id: string;
  /** The calendar date (YYYY-MM-DD) of the meal's day, or null when its week can't be read. */
  date: string | null;
  /** The plan's slot key (a standard one or a household custom meal). */
  slotKey: string;
  recipeId: string | null;
  status: PlanMealStatus;
  /** Logins the meal is for: every admin/parent login (family) or the one linked to the member (individual). */
  targetUserIds: string[];
  /** Why part of the audience can't be reached before any login is looked at ("Ben isn't linked to a login"). */
  notTargeted?: string[];
}

export interface SyncReport {
  /** Planned entries written. */
  created: Array<{ userId: string; name: string; entryId: string; slotKey: string }>;
  /** Planned entries soft-deleted (they were still planned). */
  removed: number;
  /** Planned entries already right, left exactly as they were. */
  kept: number;
  /** People who had already LOGGED this meal and whose entries were left alone because the change would have touched them. */
  alreadyLogged: Array<{ userId: string; name: string }>;
  /** Who got nothing, and why. `userId` is null when the reason is about the audience, not a login. */
  skipped: Array<{ userId: string | null; name?: string; reason: string }>;
  /** A person who lacks the plan's slot and got the nearest standard one. */
  slotFallbacks: Array<{ userId: string; name: string; from: string; to: string }>;
  /** A sentence for the person who made the change when something about the meal means nobody was given an entry. */
  note?: string;
}

export const emptySyncReport = (): SyncReport => ({ created: [], removed: 0, kept: 0, alreadyLogged: [], skipped: [], slotFallbacks: [] });

const sameSet = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x) => b.includes(x));

/** A deterministic group id per meal + person, so the entries a meal made for someone share one (<= 64 safe characters). */
export const planGroupId = (mealId: string, userId: string): string =>
  `plan-${crypto.createHash("sha256").update(`${mealId}:${userId}`).digest("hex").slice(0, 40)}`;

/** Every live entry the plan made for this meal, oldest first. */
export function liveMealEntries(db: Db, mealId: string): EntryRow[] {
  return all<EntryRow>(db,
    "SELECT * FROM nutrition_diary_entries WHERE meal_plan_id = ? AND deleted_at IS NULL ORDER BY logged_at, rowid", mealId);
}

function displayNameOf(db: Db, userId: string): string {
  return get<{ display_name: string }>(db, "SELECT display_name FROM users WHERE id = ?", userId)?.display_name ?? "Someone";
}

interface Prepared {
  tracker: Tracker;
  computed: Computed;
  slotKey: string;
  fellBackFrom?: string;
}

/**
 * Bring the diaries in line with a change to one planned meal. `prev` is the meal as it was (null for a new
 * one) and `next` as it is now (null when it was deleted). Runs in a transaction; throws a NutritionError
 * (nothing written) when the meal can't be put in a diary as it stands -- a recipe that is missing or isn't joint.
 */
export function syncMealEntries(db: Db, input: { prev: SyncMeal | null; next: SyncMeal | null; now?: Date }): SyncReport {
  const { prev, next } = input;
  const now = input.now ?? new Date();
  const report = emptySyncReport();
  const mealId = (next ?? prev)?.id;
  if (!mealId) return report;
  for (const reason of next?.notTargeted ?? []) report.skipped.push({ userId: null, reason });

  // Nothing about the meal that matters to a diary changed: leave every entry alone (this is also what
  // keeps a person's own deleted entry deleted through a name or ingredient edit).
  const unchanged = prev !== null && next !== null && prev.status === next.status && prev.date === next.date
    && prev.slotKey === next.slotKey && prev.recipeId === next.recipeId && sameSet(prev.targetUserIds, next.targetUserIds);
  if (unchanged) return report;

  return tx(db, () => {
    const live = liveMealEntries(db, mealId);
    const entriesOf = (userId: string) => live.filter((e) => e.user_id === userId);
    const wantsEntries = next !== null && next.status === "approved" && next.date !== null;

    // ---- prepare (reads only; throws before anything is written) ----------------------------
    const targets: Prepared[] = [];
    if (wantsEntries) {
      if (!next.recipeId) throw new NutritionError(400, "A meal needs a recipe before it can be approved: pick one or create one.");
      const rec = getRecipeRecord(db, next.recipeId);
      if (!rec) throw new NutritionError(400, "That recipe doesn't exist (any more). Pick or create another one.");
      if (rec.ownerUserId !== null) {
        throw new NutritionError(400, `"${rec.doc.name}" is a personal recipe, and the shared plan would show its name to everyone. Use a joint recipe.`);
      }
      const food = liveRecipeFood(db, next.recipeId);
      if (!food) {
        report.note = `"${rec.doc.name}" has no calories yet, so nothing was put in anyone's food diary. Work out its calories in Recipes and approve it again.`;
      } else {
        for (const userId of [...new Set(next.targetUserIds)]) {
          const user = get<{ id: string; role: string }>(db, "SELECT id, role FROM users WHERE id = ?", userId);
          if (!user) {
            report.skipped.push({ userId, reason: "That login no longer exists, so there is no diary to put it in." });
            continue;
          }
          if (!canTrack(user.role)) {
            report.skipped.push({ userId, name: displayNameOf(db, userId), reason: "Kiosk logins don't keep a food diary." });
            continue;
          }
          const tracker = getTracker(db, userId);
          assertCanTrack(tracker);
          const slot = mapPlanSlot(db, userId, next.slotKey);
          // One serving of the recipe's food. The entry is a snapshot, like any other.
          targets.push({ tracker, computed: computeFromFood(db, food, { quantity: 1 }), slotKey: slot.key, fellBackFrom: slot.fellBackFrom });
        }
      }
    }

    // ---- decide ---------------------------------------------------------------------------------
    const fresh = wantsEntries && (
      !prev || prev.status !== "approved" || prev.date !== next.date || prev.slotKey !== next.slotKey || prev.recipeId !== next.recipeId);
    const drops: EntryRow[] = [];
    const creates: Prepared[] = [];
    const targetIds = new Set(targets.map((t) => t.tracker.id));

    for (const t of targets) {
      const mine = entriesOf(t.tracker.id);
      const logged = mine.filter((e) => e.status === "logged");
      const planned = mine.filter((e) => e.status === "planned");
      if (logged.length > 0) {
        // They ate it. Never touched; they are told only when this change would otherwise have reached them.
        if (fresh) report.alreadyLogged.push({ userId: t.tracker.id, name: t.tracker.displayName });
        continue;
      }
      if (planned.length > 0 && !fresh) {
        report.kept += planned.length;
        continue;
      }
      const wasInAudience = !!prev && prev.status === "approved" && prev.targetUserIds.includes(t.tracker.id);
      if (planned.length === 0 && !fresh && wasInAudience) {
        report.skipped.push({ userId: t.tracker.id, name: t.tracker.displayName, reason: "They deleted their planned entry for this meal, so it stays deleted." });
        continue;
      }
      drops.push(...planned);
      creates.push(t);
    }
    // Everyone with entries who is no longer meant to have one (taken off the audience, or the meal is no longer approved).
    for (const userId of new Set(live.map((e) => e.user_id))) {
      if (targetIds.has(userId) && wantsEntries) continue;
      const mine = entriesOf(userId);
      drops.push(...mine.filter((e) => e.status === "planned"));
      if (mine.some((e) => e.status === "logged")) report.alreadyLogged.push({ userId, name: displayNameOf(db, userId) });
    }

    // ---- write ------------------------------------------------------------------------------------
    const stamp = now.toISOString();
    const touched = new Map<string, { userId: string; date: string }>();
    for (const e of drops) {
      run(db, "UPDATE nutrition_diary_entries SET deleted_at = ?, updated_at = ? WHERE id = ? AND status = 'planned' AND deleted_at IS NULL", stamp, stamp, e.id);
      touched.set(`${e.user_id}|${e.local_date}`, { userId: e.user_id, date: e.local_date });
      report.removed++;
    }
    for (const c of creates) {
      const row = insertEntry(db, c.tracker, {
        id: crypto.randomUUID(), date: next!.date!, slotKey: c.slotKey, status: "planned", source: "plan",
        groupId: planGroupId(mealId, c.tracker.id), c: c.computed, mealPlanId: mealId,
        planSlotKey: c.fellBackFrom ? next!.slotKey : null,
      });
      touched.set(`${c.tracker.id}|${next!.date}`, { userId: c.tracker.id, date: next!.date! });
      report.created.push({ userId: c.tracker.id, name: c.tracker.displayName, entryId: row.id, slotKey: c.slotKey });
      if (c.fellBackFrom) report.slotFallbacks.push({ userId: c.tracker.id, name: c.tracker.displayName, from: c.fellBackFrom, to: c.slotKey });
    }
    // The day's frozen/refreshed calorie budget follows, once per person and day (like every other write).
    for (const { userId, date } of touched.values()) {
      try {
        const t = getTracker(db, userId);
        resolveDayCalorieBudget(db, t, date, todayFor(t, now));
      } catch (err) {
        if (!(err instanceof NutritionError)) throw err; // a login that can't track has no calorie budget to refresh
      }
    }
    return report;
  });
}

/** Remove what is still planned for several meals (a plan or a week replaced); logged entries stay. */
export function dropMealsEntries(db: Db, mealIds: string[], now = new Date()): SyncReport {
  const total = emptySyncReport();
  tx(db, () => {
    for (const id of mealIds) {
      const r = syncMealEntries(db, {
        prev: { id, date: null, slotKey: "", recipeId: null, status: "approved", targetUserIds: [] }, next: null, now,
      });
      total.removed += r.removed;
      total.alreadyLogged.push(...r.alreadyLogged);
    }
  });
  return total;
}

/**
 * "Log all": the signed-in person's planned entries in one meal (slot) of one day become logged -- the
 * same change a single tap makes (updateEntry), done together and all-or-nothing. A day that hasn't
 * happened yet is refused: this is "we ate it", not planning.
 */
export function logPlannedSlot(db: Db, user: Tracker, date: string, today: string, slotKey: string): { logged: string[] } {
  assertCanTrack(user);
  if (date > today) throw new NutritionError(400, "That day hasn't happened yet. Log it on the day.");
  return tx(db, () => {
    const ids = all<{ id: string }>(db,
      `SELECT id FROM nutrition_diary_entries
        WHERE user_id = ? AND local_date = ? AND slot_key = ? AND status = 'planned' AND deleted_at IS NULL ORDER BY logged_at, rowid`,
      user.id, date, slotKey).map((r) => r.id);
    for (const id of ids) updateEntry(db, user, today, id, { status: "logged" });
    return { logged: ids };
  });
}
