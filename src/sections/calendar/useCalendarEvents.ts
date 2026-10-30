// The calendar's events, shared by every screen that displays or edits them
// (the family grid, the personal view, the add-event form) -- one hook per
// REST resource, same reasoning as src/sections/members/useMembers.ts:
// splitting the *screens* by job is fine, splitting the code that talks to
// /api/calendar is not.
//
// Unlike useMembers (no query params), /api/calendar is intrinsically
// range-scoped, so this hook takes a date range and refetches when it
// changes.

import { useCallback, useEffect, useState } from "react";
import { api, type CalendarEvent, type MealSlot, type Weekday } from "../../api.ts";
import { useLiveRefresh } from "../../useLiveRefresh.ts";
import { KIOSK } from "../../kiosk.ts";

export interface DateRange {
  from: string;
  to: string;
}

export interface NewEventFields {
  date: string;
  title: string;
  audience?: "family" | "individual";
  memberId?: string;
  mealSlot?: MealSlot;
  time?: string;
  endTime?: string;
}

export interface CalendarEventsApi {
  events: CalendarEvent[];
  error: string;
  setError: (message: string) => void;
  refresh: () => Promise<void>;
  addEvent: (fields: NewEventFields) => Promise<void>;
  addRecurringEvent: (fields: NewEventFields & { days: Weekday[]; until?: string }) => Promise<void>;
  updateEvent: (event: CalendarEvent, patch: Partial<NewEventFields>) => Promise<void>;
  removeEvent: (event: CalendarEvent) => Promise<void>;
}

export function useCalendarEvents(range: DateRange): CalendarEventsApi {
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try {
      const res = await api.get<{ events: CalendarEvent[] }>(
        `/api/calendar?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`
      );
      setEvents(res.events);
      setError("");
    } catch (err: any) {
      setError(err.message);
    }
  }, [range.from, range.to]);

  useEffect(() => { refresh(); }, [refresh]);

  // Picks up an event added or edited on another device -- or by the
  // assistant -- without App.tsx's dataVersion remount, which would reset
  // whatever the user is halfway through in the add-event form.
  useLiveRefresh(() => { refresh(); }, KIOSK ? 30_000 : 60_000);

  // A mutation can move an event outside the currently displayed range (e.g.
  // editing its date), so every write re-fetches the range rather than
  // merging in place -- unlike useMembers' flat, unscoped list, there's no
  // way to know locally whether a changed event still belongs in view.
  const addEvent = useCallback(async (fields: NewEventFields) => {
    try {
      await api.post("/api/calendar", fields);
      await refresh();
    } catch (err: any) { setError(err.message); }
  }, [refresh]);

  const addRecurringEvent = useCallback(async (fields: NewEventFields & { days: Weekday[]; until?: string }) => {
    const { days, until, ...rest } = fields;
    try {
      await api.post("/api/calendar", { ...rest, recurrence: { freq: "weekly", byDay: days, until } });
      await refresh();
    } catch (err: any) { setError(err.message); }
  }, [refresh]);

  // Always targets the series master (seriesId), so editing/removing one
  // occurrence of a recurring series acts on the whole series -- this pass
  // has no per-occurrence edit/delete, see PLAN.md Stage 10.
  const updateEvent = useCallback(async (event: CalendarEvent, patch: Partial<NewEventFields>) => {
    try {
      await api.put(`/api/calendar/${event.seriesId}`, patch);
      await refresh();
    } catch (err: any) { setError(err.message); }
  }, [refresh]);

  const removeEvent = useCallback(async (event: CalendarEvent) => {
    try {
      await api.del(`/api/calendar/${event.seriesId}`);
      await refresh();
    } catch (err: any) { setError(err.message); }
  }, [refresh]);

  return { events, error, setError, refresh, addEvent, addRecurringEvent, updateEvent, removeEvent };
}
