// Per-member calendar colors (Stage 10.2, PLAN.md). Tailwind's content
// scanner needs literal class strings -- an interpolated `bg-${hue}-500`
// would never be picked up as a real class -- so this is a lookup table, not
// a formula.
//
// Bolder-calendar pass (Stage 10.2 follow-up): each entry also carries a
// `solid` fill (for a "bold" personal theme and stronger event pills), a
// `gradient` (for a "gradient" personal theme banner, paired with
// `bg-linear-to-r` -- Tailwind v4's replacement for `bg-gradient-to-r`,
// which this project's Tailwind v4.1 still accepts as a compatibility
// alias but no longer documents), a `tint` (a faint wash for a personal
// view's grid body/today column), and an `accent` (a left border color for
// event pills). Same rule as the fields above: every one of these must
// appear literally in this file for Tailwind to generate it.
//
// `solid`/`gradient` are white text on a color fill, so each hue's shade was
// picked to actually clear WCAG AA (4.5:1) for small text in LIGHT mode, not
// just look bold: amber/orange/sky/teal/emerald's -500 (and even -600) read
// under 4:1 against white, so those five use -700 for `solid` and a
// -500-to-700 `gradient` range; rose/blue/violet's -500 also falls short
// (~3.6-4.2:1), but their -600 clears it, so those use -600 for `solid`.
// Every `gradient` spans -500 to -700 for the same reason. Dark mode's `solid`
// fill sits on a dark surface either way, so it keeps -600 throughout.

import type { HouseholdMember } from "../../api.ts";

export interface MemberColor {
  key: string;
  dot: string;
  bg: string;
  border: string;
  text: string;
  solid: string;
  gradient: string;
  tint: string;
  accent: string;
}

export const MEMBER_PALETTE: MemberColor[] = [
  {
    key: "rose", dot: "bg-rose-500", bg: "bg-rose-100 dark:bg-rose-950/50", border: "border-rose-400 dark:border-rose-700", text: "text-rose-700 dark:text-rose-300",
    solid: "bg-rose-600 text-white dark:bg-rose-600", gradient: "from-rose-500 to-rose-700", tint: "bg-rose-50/60 dark:bg-rose-950/20", accent: "border-l-rose-500",
  },
  {
    key: "blue", dot: "bg-blue-500", bg: "bg-blue-100 dark:bg-blue-950/50", border: "border-blue-400 dark:border-blue-700", text: "text-blue-700 dark:text-blue-300",
    solid: "bg-blue-600 text-white dark:bg-blue-600", gradient: "from-blue-500 to-blue-700", tint: "bg-blue-50/60 dark:bg-blue-950/20", accent: "border-l-blue-500",
  },
  {
    key: "amber", dot: "bg-amber-500", bg: "bg-amber-100 dark:bg-amber-950/50", border: "border-amber-400 dark:border-amber-700", text: "text-amber-700 dark:text-amber-300",
    solid: "bg-amber-700 text-white dark:bg-amber-600", gradient: "from-amber-500 to-amber-700", tint: "bg-amber-50/60 dark:bg-amber-950/20", accent: "border-l-amber-500",
  },
  {
    key: "emerald", dot: "bg-emerald-500", bg: "bg-emerald-100 dark:bg-emerald-950/50", border: "border-emerald-400 dark:border-emerald-700", text: "text-emerald-700 dark:text-emerald-300",
    solid: "bg-emerald-700 text-white dark:bg-emerald-600", gradient: "from-emerald-500 to-emerald-700", tint: "bg-emerald-50/60 dark:bg-emerald-950/20", accent: "border-l-emerald-500",
  },
  {
    key: "violet", dot: "bg-violet-500", bg: "bg-violet-100 dark:bg-violet-950/50", border: "border-violet-400 dark:border-violet-700", text: "text-violet-700 dark:text-violet-300",
    solid: "bg-violet-600 text-white dark:bg-violet-600", gradient: "from-violet-500 to-violet-700", tint: "bg-violet-50/60 dark:bg-violet-950/20", accent: "border-l-violet-500",
  },
  {
    key: "sky", dot: "bg-sky-500", bg: "bg-sky-100 dark:bg-sky-950/50", border: "border-sky-400 dark:border-sky-700", text: "text-sky-700 dark:text-sky-300",
    solid: "bg-sky-700 text-white dark:bg-sky-600", gradient: "from-sky-500 to-sky-700", tint: "bg-sky-50/60 dark:bg-sky-950/20", accent: "border-l-sky-500",
  },
  {
    key: "orange", dot: "bg-orange-500", bg: "bg-orange-100 dark:bg-orange-950/50", border: "border-orange-400 dark:border-orange-700", text: "text-orange-700 dark:text-orange-300",
    solid: "bg-orange-700 text-white dark:bg-orange-600", gradient: "from-orange-500 to-orange-700", tint: "bg-orange-50/60 dark:bg-orange-950/20", accent: "border-l-orange-500",
  },
  {
    key: "teal", dot: "bg-teal-500", bg: "bg-teal-100 dark:bg-teal-950/50", border: "border-teal-400 dark:border-teal-700", text: "text-teal-700 dark:text-teal-300",
    solid: "bg-teal-700 text-white dark:bg-teal-600", gradient: "from-teal-500 to-teal-700", tint: "bg-teal-50/60 dark:bg-teal-950/20", accent: "border-l-teal-500",
  },
];

const PALETTE_BY_KEY = new Map(MEMBER_PALETTE.map((p) => [p.key, p]));

/** A neutral style for family-wide (not one person's) events and chores. */
export const FAMILY_COLOR: MemberColor = {
  key: "family",
  dot: "bg-slate-400",
  bg: "bg-slate-100 dark:bg-slate-800",
  border: "border-slate-300 dark:border-slate-700",
  text: "text-slate-600 dark:text-slate-300",
  solid: "bg-slate-500 text-white dark:bg-slate-600",
  gradient: "from-slate-400 to-slate-600",
  tint: "bg-slate-100/60 dark:bg-slate-800/40",
  accent: "border-l-slate-400",
};

/** A member with no stored color gets a stable, deterministic fallback --
 * derived from their id at display time, never written back to the row --
 * rather than every unset member rendering identically gray. */
export function resolveMemberColor(member: Pick<HouseholdMember, "id" | "color">): MemberColor {
  const stored = member.color ? PALETTE_BY_KEY.get(member.color) : undefined;
  if (stored) return stored;
  const hash = [...member.id].reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  return MEMBER_PALETTE[hash % MEMBER_PALETTE.length];
}

export type MemberTheme = "soft" | "bold" | "gradient";
export const MEMBER_THEMES: MemberTheme[] = ["soft", "bold", "gradient"];

/** A member with no stored theme defaults to "soft" -- today's look. */
export function resolveMemberTheme(member: Pick<HouseholdMember, "theme">): MemberTheme {
  return member.theme && (MEMBER_THEMES as string[]).includes(member.theme) ? member.theme : "soft";
}
