// The week grid: day columns x hour rows, with an all-day banner row above
// for anything with no specific time (Stage 10.1, PLAN.md -- the visual
// redesign of what used to be a bare chronological list). Family events only
// in this pass; PersonalView reuses this same grid for one member. Chores
// (Stage 10.3, PLAN.md) share the same cells as events -- events render
// first, then chores -- and are filtered by member the same way events are.
//
// Bolder-calendar pass (Stage 10.2 follow-up, PLAN.md): today's column gets
// a filled day-number chip and a light tint across every row, not just the
// header; weekend columns get a faint neutral tint; personal mode (memberId
// set) tints the whole grid body with that member's palette.tint instead.
// Pills got stronger fills and a colored left accent bar (palette.ts's
// `accent`) rather than a thin all-around border.

import { useEffect, useRef, useState } from "react";
import { Check, ChevronLeft, ChevronRight, Lock, Plus, X } from "lucide-react";
import type { CalendarEvent, Chore, HouseholdMember, MealSlot, Weekday } from "../../api.ts";
import { useCalendarEvents } from "./useCalendarEvents.ts";
import { useChores } from "./useChores.ts";
import { resolveMemberColor, resolveMemberTheme, FAMILY_COLOR, type MemberColor } from "./palette.ts";
import { KIOSK } from "../../kiosk.ts";
import EventForm, {
  type EventFormValues, type RecurringEventFormValues, type ChoreFormValues, type RecurringChoreFormValues,
} from "./EventForm.tsx";

const SLOT_LABEL: Record<MealSlot, string> = { breakfast: "B", lunch: "L", dinner: "D" };
const HOUR_START = 6; // 6am -- covers school/work/dinner without scrolling on a kiosk display
const HOUR_END = 21; // 9pm
const HOURS = Array.from({ length: HOUR_END - HOUR_START + 1 }, (_, i) => HOUR_START + i);
const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function todayISO(): string {
  return new Date().toLocaleDateString("en-CA");
}

function addDaysISO(date: string, days: number): string {
  const d = new Date(date + "T00:00:00");
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString("en-CA");
}

function startOfWeek(date: string): string {
  const d = new Date(date + "T00:00:00");
  return addDaysISO(date, -d.getDay());
}

function formatDayHeader(date: string): { weekday: string; day: number } {
  const d = new Date(date + "T00:00:00");
  return { weekday: WEEKDAY_LABELS[d.getDay()], day: d.getDate() };
}

function formatHour(hour: number): string {
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h}${hour < 12 ? "a" : "p"}`;
}

function formatWeekRange(from: string, to: string): string {
  const f = new Date(from + "T00:00:00");
  const t = new Date(to + "T00:00:00");
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  return `${f.toLocaleDateString(undefined, opts)} – ${t.toLocaleDateString(undefined, opts)}`;
}

interface Props {
  members: HouseholdMember[];
  // When set, shows one member's agenda instead of everyone's: their own
  // individual events plus family-wide events shown "inherited" (dashed
  // border), the same visual language MealPlan.tsx already uses for a family
  // meal showing up on a person's tab. Other members' individual events are
  // hidden entirely -- this isn't their calendar to see.
  memberId?: string;
  // Stage 10.4: fires after a chore's done/pending status is toggled here,
  // so a points balance shown elsewhere (PersonalView's banner/rewards
  // section) can refresh. FamilyGrid's useChores and PersonalView's
  // useRewards are two separate hooks with no shared store, so rather than
  // build one (a bigger change than this phase calls for) the grid just
  // tells its parent a completion happened and lets the parent decide what
  // to refresh -- the same "caller owns refresh" shape useLiveRefresh
  // already uses for polling.
  onChoreStatusChange?: () => void;
  // The household PIN lock (auth.ts / routes/lock.ts) -- creating a chore
  // here still needs it (routes/chores.ts's passesUnlockCheck), same as the
  // Chores tab's Manage area, though ticking one off (even a parent's) no
  // longer does. `locked` just decides whether a 423 gets a "here's why, tap
  // to unlock" banner instead of the generic error text; `onRequestUnlock`
  // opens the same PIN prompt Budget and Chores.tsx already use -- there's
  // only one lock, so there's only one prompt.
  locked: boolean;
  onRequestUnlock: () => void;
}

export default function FamilyGrid({ members, memberId, onChoreStatusChange, locked, onRequestUnlock }: Props) {
  const [weekStart, setWeekStart] = useState(() => startOfWeek(todayISO()));
  const weekEnd = addDaysISO(weekStart, 6);
  const days = Array.from({ length: 7 }, (_, i) => addDaysISO(weekStart, i));

  // Personal mode: the active member's own theme decides both the grid's
  // background tint and whether their own events render with a bold solid
  // fill instead of the usual tinted-border pill (Stage 10.2 follow-up,
  // PLAN.md).
  const activeMember = memberId ? members.find((m) => m.id === memberId) : undefined;
  const activeColor = activeMember ? resolveMemberColor(activeMember) : undefined;
  const activeTheme = activeMember ? resolveMemberTheme(activeMember) : undefined;
  const bold = activeTheme === "bold";

  const { events: allEvents, error: eventsError, addEvent, addRecurringEvent, removeEvent } = useCalendarEvents({ from: weekStart, to: weekEnd });
  const { chores: allChores, error: choresError, addChore, addRecurringChore, setChoreStatus, removeChore } = useChores({ from: weekStart, to: weekEnd });
  const events = memberId ? allEvents.filter((e) => !e.memberId || e.memberId === memberId) : allEvents;
  const chores = memberId ? allChores.filter((c) => !c.memberId || c.memberId === memberId) : allChores;
  const error = eventsError || choresError;
  const [formDate, setFormDate] = useState<string | null>(null);
  // The form renders below the whole grid (~16 hour rows), so opening it
  // from a day header's "+" would otherwise look like nothing happened --
  // scroll it into view and focus its title field (Coordinator review,
  // Phase 2 fix 1). autoFocus on the input alone isn't enough: it can fire
  // before the scroll lands, or not at all on a re-used, already-mounted
  // form when formDate just changes to a different day.
  const formWrapperRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!formDate) return;
    const wrapper = formWrapperRef.current;
    if (!wrapper) return;
    wrapper.scrollIntoView({ behavior: "smooth", block: "nearest" });
    wrapper.querySelector<HTMLInputElement>("input")?.focus();
  }, [formDate]);

  function colorFor(item: Pick<CalendarEvent | Chore, "memberId">): MemberColor {
    const member = item.memberId ? members.find((m) => m.id === item.memberId) : undefined;
    return member ? resolveMemberColor(member) : FAMILY_COLOR;
  }
  const isInherited = (item: Pick<CalendarEvent | Chore, "memberId">) => !!memberId && !item.memberId;

  // One background tint per day column, applied to its header and every
  // cell below it: personal mode's member tint wins (it's the point of that
  // view), then today, then a faint weekend wash -- an ordinary weekday in
  // family mode gets none of these.
  function columnTint(date: string): string {
    if (activeColor) return activeColor.tint;
    if (date === todayISO()) return "bg-blue-50 dark:bg-blue-950/30";
    const weekday = new Date(date + "T00:00:00").getDay();
    if (weekday === 0 || weekday === 6) return "bg-slate-50 dark:bg-slate-900/40";
    return "";
  }

  const allDayFor = (date: string) => events.filter((e) => e.date === date && !e.time);
  const timedFor = (date: string, hour: number) =>
    events.filter((e) => e.date === date && e.time && Number(e.time.slice(0, 2)) === hour);
  const allDayChoresFor = (date: string) => chores.filter((c) => c.date === date && !c.time);
  const timedChoresFor = (date: string, hour: number) =>
    chores.filter((c) => c.date === date && c.time && Number(c.time.slice(0, 2)) === hour);

  async function submit(values: EventFormValues) {
    if (!formDate) return;
    await addEvent({ ...values, date: formDate });
    setFormDate(null);
  }

  async function submitRecurring(values: RecurringEventFormValues) {
    if (!formDate) return;
    await addRecurringEvent({ ...values, date: formDate });
    setFormDate(null);
  }

  async function submitChore(values: ChoreFormValues) {
    if (!formDate) return;
    await addChore({ ...values, date: formDate });
    setFormDate(null);
  }

  async function submitRecurringChore(values: RecurringChoreFormValues) {
    if (!formDate) return;
    await addRecurringChore({ ...values, date: formDate });
    setFormDate(null);
  }

  async function toggleChore(chore: Chore) {
    await setChoreStatus(chore, chore.status === "done" ? "pending" : "done");
    onChoreStatusChange?.();
  }

  const headerPad = KIOSK ? "py-3" : "py-1.5";
  // Rows grow to fit their pills so a title is never cut off; text wraps instead
  // of truncating (EventPill / ChorePill).
  const rowMin = KIOSK ? "min-h-16" : "min-h-10";
  const pillText = KIOSK ? "text-sm" : "text-[11px]";
  // ONE grid for the header, the all-day row and every hour row (the row wrappers
  // below are `display: contents`), so the day columns are shared by all rows: a
  // column may be wider or narrower than its neighbours depending on its longest
  // title, but every box inside one column is exactly the same width, and the
  // lines match the header. Separate per-row grids can't do that.
  const gridCols = "60px repeat(7, minmax(5rem, auto))";
  const cellLine = "border-b border-slate-200 dark:border-slate-800";

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setWeekStart(addDaysISO(weekStart, -7))}
            className="p-1 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800"
            aria-label="Previous week"
          >
            <ChevronLeft size={16} />
          </button>
          <span className="text-sm font-medium min-w-[9rem] text-center">{formatWeekRange(weekStart, weekEnd)}</span>
          <button
            onClick={() => setWeekStart(addDaysISO(weekStart, 7))}
            className="p-1 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800"
            aria-label="Next week"
          >
            <ChevronRight size={16} />
          </button>
        </div>
        <button
          onClick={() => setWeekStart(startOfWeek(todayISO()))}
          className="px-2 py-1 rounded-lg text-xs bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700"
        >
          Today
        </button>
      </div>

      {/* requireUnlocked's 423 body is always exactly `{ error: "locked" }`
          (auth.ts), and useChores.ts's refresh/addChore/setChoreStatus store
          a caught error's `.message` verbatim -- so this is the one string
          that means "the PIN lock caught this," as opposed to a real
          validation error. Gets its own banner with an Unlock shortcut
          rather than reading as a bare, confusing "locked". */}
      {choresError === "locked" ? (
        <div className="mb-3 flex flex-wrap items-center gap-2 text-sm text-amber-800 dark:text-amber-200 bg-amber-50 dark:bg-amber-950/40 rounded-lg px-3 py-2">
          <Lock size={14} className="shrink-0" />
          <span>Enter the parent PIN to add a chore.</span>
          <button onClick={onRequestUnlock} className="font-semibold underline underline-offset-2">
            Unlock
          </button>
        </div>
      ) : (
        error && <p className="mb-3 text-sm text-red-600 dark:text-red-400">{error}</p>
      )}

      <div className="border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden overflow-x-auto">
        <div className="grid min-w-[640px]" style={{ gridTemplateColumns: gridCols }}>
          {/* Day header row */}
          <div className="contents">
            <div className={cellLine} />
            {days.map((date) => {
              const { weekday, day } = formatDayHeader(date);
              const isToday = date === todayISO();
              return (
                <div
                  key={date}
                  className={`${headerPad} ${cellLine} border-l border-slate-200 dark:border-slate-800 flex flex-col items-center gap-0.5 ${columnTint(date)}`}
                >
                  <span className="text-[10px] uppercase tracking-wide text-slate-400 dark:text-slate-500">{weekday}</span>
                  <div className="flex items-center gap-1">
                    <span
                      className={`text-sm font-medium flex items-center justify-center ${
                        isToday ? "w-5 h-5 rounded-full bg-blue-600 text-white dark:bg-blue-500" : ""
                      }`}
                    >
                      {day}
                    </span>
                    <button
                      onClick={() => setFormDate(date)}
                      className="text-slate-300 hover:text-blue-600 dark:text-slate-600 dark:hover:text-blue-400"
                      aria-label={`Add an event or chore on ${date}`}
                      title={locked ? "Adding a chore needs the parent PIN" : undefined}
                    >
                      <Plus size={13} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {/* All-day banner row */}
          <div className="contents">
            <div className={`${cellLine} ${rowMin} p-1 text-[10px] text-slate-400 dark:text-slate-500 flex items-start justify-end pr-1.5 pt-1.5`}>
              All day
            </div>
            {days.map((date) => (
              <div key={date} className={`${cellLine} ${rowMin} p-1 border-l border-slate-200 dark:border-slate-800 space-y-1 ${columnTint(date)}`}>
                {allDayFor(date).map((event) => (
                  <EventPill key={event.id} event={event} color={colorFor(event)} textSize={pillText} inherited={isInherited(event)} bold={bold && event.memberId === memberId} onRemove={() => removeEvent(event)} />
                ))}
                {allDayChoresFor(date).map((chore) => (
                  <ChorePill
                    key={chore.id}
                    chore={chore}
                    color={colorFor(chore)}
                    textSize={pillText}
                    inherited={isInherited(chore)}
                    bold={bold && chore.memberId === memberId}
                    onToggle={() => toggleChore(chore)}
                    onRemove={() => removeChore(chore)}
                  />
                ))}
              </div>
            ))}
          </div>

          {/* Hour rows */}
          {HOURS.map((hour) => {
            const line = hour === HOUR_END ? "" : cellLine; // no rule under the last row
            return (
            <div key={hour} className="contents">
              <div className={`${line} ${rowMin} p-1 text-[10px] text-slate-400 dark:text-slate-500 text-right pr-1.5 pt-0.5`}>{formatHour(hour)}</div>
              {days.map((date) => (
                <div key={date} className={`${line} ${rowMin} p-1 border-l border-slate-200 dark:border-slate-800 space-y-1 ${columnTint(date)}`}>
                  {timedFor(date, hour).map((event) => (
                    <EventPill key={event.id} event={event} color={colorFor(event)} textSize={pillText} inherited={isInherited(event)} bold={bold && event.memberId === memberId} onRemove={() => removeEvent(event)} />
                  ))}
                  {timedChoresFor(date, hour).map((chore) => (
                    <ChorePill
                      key={chore.id}
                      chore={chore}
                      color={colorFor(chore)}
                      textSize={pillText}
                      inherited={isInherited(chore)}
                      bold={bold && chore.memberId === memberId}
                      onToggle={() => toggleChore(chore)}
                      onRemove={() => removeChore(chore)}
                    />
                  ))}
                </div>
              ))}
            </div>
            );
          })}
        </div>
      </div>

      {formDate && (
        <div className="mt-3" ref={formWrapperRef}>
          <EventForm
            date={formDate}
            members={members}
            defaultMemberId={memberId}
            onCancel={() => setFormDate(null)}
            onSubmit={submit}
            onSubmitRecurring={submitRecurring}
            onSubmitChore={submitChore}
            onSubmitRecurringChore={submitRecurringChore}
          />
        </div>
      )}
    </div>
  );
}

function EventPill({
  event, color, textSize, inherited, bold, onRemove,
}: { event: CalendarEvent; color: MemberColor; textSize: string; inherited: boolean; bold: boolean; onRemove: () => void }) {
  // A 3px colored left accent bar on every pill, plus (in a member's "bold"
  // personal theme, for their own events only) a solid fill instead of the
  // usual tinted background -- the bolder-calendar pass, Stage 10.2 follow-up
  // (PLAN.md).
  const fill = bold ? color.solid : `${color.bg} ${color.border} ${color.text} border`;
  return (
    <div
      className={`group flex items-center gap-1 px-1.5 py-0.5 rounded border-l-[3px] ${color.accent} ${fill} ${textSize} leading-tight font-medium ${
        inherited ? "border-dashed" : ""
      }`}
    >
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${bold ? "bg-white/80" : color.dot}`} />
      <span className="flex-1 min-w-0 break-words">{event.title}</span>
      {event.time && <span className="shrink-0 opacity-70">{event.time}</span>}
      {event.mealSlot && <span className="shrink-0 opacity-70">{SLOT_LABEL[event.mealSlot]}</span>}
      <button
        onClick={onRemove}
        className={`shrink-0 hover:text-red-600 dark:hover:text-red-400 ${
          KIOSK ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100"
        }`}
        aria-label={`Remove ${event.title}`}
      >
        <X size={10} />
      </button>
    </div>
  );
}

// Member-colored like EventPill, but with a check button on the left instead
// of a dot (Stage 10.3, PLAN.md): tap to toggle this occurrence's status
// (useChores.setChoreStatus targets chore.id, not the series, so completing
// one occurrence of a recurring chore leaves the rest pending). Removing
// always deletes the whole series -- there's no per-occurrence delete -- so
// the button says so for a recurring chore.
function ChorePill({
  chore, color, textSize, inherited, bold, onToggle, onRemove,
}: { chore: Chore; color: MemberColor; textSize: string; inherited: boolean; bold: boolean; onToggle: () => void; onRemove: () => void }) {
  const done = chore.status === "done";
  // Stage 10.4 calendar tie-in: a done chore still waiting on a parent shows
  // an hourglass instead of the check, visually distinct from ✓ approved --
  // same ⏳ KidView already uses for this state. A parent's own chore is
  // always approval "none" while done (parents don't need approval), so it
  // still reads as a plain ✓, like an approved kid chore.
  const waiting = done && chore.approval === "waiting";
  const recurring = !!chore.recurrence;
  const fill = bold ? color.solid : `${color.bg} ${color.border} ${color.text} border`;
  const toggleLabel = waiting
    ? `Waiting for a parent to approve "${chore.title}"`
    : done
    ? `Mark "${chore.title}" not done`
    : `Mark "${chore.title}" done`;
  return (
    <div
      className={`group flex items-center gap-1 px-1.5 py-0.5 rounded border-l-[3px] ${color.accent} ${fill} ${textSize} leading-tight font-medium ${
        inherited ? "border-dashed" : ""
      } ${done ? "opacity-60" : ""}`}
    >
      <button
        onClick={onToggle}
        className={`shrink-0 flex items-center justify-center rounded-full border border-current ${KIOSK ? "w-5 h-5" : "w-3 h-3"}`}
        aria-label={toggleLabel}
        title={toggleLabel}
      >
        {waiting ? (
          <span aria-hidden="true" className={KIOSK ? "text-xs leading-none" : "text-[8px] leading-none"}>⏳</span>
        ) : (
          done && <Check size={KIOSK ? 14 : 9} strokeWidth={3} />
        )}
      </button>
      <span className={`flex-1 min-w-0 break-words ${done ? "line-through" : ""}`}>{chore.title}</span>
      {/* Stage 10.4: only shown above the default (1) so an ordinary chore's
          pill doesn't get busier -- see routes/chores.ts's buildChore comment
          for why `points` is absent rather than 1 in that common case. */}
      {chore.points != null && chore.points > 1 && (
        <span className="shrink-0 opacity-70" title={`${chore.points} points`}>+{chore.points}</span>
      )}
      {chore.time && <span className="shrink-0 opacity-70">{chore.time}</span>}
      <button
        onClick={onRemove}
        className={`shrink-0 hover:text-red-600 dark:hover:text-red-400 ${
          KIOSK ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100"
        }`}
        aria-label={recurring ? `Remove every week's ${chore.title}` : `Remove ${chore.title}`}
        title={recurring ? `Remove every week's ${chore.title}` : `Remove ${chore.title}`}
      >
        <X size={10} />
      </button>
    </div>
  );
}
