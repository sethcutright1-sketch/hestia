// Where a planned meal sits in the week -- a day and a meal (slot) -- and the rules for moving one.
//
// Pure: no database, no clock, so the server (PUT /api/mealplan/meals/:id) and the Meal Plan screen's "Move"
// control run the SAME check on plain meal objects, and the screen can grey out a move the server would refuse.
// (The server stays the authority: it re-checks, and a stale screen gets the same sentence back.)
//
// The rules (merge plan decision 6 and phase 4 assumption 4.7):
//   - a meal can't move onto a day + meal that already holds a meal for the same audience (the Meal Plan grid
//     draws one meal per cell, so a second would be hidden);
//   - a LEFTOVER meal stays a later lunch or dinner than the meal it is the leftovers of;
//   - a meal that HAS leftovers can't move to or past its earliest leftover. (Its recipe is locked too while it
//     has leftovers; that rule is in routes/mealplan.ts.)

export const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export type SlotKind = "breakfast" | "lunch" | "dinner" | "snacks";

const STANDARD_KINDS: readonly string[] = ["breakfast", "lunch", "dinner", "snacks"];
const KEYWORDS: Array<[SlotKind, RegExp]> = [
  ["breakfast", /breakfast|brunch|morning/],
  ["lunch", /lunch|midday|noon/],
  ["dinner", /dinner|supper|evening/],
];

/** Which standard meal a slot key is nearest to: itself if standard, else by what its name sounds like, else snacks. */
export function slotKindOf(key: string): SlotKind {
  if (STANDARD_KINDS.includes(key)) return key as SlotKind;
  for (const [kind, re] of KEYWORDS) if (re.test(key)) return kind;
  return "snacks";
}

export const KIND_RANK: Record<SlotKind, number> = { breakfast: 0, lunch: 1, dinner: 2, snacks: 3 };

export const dayIndex = (day: string): number => DAY_NAMES.findIndex((d) => d.toLowerCase() === String(day).trim().toLowerCase());

/** A number that orders cells through the week: day first, then breakfast, lunch, dinner, snacks. */
export const cellRank = (day: string, slot: string): number => dayIndex(day) * 10 + KIND_RANK[slotKindOf(slot)];

/** The part of a planned meal these rules read. */
export interface CellMeal {
  id: string;
  day: string;
  slot: string;
  status?: string;
  audience?: "family" | "individual";
  memberId?: string;
  leftoverOf?: string;
}

/** Leftovers only go on a lunch or dinner (the exact keys, as the leftover offer has always required). */
export const isLeftoverSlot = (slot: string): boolean => slot === "lunch" || slot === "dinner";

/** Do two meals compete for one cell? A family meal and an individual one can share a cell; two of the same audience can't. */
function sameCellOwner(a: CellMeal, b: CellMeal): boolean {
  const aa = a.audience ?? "family";
  if (aa !== (b.audience ?? "family")) return false;
  return aa === "family" || a.memberId === b.memberId;
}

/**
 * Why `meal` can't move to `day` + `slot`, or null when it can. `slotLabel` words a meal for people
 * ("Dinner" rather than "dinner"). Moving a meal to where it already is is not a move (null).
 */
export function checkMoveCell(
  meals: readonly CellMeal[], meal: CellMeal, day: string, slot: string, slotLabel: (key: string) => string = (k) => k,
): string | null {
  if (dayIndex(day) < 0) return "day must be a day of the week.";
  if (!slot) return "Pick a meal.";
  const where = (d: string, s: string) => `${d} ${slotLabel(s).toLowerCase()}`;
  if (meal.day === day && meal.slot === slot) return null;

  const taken = meals.some((m) => m.id !== meal.id && m.day === day && m.slot === slot && sameCellOwner(m, meal));
  if (taken) return `${where(day, slot)} already has a meal. Move or remove that one first.`;

  if (meal.leftoverOf) {
    const original = meals.find((m) => m.id === meal.leftoverOf);
    if (original) {
      if (!isLeftoverSlot(slot)) return "Leftovers go on a lunch or dinner.";
      if (cellRank(day, slot) <= cellRank(original.day, original.slot)) {
        return `Leftovers go on a later meal than the one they come from (${where(original.day, original.slot)}).`;
      }
    }
  }

  const leftovers = meals.filter((m) => m.leftoverOf === meal.id && m.status !== "denied");
  if (leftovers.length > 0) {
    const first = leftovers.reduce((a, b) => (cellRank(a.day, a.slot) <= cellRank(b.day, b.slot) ? a : b));
    if (cellRank(day, slot) >= cellRank(first.day, first.slot)) {
      return `This meal has leftovers on ${where(first.day, first.slot)}, so it has to stay before then. Move the leftovers first.`;
    }
  }
  return null;
}

export interface MoveChoice {
  day: string;
  slot: string;
}

/** Every day + meal this meal may move to (not its current cell), in week order. `slotKeys` are the meals to offer. */
export function moveChoices(meals: readonly CellMeal[], meal: CellMeal, slotKeys: readonly string[]): MoveChoice[] {
  const out: MoveChoice[] = [];
  for (const day of DAY_NAMES) {
    for (const slot of slotKeys) {
      if (day === meal.day && slot === meal.slot) continue;
      if (checkMoveCell(meals, meal, day, slot) === null) out.push({ day, slot });
    }
  }
  return out;
}
