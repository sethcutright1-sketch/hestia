import express from "express";
import { getScopedItems, getScopedItem, putScopedItem, deleteScopedItem, newId } from "../db.ts";
import { currentUserId, requireUnlocked } from "../auth.ts";
import { type RecurrenceRule, isValidRecurrence, expandOccurrences, seriesIdOf, todayISO } from "./recurrence.ts";
// members.ts never imports this file, so this direction is safe -- see
// isParentAssignee's comment below for why chores.ts needs it.
import { listMembers, isParentMember } from "./members.ts";

// Never send the raw completions map to the client -- an occurrence's status
// is derived from it (see withOccurrenceStatus) and the client's Chore type
// (src/api.ts) doesn't carry it.
function stripCompletions<T extends { completions?: unknown }>(chore: T): Omit<T, "completions"> {
  const { completions, ...rest } = chore;
  return rest;
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/; // 24h "HH:MM", 00:00-23:59

// Chores, rendered alongside calendar events rather than as their own separate
// list (Stage 10.3, PLAN.md) -- same shape and conventions as routes/calendar.ts.
export interface Chore {
  id: string;
  title: string;
  memberId?: string; // absent = a family/unassigned chore
  // A chore assigned to 2+ members ("chores assigned to more than one kid")
  // is stored as N ordinary single-assignee rows -- one per member -- that
  // all share this groupId. Each row is otherwise a completely normal chore:
  // its own completions/status/approval/points, so every existing read path
  // (occurrences, completion, approval, pointsByMember, the assistant tools)
  // needs no changes at all. A chore with no groupId is a group of one, keyed
  // by its own id -- see routes/chores.ts's group routes below. Never set for
  // a family/unassigned chore (those stay a single row with no memberId).
  groupId?: string;
  date: string; // YYYY-MM-DD -- the anchor due date; the first occurrence for a recurring series
  time?: string;
  recurrence?: RecurrenceRule;
  status: "pending" | "done";
  completedAt?: string;
  // Stage 6.5 (PLAN.md): set once a parent approves a DONE one-off chore.
  // Meaningless (and never set) while status isn't "done", and cleared
  // whenever the chore is reopened or rejected -- see
  // setChoreOccurrenceStatus/setChoreOccurrenceApproval.
  approvedAt?: string;
  approvedByUserId?: string;
  // Bug fix: stars must survive later edits to a chore's `points` value, so
  // the points a one-off chore was actually worth AT APPROVAL TIME are
  // snapshotted here the moment it's approved (setChoreOccurrenceApproval),
  // the same way `completions[date].points` below snapshots it for a
  // recurring occurrence. Meaningless (and never set) unless approvedAt is
  // also set; cleared alongside it on reopen/reject. pointsByMember prefers
  // this over the chore's current `points` when present, and falls back to
  // `points ?? 1` for anything approved before this field existed.
  approvedPoints?: number;
  // Per-occurrence completion for a RECURRING chore, keyed by occurrence date
  // (Stage 10.3 fix, PLAN.md -- `status`/`completedAt` above used to be the only
  // record of "done", so marking one occurrence done marked the whole series
  // done). For a one-off chore this stays unused and `status`/`completedAt`
  // remain the source of truth -- see withOccurrenceStatus below. approvedAt/
  // approvedByUserId are this map's Stage 6.5 equivalent of the top-level
  // fields above, set once a parent approves that one occurrence. `points` is
  // this map's equivalent of `approvedPoints` above -- the chore's points
  // value snapshotted at the moment THIS occurrence was approved.
  completions?: Record<
    string,
    { completedAt: string; byUserId?: string; approvedAt?: string; approvedByUserId?: string; points?: number }
  >;
  // Stage 10.4 (PLAN.md): how many points this chore is worth toward the
  // sticker chart / rewards catalog (see pointsByMember below). Optional in
  // storage -- absent means "worth the default" (1), same convention as
  // `time`/`recurrence` above -- rather than every chore ever written before
  // this field existed needing a migration.
  points?: number;
  scope: "joint";
  createdAt: string;
  updatedAt: string;
}

// Rewards/points are points-only, deliberately outside the financial privacy
// boundary (PLAN.md Stage 10.4's open design question, resolved: no money).
// Any assistant tool touching this data must stay `sensitivity: "household"`.

/** A chore with no `memberId` earns points for the whole family rather than
 * one person -- credited here under this bucket key instead of a real member
 * id. Never redeemable: routes/rewards.ts only resolves balances for real
 * `listMembers()` ids, so a "family" bucket has no reward balance and can't
 * be spent, on purpose -- there's no single person to charge a redemption to. */
export const FAMILY_POINTS_BUCKET = "family";

export const choreRoutes = express.Router();

// Field by field, never spread: `scope` drives row ownership in putScopedItem,
// same convention as routes/members.ts and routes/calendar.ts.
function buildChore(
  fields: {
    id?: string; title: string; date: string; memberId?: unknown; groupId?: unknown; time?: unknown; recurrence?: unknown;
    status?: unknown; completedAt?: string; approvedAt?: string; approvedByUserId?: string; approvedPoints?: number;
    completions?: Chore["completions"]; createdAt?: string;
    points?: unknown;
  }
): Chore {
  const now = new Date().toISOString();
  const time = typeof fields.time === "string" && TIME_RE.test(fields.time) ? fields.time : undefined;
  const recurrence = isValidRecurrence(fields.recurrence) ? fields.recurrence : undefined;
  const status: Chore["status"] = fields.status === "done" ? "done" : "pending";
  // Already validated (integer 1-10) by the time this runs -- see
  // validateChoreFields -- so anything else here is "not supplied", which
  // stores as undefined (the default-of-1 lives at the read side, e.g.
  // pointsByMember's `points ?? 1`).
  const points = typeof fields.points === "number" ? fields.points : undefined;
  return {
    id: fields.id || newId("chore"),
    title: fields.title.trim(),
    memberId: fields.memberId ? String(fields.memberId) : undefined,
    groupId: fields.groupId ? String(fields.groupId) : undefined,
    date: fields.date,
    time,
    recurrence,
    status,
    // Set once when first marked done, preserved across later edits, cleared
    // the moment it's reopened -- never bumped just for touching another field.
    completedAt: status === "done" ? fields.completedAt || now : undefined,
    // Same lifecycle as completedAt: only meaningful while status is "done",
    // preserved across an edit to another field, cleared on reopen. Only
    // setChoreOccurrenceApproval/setChoreOccurrenceStatus ever set or clear it.
    approvedAt: status === "done" ? fields.approvedAt : undefined,
    approvedByUserId: status === "done" ? fields.approvedByUserId : undefined,
    // Same lifecycle as approvedAt immediately above -- see its comment on
    // the Chore interface.
    approvedPoints: status === "done" ? fields.approvedPoints : undefined,
    // Preserved across edits to other fields, same as completedAt above --
    // only setChoreOccurrenceStatus/setChoreOccurrenceApproval ever change this map.
    completions: fields.completions,
    points,
    scope: "joint",
    createdAt: fields.createdAt || now,
    updatedAt: now,
  };
}

// Shared by POST and PUT so the two routes cannot drift apart -- see
// routes/calendar.ts's validateEventFields for why that matters.
function validateChoreFields(fields: {
  title: unknown; date: unknown; memberId?: unknown; time?: unknown; recurrence?: unknown; status?: unknown;
  points?: unknown;
}): string | null {
  if (!fields.title || typeof fields.title !== "string" || !fields.title.trim()) {
    return "title is required";
  }
  if (!fields.date || typeof fields.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(fields.date)) {
    return "date must be a date like 2026-08-24";
  }
  if (fields.time != null && (typeof fields.time !== "string" || !TIME_RE.test(fields.time))) {
    return "time must be a 24-hour time like 18:30";
  }
  if (fields.status != null && fields.status !== "pending" && fields.status !== "done") {
    return 'status must be "pending" or "done"';
  }
  if (fields.points != null) {
    if (typeof fields.points !== "number" || !Number.isInteger(fields.points) || fields.points < 1 || fields.points > 10) {
      return "points must be a whole number from 1 to 10";
    }
  }
  if (fields.recurrence != null) {
    if (!isValidRecurrence(fields.recurrence)) {
      return "recurrence must be a weekly rule with at least one weekday";
    }
    if (fields.recurrence.until && fields.recurrence.until < fields.date) {
      return "recurrence.until cannot be before date";
    }
  }
  return null;
}

function loadChore(req: express.Request, res: express.Response): Chore | null {
  const chore = getScopedItem("chores", currentUserId(req), seriesIdOf(req.params.id)) as Chore | undefined;
  if (!chore) {
    res.status(404).json({ error: "Chore not found" });
    return null;
  }
  return chore;
}

/** The real stored master row for an id that may be a synthetic occurrence id
 * -- for callers (the assistant tool) that need to read-then-write a chore
 * outside the request/response cycle `loadChore` is built around. */
export function getChore(userId: string, id: string): Chore | undefined {
  return getScopedItem("chores", userId, seriesIdOf(id)) as Chore | undefined;
}

export type ChoreApproval = "none" | "waiting" | "approved";

/** Every chore-reading endpoint needs "is this assignee a parent" for every
 * chore it returns (approval, and Stage 10.4's points), so it's computed once
 * per request/call as a Set of member ids rather than re-walking
 * listMembers() per chore. Unassigned chores are never in this set --
 * isParentAssignee(undefined, ...) is always false -- so they're treated like
 * a kid's chore: they still need approval, and (per FAMILY_POINTS_BUCKET)
 * still earn into the non-redeemable family bucket, same as before Stage 6.5. */
function parentMemberIds(userId: string): Set<string> {
  return new Set(listMembers(userId).filter(isParentMember).map((m) => m.id));
}

function isParentAssignee(memberId: string | undefined, parents: Set<string>): boolean {
  return !!memberId && parents.has(memberId);
}

/** The household PIN lock (auth.ts), applied by hand rather than as router-level
 * middleware -- whether a given request needs it depends on what's IN the request
 * (a status-only tick from a kid needs no PIN; the same route editing a title does),
 * not just which route it hit. Reuses requireUnlocked itself (not a re-implementation
 * of isUnlocked) so the 423 shape, the sliding-window refresh, and the device-token
 * refusal all stay byte-identical to every other PIN-gated route in the app. Returns
 * whether the request may proceed; requireUnlocked has already written the 423
 * response for a locked caller, so the caller here just needs to `return` immediately. */
function passesUnlockCheck(req: express.Request, res: express.Response): boolean {
  let ok = false;
  requireUnlocked(req, res, () => { ok = true; });
  return ok;
}

/** A RECURRING occurrence's status/completedAt come from its own entry in
 * `completions`, not the top-level fields (which stay meaningful only for a
 * one-off chore) -- the Stage 10.3 fix for "completing Monday completes every
 * Monday". Always strips the raw `completions` map -- see stripCompletions.
 *
 * Stage 6.5: also derives `approval` here, from the same completion entry (or
 * the same top-level fields for a one-off), so every caller gets it for free
 * instead of computing it separately. A parent-role assignee's occurrence is
 * always "none" -- parents never need approval (PLAN.md's Phase 1 decision) --
 * and an occurrence that isn't done is always "none" regardless of role. */
function withOccurrenceStatus(
  occ: Chore & { seriesId: string },
  parents: Set<string>
): Chore & { seriesId: string; approval: ChoreApproval } {
  const stripped = stripCompletions(occ);
  const assigneeIsParent = isParentAssignee(occ.memberId, parents);

  if (!occ.recurrence) {
    // one-off: status/completedAt/approvedAt are already correct at the top level
    const approval: ChoreApproval =
      occ.status !== "done" || assigneeIsParent ? "none" : occ.approvedAt ? "approved" : "waiting";
    return { ...stripped, approval };
  }

  const entry = occ.completions?.[occ.date];
  const approval: ChoreApproval = !entry || assigneeIsParent ? "none" : entry.approvedAt ? "approved" : "waiting";
  return { ...stripped, status: entry ? "done" : "pending", completedAt: entry?.completedAt, approval };
}

/** True when `date` is actually a day this chore (or series) falls on --
 * guards against setting a completion for a date the series was never
 * scheduled on, whether from a malformed occurrence id or a typo'd date
 * passed to the assistant tool. */
function isValidOccurrenceDate(chore: Chore, date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  if (!chore.recurrence) return date === chore.date;
  return expandOccurrences([chore], date, date).length > 0;
}

/** Recurring series expand to one row per occurrence within [from, to], same
 * as routes/calendar.ts's listEvents -- see routes/recurrence.ts. Loads the
 * member roster once (for approval/parent-role lookups) rather than once per
 * occurrence. */
export function listChores(
  userId: string,
  from?: string,
  to?: string
): (Chore & { seriesId: string; approval: ChoreApproval })[] {
  const parents = parentMemberIds(userId);
  return expandOccurrences(getScopedItems("chores", userId) as Chore[], from, to)
    .map((occ) => withOccurrenceStatus(occ, parents))
    .sort((a, b) => a.date.localeCompare(b.date) || (a.time || "").localeCompare(b.time || ""));
}

export interface PointsSummary {
  earned: number;
  completedCount: number;
  // Stage 6.5: done, but not yet approved by a parent -- not counted in
  // `earned`/`completedCount` yet (see the approval gate below).
  waitingCount: number;
}

/**
 * Points earned per member (Stage 10.4, PLAN.md, gated by approval as of
 * Stage 6.5) -- pure, walks the raw stored rows itself rather than reusing
 * listChores/expandOccurrences, because a recurring chore's completed dates
 * already live directly in its `completions` map and don't need synthesizing
 * into per-occurrence rows first. [from, to] bounds which completions count,
 * same inclusive-range convention as listChores; both omitted counts all-time
 * (routes/rewards.ts uses that form for a redeemable balance).
 *
 * A chore with no `memberId` credits FAMILY_POINTS_BUCKET instead of a real
 * member -- see that constant's comment for why it's never redeemable.
 *
 * A parent-role assignee is skipped entirely, not just left at zero: parents
 * track their own chores without stars (PLAN.md's Phase 1 decision), so they
 * never appear as a key in the returned record at all.
 *
 * Bug fix: also folds in `earned_points` -- approved completions archived by
 * deleteChoreRow when their chore row was later deleted (whole chore, whole
 * group, or one member dropped from a group). Those are always counted as
 * approved (nothing gets archived there unless it was approved first -- see
 * deleteChoreRow), so a deleted chore's stars keep counting exactly as they
 * did before the row was removed.
 */
export function pointsByMember(userId: string, from?: string, to?: string): Record<string, PointsSummary> {
  const chores = getScopedItems("chores", userId) as Chore[];
  const archived = getScopedItems("earned_points", userId) as EarnedPointsRecord[];
  const parents = parentMemberIds(userId);
  const result: Record<string, PointsSummary> = {};

  function summaryFor(memberId: string | undefined): PointsSummary {
    const key = memberId || FAMILY_POINTS_BUCKET;
    return result[key] || (result[key] = { earned: 0, completedCount: 0, waitingCount: 0 });
  }

  function credit(memberId: string | undefined, points: number, approved: boolean): void {
    const summary = summaryFor(memberId);
    if (approved) {
      summary.earned += points;
      summary.completedCount += 1;
    } else {
      summary.waitingCount += 1;
    }
  }

  const inRange = (date: string) => (!from || date >= from) && (!to || date <= to);

  for (const chore of chores) {
    if (isParentAssignee(chore.memberId, parents)) continue; // parents never earn points
    const defaultPoints = chore.points ?? 1;
    if (chore.recurrence) {
      // A reopened occurrence has no entry left in `completions` (see
      // setChoreOccurrenceStatus), so it simply isn't counted here -- no
      // separate "was it undone" check needed. entry.points is the snapshot
      // taken at approval time (setChoreOccurrenceApproval); an occurrence
      // approved before that field existed falls back to the chore's current
      // points, same as before this fix.
      for (const [date, entry] of Object.entries(chore.completions || {})) {
        if (inRange(date)) credit(chore.memberId, entry.points ?? defaultPoints, !!entry.approvedAt);
      }
    } else if (chore.status === "done" && inRange(chore.date)) {
      credit(chore.memberId, chore.approvedPoints ?? defaultPoints, !!chore.approvedAt);
    }
  }

  // Deleted chores' approved completions, archived by deleteChoreRow -- see
  // this function's doc comment above.
  for (const record of archived) {
    if (record.memberId && isParentAssignee(record.memberId, parents)) continue;
    if (inRange(record.date)) credit(record.memberId, record.points, true);
  }

  return result;
}

// Bug fix: an approved completion archived here by deleteChoreRow before its
// chore row is deleted, so the stars it earned outlive the row. Snapshots
// everything pointsByMember needs to keep crediting it -- points, who it was
// for, and which date it was earned on -- the same "copy it now, the source
// might change or disappear later" idea as Redemption snapshotting a
// reward's title/cost (see routes/rewards.ts). Same item_id/owner/data shape
// as every other scoped table -- see db.ts's earned_points table.
export interface EarnedPointsRecord {
  id: string;
  memberId?: string; // absent = FAMILY_POINTS_BUCKET, same convention as Chore.memberId
  choreTitle: string;
  date: string; // the occurrence date (YYYY-MM-DD) this was earned for
  points: number;
  approvedAt: string;
  archivedAt: string;
  sourceChoreId: string;
}

/**
 * The one path every chore-deletion route/tool must go through (bug report:
 * deleting a chore -- the whole row, a whole group, or one member dropped out
 * of a group -- was erasing the completions map along with it, taking back
 * stars a kid had already earned). Archives each APPROVED completion into
 * `earned_points` before the row goes away, then deletes it. A completion
 * that was only "waiting" or the chore was merely "pending" never earned
 * anything, so it's simply discarded with the row, same as before this fix.
 */
export function deleteChoreRow(userId: string, chore: Chore): void {
  const now = new Date().toISOString();
  const archive = (date: string, points: number, approvedAt: string): void => {
    const record: EarnedPointsRecord = {
      id: newId("earned"),
      memberId: chore.memberId,
      choreTitle: chore.title,
      date,
      points,
      approvedAt,
      archivedAt: now,
      sourceChoreId: chore.id,
    };
    putScopedItem("earned_points", userId, record);
  };

  if (chore.recurrence) {
    for (const [date, entry] of Object.entries(chore.completions || {})) {
      if (entry.approvedAt) archive(date, entry.points ?? (chore.points ?? 1), entry.approvedAt);
    }
  } else if (chore.status === "done" && chore.approvedAt) {
    archive(chore.date, chore.approvedPoints ?? (chore.points ?? 1), chore.approvedAt);
  }

  deleteScopedItem("chores", userId, chore.id);
}

/** Shared with the assistant tool so both save chores the same way. */
export function saveChore(
  userId: string,
  fields: { title: string; date: string; memberId?: unknown; time?: unknown; recurrence?: unknown }
): Chore {
  const chore = buildChore(fields);
  putScopedItem("chores", userId, chore);
  return chore;
}

/**
 * Marks a chore's completion status, dispatching on the shape of `id`:
 *  - `<seriesId>::<date>` (an occurrence id, from listChores) on a recurring
 *    chore: flips only that date's entry in `completions`, leaving every
 *    other occurrence untouched -- the Stage 10.3 fix (PLAN.md).
 *  - a bare id on a recurring chore: there's no single date to mark, so this
 *    assumes "today" when today is actually a scheduled occurrence (the
 *    common case -- "mark it done" about the chore due today) and asks for
 *    the specific date otherwise, rather than guessing.
 *  - a bare id on a one-off chore: sets the top-level status/completedAt,
 *    same as before this fix.
 *
 * Shared by PUT /:id and the assistant's complete_chore so they can't drift.
 *
 * Stage 6.5: setting an occurrence back to "pending" also clears its
 * approval. For a recurring occurrence that falls out naturally -- the whole
 * `completions[date]` entry (approvedAt included) is deleted below, same as
 * before Stage 6.5. For a one-off chore, approvedAt/approvedByUserId are
 * explicitly cleared alongside completedAt so un-checking an approved chore
 * doesn't leave a stale approval behind it.
 */
export function setChoreOccurrenceStatus(
  userId: string,
  id: string,
  status: Chore["status"],
  byUserId?: string
): { chore: Chore & { seriesId: string; approval: ChoreApproval } } | { error: string } {
  const master = getChore(userId, id);
  if (!master) return { error: "Chore not found" };
  const parents = parentMemberIds(userId);

  const sep = id.indexOf("::");
  let date = sep === -1 ? undefined : id.slice(sep + 2);

  if (master.recurrence && !date) {
    const today = todayISO();
    if (!isValidOccurrenceDate(master, today)) {
      return { error: "This chore repeats -- say which date's occurrence to mark (today isn't one of its scheduled days)." };
    }
    date = today;
  }

  if (date && master.recurrence) {
    if (!isValidOccurrenceDate(master, date)) {
      return { error: `${date} is not a scheduled occurrence of this chore.` };
    }
    const completions = { ...master.completions };
    if (status === "done") {
      completions[date] = byUserId ? { completedAt: new Date().toISOString(), byUserId } : { completedAt: new Date().toISOString() };
    } else {
      delete completions[date]; // also clears any approvedAt/approvedByUserId that entry held
    }
    const updated: Chore = { ...master, completions, updatedAt: new Date().toISOString() };
    putScopedItem("chores", userId, updated);
    return { chore: withOccurrenceStatus({ ...updated, id: `${master.id}::${date}`, date, seriesId: master.id }, parents) };
  }

  // One-off chore: unchanged top-level status field.
  const now = new Date().toISOString();
  const updated: Chore = {
    ...master,
    status,
    completedAt: status === "done" ? master.completedAt || now : undefined,
    approvedAt: status === "done" ? master.approvedAt : undefined,
    approvedByUserId: status === "done" ? master.approvedByUserId : undefined,
    approvedPoints: status === "done" ? master.approvedPoints : undefined,
    updatedAt: now,
  };
  putScopedItem("chores", userId, updated);
  return { chore: withOccurrenceStatus({ ...updated, seriesId: updated.id }, parents) };
}

/**
 * Approves or rejects a DONE occurrence, dispatching on the shape of `id`
 * exactly like setChoreOccurrenceStatus above (occurrence-shaped id, bare id
 * on a recurring chore resolved to today, or bare id on a one-off).
 *
 *  - approve: stamps approvedAt/approvedByUserId on that occurrence (or on a
 *    one-off chore's top-level fields).
 *  - reject: removes the completion entirely (recurring) or resets status to
 *    "pending" and clears completedAt/approvedAt/approvedByUserId (one-off) --
 *    either way the chore goes back to pending, same end state as
 *    setChoreOccurrenceStatus(..., "pending").
 *
 * Refuses (400-shaped, same convention as setChoreOccurrenceStatus's `error`
 * return) when the occurrence isn't done yet, or when the assignee is a
 * parent-role member -- parent chores never enter the approval queue in the
 * first place (their `approval` is always "none"), so there's nothing here to
 * approve or reject.
 */
export function setChoreOccurrenceApproval(
  userId: string,
  id: string,
  approve: boolean,
  byUserId?: string
): { chore: Chore & { seriesId: string; approval: ChoreApproval } } | { error: string } {
  const master = getChore(userId, id);
  if (!master) return { error: "Chore not found" };

  const parents = parentMemberIds(userId);
  if (isParentAssignee(master.memberId, parents)) {
    return { error: "This chore is assigned to a parent -- parent chores don't need approval." };
  }

  const sep = id.indexOf("::");
  let date = sep === -1 ? undefined : id.slice(sep + 2);

  if (master.recurrence && !date) {
    const today = todayISO();
    if (!isValidOccurrenceDate(master, today)) {
      return { error: "This chore repeats -- say which date's occurrence to approve (today isn't one of its scheduled days)." };
    }
    date = today;
  }

  if (date && master.recurrence) {
    if (!isValidOccurrenceDate(master, date)) {
      return { error: `${date} is not a scheduled occurrence of this chore.` };
    }
    const entry = master.completions?.[date];
    if (!entry) return { error: "This occurrence isn't done yet -- nothing to approve." };

    const completions = { ...master.completions };
    if (approve) {
      // Snapshot the chore's current points onto this occurrence -- bug fix:
      // stars already earned must not change if the chore's points are
      // edited afterward (pointsByMember prefers this snapshot over the
      // chore's live `points`).
      const snapshot = { approvedAt: new Date().toISOString(), points: master.points ?? 1 };
      completions[date] = byUserId ? { ...entry, ...snapshot, approvedByUserId: byUserId } : { ...entry, ...snapshot };
    } else {
      delete completions[date]; // reject -> back to pending, same as setChoreOccurrenceStatus
    }
    const updated: Chore = { ...master, completions, updatedAt: new Date().toISOString() };
    putScopedItem("chores", userId, updated);
    return { chore: withOccurrenceStatus({ ...updated, id: `${master.id}::${date}`, date, seriesId: master.id }, parents) };
  }

  // One-off chore.
  if (master.status !== "done") return { error: "This chore isn't done yet -- nothing to approve." };
  const now = new Date().toISOString();
  // Same points-snapshot idea as the recurring branch above, on the top-level
  // approvedPoints field instead of a completions[date] entry.
  const updated: Chore = approve
    ? byUserId
      ? { ...master, approvedAt: now, approvedByUserId: byUserId, approvedPoints: master.points ?? 1, updatedAt: now }
      : { ...master, approvedAt: now, approvedPoints: master.points ?? 1, updatedAt: now }
    : {
        ...master,
        status: "pending",
        completedAt: undefined,
        approvedAt: undefined,
        approvedByUserId: undefined,
        approvedPoints: undefined,
        updatedAt: now,
      };
  putScopedItem("chores", userId, updated);
  return { chore: withOccurrenceStatus({ ...updated, seriesId: updated.id }, parents) };
}

choreRoutes.get("/", (req, res) => {
  const { from, to } = req.query;
  res.json({
    chores: listChores(
      currentUserId(req),
      typeof from === "string" ? from : undefined,
      typeof to === "string" ? to : undefined
    ),
  });
});

// Registered ahead of PUT/DELETE "/:id" below (and before POST "/", so the
// static path always reads clearly next to GET "/") so a literal "points"
// segment is never mistaken for an id.
choreRoutes.get("/points", (req, res) => {
  const { from, to } = req.query;
  res.json({
    points: pointsByMember(
      currentUserId(req),
      typeof from === "string" ? from : undefined,
      typeof to === "string" ? to : undefined
    ),
  });
});

// Registered ahead of PUT/DELETE "/:id", same reason as GET "/points" above --
// a literal "series" segment must never be mistaken for an id. Unlike GET "/",
// this returns one row per master chore (not expanded into occurrences), for
// the Parent "manage chores" list (Phase 3) to edit the series itself rather
// than one date at a time.
choreRoutes.get("/series", (req, res) => {
  const userId = currentUserId(req);
  const parents = parentMemberIds(userId);
  const chores = (getScopedItems("chores", userId) as Chore[])
    .map((c) => withOccurrenceStatus({ ...c, seriesId: c.id }, parents))
    .sort((a, b) => a.title.localeCompare(b.title));
  res.json({ chores });
});

// Every id in `memberIds` must be a real household member -- unlike the
// pre-existing `memberId` field (never existence-checked; see buildChore),
// this is checked because a typo'd id here would silently create an
// un-attributable copy nobody can see in their own Kid view.
function findInvalidMemberId(userId: string, ids: string[]): string | undefined {
  const members = listMembers(userId);
  return ids.find((id) => !members.some((m) => m.id === id));
}

// Creating a chore is a parent action -- gated behind the household PIN
// (the owner's decision: the Chores tab's "Manage" area shares the Budget lock
// rather than getting a PIN of its own). Kids never reach POST /api/chores;
// only ticking one off (PUT /:id, below) is open to them.
choreRoutes.post("/", (req, res) => {
  if (!passesUnlockCheck(req, res)) return;
  const { title, date, memberId, memberIds, time, recurrence, points } = req.body || {};
  const userId = currentUserId(req);

  // Multi-assignee create ("chores assigned to more than one kid"): memberIds
  // with 2+ distinct real members creates one linked copy per member sharing
  // a new groupId (see Chore.groupId's comment). memberIds with only one id
  // (after dedup) falls through to the single-chore path below, behaving
  // exactly like passing that id as `memberId`.
  let resolvedMemberIds: string[] | undefined;
  if (Array.isArray(memberIds)) {
    const uniqueIds = [...new Set(memberIds.map((m) => String(m)).filter(Boolean))];
    if (uniqueIds.length > 0) {
      const invalid = findInvalidMemberId(userId, uniqueIds);
      if (invalid) return res.status(400).json({ error: `No household member with id "${invalid}"` });
      resolvedMemberIds = uniqueIds;
    }
  }

  if (resolvedMemberIds && resolvedMemberIds.length >= 2) {
    const validationError = validateChoreFields({ title, date, time, recurrence, points });
    if (validationError) return res.status(400).json({ error: validationError });

    const groupId = newId("chore");
    const parents = parentMemberIds(userId);
    const chores = resolvedMemberIds.map((mid) => {
      const chore = buildChore({ title, date, memberId: mid, time, recurrence, points, groupId });
      putScopedItem("chores", userId, chore);
      return withOccurrenceStatus({ ...chore, seriesId: chore.id }, parents);
    });
    // Multi-assignee response shape: `chores` holds every linked copy (one
    // per member), and `chore` is the first of them, so any existing caller
    // that only reads `.chore` (e.g. the assistant, which never sends
    // memberIds) keeps working unchanged.
    return res.json({ chores, chore: chores[0] });
  }

  const effectiveMemberId = resolvedMemberIds ? resolvedMemberIds[0] : memberId;
  const validationError = validateChoreFields({ title, date, memberId: effectiveMemberId, time, recurrence, points });
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  const chore = buildChore({ title, date, memberId: effectiveMemberId, time, recurrence, points });
  putScopedItem("chores", userId, chore);
  res.json({ chore: withOccurrenceStatus({ ...chore, seriesId: chore.id }, parentMemberIds(userId)) });
});

// Registered ahead of PUT/DELETE "/:id", same reason as GET "/series" above --
// a literal "group" segment must never be mistaken for an id. groupKey is
// either a real groupId, or (for a chore that was never grouped) that
// chore's own id -- see Chore.groupId's comment.
function findGroupChores(userId: string, groupKey: string): Chore[] {
  return (getScopedItems("chores", userId) as Chore[]).filter((c) => (c.groupId || c.id) === groupKey);
}

// Edits the shared fields (title/date/time/recurrence/points) across every
// copy in a group, and reconciles membership: adds a fresh copy (empty
// completions) for each newly-added member, and deletes the copy of each
// removed member. Status/completion is never editable here -- only PUT
// "/:id" (or an occurrence id) can mark a chore done. Removing a member from
// the group deletes their completion/approval history for this chore along
// with their copy -- there's no per-row history to preserve once nobody's
// assigned to it anymore.
choreRoutes.put("/group/:groupKey", (req, res) => {
  if (!passesUnlockCheck(req, res)) return;
  const userId = currentUserId(req);
  const groupChores = findGroupChores(userId, req.params.groupKey);
  if (groupChores.length === 0) {
    return res.status(404).json({ error: "Chore group not found" });
  }

  const { title, date, time, recurrence, points, memberIds } = req.body || {};
  if (!Array.isArray(memberIds)) {
    return res.status(400).json({ error: "memberIds is required" });
  }
  const uniqueIds = [...new Set(memberIds.map((m) => String(m)).filter(Boolean))];
  if (uniqueIds.length === 0) {
    return res.status(400).json({
      error: "A chore group needs at least one assigned member -- use the family chore routes for an unassigned chore.",
    });
  }
  const invalid = findInvalidMemberId(userId, uniqueIds);
  if (invalid) return res.status(400).json({ error: `No household member with id "${invalid}"` });

  const template = groupChores[0];
  const mergedTitle = typeof title === "string" && title.trim() ? title : template.title;
  const mergedDate = typeof date === "string" && date ? date : template.date;
  const mergedTime = time !== undefined ? time : template.time;
  const mergedRecurrence = recurrence !== undefined ? recurrence : template.recurrence;
  const mergedPoints = points !== undefined ? points : template.points;

  const validationError = validateChoreFields({
    title: mergedTitle, date: mergedDate, time: mergedTime, recurrence: mergedRecurrence, points: mergedPoints,
  });
  if (validationError) return res.status(400).json({ error: validationError });

  // Once a chore has a groupId it keeps it even if membership later shrinks
  // to one (harmless -- a group of one behaves identically either way). An
  // ungrouped chore (template.groupId absent) only gains one if this edit
  // grows it to 2+ members.
  const groupId = template.groupId || (uniqueIds.length >= 2 ? newId("chore") : undefined);

  const existingByMember = new Map(
    groupChores.filter((c) => c.memberId).map((c) => [c.memberId as string, c])
  );
  const parents = parentMemberIds(userId);
  const resultChores: (Chore & { seriesId: string; approval: ChoreApproval })[] = [];

  for (const mid of uniqueIds) {
    const existing = existingByMember.get(mid);
    const chore = buildChore({
      id: existing?.id,
      title: mergedTitle,
      date: mergedDate,
      memberId: mid,
      groupId,
      time: mergedTime,
      recurrence: mergedRecurrence,
      status: existing?.status,
      completedAt: existing?.completedAt,
      approvedAt: existing?.approvedAt,
      approvedByUserId: existing?.approvedByUserId,
      approvedPoints: existing?.approvedPoints,
      completions: existing?.completions,
      points: mergedPoints,
      createdAt: existing?.createdAt,
    });
    putScopedItem("chores", userId, chore);
    resultChores.push(withOccurrenceStatus({ ...chore, seriesId: chore.id }, parents));
    existingByMember.delete(mid);
  }

  // Every row in the group that wasn't reused above goes: member copies
  // removed from the list, and also a family/unassigned row when this edit
  // is turning a Whole-family chore into a per-member one -- it has no
  // memberId, so it never enters existingByMember, and leaving it would
  // duplicate the chore. Their stars (if any were already approved) survive
  // through deleteChoreRow -- only the completion/approval history itself
  // goes with the row, not the points already earned from it.
  const kept = new Set(resultChores.map((c) => c.id));
  for (const row of groupChores) {
    if (!kept.has(row.id)) deleteChoreRow(userId, row);
  }

  res.json({ chores: resultChores, chore: resultChores[0] });
});

choreRoutes.delete("/group/:groupKey", (req, res) => {
  if (!passesUnlockCheck(req, res)) return;
  const userId = currentUserId(req);
  const groupChores = findGroupChores(userId, req.params.groupKey);
  if (groupChores.length === 0) {
    return res.status(404).json({ error: "Chore group not found" });
  }
  for (const c of groupChores) deleteChoreRow(userId, c); // archives each kid's approved stars first
  res.json({ success: true, deletedCount: groupChores.length });
});

choreRoutes.put("/:id", (req, res) => {
  const existing = loadChore(req, res);
  if (!existing) return;

  // A status-only PUT (ticking a chore done/undone) is open to everyone,
  // parent or kid alike -- the owner's call: only managing chores (add/edit/
  // delete/approve) and rewards/points needs the PIN, not ticking your own
  // box. Any other edit -- retitling, reassigning, changing the schedule --
  // always needs it. See passesUnlockCheck's comment for why this is a
  // manual check rather than router-level middleware: the same route needs
  // different treatment depending on what's actually in the body.
  const bodyKeys = Object.keys(req.body || {});
  const isStatusOnly = bodyKeys.length === 1 && bodyKeys[0] === "status";
  const userId = currentUserId(req);

  if (!isStatusOnly) {
    if (!passesUnlockCheck(req, res)) return;
  }

  // A status-only PUT against a recurring chore -- whether id is an
  // occurrence id from listChores ("<seriesId>::2026-10-12") or the bare
  // series id -- marks a single occurrence via setChoreOccurrenceStatus
  // (which resolves a bare id to today's occurrence). Writing the top-level
  // `status` field instead would be a silent no-op: GET/listChores stops
  // reading it once a chore is recurring (see withOccurrenceStatus). A body
  // touching other fields still takes the series-level path below, unchanged.
  const isOccurrenceStatusUpdate = !!existing.recurrence && isStatusOnly;

  if (isOccurrenceStatusUpdate) {
    const { status } = req.body;
    if (status !== "pending" && status !== "done") {
      return res.status(400).json({ error: 'status must be "pending" or "done"' });
    }
    const result = setChoreOccurrenceStatus(userId, req.params.id, status, userId);
    if ("error" in result) return res.status(400).json({ error: result.error });
    return res.json({ chore: result.chore });
  }

  const { title, date, memberId, time, recurrence, status, points } = req.body || {};
  const mergedTitle = typeof title === "string" && title.trim() ? title : existing.title;
  const mergedDate = typeof date === "string" && date ? date : existing.date;
  const mergedMemberId = memberId !== undefined ? memberId : existing.memberId;
  const mergedTime = time !== undefined ? time : existing.time;
  const mergedRecurrence = recurrence !== undefined ? recurrence : existing.recurrence;
  const mergedStatus = status !== undefined ? status : existing.status;
  const mergedPoints = points !== undefined ? points : existing.points;

  const validationError = validateChoreFields({
    title: mergedTitle, date: mergedDate, memberId: mergedMemberId,
    time: mergedTime, recurrence: mergedRecurrence, status: mergedStatus, points: mergedPoints,
  });
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  const chore = buildChore({
    id: existing.id,
    title: mergedTitle,
    date: mergedDate,
    memberId: mergedMemberId,
    // Preserved across an edit to any other field, same as completedAt etc.
    // below -- only the group routes (PUT/DELETE /group/:groupKey) ever
    // change group membership; this route edits one chore at a time.
    groupId: existing.groupId,
    time: mergedTime,
    recurrence: mergedRecurrence,
    status: mergedStatus,
    completedAt: existing.completedAt,
    approvedAt: existing.approvedAt,
    approvedByUserId: existing.approvedByUserId,
    approvedPoints: existing.approvedPoints,
    completions: existing.completions,
    points: mergedPoints,
    createdAt: existing.createdAt,
  });

  putScopedItem("chores", userId, chore);
  res.json({ chore: withOccurrenceStatus({ ...chore, seriesId: chore.id }, parentMemberIds(userId)) });
});

// Stage 6.5: approve/reject a DONE occurrence. Both take the same occurrence
// id shapes as PUT /:id's status update (an occurrence id, or a bare id
// resolved to today for a recurring chore) -- see setChoreOccurrenceApproval.
// Always a parent action -- gated behind the PIN regardless of who the
// chore is assigned to (a kid's completion still needs a parent to approve
// it, and it's a parent looking at this queue in the first place).
choreRoutes.post("/:id/approve", requireUnlocked, (req, res) => {
  const userId = currentUserId(req);
  const result = setChoreOccurrenceApproval(userId, req.params.id, true, userId);
  if ("error" in result) return res.status(400).json({ error: result.error });
  res.json({ chore: result.chore });
});

choreRoutes.post("/:id/reject", requireUnlocked, (req, res) => {
  const userId = currentUserId(req);
  const result = setChoreOccurrenceApproval(userId, req.params.id, false, userId);
  if ("error" in result) return res.status(400).json({ error: result.error });
  res.json({ chore: result.chore });
});

// Deleting a chore's whole series is a parent action, same as creating one.
choreRoutes.delete("/:id", requireUnlocked, (req, res) => {
  const userId = currentUserId(req);
  const chore = getScopedItem("chores", userId, seriesIdOf(req.params.id)) as Chore | undefined;
  if (!chore) return res.status(404).json({ error: "Chore not found" });
  deleteChoreRow(userId, chore); // archives approved stars first -- see its comment
  res.json({ success: true });
});
