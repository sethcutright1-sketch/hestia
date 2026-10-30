// Rewards catalog + redemptions (Stage 10.4, PLAN.md) -- what chore points
// (routes/chores.ts) can be spent on. Points only, no money: this file (and
// every assistant tool touching it) must stay outside the financial privacy
// boundary -- see routes/chores.ts's FAMILY_POINTS_BUCKET comment for why
// pointsByMember's "family" bucket is excluded from balances below.

import express from "express";
import { getScopedItems, getScopedItem, putScopedItem, deleteScopedItem, newId } from "../db.ts";
import { currentUserId, requireUnlocked } from "../auth.ts";
import { listMembers, isParentMember } from "./members.ts";
import { pointsByMember } from "./chores.ts";

export interface Reward {
  id: string;
  title: string;
  cost: number; // integer, 1-1000
  scope: "joint";
  createdAt: string;
  updatedAt: string;
}

// A snapshot, not a live join to Reward -- rewardTitle/cost are copied at
// redemption time so editing or deleting the reward afterward never rewrites
// what a member actually redeemed (task requirement, and matches how a real
// receipt works).
export interface Redemption {
  id: string;
  rewardId: string;
  rewardTitle: string;
  memberId: string;
  cost: number;
  redeemedAt: string;
  byUserId: string;
}

export interface MemberBalance {
  earned: number;
  // Phase 3 (PLAN.md): the net of every PointAdjustment for this member, split
  // out from `balance` so the Parent "Rewards" balance table can show it as
  // its own column instead of a caller re-deriving it from adjustment rows.
  adjusted: number;
  spent: number;
  balance: number;
}

// Stage 6.5/10.4 (PLAN.md): a manual +/- a parent applies outside of chores
// ("+5 for helping with the garage sale"), folded into balancesByMember
// alongside approved chore earnings and redemptions. Kid-only, same as
// redeeming -- see the 400 checks on the POST route below.
export interface PointAdjustment {
  id: string;
  memberId: string;
  amount: number; // non-zero integer, -100 to 100
  note: string; // trimmed, may be empty, capped at 200 chars
  scope: "joint";
  createdAt: string;
  byUserId: string;
}

export const rewardRoutes = express.Router();

function validateRewardFields(fields: { title: unknown; cost: unknown }): string | null {
  if (!fields.title || typeof fields.title !== "string" || !fields.title.trim()) {
    return "title is required";
  }
  if (typeof fields.cost !== "number" || !Number.isInteger(fields.cost) || fields.cost < 1 || fields.cost > 1000) {
    return "cost must be a whole number from 1 to 1000";
  }
  return null;
}

function validateAdjustmentFields(fields: { amount: unknown; note: unknown }): string | null {
  if (
    typeof fields.amount !== "number" ||
    !Number.isInteger(fields.amount) ||
    fields.amount === 0 ||
    fields.amount < -100 ||
    fields.amount > 100
  ) {
    return "amount must be a non-zero whole number from -100 to 100";
  }
  if (fields.note != null && typeof fields.note !== "string") {
    return "note must be a string";
  }
  return null;
}

// Field by field, never spread -- same convention as buildReward/buildChore.
function buildAdjustment(fields: { id?: string; memberId: string; amount: number; note?: unknown; createdAt?: string; byUserId: string }): PointAdjustment {
  const now = new Date().toISOString();
  const note = typeof fields.note === "string" ? fields.note.trim().slice(0, 200) : "";
  return {
    id: fields.id || newId("adjustment"),
    memberId: fields.memberId,
    amount: fields.amount,
    note,
    scope: "joint",
    createdAt: fields.createdAt || now,
    byUserId: fields.byUserId,
  };
}

// Field by field, never spread -- same convention as routes/chores.ts and
// routes/members.ts.
function buildReward(fields: { id?: string; title: string; cost: number; createdAt?: string }): Reward {
  const now = new Date().toISOString();
  return {
    id: fields.id || newId("reward"),
    title: fields.title.trim(),
    cost: fields.cost,
    scope: "joint",
    createdAt: fields.createdAt || now,
    updatedAt: now,
  };
}

export function listRewards(userId: string): Reward[] {
  return (getScopedItems("rewards", userId) as Reward[]).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function listRedemptions(userId: string, memberId?: string): Redemption[] {
  const all = (getScopedItems("redemptions", userId) as Redemption[]).sort((a, b) =>
    b.redeemedAt.localeCompare(a.redeemedAt)
  );
  return memberId ? all.filter((r) => r.memberId === memberId) : all;
}

export function listPointAdjustments(userId: string, memberId?: string): PointAdjustment[] {
  const all = (getScopedItems("point_adjustments", userId) as PointAdjustment[]).sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt)
  );
  return memberId ? all.filter((a) => a.memberId === memberId) : all;
}

/** All-time approved earnings (routes/chores.ts's pointsByMember with no
 * range -- a "waiting" completion doesn't count until a parent approves it,
 * Stage 6.5) plus adjustments minus everything spent, for every KID
 * household member. Parent-role members are skipped entirely, the same way
 * pointsByMember skips them: parents track their own chores without stars,
 * so they have no balance to redeem or adjust. The "family" bucket
 * pointsByMember can also return is likewise left out here, since it has no
 * member to redeem against (see FAMILY_POINTS_BUCKET's comment). */
export function balancesByMember(userId: string): Record<string, MemberBalance> {
  const earned = pointsByMember(userId);
  const redemptions = listRedemptions(userId);
  const adjustments = listPointAdjustments(userId);
  const result: Record<string, MemberBalance> = {};
  for (const member of listMembers(userId)) {
    if (isParentMember(member)) continue;
    const memberEarned = earned[member.id]?.earned ?? 0;
    const spent = redemptions.filter((r) => r.memberId === member.id).reduce((sum, r) => sum + r.cost, 0);
    const adjusted = adjustments.filter((a) => a.memberId === member.id).reduce((sum, a) => sum + a.amount, 0);
    result[member.id] = { earned: memberEarned, adjusted, spent, balance: memberEarned + adjusted - spent };
  }
  return result;
}

function balanceFor(userId: string, memberId: string): number {
  return balancesByMember(userId)[memberId]?.balance ?? 0;
}

rewardRoutes.get("/", (req, res) => {
  res.json({ rewards: listRewards(currentUserId(req)) });
});

// Building the reward catalog is a parent action, same PIN as the rest of
// the Chores tab's "Manage" area (the owner's decision -- one shared household
// lock, not a second PIN just for rewards).
rewardRoutes.post("/", requireUnlocked, (req, res) => {
  const { title, cost } = req.body || {};
  const validationError = validateRewardFields({ title, cost });
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  const userId = currentUserId(req);
  const reward = buildReward({ title, cost });
  putScopedItem("rewards", userId, reward);
  res.json({ reward });
});

// Registered ahead of the "/:id" routes below, same reason as
// routes/chores.ts's GET "/points" -- a literal path segment must never be
// mistaken for an id.
rewardRoutes.get("/balances", (req, res) => {
  res.json({ balances: balancesByMember(currentUserId(req)) });
});

rewardRoutes.get("/redemptions", (req, res) => {
  const { memberId } = req.query;
  res.json({ redemptions: listRedemptions(currentUserId(req), typeof memberId === "string" ? memberId : undefined) });
});

// Also ahead of "/:id" -- "adjustments" is a literal path segment, same
// reasoning as "/balances" and "/redemptions" above.
rewardRoutes.get("/adjustments", (req, res) => {
  const { memberId } = req.query;
  res.json({
    adjustments: listPointAdjustments(currentUserId(req), typeof memberId === "string" ? memberId : undefined),
  });
});

// A manual +/- is a parent action too.
rewardRoutes.post("/adjustments", requireUnlocked, (req, res) => {
  const userId = currentUserId(req);
  const { memberId, amount, note } = req.body || {};
  const member = typeof memberId === "string" ? listMembers(userId).find((m) => m.id === memberId) : undefined;
  if (!member) return res.status(404).json({ error: "Household member not found" });
  if (isParentMember(member)) {
    return res.status(400).json({ error: "Parent members don't earn or spend chore points." });
  }

  const validationError = validateAdjustmentFields({ amount, note });
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  const adjustment = buildAdjustment({ memberId: member.id, amount, note, byUserId: userId });
  putScopedItem("point_adjustments", userId, adjustment);
  res.json({ adjustment, balance: balanceFor(userId, member.id) });
});

rewardRoutes.post("/:id/redeem", (req, res) => {
  const userId = currentUserId(req);
  const reward = getScopedItem("rewards", userId, req.params.id) as Reward | undefined;
  if (!reward) return res.status(404).json({ error: "Reward not found" });

  const { memberId } = req.body || {};
  const member = typeof memberId === "string" ? listMembers(userId).find((m) => m.id === memberId) : undefined;
  if (!member) return res.status(404).json({ error: "Household member not found" });
  if (isParentMember(member)) {
    return res.status(400).json({ error: "Parent members don't earn or spend chore points." });
  }

  const balance = balanceFor(userId, member.id);
  if (balance < reward.cost) {
    return res.status(400).json({
      error: `${member.name} has ${balance} point${balance === 1 ? "" : "s"} -- "${reward.title}" costs ${reward.cost}.`,
    });
  }

  const redemption: Redemption = {
    id: newId("redemption"),
    rewardId: reward.id,
    rewardTitle: reward.title,
    memberId: member.id,
    cost: reward.cost,
    redeemedAt: new Date().toISOString(),
    byUserId: userId,
  };
  putScopedItem("redemptions", userId, redemption);
  res.json({ redemption, balance: balanceFor(userId, member.id) });
});

// Removing a reward is a parent action -- redeeming one (above) is not.
rewardRoutes.delete("/:id", requireUnlocked, (req, res) => {
  const deleted = deleteScopedItem("rewards", currentUserId(req), req.params.id);
  if (!deleted) return res.status(404).json({ error: "Reward not found" });
  res.json({ success: true });
});
