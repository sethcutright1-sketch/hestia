// The leftover picker (phase 5c). GET /api/mealplan/meals/:id/leftover-offer answers with a suggestion (the first
// free later lunch or dinner) and the other free ones; the picker shows them all so the person chooses the day.
// Pure, so the choices and the wording are tested without a browser.

import type { LeftoverOffer } from "../../api.ts";

export interface LeftoverChoice {
  day: string;
  slot: string;
  /** The offer's own suggestion (the earliest free cell). */
  suggested: boolean;
}

/** The suggestion first, then the alternatives, each cell once. */
export function leftoverChoices(offer: Pick<LeftoverOffer, "suggestion" | "alternatives">): LeftoverChoice[] {
  const out: LeftoverChoice[] = [];
  const seen = new Set<string>();
  const add = (c: { day: string; slot: string }, suggested: boolean) => {
    const key = `${c.day}|${c.slot}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ ...c, suggested });
  };
  if (offer.suggestion) add(offer.suggestion, true);
  for (const a of offer.alternatives ?? []) add(a, false);
  return out;
}

/** "Tuesday" -> "Tue". */
export const shortDay = (day: string): string => day.slice(0, 3);

/** "Tue lunch": a chip's words. */
export const choiceLabel = (c: { day: string; slot: string }, slotLabel: (key: string) => string): string =>
  `${shortDay(c.day)} ${slotLabel(c.slot).toLowerCase()}`;

/** "4 servings left over" / "1 serving left over (the recipe's servings are assumed)". */
export function servingsLine(offer: Pick<LeftoverOffer, "servingsLeft" | "yieldAssumed">): string {
  const n = offer.servingsLeft;
  return `${n} serving${n === 1 ? "" : "s"} left over${offer.yieldAssumed ? " (the recipe's servings are assumed)" : ""}.`;
}
