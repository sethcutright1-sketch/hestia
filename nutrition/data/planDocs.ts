// Reading the household meal plan's documents from the nutrition side.
//
// The plan is household-app's `meal_plans` table (item_id, owner_user_id, data JSON; always joint) and the
// roster is `household_members`. Like recipes.ts does for recipes, the nutrition data layer reads them with
// plain SQL on the handle it is given, because it can't import db.ts. Only the pieces the kiosk board and the
// weekly calorie view need live here; writing the plan is routes/mealplan.ts's job.

import { addDays, dayOfWeek, isValidLocalDate } from "../dates.ts";
import { planSlotOptions } from "./planSlots.ts";
import { all, type Db } from "./sql.ts";

export const PLAN_DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** The calendar date of a plan day ("Tuesday") in the week starting `weekStart`, or null when either can't be read. */
export function planDayDate(weekStart: string, day: string): string | null {
  if (!isValidLocalDate(weekStart)) return null;
  const i = PLAN_DAYS.findIndex((d) => d.toLowerCase() === String(day).trim().toLowerCase());
  return i < 0 ? null : addDays(weekStart, i);
}

interface PlanMealJson {
  id: string;
  day: string;
  slot: string;
  name: string;
  status: string;
  audience?: "family" | "individual";
  memberId?: string;
  leftoverOf?: string;
}

interface PlanJson {
  id: string;
  weekStart: string;
  meals: PlanMealJson[];
}

export interface BoardMeal {
  id: string;
  name: string;
  slotKey: string;
  slotLabel: string;
  /** "Everyone" for a family meal, else the roster member's name. */
  who: string;
  leftover: boolean;
}

/** Each stored plan whose week contains `date`. (There is normally one; a re-planned week replaces it.) */
function plansCovering(db: Db, date: string): PlanJson[] {
  return all<{ data: string }>(db, "SELECT data FROM meal_plans")
    .map((r) => JSON.parse(r.data) as PlanJson)
    .filter((p) => typeof p.weekStart === "string" && isValidLocalDate(p.weekStart) && date >= p.weekStart && date <= addDays(p.weekStart, 6));
}

/**
 * The meals approved for a calendar date: name, slot and who they're for -- nothing else. This is the plan
 * side of the kiosk board (merge plan decision 10): no calories, no one's diary.
 */
export function approvedMealsOn(db: Db, date: string): BoardMeal[] {
  const dayName = PLAN_DAYS[(dayOfWeek(date) + 6) % 7];
  const members = new Map(all<{ data: string }>(db, "SELECT data FROM household_members")
    .map((r) => JSON.parse(r.data) as { id: string; name: string })
    .map((m) => [m.id, m.name]));
  const labels = new Map(planSlotOptions(db).map((o) => [o.key, o.label]));
  const slotRank = new Map(planSlotOptions(db).map((o, i) => [o.key, i]));
  const out: BoardMeal[] = [];
  for (const plan of plansCovering(db, date)) {
    for (const m of plan.meals ?? []) {
      if (m.status !== "approved" || String(m.day).toLowerCase() !== dayName.toLowerCase()) continue;
      out.push({
        id: m.id,
        name: m.name,
        slotKey: m.slot,
        slotLabel: labels.get(m.slot) ?? m.slot,
        who: m.audience === "individual" ? members.get(m.memberId ?? "") ?? "Someone" : "Everyone",
        leftover: !!m.leftoverOf,
      });
    }
  }
  return out.sort((a, b) => (slotRank.get(a.slotKey) ?? 99) - (slotRank.get(b.slotKey) ?? 99));
}
