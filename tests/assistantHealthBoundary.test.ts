// The data boundary for HEALTH data (the food diary, calories, calorie budgets, weight, steps), the
// independent twin of the money rule in providers.test.ts:
//
//   1. routing   a turn that looks health-related runs on local Ollama, decided before the first model call;
//   2. tools     a cloud provider is never even HANDED a health tool definition unless the admin switched that
//                provider on (`assistant.allowCloudHealth.<provider>`, off by default, Claude and Gemini separate,
//                and independent of the money switches);
//   3. voice     a spoken health question is refused by default (`assistant.noHealthVoiceData`), like money;
//   4. locks     the person's own "Require the PIN for my food diary" withholds the health tools like Budget's lock;
//   5. kiosk     the kiosk login gets plan-level tools only.
//
// The last test goes all the way to the wire: with a cloud provider selected and the switch off, the request body a
// stubbed fetch receives contains no health tool and the prompt names none.

import { test, describe, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";

import "../env.ts";
process.env.ANTHROPIC_API_KEY = "test-key-anthropic";
process.env.GEMINI_API_KEY = "test-key-gemini";

import { loadDb, cleanupDb } from "./helpers/testdb.ts";
import { callRoute } from "./helpers/router.ts";
import type { ToolDefinition } from "../ollama.ts";

const { createUser, db, setConfig, getConfig } = await loadDb();
const providers = await import("../assistant/providers/index.ts");
const { planTurn, VOICE_HEALTH_REPLY, VOICE_FINANCE_REPLY } = await import("../assistant/turn.ts");
const { systemPrompt } = await import("../assistant/systemPrompt.ts");
const { assistantRoutes } = await import("../routes/assistant.ts");
const { KIOSK_ACCESS_KEY } = await import("../routes/nutrition.ts");
const { saveProfile, getTracker } = await import("../nutrition/data/tracker.ts");
const { anthropicProvider } = await import("../assistant/providers/anthropic.ts");
const { turnTouchesHealthData, turnTouchesFinancialData, selectProvider, toolsForProvider, mayReceiveHealth, blocksVoiceHealth } = providers;

let admin: string;
let parent: string;
let kiosk: string;

const realFetch = globalThis.fetch;
const FLAGS = ["anthropic", "gemini"] as const;
function reset() {
  for (const p of FLAGS) {
    setConfig(`assistant.allowCloudHealth.${p}`, false);
    setConfig(`assistant.allowCloudFinance.${p}`, false);
  }
  setConfig("assistant.noHealthVoiceData", true);
  setConfig("assistant.noFinanceVoiceData", true);
  setConfig(KIOSK_ACCESS_KEY, "hidden");
  setConfig(`nutrition_require_pin:${admin}`, false);
  setConfig("lock_pin_hash", null);
}

before(async () => {
  admin = createUser("admin-hb", await bcrypt.hash("right-password", 4), "Ada", "admin");
  parent = createUser("parent-hb", await bcrypt.hash("parent-password", 4), "Pat", "parent");
  kiosk = createUser("kiosk-hb", "not-a-real-hash", "Kiosk", "kiosk");
  saveProfile(db, getTracker(db, admin), { sex: "female", birthDate: "1990-06-15", heightCm: 170 });
  reset();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  reset();
});
after(cleanupDb);

function tool(name: string, sensitivity: ToolDefinition["sensitivity"]): ToolDefinition {
  return { name, description: name, parameters: { type: "object", properties: {} }, run: async () => ({}), domain: "test", sensitivity };
}
const house = tool("add_grocery_item", "household");
const money = tool("get_budget_summary", "financial");
const health = tool("get_calorie_day_summary", "health");
const names = (tools: ToolDefinition[]) => tools.map((t) => t.name).sort();

describe("turnTouchesHealthData -- what counts as health", () => {
  test("flags the food diary, calories, weight, steps and someone saying what they ate", () => {
    for (const message of [
      "how many calories do I have left today",
      "I had two eggs and toast for breakfast",
      "we ate pizza last night",
      "what's Bea's weight",
      "did I weigh in this morning",
      "log my lunch",
      "how many steps did I walk",
      "show my steps today",
      "what's my logging streak",
      "how much protein have I had",
      "what's in my food diary",
      "plan dinners this week within our calorie budgets",
      "how many kcal is a banana",
    ]) {
      assert.equal(turnTouchesHealthData(message, []), true, `should be health: ${message}`);
    }
  });

  test("is case-insensitive and matches whole words", () => {
    assert.equal(turnTouchesHealthData("CALORIES LEFT?", []), true);
    assert.equal(turnTouchesHealthData("is the carbonara ready", []), false, "carb- inside a longer word");
    assert.equal(turnTouchesHealthData("a diaryfree dinner", []), false);
  });

  test("ordinary household and money turns are not health", () => {
    for (const message of [
      "what's for dinner tomorrow",
      "add milk to the grocery list",
      "how much is left in the grocery budget",
      "how much have we spent this month",
      "who has soccer practice this week",
      "read me the recipe steps",
      "plan meals for the week",
    ]) {
      assert.equal(turnTouchesHealthData(message, []), false, `should not be health: ${message}`);
    }
  });

  test("a health earlier turn taints an innocuous follow-up, and EVERY history entry is scanned", () => {
    const history = [{ text: "You've eaten 1,240 calories today." }, ...Array.from({ length: 24 }, (_, i) => ({ text: `turn ${i} about dinner` }))];
    assert.equal(turnTouchesHealthData("and what about tomorrow", history), true);
    assert.equal(turnTouchesHealthData("and what about tomorrow", history.slice(1)), false);
  });

  test("the money signal and the health signal are independent", () => {
    assert.equal(turnTouchesFinancialData("how many calories are left", []), false);
    assert.equal(turnTouchesHealthData("how much is left in the budget", []), false);
    assert.equal(turnTouchesHealthData("how much is left in my calorie budget", []), true);
  });
});

describe("routing: a health turn runs on the local model", () => {
  test("a cloud pick is overridden to Ollama for a health turn, whichever cloud it was", () => {
    for (const id of FLAGS) assert.equal(selectProvider(id, false, {}, true, {}).id, "ollama", id);
  });

  test("a non-health turn keeps the user's pick", () => {
    for (const id of FLAGS) assert.equal(selectProvider(id, false, {}, false, {}).id, id);
  });

  test("the per-provider health switch lets a health turn through to THAT provider only", () => {
    assert.equal(selectProvider("anthropic", false, {}, true, { anthropic: true }).id, "anthropic");
    assert.equal(selectProvider("gemini", false, {}, true, { anthropic: true }).id, "ollama", "Claude's switch is not Gemini's");
    assert.equal(selectProvider("gemini", false, {}, true, { gemini: true }).id, "gemini");
  });

  test("money consent never lets health through, and health consent never lets money through", () => {
    assert.equal(selectProvider("anthropic", false, { anthropic: true }, true, {}).id, "ollama");
    assert.equal(selectProvider("anthropic", true, {}, false, { anthropic: true }).id, "ollama");
  });

  test("a turn that is both needs both consents", () => {
    assert.equal(selectProvider("anthropic", true, { anthropic: true }, true, {}).id, "ollama");
    assert.equal(selectProvider("anthropic", true, {}, true, { anthropic: true }).id, "ollama");
    assert.equal(selectProvider("anthropic", true, { anthropic: true }, true, { anthropic: true }).id, "anthropic");
  });

  test("only a real boolean true counts as consent; garbage never does", () => {
    for (const bad of ["true", 1, "yes", {}, null, undefined]) {
      assert.equal(mayReceiveHealth("anthropic", { anthropic: bad as any }), false);
    }
    assert.equal(mayReceiveHealth("ollama", {}), true);
  });

  test("existing two-argument callers still get the strict money behaviour", () => {
    assert.equal(selectProvider("anthropic", true).id, "ollama");
    assert.equal(selectProvider("anthropic", false).id, "anthropic");
  });
});

describe("toolsForProvider: the hard guarantee", () => {
  const all = [house, money, health];

  test("a cloud provider gets no health tool without its switch (and no money tool without its own)", () => {
    for (const id of FLAGS) assert.deepEqual(names(toolsForProvider(id, all)), ["add_grocery_item"], id);
  });

  test("Claude and Gemini are independent", () => {
    assert.deepEqual(names(toolsForProvider("anthropic", all, {}, { anthropic: true })), ["add_grocery_item", "get_calorie_day_summary"]);
    assert.deepEqual(names(toolsForProvider("gemini", all, {}, { anthropic: true })), ["add_grocery_item"]);
    assert.deepEqual(names(toolsForProvider("gemini", all, {}, { gemini: true })), ["add_grocery_item", "get_calorie_day_summary"]);
  });

  test("the health switch does not unlock money tools, and the money switch does not unlock health tools", () => {
    assert.deepEqual(names(toolsForProvider("anthropic", all, {}, { anthropic: true })).includes("get_budget_summary"), false);
    assert.deepEqual(names(toolsForProvider("anthropic", all, { anthropic: true }, {})).includes("get_calorie_day_summary"), false);
    assert.deepEqual(names(toolsForProvider("anthropic", all, { anthropic: true }, { anthropic: true })), names(all));
  });

  test("local Ollama always gets everything", () => {
    assert.deepEqual(names(toolsForProvider("ollama", all)), names(all));
  });
});

describe("voice and watch", () => {
  test("blocksVoiceHealth blocks only when all three hold, like blocksVoiceFinance", () => {
    assert.equal(blocksVoiceHealth("voice", true, true), true);
    assert.equal(blocksVoiceHealth("voice", false, true), false, "not health");
    assert.equal(blocksVoiceHealth("text", true, true), false, "not voice");
    assert.equal(blocksVoiceHealth(undefined, true, true), false, "a missing inputMode is typed");
    assert.equal(blocksVoiceHealth("voice", true, false), false, "setting turned off");
  });

  const turn = (message: string, extra: Record<string, unknown> = {}) =>
    planTurn({ userId: admin, message, history: [], unlocked: true, requestedProvider: "ollama", ...extra });

  test("a spoken health question is refused before any provider by default; typed is not", () => {
    assert.equal(turn("how many calories do I have left", { inputMode: "voice", device: true }).blocked?.reply, VOICE_HEALTH_REPLY);
    assert.equal(turn("how many calories do I have left", { inputMode: "voice", device: true }).blocked?.kind, "health");
    assert.equal(turn("how many calories do I have left").blocked, undefined);
    assert.equal(turn("add milk to the list", { inputMode: "voice", device: true }).blocked, undefined, "an ordinary spoken turn is fine");
  });

  test("the setting is on (blocking) by default, and the admin turning it off lets the spoken question through", () => {
    assert.equal(getConfig("assistant.noHealthVoiceData", true), true);
    setConfig("assistant.noHealthVoiceData", false);
    assert.equal(turn("how many calories do I have left", { inputMode: "voice", device: true }).blocked, undefined);
  });

  test("money voice blocking is unchanged, and its reply is the same words as before", () => {
    const money = turn("how much did we spend", { inputMode: "voice", device: true });
    assert.equal(money.blocked?.kind, "finance");
    assert.equal(money.blocked?.reply, VOICE_FINANCE_REPLY);
    setConfig("assistant.noFinanceVoiceData", false);
    assert.equal(turn("how much did we spend", { inputMode: "voice", device: true }).blocked, undefined);
  });

  test("the two voice switches are independent", () => {
    setConfig("assistant.noHealthVoiceData", false);
    assert.equal(turn("how much did we spend", { inputMode: "voice", device: true }).blocked?.kind, "finance");
    setConfig("assistant.noHealthVoiceData", true);
    setConfig("assistant.noFinanceVoiceData", false);
    assert.equal(turn("how many calories are left", { inputMode: "voice", device: true }).blocked?.kind, "health");
  });
});

describe("planTurn: one turn, end to end", () => {
  const turn = (message: string, extra: Record<string, unknown> = {}) =>
    planTurn({ userId: admin, message, history: [], unlocked: true, ...extra });
  const healthNames = (tools: ToolDefinition[]) => tools.filter((t) => t.sensitivity === "health").map((t) => t.name);

  test("a health question picked for Claude runs on Ollama and keeps the health tools", () => {
    const p = turn("how many calories do I have left today", { requestedProvider: "anthropic" });
    assert.equal(p.provider.id, "ollama");
    assert.equal(p.isHealth, true);
    assert.ok(healthNames(p.tools).includes("get_calorie_day_summary"));
    assert.equal(p.prompt.hideHealth, false);
  });

  test("an ordinary question picked for Claude stays on Claude, WITHOUT the health or money tools, and the prompt hides the diaries", () => {
    const p = turn("what's in the pantry", { requestedProvider: "anthropic" });
    assert.equal(p.provider.id, "anthropic");
    assert.deepEqual(p.tools.filter((t) => t.sensitivity !== "household"), []);
    assert.ok(p.tools.some((t) => t.name === "list_pantry_items"));
    assert.equal(p.prompt.hideHealth, true);
    const prompt = systemPrompt(admin, p.prompt);
    assert.equal(prompt.includes("get_calorie_day_summary"), false);
    assert.equal(prompt.includes("add_planned_calorie_diary_entries"), false);
    assert.equal(prompt.includes("plan_meals_within_calorie_budgets"), false);
    assert.equal(prompt.includes("calorie diaries"), false);
    assert.match(prompt, /cannot see anyone's food diary/);
  });

  test("with Claude's health switch on, a health turn goes to Claude with the health tools -- Gemini's stays off", () => {
    setConfig("assistant.allowCloudHealth.anthropic", true);
    const claude = turn("how many calories do I have left today", { requestedProvider: "anthropic" });
    assert.equal(claude.provider.id, "anthropic");
    assert.ok(healthNames(claude.tools).includes("get_calorie_day_summary"));
    assert.deepEqual(claude.tools.filter((t) => t.sensitivity === "financial"), [], "money is still off");
    assert.equal(claude.prompt.hideHealth, false);
    const gemini = turn("how many calories do I have left today", { requestedProvider: "gemini" });
    assert.equal(gemini.provider.id, "ollama");
  });

  test("an ordinary turn on Claude with the switch on does get the health tools (consent covers the tools)", () => {
    setConfig("assistant.allowCloudHealth.anthropic", true);
    const p = turn("what's in the pantry", { requestedProvider: "anthropic" });
    assert.equal(p.provider.id, "anthropic");
    assert.ok(healthNames(p.tools).length > 0);
  });

  test("the money consent does not open health, on the plan either", () => {
    setConfig("assistant.allowCloudFinance.anthropic", true);
    const p = turn("what's in the pantry", { requestedProvider: "anthropic" });
    assert.ok(p.tools.some((t) => t.sensitivity === "financial"));
    assert.deepEqual(healthNames(p.tools), []);
    assert.equal(turn("how many calories are left", { requestedProvider: "anthropic" }).provider.id, "ollama");
  });

  test("local Ollama with an ordinary turn gets every tool, and the planning prompt points at the calorie targets tool", () => {
    const p = turn("plan meals for the week", { requestedProvider: "ollama" });
    assert.ok(healthNames(p.tools).includes("plan_meals_within_calorie_budgets"));
    assert.match(systemPrompt(admin, p.prompt), /plan_meals_within_calorie_budgets/);
  });

  test("while the budget PIN lock is engaged, money tools go but health tools stay; and the other way round for the food-diary lock", () => {
    const locked = turn("how many calories are left", { unlocked: false, requestedProvider: "ollama" });
    assert.equal(locked.tools.some((t) => t.sensitivity === "financial"), false);
    assert.ok(healthNames(locked.tools).length > 0, "the budget lock is not the food-diary lock");

    setConfig(`nutrition_require_pin:${admin}`, true);
    setConfig("lock_pin_hash", "x");
    const diaryLocked = turn("how many calories are left", { unlocked: false, requestedProvider: "ollama" });
    assert.equal(diaryLocked.foodDiaryLocked, true);
    assert.deepEqual(healthNames(diaryLocked.tools), []);
    assert.equal(diaryLocked.prompt.hideHealth, true);
    const unlocked = turn("how many calories are left", { unlocked: true, requestedProvider: "ollama" });
    assert.equal(unlocked.foodDiaryLocked, false);
    assert.ok(healthNames(unlocked.tools).length > 0);
    const watch = turn("how many calories are left", { unlocked: true, device: true, requestedProvider: "ollama" });
    assert.equal(watch.foodDiaryLocked, true, "a watch can't enter the PIN");
  });

  test("with the option off, a locked budget session leaves the diary tools alone", () => {
    setConfig("lock_pin_hash", "x");
    assert.equal(turn("how many calories are left", { unlocked: false }).foodDiaryLocked, false);
  });

  test("history is scanned too: a health reply earlier in the window keeps a later innocuous turn local", () => {
    const p = turn("thanks, and tomorrow?", { requestedProvider: "anthropic", history: [{ text: "You have 640 calories left." }] });
    assert.equal(p.provider.id, "ollama");
  });
});

describe("the kiosk login", () => {
  const turn = (message = "what's for dinner", extra: Record<string, unknown> = {}) =>
    planTurn({ userId: kiosk, message, history: [], unlocked: true, requestedProvider: "ollama", ...extra });
  const healthNames = (tools: ToolDefinition[]) => tools.filter((t) => t.sensitivity === "health").map((t) => t.name).sort();

  test("hidden (the default): no food tools at all, but the meal plan and recipe tools stay", () => {
    const p = turn();
    assert.deepEqual(healthNames(p.tools), []);
    for (const name of ["list_recipes", "get_meal_plan", "save_recipe", "create_meal_plan"]) assert.ok(p.tools.some((t) => t.name === name), name);
    assert.equal(p.role, "kiosk");
  });

  test("plan only: it may read portions, never log", () => {
    setConfig(KIOSK_ACCESS_KEY, "plan_only");
    assert.deepEqual(healthNames(turn().tools), ["get_planned_meal_portions"]);
  });

  test("plan + quick logging: it may also mark a planned meal-plan meal as eaten", () => {
    setConfig(KIOSK_ACCESS_KEY, "plan_and_quick_log");
    assert.deepEqual(healthNames(turn().tools), ["get_planned_meal_portions", "log_planned_meal"]);
  });

  test("never a diary, total, calorie budget, weight, step or goal tool, whatever the setting", () => {
    setConfig(KIOSK_ACCESS_KEY, "plan_and_quick_log");
    const all = turn().tools.map((t) => t.name);
    for (const banned of ["get_calorie_day_summary", "get_calorie_week_summary", "get_weight_progress", "add_planned_calorie_diary_entries", "plan_meals_within_calorie_budgets"]) {
      assert.equal(all.includes(banned), false, banned);
    }
  });

  test("the kiosk prompt names only the kiosk tools it has, and says it can't see diaries", () => {
    setConfig(KIOSK_ACCESS_KEY, "plan_only");
    const plan = turn();
    const prompt = systemPrompt(kiosk, plan.prompt);
    assert.match(prompt, /shared kitchen screen/);
    assert.ok(prompt.includes("get_planned_meal_portions"));
    assert.equal(prompt.includes("log_planned_meal"), false, "no logging tool offered, none described");
    assert.equal(prompt.includes("get_calorie_day_summary"), false);
    assert.match(prompt, /no access to anyone's food diary/);
  });

  test("on a cloud provider the kiosk's health-tagged tools are withheld too", () => {
    setConfig(KIOSK_ACCESS_KEY, "plan_and_quick_log");
    const p = turn("what's for dinner", { requestedProvider: "anthropic" });
    assert.equal(p.provider.id, "anthropic");
    assert.deepEqual(healthNames(p.tools), []);
  });
});

describe("the wire: a cloud request carries no health tool and no health prompt", () => {
  test("with the switch off, what Claude's request body holds is household only", async () => {
    const plan = planTurn({ userId: admin, message: "what's in the pantry", history: [], unlocked: true, requestedProvider: "anthropic" });
    assert.equal(plan.provider.id, "anthropic");

    let body: any;
    globalThis.fetch = (async (_url: any, init: any) => {
      body = JSON.parse(init.body);
      const sse = (events: Array<{ event: string; data: unknown }>) =>
        new Response(new ReadableStream({
          start(c) {
            for (const e of events) c.enqueue(new TextEncoder().encode(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`));
            c.close();
          },
        }), { status: 200 });
      return sse([
        { event: "content_block_start", data: { index: 0, content_block: { type: "text", text: "" } } },
        { event: "content_block_delta", data: { index: 0, delta: { type: "text_delta", text: "ok" } } },
        { event: "content_block_stop", data: { index: 0 } },
        { event: "message_delta", data: { delta: { stop_reason: "end_turn" } } },
      ]);
    }) as typeof fetch;

    await anthropicProvider.chat(
      [{ role: "system", content: systemPrompt(admin, plan.prompt) }, { role: "user", content: "what's in the pantry" }],
      plan.tools
    );
    const sentTools: string[] = body.tools.map((t: any) => t.name);
    assert.ok(sentTools.includes("list_pantry_items"));
    const banned = ["get_calorie_day_summary", "get_calorie_week_summary", "get_weight_progress", "add_planned_calorie_diary_entries", "plan_meals_within_calorie_budgets", "get_budget_summary"];
    for (const name of banned) assert.equal(sentTools.includes(name), false, `${name} was sent to Claude`);
    const wire = JSON.stringify(body);
    for (const word of banned) assert.equal(wire.includes(word), false, `${word} appears in Claude's request`);
  });
});

describe("the admin switches (routes/assistant.ts)", () => {
  const as = (userId: string) => ({ session: { userId } });
  const put = (path: string, userId: string, body: unknown) => callRoute(assistantRoutes, "PUT", path, { ...as(userId), body });

  test("GET /settings reports both, defaulting to off (cloud) and on (voice block)", async () => {
    const r = await callRoute(assistantRoutes, "GET", "/settings", as(admin));
    assert.deepEqual(r.body.allowCloudHealth, { anthropic: false, gemini: false });
    assert.equal(r.body.noHealthVoiceData, true);
    assert.deepEqual(r.body.allowCloudFinance, { anthropic: false, gemini: false });
  });

  test("turning a cloud switch ON needs the admin's password; OFF does not", async () => {
    assert.equal((await put("/settings/cloud-health", admin, { provider: "anthropic", allow: true })).status, 401);
    assert.equal((await put("/settings/cloud-health", admin, { provider: "anthropic", allow: true, password: "wrong" })).status, 401);
    assert.equal(getConfig("assistant.allowCloudHealth.anthropic", false), false);
    const on = await put("/settings/cloud-health", admin, { provider: "anthropic", allow: true, password: "right-password" });
    assert.equal(on.status, 200);
    assert.deepEqual(on.body.allowCloudHealth, { anthropic: true, gemini: false });
    const off = await put("/settings/cloud-health", admin, { provider: "anthropic", allow: false });
    assert.deepEqual(off.body.allowCloudHealth, { anthropic: false, gemini: false });
  });

  test("Claude and Gemini are separate switches, and neither touches the money ones", async () => {
    await put("/settings/cloud-health", admin, { provider: "gemini", allow: true, password: "right-password" });
    const r = await callRoute(assistantRoutes, "GET", "/settings", as(admin));
    assert.deepEqual(r.body.allowCloudHealth, { anthropic: false, gemini: true });
    assert.deepEqual(r.body.allowCloudFinance, { anthropic: false, gemini: false });
  });

  test("a parent, the kiosk and a bad provider or value are refused", async () => {
    assert.equal((await put("/settings/cloud-health", parent, { provider: "anthropic", allow: true, password: "parent-password" })).status, 403);
    assert.equal((await put("/settings/cloud-health", kiosk, { provider: "anthropic", allow: false })).status, 403);
    assert.equal((await put("/settings/cloud-health", admin, { provider: "ollama", allow: true, password: "right-password" })).status, 400);
    assert.equal((await put("/settings/cloud-health", admin, { provider: "anthropic", allow: "yes", password: "right-password" })).status, 400);
    assert.equal(getConfig("assistant.allowCloudHealth.anthropic", false), false);
  });

  test("the voice setting: admin only, a real boolean, never from a device token", async () => {
    assert.equal((await put("/settings/health-voice", admin, { noHealthVoiceData: false })).body.noHealthVoiceData, false);
    assert.equal(getConfig("assistant.noHealthVoiceData", true), false);
    assert.equal((await put("/settings/health-voice", parent, { noHealthVoiceData: true })).status, 403);
    assert.equal((await put("/settings/health-voice", admin, { noHealthVoiceData: "no" })).status, 400);
    const device = await callRoute(assistantRoutes, "PUT", "/settings/health-voice", { session: {}, deviceUserId: admin, body: { noHealthVoiceData: true } });
    assert.equal(device.status, 403);
  });

  test("the money voice setting is untouched by all of this", async () => {
    const r = await callRoute(assistantRoutes, "PUT", "/settings", { ...as(admin), body: { noFinanceVoiceData: false } });
    assert.equal(r.body.noFinanceVoiceData, false);
    assert.equal(getConfig("assistant.noHealthVoiceData", true), true);
  });
});
