// The kiosk's "Log for: Alex · Bea" buttons on approved plan meals (phase 5c). Pure: which people get a button on
// which meal, which days to ask the kiosk board about, and the words on the buttons.
//
// WHAT THE KIOSK MAY KNOW. The board (GET /api/nutrition/kiosk/today and /kiosk/day/:date) lists, per person who
// keeps a diary, their PLANNED entries that came from the household meal plan. It never lists logged food, totals,
// weights or photos. Each live button shows that person's PORTION calories for the meal ("Bea · 471 kcal": the plan
// entries' kcal, i.e. recipe calories × their servings), the user's answer to 5b.R4 (2026-10-15). Nothing else
// about anyone's eating appears.
//
// THE MATCHING RULE. A button for a person goes on a plan meal when one of that person's board entries came from
// that meal: the entry's `mealId` (the plan meal's id, which the board carries since phase 5c) is the meal's id.
// Only if an entry has no `mealId` at all does it fall back to the same meal slot and the same dish name
// (case-insensitive), which is how a diary entry is named after its recipe. A meal must also be on the board's own
// list of APPROVED meals for that day, so a meal approved on this screen a moment ago but changed elsewhere gets no button.
//
// WHICH DAYS. Only days up to the board's "today": a planned entry can be logged only on or after its own day
// (the server refuses earlier). One tap logs that person's planned portion (1 serving, as planned) for this meal.

import { addDays } from "../food/dates.ts";

export interface BoardEntry {
  id: string;
  name: string;
  /** That entry's calories: the person's portion of the plan meal (shown on their button, 5b.R4). */
  kcal?: number;
  /** The household-plan meal this entry came from. */
  mealId?: string | null;
  slotKey: string;
  slotLabel: string;
}

export interface BoardPerson {
  userId: string;
  name: string;
  date: string;
  planned: BoardEntry[];
}

export interface BoardMeal {
  id: string;
  name: string;
  slotKey: string;
  slotLabel: string;
  who: string;
  leftover: boolean;
}

export interface KioskBoard {
  kioskAccess: string;
  canQuickLog: boolean;
  date: string;
  meals: BoardMeal[];
  people: BoardPerson[];
}

/** The part of a plan meal the matching reads. */
export interface PlanMealRef {
  id: string;
  name: string;
  slot: string;
  status: string;
}

export interface LogForOption {
  userId: string;
  name: string;
  /** That person's planned entries for this meal: what one tap logs. */
  entryIds: string[];
  /** Their portion's calories: the sum of those entries' kcal (undefined when the board sent none). */
  kcal?: number;
}

const norm = (s: string): string => s.trim().toLowerCase();

/** Does this board entry belong to this plan meal? */
export function entryMatchesMeal(entry: BoardEntry, meal: PlanMealRef): boolean {
  if (entry.mealId) return entry.mealId === meal.id;
  return entry.slotKey === meal.slot && norm(entry.name) === norm(meal.name);
}

/** The people who get a "Log for" button on `meal`, in the board's order. Empty unless the meal is approved and on the board. */
export function logForOptions(board: KioskBoard | undefined, meal: PlanMealRef): LogForOption[] {
  if (!board || !board.canQuickLog || meal.status !== "approved") return [];
  if (!board.meals.some((m) => m.id === meal.id)) return [];
  const out: LogForOption[] = [];
  for (const person of board.people) {
    const mine = person.planned.filter((e) => entryMatchesMeal(e, meal));
    if (mine.length === 0) continue;
    const known = mine.filter((e) => typeof e.kcal === "number");
    const option: LogForOption = { userId: person.userId, name: person.name, entryIds: mine.map((e) => e.id) };
    if (known.length > 0) option.kcal = known.reduce((a, e) => a + (e.kcal as number), 0);
    out.push(option);
  }
  return out;
}

export interface LogChip {
  userId: string;
  name: string;
  /** Logged from this screen: the button reads "✓ Alex logged" and does nothing. */
  done: boolean;
  /** What one tap logs; empty once done. */
  entryIds: string[];
  /** Their portion's calories, on a live button only. */
  kcal?: number;
}

/**
 * The buttons for one meal: a live button for each person who still has a planned entry for it, and a ticked,
 * inactive one for each person this screen has already logged it for (`done`: loggedKey -> name). The kiosk can't
 * see logged food, so "already logged" is only remembered while the screen stays open. If the board shows a
 * planned entry for someone again (it was un-logged elsewhere), they get a live button, not a tick.
 */
export function logChips(board: KioskBoard | undefined, meal: PlanMealRef, done: ReadonlyMap<string, string>): LogChip[] {
  if (!board || !board.canQuickLog || meal.status !== "approved") return [];
  const live = new Map(logForOptions(board, meal).map((o) => [o.userId, o]));
  const chips: LogChip[] = [];
  for (const person of board.people) {
    const o = live.get(person.userId);
    if (o) chips.push({ userId: o.userId, name: o.name, done: false, entryIds: o.entryIds, ...(o.kcal === undefined ? {} : { kcal: o.kcal }) });
    else if (done.has(loggedKey(meal.id, person.userId))) chips.push({ userId: person.userId, name: done.get(loggedKey(meal.id, person.userId))!, done: true, entryIds: [] });
  }
  return chips;
}

/** The key that remembers "this person was logged for this meal" while the screen stays open. */
export const loggedKey = (mealId: string, userId: string): string => `${mealId}|${userId}`;

/** The button's words: "Bea · 471 kcal" (the portion), then "✓ Bea logged" once it is done. */
export const chipLabel = (name: string, done: boolean, kcal?: number): string =>
  done ? `✓ ${name} logged` : kcal === undefined ? name : `${name} · ${Math.round(kcal).toLocaleString("en-US")} kcal`;

/**
 * The dates to ask the kiosk board about: the days of the week on screen that are up to `today` and have at least
 * one approved meal (no point asking about a day with nothing to log, or one that hasn't happened).
 */
export function boardDates(weekStart: string, meals: Array<{ day: string; status: string }>, today: string): string[] {
  const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const out: string[] = [];
  days.forEach((day, i) => {
    const date = addDays(weekStart, i);
    if (date > today) return;
    if (meals.some((m) => m.status === "approved" && m.day === day)) out.push(date);
  });
  return out;
}
