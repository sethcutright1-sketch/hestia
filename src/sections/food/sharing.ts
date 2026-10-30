// Who sees what, on the screen's side. The SERVER enforces every rule (nutrition/data/visibility.ts, routes/nutrition/
// share.ts); this only words the three levels and decides which view a person at which level gets, so the screen
// never offers something the server will refuse. Tested in tests/foodSharing.test.ts.
//
//   nothing     the default: nobody else sees anything
//   totals      the day's calories eaten against the calorie budget (no foods), and the streak
//   everything  also the diary entries, exercise, weigh-ins and steps, read-only
//
// Progress photos are never shared at any level.

import type { SharedLevel, Sharer, Visibility } from "./types.ts";

export const PHOTOS_NEVER_SHARED = "Progress photos are never shared, whatever you choose.";

export interface LevelInfo {
  value: Visibility;
  label: string;
  /** One line, plain language, for the radio button. */
  summary: string;
  /** What exactly the other login sees. */
  detail: string;
}

export const LEVELS: LevelInfo[] = [
  {
    value: "nothing",
    label: "Nothing",
    summary: "The other logins see nothing of mine.",
    detail: "This is the default. Nobody else can see your calories, streak, diary, exercise, weight or steps.",
  },
  {
    value: "totals",
    label: "Daily totals",
    summary: "They see my daily calories and my streak.",
    detail: "They see each day's calories eaten against your calorie budget, and your logging streak. No foods, no weight, no exercise.",
  },
  {
    value: "everything",
    label: "Everything",
    summary: "They see my diary, exercise, weight and steps (read-only).",
    detail: "They see your diary entries and exercise, your weigh-ins and trend, and your steps. They can only look: they cannot change anything of yours.",
  },
];

export const levelLabel = (level: Visibility): string => LEVELS.find((l) => l.value === level)?.label ?? level;

/** What a viewer's screen shows for a person at their level. */
export interface ViewShape {
  /** The Diary tab: the top card and streak (always when shared). */
  summary: boolean;
  /** The Diary tab: meals with entries, and exercise. */
  entries: boolean;
  /** The Weight & progress tab: weigh-ins, trend and steps. */
  progress: boolean;
}

export function viewShape(level: SharedLevel): ViewShape {
  return { summary: true, entries: level === "everything", progress: level === "everything" };
}

/** The line above a read-only view: whose it is and what is shared. */
export function viewerBanner(name: string, level: SharedLevel): string {
  return level === "everything"
    ? `${name} shares everything with you, read-only. Photos are never shared.`
    : `${name} shares daily totals with you: calories against their calorie budget, and their streak.`;
}

/** What the Weight & progress tab says for a person who shares only totals. */
export const progressNotShared = (name: string): string => `${name} doesn't share weight or steps with you.`;

/** The people for the switcher: the others who share something, in the server's order. Null = show no switcher at all. */
export function switcherPeople(sharers: Sharer[]): Sharer[] | null {
  return sharers.length > 0 ? sharers : null;
}

/** "Me", "Bea": the chip text. */
export const chipLabel = (name: string, mine: boolean): string => (mine ? "Me" : name);

/** The switcher as one line, for a screen reader and the tests: "Me · Bea". */
export const switcherText = (sharers: Sharer[]): string => ["Me", ...sharers.map((s) => s.name)].join(" · ");

/** True when the person being viewed is no longer in the list (they changed their setting): the screen goes back to "Me". */
export const stillShared = (sharers: Sharer[], userId: string | null): boolean => userId === null || sharers.some((s) => s.userId === userId);
