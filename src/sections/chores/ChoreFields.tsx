// A dedicated add/edit form for a chore series, used by Phase 3's
// ParentView.tsx "Chores" panel (PLAN.md).
//
// EventForm.tsx (src/sections/calendar/) already has a chore-mode field set,
// and the plan's preference was to extract a shared ChoreFields component
// from it. That turned out risky rather than a straightforward pull: its
// chore fields (member select, points stepper) are interleaved inside one
// flex row alongside event-only markup (the Event/Chore kind toggle, the
// audience "One person" branch, the meal-slot select) and share that row's
// conditional layout; EventForm also has no date field of its own; it takes
// `date` from whichever calendar day the user clicked, and always writes to
// the master `date`/anchor as a byproduct of that click. This form needs its
// own start-date input (a one-off's due date, or a series' anchor date) with
// no calendar day to inherit it from, plus points hidden by assignee role,
// which EventForm's stepper doesn't do. Reworking EventForm's layout to
// support both would touch a calendar screen this phase doesn't otherwise
// need to change, for a component that would end up threading almost as many
// conditional props as it saved lines. So this is a clean dedicated form
// instead (the plan's documented fallback) -- same field markup and Tailwind
// classes as EventForm's chore mode, kept in sync by hand the way
// routes/chores.ts's buildChore/validateChoreFields comment says server-side
// validation already is.

import { useState } from "react";
import type { HouseholdMember, RecurrenceRule, Weekday } from "../../api.ts";
import { isParentMember, todayISO } from "./parentHelpers.ts";
import MemberMultiPicker from "./MemberMultiPicker.tsx";

const WEEKDAY_OPTIONS: { code: Weekday; label: string }[] = [
  { code: "SU", label: "Sun" },
  { code: "MO", label: "Mon" },
  { code: "TU", label: "Tue" },
  { code: "WE", label: "Wed" },
  { code: "TH", label: "Thu" },
  { code: "FR", label: "Fri" },
  { code: "SA", label: "Sat" },
];

export interface ChoreFieldsValues {
  title: string;
  date: string;
  // Every id the chore is assigned to -- empty means "Whole family". A
  // single id behaves exactly like the old single-assignee `memberId` field;
  // 2+ ids create/edit a linked group (see routes/chores.ts's Chore.groupId).
  memberIds: string[];
  time?: string;
  points?: number;
  days?: Weekday[];
  until?: string;
}

export interface ChoreFieldsInitial {
  title?: string;
  date?: string;
  memberIds?: string[];
  time?: string;
  points?: number;
  recurrence?: RecurrenceRule;
}

interface Props {
  members: HouseholdMember[];
  initial?: ChoreFieldsInitial;
  submitLabel: string;
  // False hides "Whole family" -- passed by SeriesPanel while editing an
  // existing multi-member group, since collapsing a group to a family chore
  // isn't a supported edit through this form (see MemberMultiPicker.tsx).
  allowFamily?: boolean;
  onCancel: () => void;
  onSubmit: (values: ChoreFieldsValues) => void;
}

export default function ChoreFields({ members, initial, submitLabel, allowFamily = true, onCancel, onSubmit }: Props) {
  const [title, setTitle] = useState(initial?.title || "");
  const [date, setDate] = useState(initial?.date || todayISO());
  const [memberIds, setMemberIds] = useState<string[]>(initial?.memberIds || []);
  const [time, setTime] = useState(initial?.time || "");
  const [points, setPoints] = useState(initial?.points || 1);
  const [repeats, setRepeats] = useState(!!initial?.recurrence);
  const [days, setDays] = useState<Weekday[]>(initial?.recurrence?.byDay || []);
  const [until, setUntil] = useState(initial?.recurrence?.until || "");

  const selectedMembers = members.filter((m) => memberIds.includes(m.id));
  // Points are worth crediting whenever at least one selected assignee could
  // actually earn them -- a kid (unset role counts as kid), or nobody
  // selected at all (a family chore still earns into the family bucket, see
  // routes/chores.ts's FAMILY_POINTS_BUCKET). Only hidden when every
  // selected member is a parent.
  const showPoints = memberIds.length === 0 || selectedMembers.some((m) => !isParentMember(m));

  function toggleDay(code: Weekday) {
    setDays((prev) => (prev.includes(code) ? prev.filter((d) => d !== code) : [...prev, code]));
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || !date) return;
    if (repeats && days.length === 0) return;
    // "Whole family" is unavailable here (allowFamily=false), so an empty
    // selection means nothing was picked at all -- not a valid submission.
    if (!allowFamily && memberIds.length === 0) return;
    onSubmit({
      title: title.trim(),
      date,
      memberIds,
      time: time || undefined,
      points: showPoints ? (points !== 1 ? points : undefined) : undefined,
      days: repeats && days.length > 0 ? days : undefined,
      until: repeats ? until || undefined : undefined,
    });
  }

  return (
    <form
      onSubmit={submit}
      className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 space-y-2 text-sm"
    >
      <input
        className="w-full px-2 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
        placeholder="Chore title…"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        autoFocus
      />

      <MemberMultiPicker members={members} selectedIds={memberIds} onChange={setMemberIds} allowFamily={allowFamily} />

      <div className="flex flex-wrap gap-2">
        <input
          type="date"
          className="px-2 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          aria-label="Start date"
        />
        <input
          type="time"
          className="px-2 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
          value={time}
          onChange={(e) => setTime(e.target.value)}
          aria-label="Time (optional -- leave blank for all-day)"
        />
        {showPoints && (
          <div className="flex items-center gap-1 px-2 py-1 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900">
            <label htmlFor="chore-fields-points" className="text-xs text-slate-500 dark:text-slate-400 shrink-0">
              Points
            </label>
            <button
              type="button"
              onClick={() => setPoints((p) => Math.max(1, p - 1))}
              className="px-1.5 text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-100"
              aria-label="Fewer points"
            >
              −
            </button>
            <input
              id="chore-fields-points"
              type="number"
              min={1}
              max={10}
              value={points}
              onChange={(e) => {
                const n = Math.round(Number(e.target.value));
                if (Number.isFinite(n)) setPoints(Math.min(10, Math.max(1, n)));
              }}
              className="w-8 text-center bg-transparent"
            />
            <button
              type="button"
              onClick={() => setPoints((p) => Math.min(10, p + 1))}
              className="px-1.5 text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-100"
              aria-label="More points"
            >
              +
            </button>
          </div>
        )}
      </div>

      <label className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
        <input type="checkbox" checked={repeats} onChange={(e) => setRepeats(e.target.checked)} />
        Repeats weekly
      </label>

      {repeats && (
        <div className="flex flex-wrap items-center gap-2">
          {WEEKDAY_OPTIONS.map(({ code, label }) => (
            <button
              type="button"
              key={code}
              onClick={() => toggleDay(code)}
              className={`px-2 py-1 rounded-lg text-xs ${
                days.includes(code)
                  ? "bg-blue-600 text-white"
                  : "bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300"
              }`}
            >
              {label}
            </button>
          ))}
          <input
            type="date"
            className="px-2 py-1 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs"
            value={until}
            onChange={(e) => setUntil(e.target.value)}
            aria-label="Repeat until (optional)"
          />
        </div>
      )}

      <div className="flex gap-2">
        <button className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm">{submitLabel}</button>
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-1.5 rounded-lg bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-200 text-sm"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
