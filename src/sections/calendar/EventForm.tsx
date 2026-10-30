// Small inline form for adding a calendar event or chore -- not a modal,
// matching this app's existing preference for inline forms over dialogs (see
// Members.tsx, the old Calendar.tsx). Shared by FamilyGrid and PersonalView.
// Chore mode was added in Stage 10.3 (PLAN.md): it reuses the title/member/
// time/weekly-repeat fields and hides event-only fields (meal slot).

import { useState } from "react";
import { X } from "lucide-react";
import type { HouseholdMember, MealSlot, Weekday } from "../../api.ts";
import MemberMultiPicker from "../chores/MemberMultiPicker.tsx";

const WEEKDAY_OPTIONS: { code: Weekday; label: string }[] = [
  { code: "MO", label: "Mon" },
  { code: "TU", label: "Tue" },
  { code: "WE", label: "Wed" },
  { code: "TH", label: "Thu" },
  { code: "FR", label: "Fri" },
  { code: "SA", label: "Sat" },
  { code: "SU", label: "Sun" },
];

export interface EventFormValues {
  title: string;
  time?: string;
  audience: "family" | "individual";
  memberId?: string;
  mealSlot?: MealSlot;
}

export interface RecurringEventFormValues extends EventFormValues {
  days: Weekday[];
  until?: string;
}

export interface ChoreFormValues {
  title: string;
  time?: string;
  // Every id the chore is assigned to -- empty means "Whole family". See
  // useChores.ts's NewChoreFields.
  memberIds: string[];
  points?: number;
}

export interface RecurringChoreFormValues extends ChoreFormValues {
  days: Weekday[];
  until?: string;
}

interface Props {
  date: string;
  members: HouseholdMember[];
  // Pre-selects "one person" + this member -- set from a personal calendar
  // view, where adding an event almost always means "for me," not the family.
  defaultMemberId?: string;
  onCancel: () => void;
  onSubmit: (values: EventFormValues) => void;
  onSubmitRecurring: (values: RecurringEventFormValues) => void;
  onSubmitChore: (values: ChoreFormValues) => void;
  onSubmitRecurringChore: (values: RecurringChoreFormValues) => void;
}

export default function EventForm({
  date, members, defaultMemberId, onCancel, onSubmit, onSubmitRecurring, onSubmitChore, onSubmitRecurringChore,
}: Props) {
  const [kind, setKind] = useState<"event" | "chore">("event");
  const [title, setTitle] = useState("");
  const [time, setTime] = useState("");
  const [audience, setAudience] = useState<"family" | "individual">(defaultMemberId ? "individual" : "family");
  const [memberId, setMemberId] = useState(defaultMemberId || members[0]?.id || "");
  // Kept separate from the event's `memberId` so switching Event -> Chore
  // never carries over whichever member the event audience happened to be
  // set to; it defaults to "Whole family" in the Family view, or to the
  // active member in Personal view (Coordinator review, Phase 2 fix 2). A
  // list rather than a single id so a chore can be assigned to more than one
  // kid, each completing independently (see MemberMultiPicker.tsx).
  const [choreMemberIds, setChoreMemberIds] = useState<string[]>(defaultMemberId ? [defaultMemberId] : []);
  // Stage 10.4: how many points completing this chore is worth (1-10,
  // stored as absent/default when left at 1 -- see buildChore's comment in
  // routes/chores.ts).
  const [points, setPoints] = useState(1);
  const [mealSlot, setMealSlot] = useState<MealSlot | "">("");
  const [repeats, setRepeats] = useState(false);
  const [days, setDays] = useState<Weekday[]>([]);
  const [until, setUntil] = useState("");

  function toggleDay(code: Weekday) {
    setDays((prev) => (prev.includes(code) ? prev.filter((d) => d !== code) : [...prev, code]));
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    if (kind === "event" && audience === "individual" && !memberId) return;

    if (kind === "chore") {
      const choreValues: ChoreFormValues = {
        title: title.trim(),
        time: time || undefined,
        memberIds: choreMemberIds,
        points: points !== 1 ? points : undefined,
      };
      if (repeats && days.length > 0) {
        onSubmitRecurringChore({ ...choreValues, days, until: until || undefined });
      } else {
        onSubmitChore(choreValues);
      }
      return;
    }

    const values: EventFormValues = {
      title: title.trim(),
      time: time || undefined,
      audience,
      memberId: audience === "individual" ? memberId : undefined,
      mealSlot: mealSlot || undefined,
    };

    if (repeats && days.length > 0) {
      onSubmitRecurring({ ...values, days, until: until || undefined });
    } else {
      onSubmit(values);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 space-y-2 text-sm"
    >
      <div className="flex items-center justify-between">
        <span className="font-medium text-slate-500 dark:text-slate-400">
          New {kind === "chore" ? "chore" : "event"} · {date}
        </span>
        <button
          type="button"
          onClick={onCancel}
          className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
          aria-label="Cancel"
        >
          <X size={14} />
        </button>
      </div>

      <div className="flex rounded-lg border border-slate-300 dark:border-slate-700 overflow-hidden w-fit text-xs">
        <button
          type="button"
          onClick={() => setKind("event")}
          className={`px-2.5 py-1 ${kind === "event" ? "bg-blue-600 text-white" : "bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300"}`}
        >
          Event
        </button>
        <button
          type="button"
          onClick={() => setKind("chore")}
          className={`px-2.5 py-1 border-l border-slate-300 dark:border-slate-700 ${
            kind === "chore" ? "bg-blue-600 text-white" : "bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300"
          }`}
        >
          Chore
        </button>
      </div>

      <input
        className="w-full px-2 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
        placeholder={kind === "chore" ? "Chore title…" : "Event title…"}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        autoFocus
      />

      {kind === "chore" && (
        <MemberMultiPicker members={members} selectedIds={choreMemberIds} onChange={setChoreMemberIds} />
      )}

      <div className="flex flex-wrap gap-2">
        <input
          type="time"
          className="px-2 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
          value={time}
          onChange={(e) => setTime(e.target.value)}
          aria-label="Time (optional -- leave blank for all-day)"
        />
        {kind === "event" && (
          <select
            className="px-2 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
            value={audience}
            onChange={(e) => setAudience(e.target.value as "family" | "individual")}
          >
            <option value="family">Whole family</option>
            <option value="individual">One person</option>
          </select>
        )}
        {kind === "event" && audience === "individual" && (
          <select
            className="px-2 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
            value={memberId}
            onChange={(e) => setMemberId(e.target.value)}
          >
            {members.length === 0 && <option value="">No members added yet</option>}
            {members.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
        )}
        {kind === "event" && (
          <select
            className="px-2 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
            value={mealSlot}
            onChange={(e) => setMealSlot(e.target.value as MealSlot | "")}
          >
            <option value="">Not tied to a mealtime</option>
            <option value="breakfast">Breakfast</option>
            <option value="lunch">Lunch</option>
            <option value="dinner">Dinner</option>
          </select>
        )}
        {kind === "chore" && (
          <div className="flex items-center gap-1 px-2 py-1 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900">
            <label htmlFor="chore-points" className="text-xs text-slate-500 dark:text-slate-400 shrink-0">
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
              id="chore-points"
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

      <button className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm">Add</button>
    </form>
  );
}
