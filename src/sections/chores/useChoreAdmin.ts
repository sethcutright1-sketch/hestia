// Everything Phase 3's ParentView.tsx needs beyond what useChores.ts/
// useRewards.ts (src/sections/calendar/) already cover: the unexpanded series
// list (for the "Chores" manage panel), approving/rejecting waiting
// occurrences, and point adjustments. Same shape as those two hooks -- error
// state, a `loading` flag until the first fetch settles, live refresh -- so
// ParentView's panels read the same way KidView.tsx's already do.
//
// "Waiting for approval" and "This week"'s own chore data still come from
// useChores() directly (ParentView calls it with its own date ranges) rather
// than being duplicated in here -- there's no reason to re-fetch/re-store the
// same /api/chores rows under a second hook.
//
// Every mutator here (approve/reject/approveAll/adjust) takes an optional
// `onChanged` callback -- ParentView passes one that refreshes its own
// useChores()/useRewards() instances, since approving a chore or posting an
// adjustment moves a balance those hooks own, and this hook has no reference
// to them (see useChoreAdmin's own JSDoc below for why that's simpler than a
// shared store).

import { useCallback, useEffect, useState } from "react";
import { api, type Chore, type PointAdjustment, type Weekday } from "../../api.ts";
import { useLiveRefresh } from "../../useLiveRefresh.ts";
import { KIOSK } from "../../kiosk.ts";
import { addDaysISO, startOfWeek, todayISO } from "./parentHelpers.ts";

export interface ChoreSeriesFields {
  title: string;
  date: string;
  // Empty = "Whole family". See ChoreFields.tsx's ChoreFieldsValues -- this
  // mirrors it exactly, one per assignee, 2+ forming a linked group.
  memberIds: string[];
  time?: string;
  points?: number;
  days?: Weekday[];
  until?: string;
}

export interface ChoreAdminApi {
  series: Chore[];
  seriesError: string;
  seriesLoading: boolean;
  refreshSeries: () => Promise<void>;
  addSeries: (fields: ChoreSeriesFields) => Promise<void>;
  // Takes the group's representative chore (any one copy), not just an id --
  // editing needs its groupId (or its own id, for a still-ungrouped chore)
  // to know which group route to call. See editSeries below.
  editSeries: (chore: Chore, fields: ChoreSeriesFields) => Promise<void>;
  deleteSeries: (chore: Chore) => Promise<void>;

  approve: (chore: Chore) => Promise<void>;
  reject: (chore: Chore) => Promise<void>;
  approveAll: (chores: Chore[]) => Promise<void>;

  adjustments: PointAdjustment[];
  adjustmentsError: string;
  adjustmentsLoading: boolean;
  refreshAdjustments: () => Promise<void>;
  adjust: (memberId: string, amount: number, note: string) => Promise<void>;
}

/** `onChanged`: called after any mutation here that can move a balance or a
 * chore's status -- approve, reject, approveAll, adjust. Not called for
 * series add/edit/delete, which touch the chore catalog, not anyone's points
 * or today's occurrences. */
export function useChoreAdmin(onChanged?: () => void | Promise<void>): ChoreAdminApi {
  const [series, setSeries] = useState<Chore[]>([]);
  const [seriesError, setSeriesError] = useState("");
  const [seriesLoading, setSeriesLoading] = useState(true);

  const refreshSeries = useCallback(async () => {
    try {
      const res = await api.get<{ chores: Chore[] }>("/api/chores/series");
      setSeries(res.chores);
      setSeriesError("");
    } catch (err: any) {
      setSeriesError(err.message);
    } finally {
      setSeriesLoading(false);
    }
  }, []);

  useEffect(() => { refreshSeries(); }, [refreshSeries]);
  useLiveRefresh(() => { refreshSeries(); }, KIOSK ? 30_000 : 60_000);

  function toBody(fields: ChoreSeriesFields) {
    const { days, until, ...rest } = fields;
    return {
      ...rest,
      recurrence: days && days.length > 0 ? { freq: "weekly" as const, byDay: days, until: until || undefined } : undefined,
    };
  }

  const addSeries = useCallback(async (fields: ChoreSeriesFields) => {
    try {
      // POST /api/chores handles memberIds of any length itself (0 = family,
      // 1 = a plain single-assignee chore, 2+ = a new linked group) -- see
      // routes/chores.ts's POST handler.
      await api.post("/api/chores", toBody(fields));
      await refreshSeries();
      // Also refresh the occurrence-based panels (Waiting, This week, My
      // chores): adding/editing/deleting a chore changes them too, and
      // without this a deleted chore lingered in Waiting for approval until
      // the next live-refresh tick.
      await onChanged?.();
    } catch (err: any) { setSeriesError(err.message); }
  }, [refreshSeries, onChanged]);

  const editSeries = useCallback(async (chore: Chore, fields: ChoreSeriesFields) => {
    try {
      if (fields.memberIds.length === 0) {
        // Whole family: the single-chore route, same as before this
        // feature. Only reachable for a chore ChoreFields didn't treat as an
        // existing multi-member group (see its allowFamily prop) -- so this
        // never has to reconcile other members' copies.
        const { memberIds: _memberIds, ...body } = toBody(fields);
        // "" not undefined: JSON.stringify drops an undefined key, and PUT
        // "/:id" treats a missing memberId as "keep the current assignee" --
        // so switching a kid's chore to Whole family silently did nothing.
        // buildChore turns "" into no memberId.
        await api.put(`/api/chores/${chore.seriesId}`, { ...body, memberId: "" });
      } else {
        // 1+ members: the group route, keyed by the chore's groupId, or (for
        // a chore that was never grouped) its own id -- same "own id is the
        // group key" rule routes/chores.ts's group routes use. Handles
        // adding/removing members and growing an ungrouped chore into a real
        // group by itself.
        const groupKey = chore.groupId || chore.seriesId;
        await api.put(`/api/chores/group/${groupKey}`, toBody(fields));
      }
      await refreshSeries();
      // Also refresh the occurrence-based panels (Waiting, This week, My
      // chores): adding/editing/deleting a chore changes them too, and
      // without this a deleted chore lingered in Waiting for approval until
      // the next live-refresh tick.
      await onChanged?.();
    } catch (err: any) { setSeriesError(err.message); }
  }, [refreshSeries, onChanged]);

  const deleteSeries = useCallback(async (chore: Chore) => {
    try {
      // A grouped chore deletes every member's copy together; an ungrouped
      // one is just itself, same as before this feature.
      if (chore.groupId) {
        await api.del(`/api/chores/group/${chore.groupId}`);
      } else {
        await api.del(`/api/chores/${chore.seriesId}`);
      }
      await refreshSeries();
      // Also refresh the occurrence-based panels (Waiting, This week, My
      // chores): adding/editing/deleting a chore changes them too, and
      // without this a deleted chore lingered in Waiting for approval until
      // the next live-refresh tick.
      await onChanged?.();
    } catch (err: any) { setSeriesError(err.message); }
  }, [refreshSeries, onChanged]);

  const approve = useCallback(async (chore: Chore) => {
    try {
      await api.post(`/api/chores/${chore.id}/approve`);
      await onChanged?.();
    } catch (err: any) { setSeriesError(err.message); }
  }, [onChanged]);

  const reject = useCallback(async (chore: Chore) => {
    try {
      await api.post(`/api/chores/${chore.id}/reject`);
      await onChanged?.();
    } catch (err: any) { setSeriesError(err.message); }
  }, [onChanged]);

  // Sequential, not Promise.all: these hit the same rows' scoped-item storage
  // (db.ts), and the rest of the app's writes go one at a time too (see
  // useChores.ts's own mutators) rather than risk a lost update from two
  // concurrent read-modify-writes.
  const approveAll = useCallback(async (chores: Chore[]) => {
    try {
      for (const chore of chores) {
        await api.post(`/api/chores/${chore.id}/approve`);
      }
      await onChanged?.();
    } catch (err: any) { setSeriesError(err.message); }
  }, [onChanged]);

  const [adjustments, setAdjustments] = useState<PointAdjustment[]>([]);
  const [adjustmentsError, setAdjustmentsError] = useState("");
  const [adjustmentsLoading, setAdjustmentsLoading] = useState(true);

  const refreshAdjustments = useCallback(async () => {
    try {
      const res = await api.get<{ adjustments: PointAdjustment[] }>("/api/rewards/adjustments");
      setAdjustments(res.adjustments);
      setAdjustmentsError("");
    } catch (err: any) {
      setAdjustmentsError(err.message);
    } finally {
      setAdjustmentsLoading(false);
    }
  }, []);

  useEffect(() => { refreshAdjustments(); }, [refreshAdjustments]);
  useLiveRefresh(() => { refreshAdjustments(); }, KIOSK ? 30_000 : 60_000);

  const adjust = useCallback(async (memberId: string, amount: number, note: string) => {
    try {
      await api.post("/api/rewards/adjustments", { memberId, amount, note });
      await refreshAdjustments();
      await onChanged?.();
    } catch (err: any) { setAdjustmentsError(err.message); }
  }, [refreshAdjustments, onChanged]);

  return {
    series, seriesError, seriesLoading, refreshSeries, addSeries, editSeries, deleteSeries,
    approve, reject, approveAll,
    adjustments, adjustmentsError, adjustmentsLoading, refreshAdjustments, adjust,
  };
}

export interface WaitingApprovalCountApi {
  count: number;
  refresh: () => Promise<void>;
}

/** Panel 1's waiting count, mirrored onto Chores.tsx's Parent sub-tab as a
 * badge. Deliberately its own tiny fetch rather than threading ParentView's
 * state up through Chores.tsx: the badge needs to be visible while the Kid
 * tab is showing (i.e. while ParentView isn't mounted at all), and Chores.tsx
 * only renders one of KidView/ParentView at a time. A second cheap GET
 * /api/chores here (same live-refresh cadence as every other hook in this
 * app) is simpler than lifting state out of ParentView or adding a context
 * just for one badge.
 *
 * `refresh` is returned (not just called internally) so Chores.tsx can hand
 * it down to ParentView as `onWaitingChanged` -- an action that moves the
 * waiting count (approve/reject/approveAll, or a tick in "My chores") calls
 * it directly, rather than the badge waiting on the next focus/visibility
 * event or the 30-60s poll. Coordinator review, Phase 3 follow-up: a stale
 * badge next to a "Nothing waiting" panel read as a bug. */
export function useWaitingApprovalCount(): WaitingApprovalCountApi {
  const [count, setCount] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const today = todayISO();
      const from = addDaysISO(today, -14);
      const to = addDaysISO(startOfWeek(today), 6);
      const res = await api.get<{ chores: Chore[] }>(
        `/api/chores?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`
      );
      setCount(res.chores.filter((c) => c.approval === "waiting").length);
    } catch {
      // A badge is a nice-to-have -- ParentView's own useChores() call
      // surfaces the real error banner if the user actually opens Parent.
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  useLiveRefresh(() => { refresh(); }, KIOSK ? 30_000 : 60_000);

  return { count, refresh };
}
