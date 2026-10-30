// The assistant's system prompt. Its own module (not defined in server.ts,
// which calls app.listen() at import time) so scripts/eval-assistant.ts can
// build the exact prompt production uses without booting a second server.

import { toolDomainLabels, toolPromptRules, type PromptHiding } from "./registry.ts";
import { listMembers } from "../routes/members.ts";
import { listMealRequests, groceryBudget } from "../routes/mealplan.ts";
import { serverToday, addDays, dayOfWeek, mondayOf } from "../nutrition/dates.ts";

/**
 * What the prompt must not describe. `hideFinancial`: the PIN lock is engaged. `hideHealth`: the calorie-diary tools
 * are not offered (a cloud provider without the admin's health consent, or the person's food-diary lock), so the
 * prompt must not mention them. `kiosk`: this is the shared kitchen screen's login -- it gets no diary tools, only the
 * plan-level ones named in `toolNames` (portions of the household plan's meals, and marking one eaten).
 */
export interface PromptOptions extends PromptHiding {
  kiosk?: { toolNames: string[] };
}

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * The date lines at the top of the prompt. The model has no clock, so relative dates ("this month", "tonight",
 * "Friday") are unanswerable unless today's date is stated -- and it must be the household's LOCAL date: the server
 * runs on a PC in the house, and after ~8 pm Eastern the UTC date (toISOString) is already tomorrow, which made
 * "tonight's dinner" target the wrong day. The next seven days are spelled out with their weekdays because a small
 * local model is unreliable at date arithmetic ("what is next Tuesday?") but copies a listed date correctly. The time
 * of day is deliberately left out: it would change the prompt every minute and defeat prompt caching between turns.
 *
 * The third line names the current and the next week outright. The app's weeks run Monday to Sunday (meal plans, the
 * calorie week: mondayOf), but the seven-day list starts at today, so on a Sunday its first Monday is NEXT week's.
 * Asked "how does my calorie week look?" on a Sunday, models took that Monday as the start of "this week" and read
 * the wrong week. A model can copy a stated range; it cannot be trusted to derive one. `now` exists for tests.
 */
export function todayLines(now: Date = new Date()): string {
  const today = serverToday(now);
  const upcoming = Array.from({ length: 7 }, (_, i) => {
    const d = addDays(today, i);
    const note = i === 0 ? " (today)" : i === 1 ? " (tomorrow)" : "";
    return `${WEEKDAY_NAMES[dayOfWeek(d)].slice(0, 3)} ${d}${note}`;
  });
  const thisMonday = mondayOf(today);
  const nextMonday = addDays(thisMonday, 7);
  // On a Sunday tomorrow is already next week, and "this week" (the one ending tonight) still means last Monday onward:
  // gemma4:12b answered "what's for dinner tomorrow?" from the week ending today and then denied that past Monday's meal.
  const tomorrowLine =
    thisMonday !== mondayOf(addDays(today, 1))
      ? `
Tomorrow (${WEEKDAY_NAMES[dayOfWeek(addDays(today, 1))]} ${addDays(today, 1)}) is in next week: for tomorrow or any later day, pass week ${nextMonday} to the meal-plan tools.`
      : "";
  return `Today's date is ${today} (${WEEKDAY_NAMES[dayOfWeek(today)]}, household local time).
The next seven days: ${upcoming.join(", ")}.
This week (Monday to Sunday) is ${thisMonday} to ${addDays(thisMonday, 6)} -- "this week" and "the meal plan" mean this one, even today; next week starts Mon ${nextMonday}.${tomorrowLine}`;
}

export function systemPrompt(userId: string, hide: boolean | PromptOptions): string {
  const opts: PromptOptions = typeof hide === "boolean" ? { hideFinancial: hide } : hide;
  const hideFinancial = opts.hideFinancial === true;
  const kioskTools = opts.kiosk?.toolNames ?? [];
  // The kiosk never gets the diary tools, so for its prompt the health section and rules stay hidden whatever the
  // provider; it has its own short paragraph below naming only the kiosk tools it was actually given.
  const hiding: PromptHiding = { hideFinancial, hideHealth: opts.hideHealth === true || opts.kiosk !== undefined };
  const sections = toolDomainLabels(hiding);

  // Likes and dislikes go in the prompt rather than behind a tool: they shape
  // every meal suggested, and a rule the model has to remember to look up is a
  // rule it will sometimes skip. Only dislikes are re-checked server-side
  // afterward -- there's no such thing as a "conflict" when a meal happens to
  // include something someone likes.
  //
  // Meal requests are here for the same reason, and were moved here after
  // watching it happen: asked to plan a week, the model skipped
  // list_meal_requests and asked the user to type out their preferences and
  // requests instead -- all of which the app already knew.
  //
  // The empty cases are stated out loud rather than left as an absent line.
  // Silence reads as missing information, and missing information is what the
  // model tries to fill by asking a question; "nobody has recorded a dislike"
  // is a fact it can plan from, where saying nothing is not.
  const members = listMembers(userId);
  const withLikes = members.filter((m) => m.likes.length > 0);
  const withDislikes = members.filter((m) => m.dislikes.length > 0);

  const facts: string[] = [];
  if (members.length === 0) {
    facts.push("No household members are recorded, so there are no dietary needs to work around.");
  } else {
    facts.push(
      `The family has ${members.length} member${members.length === 1 ? "" : "s"}: ${members
        .map((m) => m.name)
        .join(", ")}.`
    );
    if (withLikes.length) {
      facts.push(`Foods they like: ${withLikes.map((m) => `${m.name} likes ${m.likes.join(", ")}`).join("; ")}.`);
    }
    if (withDislikes.length) {
      facts.push(
        `Foods to avoid: ${withDislikes.map((m) => `${m.name} won't eat ${m.dislikes.join(", ")}`).join("; ")}.`
      );
    }
    if (!withLikes.length && !withDislikes.length) {
      facts.push("Nobody has any likes or dislikes recorded, so no foods need avoiding.");
    }
  }

  // Capped: a long backlog of requests would crowd out the rules below, and the
  // oldest ones are the least likely to still be wanted.
  const requests = listMealRequests(userId).slice(0, 20);
  if (requests.length === 0) {
    facts.push("Nobody has requested a specific meal.");
  } else {
    const byName = new Map(members.map((m) => [m.id, m.name]));
    facts.push(
      `Meals someone has asked for, to work into the next plan: ${requests
        .map((r) => {
          const who = r.memberId ? byName.get(r.memberId) : undefined;
          const notes = r.notes ? ` (${r.notes})` : "";
          return `${r.name}${who ? ` for ${who}` : ""}${notes}`;
        })
        .join("; ")}.`
    );
  }

  // The one budget number meal planning may see -- see groceryBudget() in
  // routes/mealplan.ts for why it is this one figure and nothing else. Stated
  // here for the same reason as likes and dislikes: it shapes every meal, and
  // a figure the model must remember to fetch is one it will sometimes skip.
  const budget = groceryBudget(userId);
  if (budget) {
    facts.push(
      `The household's grocery budget is $${budget.monthly} a month, about $${budget.weekly} a week.`
    );
  }

  const roster = `\n${facts.join(" ")}\n`;

  // What the model is told about calories when it plans a week. The calorie numbers themselves are never in the
  // prompt: they come from plan_meals_within_calorie_budgets, a health tool that cloud providers do not receive
  // unless the admin allowed them, so the sentence changes with whether that tool is offered.
  const calorieSentence = hiding.hideHealth
    ? "Calorie targets exist in this app but you cannot see them in this conversation: plan without them, and never ask the user for a calorie number."
    : "Each person's calorie targets for the week come from plan_meals_within_calorie_budgets: call it, and never ask the user for a calorie number.";

  // Two versions of one rule, never both. The no-budget wording exists because
  // the model kept asking for "a budget for the week" the user had no way to
  // supply; once a real figure is shared, that same wording would make it
  // refuse to discuss the number the prompt just gave it. "Budget" here is
  // always the grocery MONEY budget; calorie budgets are a different thing.
  const planningRule = budget
    ? `- Planning a week needs only the days. The grocery budget is stated above --
  keep the week's meals realistic for it (cheaper staples, ingredients reused
  across meals) and never ask for a different figure. This app has no serving
  count or cuisine setting for meals, so never ask for one. ${calorieSentence}`
    : `- Planning a week needs only the days. This app has no grocery money budget,
  serving count or cuisine setting for meals, so never ask for one -- asking for
  something that does not exist leaves the user with no way to answer. ${calorieSentence}`;

  // The word "budget" alone means money. Said always (any provider), because the money tools can be present
  // while the calorie ones are not, and the model must not answer a calorie question from the dollar budget.
  const budgetWords = hiding.hideHealth
    ? `- "Budget" on its own means the household's MONEY budget. A person's calorie budget is a different thing, kept in
  their private food diary, and you cannot see anyone's food diary, calories eaten, calorie budget, weight or steps in
  this conversation. If asked about those, say so plainly (they are in the Food section, and the local assistant
  model can answer them) and do not answer from a money tool.`
    : `- "Budget" on its own means the household's MONEY budget. A person's calorie budget is a different thing: use the
  calorie tools for it, never the money tools, and never mix dollars with calories.`;

  const kioskParagraph = opts.kiosk
    ? `- This is the shared kitchen screen. You can see the meal plan and recipes, including a recipe's calories.${
        kioskTools.includes("get_planned_meal_portions")
          ? " You may also read each person's portion of a planned meal, with its calories (get_planned_meal_portions)."
          : ""
      }${
        kioskTools.includes("log_planned_meal")
          ? " You may mark a person's planned meal-plan meal as eaten (log_planned_meal) only when asked, for that person and meal."
          : ""
      } You have no access to anyone's food diary, calories eaten, totals, calorie budget, weight, steps, goals or streak: if asked, say the kitchen screen can't show those.`
    : "";

  return `You are the household assistant. ${todayLines()}

You can read and change the household's ${sections.join(", ")} through your tools.
${roster}
Rules:
- Always call a tool to get facts. Never guess or invent a figure.
- Tool results from earlier in this chat can be out of date. When asked what is on a list, plan, calendar or account
  now, call the tool again instead of answering from an earlier result.
- Never ask the user for something already stated above or available from a tool.
  Who is in the family, what they like, what they won't eat and what they have
  asked for are all written above -- asking for them makes the user type out what
  the app already knows. Look it up or read it above; do not ask.
${planningRule}
${budgetWords}${kioskParagraph ? `
${kioskParagraph}` : ""}
- When the user gives the days ("Monday to Friday", "this week", "the weekend"),
  that is your answer. Work the dates out from today's date and build the plan.
  Ask only when you genuinely cannot proceed, and then ask one specific question.
- Convert relative dates ("this month") into the YYYY-MM format tools expect.
- New events and recurring events start today or later unless the person names an earlier date.
- Answer in one or two plain sentences. Never repeat raw JSON back to the user.
- If a tool reports an error or returns nothing useful, say so plainly instead of
  filling the gap with an estimate.
- When a tool returns a list of items, mention only the items literally present in
  that result. Never invent additional items, ingredients, or quantities to round
  out an answer.
- Meal and recipe ideas are the exception: those you invent freely. Suggest whatever
  dishes make sense and do not limit them to what is in the pantry -- a suggestion
  is not a reported fact.
- Every meal you save needs a real dish name someone could cook from or shop for --
  "Chicken fajitas", "Beef stroganoff", "Margherita pizza". Naming the choosing
  instead of the dish ("Random Meal", "Dinner", "Meal 1", "Surprise") is never
  acceptable, even when the ingredients are listed alongside it. Asking for random,
  a surprise, or "you pick" tells you HOW to choose the dishes -- it is never the
  name to give them. Pick the actual dish yourself and name it. Give each day a
  different one unless the user asked to repeat a meal.
- Everything else stays fact from tools: what is in the pantry, what is on a list,
  which meals were denied, and which ingredients are missing. Never work out a
  missing-ingredient list yourself -- report the one the meal plan tool gives you.
- Only add missing ingredients to a shopping list once the user has clearly asked
  you to. Never do it as part of proposing a plan.
${toolPromptRules(hiding)
  .map((rule) => `- ${rule}`)
  .join("\n")}`;
}
