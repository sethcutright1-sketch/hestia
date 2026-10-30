// assistant/systemPrompt.ts -- the prompt every provider is handed.
//
// Worth testing despite being "just a string": it is the only place dietary
// dislikes are communicated before a meal is proposed, and it is one of the
// two places the PIN lock has to hold. A prompt that still describes finance
// tools while locked invites the model to promise something it cannot do, and
// a roster that silently drops someone's dislikes means a dinner nobody eats.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import { loadDb, cleanupDb } from "./helpers/testdb.ts";
import { serverToday } from "../nutrition/dates.ts";

const { createUser, putScopedItem, putScopedItemAs, deleteScopedItem, setConfig, newId } = await loadDb();
const { SHARE_GROCERY_BUDGET_KEY } = await import("../routes/mealplan.ts");
const { systemPrompt, todayLines } = await import("../assistant/systemPrompt.ts");

let userId: string;

function addMember(name: string, likes: string[] = [], dislikes: string[] = []) {
  putScopedItem("household_members", userId, {
    id: newId("member"),
    name,
    likes,
    dislikes,
    scope: "joint",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

before(() => {
  userId = createUser("alice-prompt", "not-a-real-hash", "Alice");
});

after(cleanupDb);

describe("the prompt with no roster yet", () => {
  test("states today's date", () => {
    // The model has no clock; "this month" is unanswerable without this.
    // The household's local date, not the UTC one (which is tomorrow after ~8 pm Eastern).
    const today = serverToday();
    assert.ok(systemPrompt(userId, false).includes(`Today's date is ${today}`));
  });

  test("opens with the date line and the seven-day list, right after the persona sentence", () => {
    const prompt = systemPrompt(userId, false);
    assert.ok(prompt.startsWith("You are the household assistant. Today's date is "));
    assert.equal(prompt.split("\n")[1].startsWith("The next seven days: "), true);
  });

  test("says so out loud rather than leaving the line out", () => {
    // Deliberately not silence. An absent line reads as missing information,
    // and missing information is what the model fills by asking the user a
    // question -- which is exactly what it did before this. "Nobody is
    // recorded" is a fact it can plan from.
    const prompt = systemPrompt(userId, false);
    assert.equal(prompt.includes("The family has"), false);
    assert.match(prompt, /no household members are recorded/i);
    assert.match(prompt, /no dietary needs to work around/i);
  });

  test("says nobody has requested a meal, rather than staying quiet about it", () => {
    assert.match(systemPrompt(userId, false), /nobody has requested a specific meal/i);
  });

  test("always carries the never-invent-a-figure rules", () => {
    const prompt = systemPrompt(userId, false);
    assert.ok(prompt.includes("Always call a tool to get facts"));
    assert.ok(prompt.includes("Never invent additional items"));
  });
});

describe("the date lines", () => {
  // Built from local components so these hold in any machine timezone: new Date(y, m, d, h, min) is local time by
  // definition, and the helper must read it back as the same local day.
  test("names the weekday of today", () => {
    assert.ok(todayLines(new Date(2026, 9, 17, 12, 0)).startsWith("Today's date is 2026-10-17 (Saturday, household local time)."));
  });

  test("lists the next seven days with weekdays, flagging today and tomorrow", () => {
    const lines = todayLines(new Date(2026, 9, 17, 12, 0)).split("\n");
    assert.equal(
      lines[1],
      "The next seven days: Sat 2026-10-17 (today), Sun 2026-10-18 (tomorrow), Mon 2026-10-19, Tue 2026-10-20, Wed 2026-10-21, Thu 2026-10-22, Fri 2026-10-23."
    );
  });

  test("late evening local time is still today, even when UTC has rolled to tomorrow", () => {
    // 11:30 pm local on the 17th: in America/New_York that is already the 18th in UTC, which is what the old
    // toISOString() code answered. Whatever the machine's timezone, the local date must stay the 17th.
    const lateEvening = new Date(2026, 9, 17, 23, 30);
    assert.equal(serverToday(lateEvening), "2026-10-17");
    assert.ok(todayLines(lateEvening).startsWith("Today's date is 2026-10-17 (Saturday"));
    assert.ok(todayLines(lateEvening).includes("Sat 2026-10-17 (today), Sun 2026-10-18 (tomorrow)"));
  });

  test("just after midnight local time is the new day", () => {
    assert.ok(todayLines(new Date(2026, 9, 18, 0, 5)).startsWith("Today's date is 2026-10-18 (Sunday"));
  });

  test("the seven-day list rolls over month and year ends", () => {
    assert.ok(todayLines(new Date(2026, 11, 30, 9, 0)).includes("Wed 2026-12-30 (today), Thu 2026-12-31 (tomorrow), Fri 2027-01-01, Sat 2027-01-02"));
  });

  test("carries no time of day, which would defeat prompt caching between turns", () => {
    assert.equal(/\d{1,2}:\d{2}/.test(todayLines(new Date(2026, 9, 17, 23, 30))), false);
  });

  // The app's weeks run Monday to Sunday. On a Sunday the seven-day list's first Monday is NEXT week's, and models asked
  // about "this week" took it as this week's; the third line says outright which week is which.
  describe("the week line (Monday to Sunday)", () => {
    const weekLine = (now: Date) => todayLines(now).split("\n")[2];
    // The wording matters: on a Sunday models read "next week starts Mon ..." and passed next week to the meal plan
    // tools for "the meal plan" and "tonight", so the line says outright that this week includes today.
    const expected = (monday: string, sunday: string, nextMonday: string) =>
      `This week (Monday to Sunday) is ${monday} to ${sunday} -- "this week" and "the meal plan" mean this one, even today; next week starts Mon ${nextMonday}.`;

    test("on a Sunday, this week is the one that began six days ago and next week starts tomorrow", () => {
      assert.equal(weekLine(new Date(2026, 9, 18, 12, 0)), expected("2026-10-12", "2026-10-18", "2026-10-19"));
    });

    test("on a Sunday the line says the week ending today is the meal plan week", () => {
      const line = weekLine(new Date(2026, 9, 18, 12, 0));
      assert.ok(line.includes("2026-10-12 to 2026-10-18"));
      assert.ok(line.includes("even today"));
      assert.ok(line.includes("next week starts Mon 2026-10-19"));
    });

    test("on a Monday, this week starts today", () => {
      assert.equal(weekLine(new Date(2026, 9, 19, 12, 0)), expected("2026-10-19", "2026-10-25", "2026-10-26"));
    });

    test("in mid-week, it names the surrounding Monday and Sunday", () => {
      assert.equal(weekLine(new Date(2026, 9, 21, 12, 0)), expected("2026-10-19", "2026-10-25", "2026-10-26"));
    });

    test("it rolls over a month and a year end", () => {
      assert.equal(weekLine(new Date(2026, 11, 31, 9, 0)), expected("2026-12-28", "2027-01-03", "2027-01-04"));
    });

    test("the existing lines are unchanged and the prompt still carries the week line", () => {
      const lines = todayLines(new Date(2026, 9, 18, 12, 0)).split("\n");
      assert.equal(lines.length, 4, "a Sunday adds the tomorrow line");
      assert.equal(todayLines(new Date(2026, 9, 21, 12, 0)).split("\n").length, 3, "other days do not");
      assert.ok(lines[0].startsWith("Today's date is 2026-10-18 (Sunday"));
      assert.ok(lines[1].startsWith("The next seven days: Sun 2026-10-18 (today), Mon 2026-10-19 (tomorrow)"));
      assert.ok(systemPrompt(userId, false).includes("This week (Monday to Sunday) is "));
    });

    // gemma4:12b answered "what's for dinner tomorrow?" on a Sunday from the week ending today (last Monday) and then denied
    // that past meal. Tomorrow is next week's Monday, so the prompt says so and names the week argument.
    test("on a Sunday a fourth line says tomorrow is in next week and which week to pass", () => {
      const lines = todayLines(new Date(2026, 9, 18, 12, 0)).split("\n");
      assert.equal(
        lines[3],
        "Tomorrow (Monday 2026-10-19) is in next week: for tomorrow or any later day, pass week 2026-10-19 to the meal-plan tools."
      );
      // The year end: Sunday 2027-01-03 -> Monday 2027-01-04.
      assert.ok(todayLines(new Date(2027, 0, 3, 9, 0)).includes("Tomorrow (Monday 2027-01-04) is in next week"));
    });

    test("on any other day there is no tomorrow line", () => {
      for (const day of [19, 20, 21, 22, 23, 24]) {
        assert.equal(todayLines(new Date(2026, 9, day, 12, 0)).includes("is in next week"), false, `Oct ${day}`);
      }
    });

    test("the prompt carries the new-events-start-today rule and the meal plan day-name rule", () => {
      const prompt = systemPrompt(userId, false);
      assert.ok(prompt.includes("New events and recurring events start today or later unless the person names an earlier date."));
      assert.ok(prompt.includes('A day name ("Monday", "tomorrow", "Friday") means the next one from today unless the person says last or past; if that day is in next week, pass week.'));
    });

    // Eval #90: on the kitchen screen gemma approved the meal and then said it had marked it eaten.
    // Eval #54: gemma4 writes a week's 21 meals as one call that Ollama's parser drops. One day per call, keepOtherDays.
    test("the meal plan module asks for one create_meal_plan call per day with keepOtherDays, not one call for everything", () => {
      const prompt = systemPrompt(userId, false);
      assert.ok(prompt.includes("Save a plan of more than one day with one create_meal_plan call per day, each with keepOtherDays: true -- the first call too, even for an empty week."));
      assert.equal(prompt.includes("them all in one call"), false, "the old save-everything-in-one-call wording is gone");
    });

    test("the meal plan module says set_meal_status never marks a meal eaten, for the full and the kiosk prompt", () => {
      const rule = "set_meal_status only approves or denies a planned meal; it never marks it eaten or logs it. To mark a meal eaten use a tool made for that if you were given one; if not, say it can't be logged from here and point to the Log button in the Food diary. Never say a meal was eaten or logged after approving it.";
      assert.ok(systemPrompt(userId, false).includes(rule));
      assert.ok(systemPrompt(userId, { hideFinancial: true, kiosk: { toolNames: ["get_meal_plan", "set_meal_status"] } }).includes(rule));
    });

    test("the meal plan module tells the model to leave week out for the current week, even on a Sunday", () => {
      const prompt = systemPrompt(userId, false);
      assert.ok(prompt.includes("Meal plan weeks run Monday to Sunday."));
      assert.ok(prompt.includes("leave week out for them"));
    });
  });
});

describe("the roster", () => {
  before(() => {
    addMember("Sam", ["tacos"], ["mushrooms"]);
    addMember("Rae", [], ["cilantro", "olives"]);
    addMember("Kit");
  });

  test("names everyone, with correct pluralization", () => {
    const prompt = systemPrompt(userId, false);
    assert.ok(prompt.includes("The family has 3 members: Sam, Rae, Kit."));
  });

  test("lists likes only for members who have any", () => {
    const prompt = systemPrompt(userId, false);
    assert.ok(prompt.includes("Sam likes tacos"));
    assert.equal(prompt.includes("Rae likes"), false);
    assert.equal(prompt.includes("Kit likes"), false);
  });

  test("lists every dislike, which is the half that gets re-checked server-side", () => {
    const prompt = systemPrompt(userId, false);
    assert.ok(prompt.includes("Sam won't eat mushrooms"));
    assert.ok(prompt.includes("Rae won't eat cilantro, olives"));
    assert.equal(prompt.includes("Kit won't eat"), false);
  });
});

describe("meal requests are stated, not left behind a tool", () => {
  // Regression: asked to plan a week, the model skipped list_meal_requests and
  // asked the user to type out their requests and dietary needs instead. Same
  // reasoning as the dislikes above -- a lookup the model has to remember is a
  // lookup it will sometimes skip.
  function addRequest(name: string, extra: Record<string, unknown> = {}) {
    putScopedItem("meal_requests", userId, {
      id: newId("request"),
      name,
      notes: "",
      scope: "joint",
      createdBy: userId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...extra,
    });
  }

  before(() => {
    addRequest("Lasagne");
    addRequest("Katsu curry", { notes: "not too spicy" });
  });

  test("names the requested meals", () => {
    const prompt = systemPrompt(userId, false);
    assert.match(prompt, /meals someone has asked for/i);
    assert.ok(prompt.includes("Lasagne"));
    assert.ok(prompt.includes("Katsu curry"));
  });

  test("carries the note attached to a request", () => {
    assert.ok(systemPrompt(userId, false).includes("(not too spicy)"));
  });

  test("no longer claims nobody has asked for anything", () => {
    assert.equal(/nobody has requested/i.test(systemPrompt(userId, false)), false);
  });
});

describe("earlier tool results are not current", () => {
  // Replayed tool results (assistant/history.ts) are labelled as earlier ones; this is the matching rule. Without it
  // the local model answered "what's on the list right now?" from the replayed result and reported a stale list.
  test("tells the model to call the tool again rather than answer from an earlier result", () => {
    for (const hide of [false, true]) {
      const prompt = systemPrompt(userId, hide).replace(/\s+/g, " ");
      assert.ok(prompt.includes("Tool results from earlier in this chat can be out of date."));
      assert.ok(prompt.includes("call the tool again instead of answering from an earlier result"));
    }
  });
});

describe("the rules that stop it interrogating the user", () => {
  test("forbids asking for what the prompt or a tool already has", () => {
    const prompt = systemPrompt(userId, false);
    assert.match(prompt, /never ask the user for something already stated above/i);
  });

  test("says there is no grocery money budget or serving count to ask about", () => {
    // It asked for "a budget for the week" -- a setting this app does not
    // have, so the user had no way to answer it. (Phase 6: "budget" here is explicitly the grocery MONEY
    // budget; calorie targets are a different thing and come from a tool.)
    const prompt = systemPrompt(userId, false);
    assert.match(prompt, /no grocery money budget,\s+serving count/i);
  });

  test("says the days the user gave are the answer", () => {
    assert.match(systemPrompt(userId, false), /that is your answer/i);
  });

  test("no rule anywhere still tells it to ask for those things", () => {
    // The actual cause of the interrogation was not a missing rule but a
    // contradicting one: the meal-plan tool rules told it to ask for the days,
    // dietary restrictions and a budget. Tool rules are appended last, so it
    // beat everything above. A rule that says "ask" and a rule that says
    // "never ask" cannot both sit in this prompt.
    const prompt = systemPrompt(userId, false);
    assert.equal(/ask the user which week/i.test(prompt), false);
    assert.equal(/dietary restrictions or budget/i.test(prompt), false);
  });
});

describe("the PIN lock is reflected in the prompt", () => {
  test("unlocked, the finance section is described", () => {
    assert.ok(systemPrompt(userId, false).includes("household finances"));
  });

  test("locked, it is not -- so the model doesn't advertise a refused capability", () => {
    const locked = systemPrompt(userId, true);
    assert.equal(locked.includes("household finances"), false);
  });

  test("locking removes only the finance section, not the rest", () => {
    const locked = systemPrompt(userId, true);
    for (const section of ["shopping lists", "the pantry", "meal plans", "the household calendar"]) {
      assert.ok(locked.includes(section), `locking should not have removed "${section}"`);
    }
  });

  test("the roster survives locking -- dietary rules are not financial", () => {
    assert.ok(systemPrompt(userId, true).includes("Sam won't eat mushrooms"));
  });
});

describe("formatting", () => {
  test("every rule line is a single-dashed bullet", () => {
    // toolPromptRules deliberately omits the leading "-" so systemPrompt can
    // add it; if a module ever included one, this catches the "- - Rule".
    const prompt = systemPrompt(userId, false);
    const bullets = prompt.split("\n").filter((l) => l.startsWith("-"));
    assert.ok(bullets.length > 5);
    for (const line of bullets) {
      assert.equal(line.startsWith("- -"), false, `double-dashed bullet: ${line}`);
    }
  });

  test("does not end with a dangling empty bullet", () => {
    assert.equal(systemPrompt(userId, false).trimEnd().endsWith("-"), false);
  });
});

describe("the grocery budget, once an admin shares it", () => {
  // Coupled to the "no budget" rule above: the two wordings must never both be
  // in the prompt, or the model is told a figure and told none exists.
  before(() => {
    putScopedItemAs("budgets", userId, "Groceries", { category: "Groceries", limit: 650, spent: 412.37, scope: "joint" });
  });
  after(() => {
    setConfig(SHARE_GROCERY_BUDGET_KEY, false);
    deleteScopedItem("budgets", userId, "Groceries");
  });

  test("stays out of the prompt while not shared", () => {
    setConfig(SHARE_GROCERY_BUDGET_KEY, false);
    const prompt = systemPrompt(userId, false);
    assert.equal(prompt.includes("$650"), false);
    assert.match(prompt, /no grocery money budget,\s+serving count/i);
  });

  test("states the figure and drops the claim that there is no budget", () => {
    setConfig(SHARE_GROCERY_BUDGET_KEY, true);
    const prompt = systemPrompt(userId, false);
    assert.ok(prompt.includes("grocery budget is $650 a month, about $150 a week"));
    assert.equal(/no grocery money budget/i.test(prompt), false);
    assert.match(prompt, /never ask for a different figure/i);
  });

  test("never carries what has been spent", () => {
    setConfig(SHARE_GROCERY_BUDGET_KEY, true);
    assert.equal(systemPrompt(userId, false).includes("412"), false);
  });

  test("is still stated while the budget PIN lock is engaged -- that is what sharing it means", () => {
    setConfig(SHARE_GROCERY_BUDGET_KEY, true);
    assert.ok(systemPrompt(userId, true).includes("$650"));
  });
});
