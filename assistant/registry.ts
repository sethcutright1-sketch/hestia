// The assistant's tool registry.
//
// Domain modules under ./tools/ each export a ToolModule; this file is the only
// place that knows the full set. Adding a tool means editing one domain file and
// nothing else -- see ./tools/README.md for the contract.
//
// Tools are still built per-request with the signed-in user bound in, because
// every read goes through the same personal/joint scoping the UI uses. The
// assistant can never see more than the person talking to it can.

import { randomUUID } from "crypto";
import type { ToolDefinition } from "../ollama.ts";
import { groceryModule } from "./tools/grocery.ts";
import { pantryModule } from "./tools/pantry.ts";
import { mealPlanModule } from "./tools/mealplan.ts";
import { membersModule } from "./tools/members.ts";
import { calendarModule } from "./tools/calendar.ts";
import { choresModule } from "./tools/chores.ts";
import { budgetModule } from "./tools/budget.ts";
import { fridgeModule } from "./tools/fridge.ts";
import { foodCatalogueModule } from "./tools/foodCatalogue.ts";
import { calorieModule } from "./tools/calories.ts";

/**
 * What a domain module writes. `domain` and `sensitivity` are stamped on by the
 * registry from the module they came from, so a tool literal can't disagree with
 * its own module about either one.
 */
export type DomainTool = Omit<ToolDefinition, "domain" | "sensitivity">;

/**
 * Facts about the request a tool set is being built for that the user id alone doesn't carry. All optional:
 * a caller that omits them (most of the test suite) gets an ordinary signed-in browser session, with the
 * role read from the database. Only the calorie module reads these.
 */
export interface ToolContext {
  /** The login's role (admin / parent / kiosk). Looked up from `users` when omitted. */
  role?: string;
  /** The request carried a Wear OS device token: it can never enter a PIN and never views another person's data. */
  device?: boolean;
  /**
   * The signed-in person turned on "Require the PIN for my food diary" and this session hasn't unlocked (or is a
   * device token): the same state in which /api/nutrition/* answers 423 for them. The health tools are not even
   * offered then, and refuse if called.
   */
  foodDiaryLocked?: boolean;
  /** Test seam: the clock (decides "today" for each person). Default: the real one. */
  now?: () => Date;
  /**
   * Which chat request these tools were built for: one value per POST /api/assistant/chat (server.ts makes it, planTurn
   * carries it here). The bulk-delete tools use it to tell "the model asking again in the same reply" from "the person
   * answered in a later message" -- see ./confirmations.ts. buildTools fills it with a fresh random id when the caller
   * leaves it out, so scripts and tests that build tools directly are a turn of their own: two buildTools calls are two
   * turns, and a confirmation requested through one set can be redeemed through the next.
   */
  turnId?: string;
}

export interface ToolModule {
  /** Presentation and grouping only. Never read by a security or privacy decision. */
  domain: string;
  /** The single field every privacy and safety decision reads. */
  sensitivity: ToolDefinition["sensitivity"];
  /** How the system prompt names this domain to the model ("the pantry"). */
  label: string;
  /**
   * Extra system-prompt rule lines this module owns -- its own bullet points
   * (no leading "-"), concatenated in TOOL_MODULES order after the generic
   * rules in server.ts's systemPrompt(). Omit when a module needs no special
   * handling beyond the tools themselves.
   */
  promptRules?: string[];
  /**
   * `unlocked` mirrors auth.ts's isUnlocked for the request this tool set is
   * being built for -- the same household PIN lock that gates Budget and the
   * Chores tab's Manage area server-side (requireUnlocked). Only the chores
   * module reads it today (create/delete_chore refuse with a clear error
   * while locked, the same way the actual routes do; completing a chore
   * doesn't -- ticking one off is open to everyone); every other module
   * ignores the extra argument. Defaults to true (unlocked) so a caller that
   * doesn't know or care about lock state -- most of the test suite -- gets
   * the tools' normal behavior.
   *
   * `ctx` carries the rest of the request (role, device token, food-diary lock, turn id);
   * see ToolContext. The calorie module reads most of it; the modules with a bulk delete (calendar, chores, grocery) read
   * `turnId` and `now` for the confirmation step (../confirmations.ts).
   */
  build: (userId: string, unlocked?: boolean, ctx?: ToolContext) => DomainTool[];
}

// Order matters only in that it's the order tools are presented to the model;
// it's the same order the old single-file buildTools() used.
export const TOOL_MODULES: ToolModule[] = [
  groceryModule,
  pantryModule,
  mealPlanModule,
  membersModule,
  calendarModule,
  choresModule,
  budgetModule,
  fridgeModule,
  foodCatalogueModule,
  calorieModule,
];

export function buildTools(userId: string, unlocked = true, givenCtx: ToolContext = {}): ToolDefinition[] {
  // Every tool set has a turn id (see ToolContext.turnId), so a bulk delete can never mistake "no id" for "same turn" or
  // for "any turn".
  const ctx: ToolContext = { ...givenCtx, turnId: givenCtx.turnId ?? randomUUID() };
  return TOOL_MODULES.flatMap((module) =>
    module.build(userId, unlocked, ctx).map((tool) => ({
      ...tool,
      mutates: tool.mutates === true,
      domain: module.domain,
      sensitivity: module.sensitivity,
    }))
  );
}

export function findTool(userId: string, name: string): ToolDefinition | undefined {
  return buildTools(userId).find((tool) => tool.name === name);
}

/**
 * What the system prompt must not mention: modules whose sensitivity is hidden are left out of both the
 * section list and the rule lines, so the model never advertises a capability it was not given. Financial is
 * hidden while the PIN lock is engaged; health is hidden from a cloud provider with no health consent and
 * while the person's food-diary lock is engaged.
 */
export interface PromptHiding {
  hideFinancial?: boolean;
  hideHealth?: boolean;
}

const shown = (module: ToolModule, hide: PromptHiding): boolean =>
  !((hide.hideFinancial && module.sensitivity === "financial") || (hide.hideHealth && module.sensitivity === "health"));

/** The domain labels the system prompt lists, generated rather than hand-maintained.
 * `hideFinancial` drops budget's label while the PIN lock (auth.ts) is engaged, so
 * the model doesn't confidently advertise a capability it's about to be refused. */
export function toolDomainLabels(hideFinancial: boolean | PromptHiding = false): string[] {
  const hide = typeof hideFinancial === "boolean" ? { hideFinancial } : hideFinancial;
  return TOOL_MODULES.filter((module) => shown(module, hide)).map((module) => module.label);
}

/** Domain-owned rule lines, generated the same way as toolDomainLabels. */
export function toolPromptRules(hideFinancial: boolean | PromptHiding = false): string[] {
  const hide = typeof hideFinancial === "boolean" ? { hideFinancial } : hideFinancial;
  return TOOL_MODULES.filter((module) => shown(module, hide)).flatMap((module) => module.promptRules || []);
}

/**
 * The shape `GET /api/assistant/tools` serves. Deliberately excludes `run` and the
 * parameter schema -- the client needs to know what each tool is and whether it
 * writes, not how to call it.
 */
export interface ToolManifestEntry {
  name: string;
  description: string;
  mutates: boolean;
  domain: string;
  sensitivity: ToolDefinition["sensitivity"];
}

export function toolManifest(userId: string, hideFinancial = false, ctx: ToolContext = {}): ToolManifestEntry[] {
  // The same two lock filters the chat endpoint applies (server.ts / assistant/turn.ts): money while the PIN lock
  // is engaged, health while the person's food-diary lock is.
  return buildTools(userId, !hideFinancial, ctx)
    .filter((tool) => !hideFinancial || tool.sensitivity !== "financial")
    .filter((tool) => !ctx.foodDiaryLocked || tool.sensitivity !== "health")
    .map(({ name, description, mutates, domain, sensitivity }) => ({
      name,
      description,
      mutates: mutates === true,
      domain,
      sensitivity,
    }));
}
