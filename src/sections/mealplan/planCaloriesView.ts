// The Meal Plan week's "calories per person" rows (phase 5c): what GET /api/nutrition/plan/calories?weekStart= says,
// worded for a small screen. Pure, so the wording is tested without a browser (tests/mealplanCalories.test.ts).
//
// WHAT IS SHOWN. For each day and each person the server returned, planned + logged calories against that person's
// PLANNING TARGET: their calorie budget for the day less the snack allowance (the part of the budget kept for
// snacks that nobody plans). The planning target is what planned meals aim at, so it is the number to compare with.
// The calorie budget itself and the snack allowance are in the row's tooltip and spoken text. A person with no
// calorie budget yet (a missing profile, goal or weigh-in) gets their planned and logged calories and the reason.
//
// WHO IS SHOWN. Exactly the people the server returned and nothing more (the server decides who shares what with
// the viewer: GET /plan/calories). Nothing here fetches or computes another person's numbers.
//
// "Calorie budget" is the only budget in this file; the meal plan's grocery MONEY budget is another thing.

export interface PlanCaloriesDay {
  date: string;
  calorieBudget: number | null;
  snackAllowanceKcal: number | null;
  planningTargetKcal: number | null;
  plannedKcal: number;
  loggedKcal: number;
  plannedPlusLoggedKcal: number;
  /** Room left under the planning target after planned and logged (negative = over); null without a calorie budget. */
  roomKcal: number | null;
  missing: Array<"profile" | "goal" | "weight">;
}

export interface PlanCaloriesPerson {
  userId: string;
  name: string;
  isMe: boolean;
  snackAllowancePct: number;
  days: PlanCaloriesDay[];
}

export interface PlanCaloriesResponse {
  weekStart: string;
  dates: string[];
  people: PlanCaloriesPerson[];
}

/** "1,240": whole kcal with thousands separators in a fixed form. */
export const kcal = (n: number): string => Math.round(n).toLocaleString("en-US");

const MISSING_WORDS: Record<PlanCaloriesDay["missing"][number], string> = {
  profile: "a profile",
  goal: "a weight goal",
  weight: "a weigh-in",
};

function joinList(items: string[]): string {
  if (items.length <= 1) return items.join("");
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

export interface DayRowView {
  userId: string;
  name: string;
  isMe: boolean;
  /** "1,240 of 1,620 kcal" or, without a calorie budget, "1,240 kcal". */
  amount: string;
  /** "380 left" / "120 over" / "no calorie budget yet". */
  room: string;
  /** over the planning target? */
  over: boolean;
  hasTarget: boolean;
  /** Bar widths in percent: logged first (solid), then planned (light). Both 0 without a target. */
  loggedPct: number;
  plannedPct: number;
  /** "logged 440 · planned 800", for the row's tooltip. */
  detail: string;
  /** A sentence for a screen reader and the tooltip. */
  spoken: string;
}

const pct = (part: number, whole: number): number => (whole > 0 ? Math.max(0, (part / whole) * 100) : 0);

/** One person's row for one day. */
export function dayRow(person: Pick<PlanCaloriesPerson, "userId" | "name" | "isMe">, d: PlanCaloriesDay): DayRowView {
  const total = d.plannedPlusLoggedKcal;
  const target = d.planningTargetKcal;
  const hasTarget = target !== null;
  const detail = `logged ${kcal(d.loggedKcal)} · planned ${kcal(d.plannedKcal)}`;
  const who = person.isMe ? `${person.name} (you)` : person.name;

  if (!hasTarget || d.roomKcal === null) {
    const needs = d.missing.length > 0 ? ` (needs ${joinList(d.missing.map((m) => MISSING_WORDS[m]))})` : "";
    return {
      userId: person.userId, name: person.name, isMe: person.isMe,
      amount: `${kcal(total)} kcal`, room: "no calorie budget yet", over: false, hasTarget: false, loggedPct: 0, plannedPct: 0, detail,
      spoken: `${who}: ${kcal(total)} kcal planned and logged, ${detail}. No calorie budget yet${needs}.`,
    };
  }

  const over = d.roomKcal < 0;
  const room = over ? `${kcal(-d.roomKcal)} over` : `${kcal(d.roomKcal)} left`;
  const loggedPct = Math.min(100, pct(d.loggedKcal, target));
  const plannedPct = Math.min(100 - loggedPct, pct(d.plannedKcal, target));
  const budget = d.calorieBudget === null ? "" : ` Calorie budget ${kcal(d.calorieBudget)}${d.snackAllowanceKcal ? `, with ${kcal(d.snackAllowanceKcal)} kept for snacks` : ""}.`;
  return {
    userId: person.userId, name: person.name, isMe: person.isMe,
    amount: `${kcal(total)} of ${kcal(target)} kcal`, room, over, hasTarget: true, loggedPct, plannedPct, detail,
    spoken: `${who}: ${kcal(total)} of ${kcal(target)} kcal planned and logged, ${room}; ${detail}.${budget}`,
  };
}

/** The rows for one date, one per person the server returned, in its order (the viewer first). Empty when nothing came back. */
export function rowsForDate(resp: PlanCaloriesResponse | null | undefined, date: string): DayRowView[] {
  if (!resp) return [];
  const out: DayRowView[] = [];
  for (const p of resp.people) {
    const d = p.days.find((x) => x.date === date);
    if (d) out.push(dayRow(p, d));
  }
  return out;
}

/** Is there anything to show at all? (No people, or nobody with a day for this week, hides the whole block.) */
export const hasCalorieRows = (resp: PlanCaloriesResponse | null | undefined): boolean => !!resp && resp.people.some((p) => p.days.length > 0);

/** The one-line key under the heading. */
export const CALORIES_LEGEND =
  "Calories planned and logged for each day, against each person's planning target: their calorie budget less the snack allowance. Solid is logged, light is planned.";
