// The household's chores, shared by every screen that displays or edits them
// -- same reasoning and shape as ./useCalendarEvents.ts and
// src/sections/members/useMembers.ts.

import { useCallback, useEffect, useState } from "react";
import { api, type Chore, type Weekday } from "../../api.ts";
import { useLiveRefresh } from "../../useLiveRefresh.ts";
import { KIOSK } from "../../kiosk.ts";
import type { DateRange } from "./useCalendarEvents.ts";

export interface NewChoreFields {
  title: string;
  date: string;
  // Every id the chore is assigned to -- omitted/empty = "Whole family". A
  // single id behaves exactly like the pre-existing memberId field; 2+ ids
  // create a linked group, one row per member (see routes/chores.ts's
  // Chore.groupId comment). Posted straight through to POST /api/chores,
  // which does the same dedupe/validate/group-or-not logic either way.
  memberIds?: string[];
  time?: string;
  points?: number; // 1-10, omitted = default (1) -- Stage 10.4
}

export interface ChoresApi {
  chores: Chore[];
  error: string;
  // True until the first fetch settles (success or failure). Lets a caller
  // that renders an "empty" state (KidView's "Nothing due today") tell a
  // genuinely empty result apart from "hasn't loaded yet" -- without this, a
  // kiosk showed the cheerful empty state for a beat on every load, chores or
  // not.
  loading: boolean;
  setError: (message: string) => void;
  refresh: () => Promise<void>;
  addChore: (fields: NewChoreFields) => Promise<void>;
  addRecurringChore: (fields: NewChoreFields & { days: Weekday[]; until?: string }) => Promise<void>;
  setChoreStatus: (chore: Chore, status: Chore["status"]) => Promise<void>;
  removeChore: (chore: Chore) => Promise<void>;
}

export function useChores(range: DateRange): ChoresApi {
  const [chores, setChores] = useState<Chore[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await api.get<{ chores: Chore[] }>(
        `/api/chores?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`
      );
      setChores(res.chores);
      setError("");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [range.from, range.to]);

  useEffect(() => { refresh(); }, [refresh]);

  useLiveRefresh(() => { refresh(); }, KIOSK ? 30_000 : 60_000);

  const addChore = useCallback(async (fields: NewChoreFields) => {
    try {
      await api.post("/api/chores", fields);
      await refresh();
    } catch (err: any) { setError(err.message); }
  }, [refresh]);

  const addRecurringChore = useCallback(async (fields: NewChoreFields & { days: Weekday[]; until?: string }) => {
    const { days, until, ...rest } = fields;
    try {
      await api.post("/api/chores", { ...rest, recurrence: { freq: "weekly", byDay: days, until } });
      await refresh();
    } catch (err: any) { setError(err.message); }
  }, [refresh]);

  // Targets this occurrence (chore.id), not the series master -- so
  // completing one occurrence of a recurring chore leaves the rest of the
  // series pending (Stage 10.3 fix, PLAN.md; routes/chores.ts's
  // setChoreOccurrenceStatus is what makes a per-occurrence id meaningful
  // here). removeChore below still targets the whole series -- there's no
  // per-occurrence delete.
  const setChoreStatus = useCallback(async (chore: Chore, status: Chore["status"]) => {
    try {
      await api.put(`/api/chores/${chore.id}`, { status });
      await refresh();
    } catch (err: any) { setError(err.message); }
  }, [refresh]);

  const removeChore = useCallback(async (chore: Chore) => {
    try {
      await api.del(`/api/chores/${chore.seriesId}`);
      await refresh();
    } catch (err: any) { setError(err.message); }
  }, [refresh]);

  return { chores, error, loading, setError, refresh, addChore, addRecurringChore, setChoreStatus, removeChore };
}
