// The date work behind Meal Plan's "Plan the week" button, kept out of the
// component so it can be tested without a DOM.
//
// The button doesn't plan anything itself -- it writes the request the user
// would otherwise type into the assistant, and lets the assistant do the rest
// under all the same rules. What it adds is the dates. The model does its own
// date arithmetic and has got it wrong before (asked for "this week" on a
// Monday it sent the Saturday before -- see mondayOf in routes/mealplan.ts), so
// the button works them out here, from the browser's own clock and timezone,
// and spells every one out.

export const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export interface PlanDay {
  day: string;
  date: string;
}

/** Local calendar date as YYYY-MM-DD -- not toISOString(), which is UTC and is tomorrow after 8pm Eastern. */
export function isoDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Midnight on the Monday of `d`'s week. Sunday belongs to the week that started six days earlier. */
export function mondayOf(d: Date): Date {
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  return monday;
}

/** All seven days of the week starting `monday`, Monday first. */
export function weekDays(monday: Date): PlanDay[] {
  return WEEKDAYS.map((day, i) => {
    const date = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i);
    return { day, date: isoDate(date) };
  });
}

/**
 * Which days start ticked. Next week: all of them. This week: today onward --
 * planning Monday's dinner on a Thursday is rarely what anyone wants, but it's
 * a default, so it can still be ticked back on.
 */
export function defaultDays(week: "this" | "next", today: Date): Set<string> {
  if (week === "next") return new Set(WEEKDAYS);
  const todayIndex = (today.getDay() + 6) % 7;
  return new Set(WEEKDAYS.slice(todayIndex));
}

/** The message sent to the assistant. Days are listed in week order, whatever order they were ticked in. */
export function buildPlanMessage(days: PlanDay[]): string {
  const ordered = [...days].sort((a, b) => a.date.localeCompare(b.date));
  const named = ordered.map((d) => `${d.day} ${d.date}`);
  const list = joinDays(named);
  const weekStart = isoDate(mondayOf(new Date(`${ordered[0].date}T00:00:00`)));
  // The second sentence is for the local model, which on the first real run
  // wrote a lovely description of four dinners and never called the tool --
  // naming it in the request is the strongest nudge a user message can give.
  // One day per call because the local model (gemma4 through Ollama) writes a
  // week's 21 meals as one long call that Ollama's tool-call parser then can't
  // read -- the call vanishes and nothing is saved -- while a day's three parse
  // every time. keepOtherDays makes each call add its day instead of replacing
  // the week.
  return (
    `Plan breakfast, lunch and dinner for ${list} (the week starting ${weekStart}). ` +
    `Choose the dishes yourself and save them with create_meal_plan one day at a time -- ` +
    `one call per day with that day's meals and keepOtherDays: true.`
  );
}

/** "Thursday", "Thursday and Friday", "Thursday, Friday and Sunday". */
function joinDays(days: string[]): string {
  return days.length <= 1 ? days.join("") : `${days.slice(0, -1).join(", ")} and ${days[days.length - 1]}`;
}

/**
 * Which weekdays a create_meal_plan call put meals on, from the call's arguments (the tool's `meals[].day`, any casing).
 * Used for both the screen and the eval, so they agree on what "saved" means.
 */
export function daysInCall(args: unknown): string[] {
  const meals = (args as { meals?: unknown } | null | undefined)?.meals;
  if (!Array.isArray(meals)) return [];
  const found = new Set<string>();
  for (const m of meals) {
    const day = typeof m?.day === "string" ? WEEKDAYS.find((d) => d.toLowerCase() === m.day.trim().toLowerCase()) : undefined;
    if (day) found.add(day);
  }
  return WEEKDAYS.filter((d) => found.has(d));
}

/**
 * The days that are saved after a run of create_meal_plan calls (only the ones that succeeded, in order). A call with
 * keepOtherDays adds its days; one without it replaced the whole week, so whatever was saved before it is gone.
 */
export function savedDays(calls: { args?: unknown }[]): Set<string> {
  let saved = new Set<string>();
  for (const call of calls) {
    const days = daysInCall(call.args);
    if ((call.args as { keepOtherDays?: unknown } | null | undefined)?.keepOtherDays === true) days.forEach((d) => saved.add(d));
    else saved = new Set(days);
  }
  return saved;
}

/** The ticked days that no saved create_meal_plan call covers, in week order. */
export function missingDays(chosen: PlanDay[], saved: Set<string>): string[] {
  return [...chosen].sort((a, b) => a.date.localeCompare(b.date)).map((d) => d.day).filter((d) => !saved.has(d));
}

/**
 * Sent only when the first turn ended without a saved plan. Lives here (not in PlanWeek.tsx) so the assistant eval
 * harness (scripts/eval-assistant.ts) can replay the exact retry the screen makes without importing a React component.
 * With per-day saves a turn can save some days and not others, so the retry names the days still missing.
 */
export function saveNudge(missing: string[]): string {
  if (missing.length === 0) return SAVE_NUDGE;
  return (
    `You haven't saved ${joinDays(missing)} yet. Call create_meal_plan for ${missing.length === 1 ? "it" : "each of them"} now, ` +
    `one day per call, with keepOtherDays: true -- use the dishes you just described, with a slot, name and ingredients for each meal.`
  );
}

/** The generic retry, for when no particular days can be named. */
export const SAVE_NUDGE =
  "You haven't saved the plan yet. Call create_meal_plan now, one day per call with keepOtherDays: true -- " +
  "use the dishes you just described, with a day, slot, name and ingredients for each.";
