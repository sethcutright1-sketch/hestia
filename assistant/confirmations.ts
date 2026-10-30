// Confirmation for the assistant's BULK deletes (delete_all_calendar_events, delete_all_chores, clear_shopping_list).
//
// Why this exists: a benchmark found models wiping the whole calendar when told "the calendar is a mess", and wiping every
// chore when asked to clear a shopping list. Telling the model to "ask first" in the prompt is a request, not a guarantee, so
// the guarantee lives here, in the server:
//
//   1. The first call (no confirmation) deletes NOTHING. It works out exactly what would go, files a pending confirmation
//      and hands the model a one-time token plus a plain-English summary.
//   2. The model tells the person what will be deleted and asks. The token it holds is useless in that same reply.
//   3. Only a LATER chat request (the person answered) can redeem it: the token must belong to the same person, the same
//      tool and the same arguments, still be unexpired, and have been issued by a different turn (`turnId`) than the one
//      now running. Then the delete happens and the token is spent.
//
// A model cannot confirm on its own behalf: within one /api/assistant/chat request every tool call shares one turnId, so a
// token it was just given is refused until the person sends another message.
//
// What this does NOT prove is that the person's next message was a "yes". The server cannot read intent; it can only
// guarantee a human turn happened between the question and the delete. The tool description and the owning module's prompt
// rule tell the model to act only on an explicit yes.
//
// Pending confirmations live in memory on purpose. A restart (or the 10-minute expiry) just means the person is asked again,
// which is the safe direction to fail; nothing here is worth a table.
//
// Adding this to a new bulk-delete tool: see "Bulk deletes need confirmation" in ./tools/README.md.

import { randomBytes } from "crypto";
import type { ToolContext } from "./registry.ts";

/** How long a person has to answer before the token dies and they are asked again. */
export const CONFIRMATION_TTL_MS = 10 * 60 * 1000;

export interface PendingConfirmation {
  token: string;
  userId: string;
  tool: string;
  /** What exactly was shown to the person: the normalised arguments plus the ids of everything that would be deleted. */
  argsFingerprint: string;
  summary: string;
  /** The chat request that issued it. A redemption from the same turnId is refused. */
  createdTurnId: string;
  expiresAt: number;
}

const pending = new Map<string, PendingConfirmation>();

/** Drops every expired entry. Called on each request/redeem so the map cannot grow without bound. */
function sweep(nowMs: number) {
  for (const [token, p] of pending) if (p.expiresAt <= nowMs) pending.delete(token);
}

/**
 * A stable string for "these arguments, over this exact set of things". Argument values are trimmed and lower-cased (the
 * tools match names case-insensitively anyway) and empty/missing ones are dropped, so `{ mealSlot: "" }` and `{}` agree;
 * `scopeIds` are the ids the delete would remove right now, so if the data changed between the question and the answer
 * (a new event, a chore added) the confirmation no longer matches and the person is shown the new picture.
 * The `confirmation` argument itself is never part of it.
 */
export function fingerprintArgs(args: Record<string, unknown>, scopeIds: string[] = []): string {
  const clean: Record<string, string> = {};
  for (const key of Object.keys(args).sort()) {
    if (key === "confirmation") continue;
    const value = args[key];
    if (value === undefined || value === null) continue;
    const text = String(value).trim().toLowerCase();
    if (text) clean[key] = text;
  }
  return JSON.stringify({ args: clean, scope: [...scopeIds].sort() });
}

export interface RequestInput {
  userId: string;
  tool: string;
  argsFingerprint: string;
  summary: string;
  turnId: string;
  /** Test seam: the clock, in ms. Default: the real one. */
  nowMs?: number;
}

/** Files a pending confirmation and returns it. An older pending one for the same person/tool/arguments is replaced. */
export function requestConfirmation(input: RequestInput): PendingConfirmation {
  const nowMs = input.nowMs ?? Date.now();
  sweep(nowMs);
  for (const [token, p] of pending) {
    if (p.userId === input.userId && p.tool === input.tool && p.argsFingerprint === input.argsFingerprint) pending.delete(token);
  }
  const entry: PendingConfirmation = {
    token: randomBytes(12).toString("hex"),
    userId: input.userId,
    tool: input.tool,
    argsFingerprint: input.argsFingerprint,
    summary: input.summary,
    createdTurnId: input.turnId,
    expiresAt: nowMs + CONFIRMATION_TTL_MS,
  };
  pending.set(entry.token, entry);
  return entry;
}

export type RedeemResult = { ok: true } | { ok: false; reason: string };

export interface RedeemInput {
  token: unknown;
  userId: string;
  tool: string;
  argsFingerprint: string;
  turnId: string;
  nowMs?: number;
}

/**
 * Spends a token if, and only if, every condition holds. Single-use: a successful redemption removes it. A failed one leaves
 * it alone (the caller issues a fresh request for the same arguments, which replaces it), so a wrong guess by the model
 * cannot burn a token the person is about to confirm.
 */
export function redeemConfirmation(input: RedeemInput): RedeemResult {
  const nowMs = input.nowMs ?? Date.now();
  sweep(nowMs);
  if (typeof input.token !== "string" || !input.token) return { ok: false, reason: "no confirmation was given" };
  const p = pending.get(input.token);
  // Unknown, spent and expired all look the same from here (sweep removed the expired), so say so without naming which.
  if (!p) return { ok: false, reason: "that confirmation is unknown, already used or expired" };
  if (p.userId !== input.userId) return { ok: false, reason: "that confirmation belongs to someone else" };
  if (p.tool !== input.tool) return { ok: false, reason: "that confirmation was issued for a different action" };
  if (p.argsFingerprint !== input.argsFingerprint) return { ok: false, reason: "what would be deleted is not what the person was asked about" };
  if (p.createdTurnId === input.turnId) return { ok: false, reason: "the person has not answered yet (the confirmation was issued in this same reply)" };
  pending.delete(p.token);
  return { ok: true };
}

/** Test seam: forget every pending confirmation. */
export function clearConfirmations(): void {
  pending.clear();
}

/** Test seam: a copy of what is pending right now. */
export function pendingConfirmations(): PendingConfirmation[] {
  return [...pending.values()].map((p) => ({ ...p }));
}

export interface BulkDeleteGate {
  /** The person the tools were built for. */
  userId: string;
  /** The tool's own name, e.g. "clear_shopping_list". */
  tool: string;
  /** The arguments that define WHAT is being deleted (list, date range, ...), normalised by the tool. Not the confirmation. */
  args: Record<string, unknown>;
  /** The `confirmation` the model passed, if any. */
  confirmation?: unknown;
  /** Ids of everything the delete would remove right now (ties the confirmation to exactly that set). */
  scopeIds: string[];
  /** Concrete, computed-now description: "This will delete 6 calendar events from 2026-10-19 to 2026-11-02." */
  summary: string;
  ctx: ToolContext;
}

/**
 * The whole pattern in one call. A bulk-delete tool computes what it would delete, then:
 *
 *   const gate = gateBulkDelete({ userId, tool: "my_tool", args, confirmation, scopeIds, summary, ctx });
 *   if (gate) return gate;      // nothing deleted: either a confirmation request or a refusal
 *   ...delete...                // only reached with a valid, spent confirmation
 *
 * Returns null when the delete may go ahead. Otherwise returns the object to hand straight back to the model:
 * `needsConfirmation: true` with a token, the summary and an instruction; when the model did pass a confirmation that did
 * not qualify, the same plus an `error` that says why, so it tells the person instead of retrying blindly.
 */
export function gateBulkDelete(gate: BulkDeleteGate): Record<string, unknown> | null {
  const { userId, tool, args, scopeIds, summary, ctx } = gate;
  // registry.buildTools always sets turnId; this fallback only matters to a caller that built a ToolContext by hand.
  const turnId = ctx.turnId ?? "unknown-turn";
  const nowMs = ctx.now ? ctx.now().getTime() : Date.now();
  const argsFingerprint = fingerprintArgs(args, scopeIds);

  const given = typeof gate.confirmation === "string" && gate.confirmation.trim() ? gate.confirmation.trim() : undefined;
  let refusal: string | undefined;
  if (given) {
    const redeemed = redeemConfirmation({ token: given, userId, tool, argsFingerprint, turnId, nowMs });
    if (redeemed.ok) return null;
    refusal = redeemed.reason;
  }

  const entry = requestConfirmation({ userId, tool, argsFingerprint, summary, turnId, nowMs });
  return {
    ...(refusal ? { error: `Confirmation required: ${refusal}. Nothing was deleted.` } : {}),
    needsConfirmation: true,
    summary,
    confirmation: entry.token,
    instruction:
      "Nothing has been deleted. Tell the person exactly what will be deleted and ask them to confirm. Only after they say yes " +
      "in their NEXT message, call this tool again with the same arguments and this confirmation.",
  };
}
