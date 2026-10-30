import express from "express";
import { getScopedItems, getScopedItem, putScopedItem, deleteScopedItem, newId, getUserById, listUsers } from "../db.ts";
import { currentUserId } from "../auth.ts";
import { resyncAfterRosterChange } from "./mealplanDiary.ts";

// A person who eats here. Deliberately not a `users` row: logins are capped at
// two (MAX_HOUSEHOLD_USERS in auth.ts) but a family isn't, and someone with no
// account still has opinions about mushrooms.
export interface HouseholdMember {
  id: string;
  name: string;
  likes: string[];
  dislikes: string[];
  color?: string;
  theme?: string;
  // Stage 6.5 (PLAN.md): drives Chores' Kid/Parent split -- a chore assigned
  // to a parent needs no approval and earns no points (see routes/chores.ts's
  // isParentAssignee/pointsByMember). Unset counts as "kid" (see
  // isParentMember below) so nobody disappears from the kid view or the
  // rewards chart just because roles haven't been set yet. The UI hiding
  // Parent on the kiosk is not a security boundary -- there's no PIN, so any
  // signed-in member can still call these routes for any memberId.
  role?: "parent" | "kid";
  // The login this person is, when they have one (an admin or parent login, never the kiosk): what lets an
  // "individual" meal plan reach THEIR food diary. At most one member per login. Set only by an admin.
  // Kids and anyone without a login have none. See validateLogin below.
  userId?: string;
  scope: "joint";
  createdAt: string;
  updatedAt: string;
}

export const memberRoutes = express.Router();

// Keys must match src/sections/calendar/palette.ts's MEMBER_PALETTE -- a
// backend route doesn't import a frontend/Tailwind file just for a string
// list, so this is kept in sync by hand, the same way this file's own
// HouseholdMember interface duplicates src/api.ts's rather than sharing one.
const MEMBER_COLORS = new Set(["rose", "blue", "amber", "emerald", "violet", "sky", "orange", "teal"]);

// Keys must match palette.ts's MEMBER_THEMES, same hand-sync rule as colors.
const MEMBER_THEMES = new Set(["soft", "bold", "gradient"]);

// Stage 6.5: the only two roles Chores knows about. Validated the same way as
// MEMBER_COLORS/MEMBER_THEMES above, and merged on PUT the same way too.
const MEMBER_ROLES = new Set(["parent", "kid"]);

/** Unset role counts as "kid" -- see HouseholdMember.role's comment. Every
 * caller that cares about parent/kid (routes/chores.ts, routes/rewards.ts)
 * goes through this rather than reading `.role` directly, so that default
 * stays in exactly one place. */
export function memberRole(member: Pick<HouseholdMember, "role">): "parent" | "kid" {
  return member.role === "parent" ? "parent" : "kid";
}

export function isParentMember(member: Pick<HouseholdMember, "role">): boolean {
  return memberRole(member) === "parent";
}

function cleanList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of value) {
    const name = String(entry || "").trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

// Field by field, never spread: `scope` drives row ownership in putScopedItem.
function buildMember(
  fields: {
    id?: string; name: string; likes?: unknown; dislikes?: unknown; color?: unknown; theme?: unknown;
    role?: unknown; userId?: string; createdAt?: string;
  }
): HouseholdMember {
  const now = new Date().toISOString();
  const color = typeof fields.color === "string" && MEMBER_COLORS.has(fields.color) ? fields.color : undefined;
  const theme = typeof fields.theme === "string" && MEMBER_THEMES.has(fields.theme) ? fields.theme : undefined;
  const role =
    typeof fields.role === "string" && MEMBER_ROLES.has(fields.role) ? (fields.role as HouseholdMember["role"]) : undefined;
  return {
    id: fields.id || newId("member"),
    name: fields.name.trim(),
    likes: cleanList(fields.likes),
    dislikes: cleanList(fields.dislikes),
    color,
    theme,
    role,
    userId: fields.userId || undefined,
    scope: "joint",
    createdAt: fields.createdAt || now,
    updatedAt: now,
  };
}

// Rows written before `likes` existed have no such key at all -- normalize so
// every downstream consumer can assume `likes: string[]` is always present.
export function listMembers(userId: string): HouseholdMember[] {
  return (getScopedItems("household_members", userId) as HouseholdMember[])
    .map((m) => ({ ...m, likes: Array.isArray(m.likes) ? m.likes : [] }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function loadMember(req: express.Request, res: express.Response): HouseholdMember | null {
  const member = getScopedItem("household_members", currentUserId(req), req.params.id) as
    | HouseholdMember
    | undefined;
  if (!member) {
    res.status(404).json({ error: "Household member not found" });
    return null;
  }
  return member;
}

// The logins a member can be linked to: the ones that keep a food diary. (Names only; same list for everyone.)
function linkableLogins() {
  return listUsers()
    .filter((u) => u.role === "admin" || u.role === "parent")
    .map((u) => ({ id: u.id, name: u.display_name, role: u.role }));
}

memberRoutes.get("/", (req, res) => {
  res.json({ members: listMembers(currentUserId(req)), logins: linkableLogins() });
});

/**
 * Validates a request's `userId` (the login link). Returns the value to store (a user id, or undefined to clear),
 * or sends the error and returns "refused". Only an admin may set, change or clear it; the same value sent again
 * is not a change. The login must exist and be an admin or parent (a kiosk never has a diary), and one login can
 * be linked to only one member.
 */
function validateLogin(
  req: express.Request, res: express.Response, requested: unknown, existing: HouseholdMember | undefined,
): string | undefined | "refused" {
  const next = requested === null || requested === "" ? undefined : requested;
  if (next !== undefined && typeof next !== "string") {
    res.status(400).json({ error: "userId must be a login id, or null to unlink." });
    return "refused";
  }
  if ((next ?? undefined) === (existing?.userId ?? undefined)) return next;
  if (getUserById(currentUserId(req))?.role !== "admin") {
    res.status(403).json({ error: "Only an admin can link a family member to a login." });
    return "refused";
  }
  if (next === undefined) return undefined;
  const login = getUserById(next);
  if (!login) {
    res.status(400).json({ error: "That login doesn't exist." });
    return "refused";
  }
  if (login.role !== "admin" && login.role !== "parent") {
    res.status(400).json({ error: "Only an admin or parent login keeps a food diary, so only those can be linked." });
    return "refused";
  }
  const taken = listMembers(currentUserId(req)).find((m) => m.userId === next && m.id !== existing?.id);
  if (taken) {
    res.status(409).json({ error: `${login.display_name} is already linked to ${taken.name}. A login can belong to one family member.` });
    return "refused";
  }
  return next;
}

memberRoutes.post("/", (req, res) => {
  const { name, likes, dislikes, color, theme, role } = req.body || {};
  if (!name || typeof name !== "string" || !name.trim()) {
    return res.status(400).json({ error: "name is required" });
  }

  const userId = currentUserId(req);
  const login = req.body?.userId === undefined ? undefined : validateLogin(req, res, req.body.userId, undefined);
  if (login === "refused") return;
  const before = listMembers(userId);
  const member = buildMember({ name, likes, dislikes, color, theme, role, userId: login });
  putScopedItem("household_members", userId, member);
  resyncAfterRosterChange(userId, before, listMembers(userId));
  res.json({ member });
});

memberRoutes.put("/:id", (req, res) => {
  const existing = loadMember(req, res);
  if (!existing) return;

  const { name, likes, dislikes, color, theme, role } = req.body || {};
  const requestedLogin = req.body?.userId === undefined ? existing.userId : validateLogin(req, res, req.body.userId, existing);
  if (requestedLogin === "refused") return;
  const member = buildMember({
    id: existing.id,
    name: typeof name === "string" && name.trim() ? name : existing.name,
    likes: Array.isArray(likes) ? likes : existing.likes,
    dislikes: Array.isArray(dislikes) ? dislikes : existing.dislikes,
    color: color !== undefined ? color : existing.color,
    theme: theme !== undefined ? theme : existing.theme,
    role: role !== undefined ? role : existing.role,
    userId: requestedLogin,
    createdAt: existing.createdAt,
  });

  const before = listMembers(currentUserId(req));
  putScopedItem("household_members", currentUserId(req), member);
  // A changed link moves approved individual meals into (or out of) that login's diary.
  if (member.userId !== existing.userId) resyncAfterRosterChange(currentUserId(req), before, listMembers(currentUserId(req)));
  res.json({ member });
});

memberRoutes.delete("/:id", (req, res) => {
  const before = listMembers(currentUserId(req));
  // Deleting a member who is linked to a login also unlinks it and takes their still-planned meals out of that
  // login's diary, so it follows the linking rule above: admin only (security audit 2026-10-16, L5). A member
  // with no login stays deletable by anyone who can see them, as before.
  const target = before.find((m) => m.id === req.params.id);
  if (target?.userId && getUserById(currentUserId(req))?.role !== "admin") {
    return res.status(403).json({ error: "Only an admin can remove a family member who is linked to a login." });
  }
  const deleted = deleteScopedItem("household_members", currentUserId(req), req.params.id);
  if (!deleted) return res.status(404).json({ error: "Household member not found" });
  // Their individual meals have nobody to eat them now: what is still only planned leaves the linked login's diary.
  resyncAfterRosterChange(currentUserId(req), before, listMembers(currentUserId(req)));
  res.json({ success: true });
});
