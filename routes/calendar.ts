import express from "express";
import { getScopedItems, getScopedItem, putScopedItem, deleteScopedItem, newId } from "../db.ts";
import { currentUserId } from "../auth.ts";
import type { MealSlot } from "./mealplan.ts";
import { type RecurrenceRule, isValidRecurrence, expandOccurrences, seriesIdOf } from "./recurrence.ts";

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/; // 24h "HH:MM", 00:00-23:59

// The household's own calendar -- not synced from Google (that's a separate,
// later OAuth project per the README roadmap). This is what MealPlan reads to
// decide whether a given day/slot is a shared family meal or one person eating
// on their own.
export interface CalendarEvent {
  id: string;
  date: string; // YYYY-MM-DD -- the anchor date; the only date for a one-off event, the first occurrence for a recurring series
  time?: string; // "HH:MM", 24h. Absent = all-day.
  endTime?: string;
  title: string;
  audience: "family" | "individual";
  memberId?: string;
  mealSlot?: MealSlot;
  recurrence?: RecurrenceRule;
  scope: "joint";
  createdAt: string;
  updatedAt: string;
}

export const calendarRoutes = express.Router();

function buildEvent(
  fields: {
    id?: string; date: string; title: string; audience?: unknown; memberId?: unknown; mealSlot?: unknown;
    time?: unknown; endTime?: unknown; recurrence?: unknown; createdAt?: string;
  }
): CalendarEvent {
  const now = new Date().toISOString();
  const audience = fields.audience === "individual" ? "individual" : "family";
  const mealSlot =
    fields.mealSlot === "breakfast" || fields.mealSlot === "lunch" || fields.mealSlot === "dinner"
      ? fields.mealSlot
      : undefined;
  const time = typeof fields.time === "string" && TIME_RE.test(fields.time) ? fields.time : undefined;
  const endTime =
    time && typeof fields.endTime === "string" && TIME_RE.test(fields.endTime) && fields.endTime > time
      ? fields.endTime
      : undefined;
  const recurrence = isValidRecurrence(fields.recurrence) ? fields.recurrence : undefined;
  return {
    id: fields.id || newId("event"),
    date: fields.date,
    time,
    endTime,
    title: fields.title.trim(),
    audience,
    memberId: audience === "individual" ? String(fields.memberId) : undefined,
    mealSlot,
    recurrence,
    scope: "joint",
    createdAt: fields.createdAt || now,
    updatedAt: now,
  };
}

// Shared by POST and PUT so the two routes cannot drift apart again -- PUT
// used to validate less than POST, which let a malformed date and a literal
// "undefined" memberId slip into the database through the update path.
function validateEventFields(fields: {
  date: unknown; title: unknown; audience?: unknown; memberId?: unknown; time?: unknown; endTime?: unknown; recurrence?: unknown;
}): string | null {
  if (!fields.date || typeof fields.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(fields.date)) {
    return "date must be a date like 2026-08-24";
  }
  if (!fields.title || typeof fields.title !== "string" || !fields.title.trim()) {
    return "title is required";
  }
  if (fields.audience === "individual" && !fields.memberId) {
    return "memberId is required when audience is individual";
  }
  if (fields.time != null && (typeof fields.time !== "string" || !TIME_RE.test(fields.time))) {
    return "time must be a 24-hour time like 18:30";
  }
  if (fields.endTime != null && (typeof fields.endTime !== "string" || !TIME_RE.test(fields.endTime))) {
    return "endTime must be a 24-hour time like 19:00";
  }
  if (
    typeof fields.time === "string" && TIME_RE.test(fields.time) &&
    typeof fields.endTime === "string" && TIME_RE.test(fields.endTime) &&
    fields.endTime <= fields.time
  ) {
    return "endTime must be after time";
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

function loadEvent(req: express.Request, res: express.Response): CalendarEvent | null {
  const event = getScopedItem("events", currentUserId(req), seriesIdOf(req.params.id)) as CalendarEvent | undefined;
  if (!event) {
    res.status(404).json({ error: "Calendar event not found" });
    return null;
  }
  return event;
}

/** Recurring series expand to one row per occurrence within [from, to] --
 * `seriesId` on each row is the master event's own id, see routes/recurrence.ts. */
export function listEvents(userId: string, from?: string, to?: string): (CalendarEvent & { seriesId: string })[] {
  return expandOccurrences(getScopedItems("events", userId) as CalendarEvent[], from, to).sort(
    (a, b) => a.date.localeCompare(b.date) || (a.time || "").localeCompare(b.time || "")
  );
}

/** Shared with the assistant tool so both save events the same way. */
export function saveEvent(
  userId: string,
  fields: { date: string; title: string; audience?: unknown; memberId?: unknown; mealSlot?: unknown; time?: unknown; endTime?: unknown; recurrence?: unknown }
): CalendarEvent {
  const event = buildEvent(fields);
  putScopedItem("events", userId, event);
  return event;
}

calendarRoutes.get("/", (req, res) => {
  const { from, to } = req.query;
  res.json({
    events: listEvents(
      currentUserId(req),
      typeof from === "string" ? from : undefined,
      typeof to === "string" ? to : undefined
    ),
  });
});

calendarRoutes.post("/", (req, res) => {
  const { date, title, audience, memberId, mealSlot, time, endTime, recurrence } = req.body || {};
  const validationError = validateEventFields({ date, title, audience, memberId, time, endTime, recurrence });
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  const userId = currentUserId(req);
  const event = buildEvent({ date, title, audience, memberId, mealSlot, time, endTime, recurrence });
  putScopedItem("events", userId, event);
  res.json({ event: { ...event, seriesId: event.id } });
});

calendarRoutes.put("/:id", (req, res) => {
  const existing = loadEvent(req, res);
  if (!existing) return;

  const { date, title, audience, memberId, mealSlot, time, endTime, recurrence } = req.body || {};
  const mergedDate = typeof date === "string" && date ? date : existing.date;
  const mergedTitle = typeof title === "string" && title.trim() ? title : existing.title;
  const mergedAudience = audience !== undefined ? audience : existing.audience;
  const mergedMemberId = memberId !== undefined ? memberId : existing.memberId;
  const mergedTime = time !== undefined ? time : existing.time;
  const mergedEndTime = endTime !== undefined ? endTime : existing.endTime;
  const mergedRecurrence = recurrence !== undefined ? recurrence : existing.recurrence;

  const validationError = validateEventFields({
    date: mergedDate, title: mergedTitle, audience: mergedAudience, memberId: mergedMemberId,
    time: mergedTime, endTime: mergedEndTime, recurrence: mergedRecurrence,
  });
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  const event = buildEvent({
    id: existing.id,
    date: mergedDate,
    title: mergedTitle,
    audience: mergedAudience,
    memberId: mergedMemberId,
    mealSlot: mealSlot !== undefined ? mealSlot : existing.mealSlot,
    time: mergedTime,
    endTime: mergedEndTime,
    recurrence: mergedRecurrence,
    createdAt: existing.createdAt,
  });

  putScopedItem("events", currentUserId(req), event);
  res.json({ event: { ...event, seriesId: event.id } });
});

calendarRoutes.delete("/:id", (req, res) => {
  const deleted = deleteScopedItem("events", currentUserId(req), seriesIdOf(req.params.id));
  if (!deleted) return res.status(404).json({ error: "Calendar event not found" });
  res.json({ success: true });
});
