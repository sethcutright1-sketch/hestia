// The data boundary (PLAN.md Stage 2): "anything financial runs on local
// Ollama, never a cloud model."
//
// That promise is enforced by three small pure functions, and nothing else in
// the app re-checks their work. If one of them quietly stops holding, no
// request fails and no log line appears -- household transaction data just
// starts leaving the house. That is exactly the failure mode a type checker
// cannot see, which is why these are the first tests in the repo.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import type { ToolDefinition } from "../ollama.ts";
import {
  turnTouchesFinancialData,
  selectProvider,
  toolsForProvider,
  mayReceiveFinancial,
} from "../assistant/providers/index.ts";

/** A tool literal shaped like registry.ts stamps them, with no real `run`. */
function tool(name: string, sensitivity: ToolDefinition["sensitivity"], domain = "test"): ToolDefinition {
  return {
    name,
    description: `${name} (test fixture)`,
    parameters: { type: "object", properties: {} },
    run: async () => ({}),
    domain,
    sensitivity,
  };
}

const groceryTool = tool("add_grocery_item", "household", "grocery");
const budgetTool = tool("list_transactions", "financial", "budget");
const cardTool = tool("get_credit_cards", "financial", "budget");

describe("turnTouchesFinancialData -- what counts as financial", () => {
  test("flags plain financial vocabulary", () => {
    for (const message of [
      "how much did we spend on groceries",
      "what's my checking balance",
      "add a transaction for gas",
      "show me the budget for March",
      "how much debt is on the credit card",
      "when is the electric bill due",
      "did my paycheck land",
    ]) {
      assert.equal(turnTouchesFinancialData(message, []), true, `should be financial: ${message}`);
    }
  });

  test("flags a bare dollar amount even with no financial word", () => {
    assert.equal(turnTouchesFinancialData("was it more than $40", []), true);
  });

  test("is case-insensitive", () => {
    assert.equal(turnTouchesFinancialData("WHAT IS MY BALANCE", []), true);
  });

  test("matches whole words, not fragments inside longer ones", () => {
    // "billy" contains "bill"; a substring check would route a question about a
    // household member to Ollama and blame the data boundary for it.
    assert.equal(turnTouchesFinancialData("is Billy free on Saturday", []), false);
  });

  test("does not fire on words that are only financial in context", () => {
    // Regression test for the 2026-09-06 backlog fix: these four were in
    // FINANCIAL_SIGNAL and silently overrode the user's provider choice on
    // ordinary turns. This is the test that keeps them out.
    for (const message of [
      "what's my goal for the week",
      "have I paid enough attention to the plants",
      "can we afford the time for a trip",
      "set an alert for Tuesday",
    ]) {
      assert.equal(turnTouchesFinancialData(message, []), false, `should not be financial: ${message}`);
    }
  });

  test("ordinary household turns stay non-financial", () => {
    for (const message of [
      "what's for dinner tomorrow",
      "add milk to the grocery list",
      "what's in the fridge",
      "who has soccer practice this week",
    ]) {
      assert.equal(turnTouchesFinancialData(message, []), false, `should not be financial: ${message}`);
    }
  });
});

describe("turnTouchesFinancialData -- history scanning", () => {
  test("a financial earlier turn taints an innocuous follow-up", () => {
    // "add that to the list" says nothing financial on its own, but the turn it
    // refers to named merchants and amounts -- and that prior turn is being
    // transmitted alongside it.
    const history = [{ text: "how much did we spend at Costco" }, { text: "You spent $214.86 at Costco." }];
    assert.equal(turnTouchesFinancialData("add that to the list", history), true);
  });

  test("innocuous history leaves an innocuous turn alone", () => {
    const history = [{ text: "what's for dinner" }, { text: "Tacos are planned for Tuesday." }];
    assert.equal(turnTouchesFinancialData("what do I need to buy", history), false);
  });

  test("scans EVERY history entry it is handed, not a fixed-size tail", () => {
    // The invariant: server.ts scans exactly the history it is about to
    // transmit. It windows that history by CHARACTER budget
    // (HISTORY_CHAR_BUDGET = 12_000), so twenty short messages can all be sent
    // in one request. Anything this function skips is a message that reaches a
    // cloud provider unscanned -- and an assistant's own prose about a budget
    // question names real merchants and amounts.
    //
    // 25 short turns, with the only financial one at the very front.
    const history = [
      { text: "You spent $214.86 at Costco on groceries." },
      ...Array.from({ length: 24 }, (_, i) => ({ text: `turn ${i} about dinner plans` })),
    ];
    assert.equal(
      turnTouchesFinancialData("and what about that other thing", history),
      true,
      "a financial turn inside the transmitted window must be caught no matter how far back it sits"
    );
  });
});

describe("selectProvider -- layer 1 of the boundary", () => {
  test("a financial turn goes to Ollama even when a cloud provider was picked", () => {
    assert.equal(selectProvider("anthropic", true).id, "ollama");
    assert.equal(selectProvider("gemini", true).id, "ollama");
  });

  test("a non-financial turn honours the user's pick", () => {
    assert.equal(selectProvider("anthropic", false).id, "anthropic");
    assert.equal(selectProvider("gemini", false).id, "gemini");
    assert.equal(selectProvider("ollama", false).id, "ollama");
  });

  test("an unknown or absent pick falls back to Ollama, never to a cloud provider", () => {
    assert.equal(selectProvider(undefined, false).id, "ollama");
    assert.equal(selectProvider("", false).id, "ollama");
    assert.equal(selectProvider("openai", false).id, "ollama");
    // A prototype-pollution-ish key must not resolve to a provider object.
    assert.equal(selectProvider("constructor", false).id, "ollama");
    assert.equal(selectProvider("toString", false).id, "ollama");
  });
});

describe("toolsForProvider -- layer 2 of the boundary", () => {
  const all = [groceryTool, budgetTool, cardTool];

  test("cloud providers are never handed a financial tool", () => {
    for (const providerId of ["anthropic", "gemini"] as const) {
      const got = toolsForProvider(providerId, all).map((t) => t.name);
      assert.deepEqual(got, ["add_grocery_item"], `${providerId} must not see financial tools`);
    }
  });

  test("Ollama gets the full set", () => {
    assert.equal(toolsForProvider("ollama", all).length, 3);
  });

  test("filters on `sensitivity`, not on `domain`", () => {
    // domain is presentation only. A financial tool that lives outside the
    // budget section must still be stripped, and a household tool that happens
    // to be grouped under "budget" must still be offered.
    const oddlyPlaced = [
      tool("get_paycheck_dates", "financial", "calendar"),
      tool("explain_budget_ui", "household", "budget"),
    ];
    const got = toolsForProvider("anthropic", oddlyPlaced).map((t) => t.name);
    assert.deepEqual(got, ["explain_budget_ui"]);
  });

  test("does not mutate the list it was given", () => {
    const input = [...all];
    toolsForProvider("anthropic", input);
    assert.equal(input.length, 3);
  });
});

describe("the two layers together", () => {
  test("even a misrouted financial turn cannot call a financial tool", () => {
    // Belt and braces: pretend layer 1 got it wrong and a financial turn was
    // routed to Anthropic anyway. Layer 2 still has to hold on its own.
    const provider = selectProvider("anthropic", /* isFinancial */ false);
    const offered = toolsForProvider(provider.id, [groceryTool, budgetTool]);
    assert.equal(
      offered.some((t) => t.sensitivity === "financial"),
      false
    );
  });
});

describe("assistant.allowCloudFinance.<provider> opt-in", () => {
  const all = [groceryTool, budgetTool, cardTool];
  const names = (providerId: "anthropic" | "gemini", allowed: object) =>
    toolsForProvider(providerId, all, allowed).map((t) => t.name);

  test("no allowance (the default) behaves exactly like the strict boundary", () => {
    for (const allowed of [undefined, {}, { anthropic: false, gemini: false }]) {
      assert.equal(selectProvider("anthropic", true, allowed).id, "ollama");
      assert.equal(selectProvider("gemini", true, allowed).id, "ollama");
      assert.deepEqual(names("anthropic", allowed ?? {}), ["add_grocery_item"]);
      assert.deepEqual(names("gemini", allowed ?? {}), ["add_grocery_item"]);
    }
  });

  test("only Claude on: Claude gets financial turns and tools, Gemini still doesn't", () => {
    const allowed = { anthropic: true };
    assert.equal(selectProvider("anthropic", true, allowed).id, "anthropic");
    assert.equal(toolsForProvider("anthropic", all, allowed).length, 3);
    assert.equal(selectProvider("gemini", true, allowed).id, "ollama");
    assert.deepEqual(names("gemini", allowed), ["add_grocery_item"]);
  });

  test("only Gemini on: the mirror image -- one switch never implies the other", () => {
    const allowed = { gemini: true };
    assert.equal(selectProvider("gemini", true, allowed).id, "gemini");
    assert.equal(toolsForProvider("gemini", all, allowed).length, 3);
    assert.equal(selectProvider("anthropic", true, allowed).id, "ollama");
    assert.deepEqual(names("anthropic", allowed), ["add_grocery_item"]);
  });

  test("both on: both may receive financial data", () => {
    const allowed = { anthropic: true, gemini: true };
    assert.equal(mayReceiveFinancial("anthropic", allowed), true);
    assert.equal(mayReceiveFinancial("gemini", allowed), true);
  });

  test("a non-boolean stored value never counts as consent", () => {
    assert.equal(mayReceiveFinancial("gemini", { gemini: "yes" as any }), false);
    assert.equal(mayReceiveFinancial("anthropic", { anthropic: 1 as any }), false);
  });

  test("an unknown or absent pick still falls back to Ollama", () => {
    const allowed = { anthropic: true, gemini: true };
    assert.equal(selectProvider(undefined, true, allowed).id, "ollama");
    assert.equal(selectProvider("constructor", true, allowed).id, "ollama");
  });

  test("Ollama may always receive financial data", () => {
    assert.equal(mayReceiveFinancial("ollama"), true);
    assert.equal(mayReceiveFinancial("ollama", { anthropic: false, gemini: false }), true);
  });
});
