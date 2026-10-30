// The "initial prompt" handed to Whisper with every clip. Whisper is biased toward whatever words it sees there, which
// is the difference between "Did Bea finish her chores" and "Did Beah finish her chores": a short list of the
// household's real names, plus the nouns the assistant is asked about, fixes it (measured in the voice benchmark).
//
// Names only -- never a recipe, an amount, a balance or anything else from the database. The text goes to the local
// whisper-server and nowhere else, but there is no reason for it to carry more than the spelling of a few names.

import { getScopedItems, listUsers } from "../../db.ts";

const FIXED_WORDS = "Household assistant.";
const TOPICS = "Meal plan, grocery list, pantry, chores, calendar, budget.";
/** Whisper only reads the last ~224 tokens of a prompt and a long one makes it parrot; ~200 characters is plenty. */
export const PROMPT_MAX_CHARS = 200;
const MAX_NAME_CHARS = 24;
const MAX_NAMES = 12;

/** Letters (any language), spaces, apostrophes and hyphens only: a name is a spelling hint, not a place to smuggle text. */
function cleanName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/[^\p{L}\p{M}' -]/gu, "").replace(/\s+/g, " ").trim().slice(0, MAX_NAME_CHARS).trim();
}

/** A login's username as a name ("bea" -> "Bea"), or "" when it isn't a plain word ("admin-dev", "kiosk2"). */
function usernameAsName(raw: unknown): string {
  if (typeof raw !== "string" || !/^\p{L}{2,24}$/u.test(raw)) return "";
  return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
}

/**
 * Household members first (the Family section: kids and everyone without a login too), then login display names, then
 * logins' usernames. The usernames matter: on the real household the roster says "mommy" and the display name "mom", and
 * the only place "Bea" is spelled is her username -- without it Whisper hears "Beah".
 */
export function householdNames(userId: string): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  const add = (raw: unknown) => {
    const name = cleanName(raw);
    const key = name.toLowerCase();
    if (name && !seen.has(key)) {
      seen.add(key);
      names.push(name);
    }
  };
  for (const member of getScopedItems("household_members", userId)) add(member?.name);
  // The kiosk login is a screen, not a person, and its display name ("Kitchen") is no help to anyone.
  const people = listUsers().filter((user) => user.role !== "kiosk");
  for (const user of people) add(user.display_name);
  for (const user of people) add(usernameAsName(user.username));
  return names.slice(0, MAX_NAMES);
}

/** Builds the prompt from a name list, dropping names from the end until it fits. Exported for tests. */
export function buildWhisperPrompt(names: string[]): string {
  for (let count = names.length; count >= 0; count--) {
    const family = count > 0 ? ` Family: ${names.slice(0, count).join(", ")}.` : "";
    const prompt = `${FIXED_WORDS}${family} ${TOPICS}`;
    if (prompt.length <= PROMPT_MAX_CHARS) return prompt;
  }
  return `${FIXED_WORDS} ${TOPICS}`;
}

export function whisperPrompt(userId: string): string {
  return buildWhisperPrompt(householdNames(userId));
}
