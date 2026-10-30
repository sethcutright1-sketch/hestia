// The main Chores screen's name-button views (PLAN.md Stage 10.4 / 6.5,
// revised for "parents on Chores too"): made for small hands -- big name
// buttons, big chore cards. One person (kid OR parent) is "active" at a time
// (remembered per device), same single-active-person shape as
// PersonalView.tsx's calendar tab, not a shared multi-person screen.
//
// A kid's chore ticked "done" doesn't earn its points yet -- it goes to
// "waiting" until a parent approves it (see routes/chores.ts's
// setChoreOccurrenceStatus/withOccurrenceStatus). This view reflects that
// directly: a waiting card can't be tapped into "approved" from here, only
// undone back to pending, and an approved card can't be undone at all --
// only a parent's "Not done" (ParentView, behind the PIN) can reopen it.
//
// A parent's own chore skips all of that: it's always approval "none"
// server-side (parents don't need approval, and ticking one no longer needs
// the PIN -- the owner's call), so a selected parent gets the plain `isParent`
// mode below -- no star balance, no rewards, no waiting/approved states,
// just tap-to-done and tap-again/Undo. See ChoreCard's own comment for how
// the two modes share one component.

import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, ChevronRight, Star } from "lucide-react";
import type { Chore, Reward } from "../../api.ts";
import { useMembers } from "../members/useMembers.ts";
import { useChores } from "../calendar/useChores.ts";
import { useRewards } from "../calendar/useRewards.ts";
import { resolveMemberColor } from "../calendar/palette.ts";
import { isParentMember } from "./parentHelpers.ts";
import { KIOSK } from "../../kiosk.ts";

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
const WEEKDAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
function formatDayLabel(date: string): string {
  const d = new Date(date + "T00:00:00");
  return WEEKDAY_LABELS[d.getDay()];
}

const SELECTED_PERSON_KEY = "household_chores_selected_kid";

// Key name is a holdover from when only kids had a button here -- left as-is
// rather than migrating everyone's remembered selection for a rename with no
// functional difference (it's just an id string either way).
function loadSelectedPerson(): string {
  try {
    return localStorage.getItem(SELECTED_PERSON_KEY) || "";
  } catch {
    return "";
  }
}
function saveSelectedPerson(id: string) {
  try {
    localStorage.setItem(SELECTED_PERSON_KEY, id);
  } catch {
    // Private browsing, storage disabled, etc. -- losing the remembered
    // person isn't worth surfacing an error over.
  }
}

interface Props {
  // Chores.tsx's waiting-approval badge refresh -- a kid's tick or undo moves
  // that count, and the badge sits on the Manage button right above this
  // view.
  onWaitingChanged?: () => void;
  // The "Manage 🔒" button (Chores.tsx) -- rendered in the same button row
  // as the name buttons, one flex row, rather than this component needing to
  // know anything about the PIN lock itself.
  trailingButton?: React.ReactNode;
}

export default function KidView({ onWaitingChanged, trailingButton }: Props) {
  const { members } = useMembers();
  // Kids first, then parents -- the owner's call: parents get a name button here
  // too now, right after the kids, rather than only reachable through the
  // PIN-gated Manage area.
  const kids = useMemo(() => members.filter((m) => !isParentMember(m)), [members]);
  const parents = useMemo(() => members.filter(isParentMember), [members]);
  const people = useMemo(() => [...kids, ...parents], [kids, parents]);

  const [selectedId, setSelectedId] = useState(loadSelectedPerson);

  // Keeps the selection valid as members are added/removed elsewhere (the
  // Family tab) or as roles change, and picks the first person once the
  // roster loads if nothing was remembered yet (a kid, per `people`'s order,
  // unless the household has none).
  useEffect(() => {
    if (people.length === 0) return;
    if (!people.some((p) => p.id === selectedId)) {
      setSelectedId(people[0].id);
    }
  }, [people, selectedId]);

  function selectPerson(id: string) {
    setSelectedId(id);
    saveSelectedPerson(id);
  }

  const activePerson = people.find((p) => p.id === selectedId);
  // A parent's own chore is always approval "none" server-side and needs no
  // PIN to tick (routes/chores.ts's PUT /:id status-only branch) -- this
  // just decides which flavor of the view below to render for the person
  // currently selected; it isn't a permission check.
  const isParentSelected = !!activePerson && isParentMember(activePerson);

  const today = todayISO();
  const weekEnd = addDaysISO(startOfWeek(today), 6);
  const { chores, error: choresError, loading: choresLoading, setChoreStatus } = useChores({ from: today, to: weekEnd });
  const {
    rewards, balances, error: rewardsError, loading: rewardsLoading, redeem, refresh: refreshRewards,
    // A parent's view has no rewards/balance, so there's nothing useful to
    // fetch per-parent -- pass undefined rather than a parent id so the
    // redemption-history query doesn't bother filtering by them either.
  } = useRewards(!isParentSelected && selectedId ? selectedId : undefined);
  const balance = selectedId ? balances[selectedId]?.balance ?? 0 : 0;
  // Until both the first chores fetch and the first rewards fetch settle, a
  // "nothing here" message would be lying -- it just hasn't loaded yet. A kid
  // on the kiosk (auto-refreshing, often glanced at mid-load) would otherwise
  // see "Nothing due today" and "No rewards yet" flash before the real list.
  // A parent's view never shows rewards, so it only waits on chores.
  const loading = isParentSelected ? choresLoading : choresLoading || rewardsLoading;

  // A kid's own chores plus family/unassigned ones -- another kid's (or a
  // parent's) chore never shows here. A parent's view is narrower: only
  // chores actually assigned to them, same as the old "My chores" Manage
  // panel this replaced -- a family chore still goes through the waiting/
  // approval flow (isParentAssignee(undefined, ...) is always false, see
  // routes/chores.ts), which the parent `isParent` mode below doesn't handle.
  const myChores = useMemo(() => {
    if (isParentSelected) return chores.filter((c) => c.memberId === selectedId);
    return chores.filter((c) => !c.memberId || c.memberId === selectedId);
  }, [chores, selectedId, isParentSelected]);
  const todayChores = useMemo(() => myChores.filter((c) => c.date === today), [myChores, today]);
  const restOfWeekChores = useMemo(() => myChores.filter((c) => c.date > today), [myChores, today]);
  const restByDay = useMemo(() => {
    const map = new Map<string, Chore[]>();
    for (const c of restOfWeekChores) {
      const list = map.get(c.date) || [];
      list.push(c);
      map.set(c.date, list);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [restOfWeekChores]);

  const [restExpanded, setRestExpanded] = useState(false);
  const [confirmingRewardId, setConfirmingRewardId] = useState<string | null>(null);

  async function markDone(chore: Chore) {
    await setChoreStatus(chore, "done");
    await refreshRewards();
    onWaitingChanged?.();
  }
  async function undo(chore: Chore) {
    await setChoreStatus(chore, "pending");
    await refreshRewards();
    onWaitingChanged?.();
  }
  async function confirmRedeem(reward: Reward) {
    setConfirmingRewardId(null);
    if (!selectedId) return;
    await redeem(reward, selectedId);
  }

  const error = choresError || rewardsError;

  const activeColor = activePerson ? resolveMemberColor(activePerson) : undefined;

  return (
    <div>
      {error && <p className="mb-3 text-sm text-red-600 dark:text-red-400">{error}</p>}

      {/* Big name buttons -- one per person, in their own color, kids first
          then parents, plus the Manage button (Chores.tsx) in the same row.
          The selected person gets a solid fill; everyone else gets a lighter
          tinted pill. */}
      <div className="flex flex-wrap gap-2 mb-4">
        {people.map((person) => {
          const c = resolveMemberColor(person);
          const isActive = person.id === selectedId;
          return (
            <button
              key={person.id}
              onClick={() => selectPerson(person.id)}
              className={`${KIOSK ? "py-4 px-6 text-xl" : "px-4 py-3 text-base"} rounded-xl font-semibold border-2 ${
                isActive ? `${c.solid} border-transparent` : `${c.bg} ${c.text} ${c.border}`
              }`}
            >
              {person.name}
            </button>
          );
        })}
        {trailingButton}
      </div>

      {people.length === 0 && (
        <p className="text-sm text-slate-400 dark:text-slate-500 py-8 text-center">
          No one yet -- add household members on the Family tab first.
        </p>
      )}

      {activePerson && (
        <>
          {/* Large star balance -- kids only; a parent's own chores don't earn stars. */}
          {!isParentSelected && (
            <div
              className={`mb-4 rounded-xl px-4 py-4 flex items-center justify-center gap-2 ${
                activeColor ? `${activeColor.bg} ${activeColor.text}` : ""
              }`}
            >
              <Star size={28} className="fill-current" />
              <span className="text-3xl font-bold">{balance}</span>
              <span className="text-sm opacity-80">stars</span>
            </div>
          )}

          {/* Today */}
          <h3 className="text-sm font-semibold mb-2 text-slate-600 dark:text-slate-300">Today</h3>
          {loading ? (
            <p className="mb-4 text-sm text-slate-400 dark:text-slate-500 py-6 text-center rounded-xl border border-dashed border-slate-300 dark:border-slate-700">
              Loading…
            </p>
          ) : todayChores.length === 0 ? (
            <p className="mb-4 text-sm text-slate-400 dark:text-slate-500 py-6 text-center rounded-xl border border-dashed border-slate-300 dark:border-slate-700">
              Nothing due today -- enjoy the day! 🎉
            </p>
          ) : (
            <div className="mb-4 space-y-2">
              {todayChores.map((chore) => (
                <ChoreCard
                  key={chore.id}
                  chore={chore}
                  isFamily={!chore.memberId}
                  isParent={isParentSelected}
                  onMarkDone={() => markDone(chore)}
                  onUndo={() => undo(chore)}
                  big
                />
              ))}
            </div>
          )}

          {/* Rest of this week -- collapsed by default */}
          <button
            onClick={() => setRestExpanded((v) => !v)}
            className="mb-2 flex items-center gap-1 text-sm font-semibold text-slate-600 dark:text-slate-300"
            aria-expanded={restExpanded}
          >
            {restExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            Rest of this week
            <span className="text-xs font-normal text-slate-400 dark:text-slate-500">
              ({restOfWeekChores.length})
            </span>
          </button>

          {restExpanded && (
            <div className="mb-4 space-y-3">
              {restByDay.length === 0 ? (
                <p className="text-sm text-slate-400 dark:text-slate-500">Nothing else scheduled this week.</p>
              ) : (
                restByDay.map(([date, dayChores]) => (
                  <div key={date}>
                    <div className="text-xs uppercase tracking-wide text-slate-400 dark:text-slate-500 mb-1">
                      {formatDayLabel(date)}
                    </div>
                    <div className="space-y-1.5">
                      {dayChores.map((chore) => (
                        <ChoreCard
                          key={chore.id}
                          chore={chore}
                          isFamily={!chore.memberId}
                          isParent={isParentSelected}
                          onMarkDone={() => markDone(chore)}
                          onUndo={() => undo(chore)}
                          big={false}
                        />
                      ))}
                    </div>
                  </div>
                ))
              )}
            </div>
          )}

          {/* Rewards you can get -- kids only; a parent's chores don't earn
              stars, so there's nothing to spend here. */}
          {!isParentSelected && (
            <>
              <h3 className="text-sm font-semibold mb-2 text-slate-600 dark:text-slate-300">Rewards you can get</h3>
              {loading ? (
                <p className="text-sm text-slate-400 dark:text-slate-500">Loading…</p>
              ) : rewards.length === 0 ? (
                <p className="text-sm text-slate-400 dark:text-slate-500">No rewards set up yet -- ask a parent.</p>
              ) : (
                <ul className="space-y-1.5">
                  {rewards.map((reward) => {
                    const affordable = balance >= reward.cost;
                    const confirming = confirmingRewardId === reward.id;
                    return (
                      <li
                        key={reward.id}
                        className="flex items-center justify-between gap-2 px-3 py-2.5 rounded-lg bg-slate-50 dark:bg-slate-800/60 text-sm"
                      >
                        <span className="truncate flex-1 min-w-0 font-medium">{reward.title}</span>
                        <span className="shrink-0 text-xs text-slate-500 dark:text-slate-400 flex items-center gap-0.5">
                          <Star size={12} className="fill-current" /> {reward.cost}
                        </span>
                        {confirming ? (
                          <span className="shrink-0 flex items-center gap-1">
                            <button
                              onClick={() => confirmRedeem(reward)}
                              className="px-2.5 py-1.5 rounded-lg text-xs bg-blue-600 hover:bg-blue-700 text-white"
                            >
                              Confirm
                            </button>
                            <button
                              onClick={() => setConfirmingRewardId(null)}
                              className="px-2.5 py-1.5 rounded-lg text-xs bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-200"
                            >
                              Cancel
                            </button>
                          </span>
                        ) : affordable ? (
                          <button
                            onClick={() => setConfirmingRewardId(reward.id)}
                            className="shrink-0 px-2.5 py-1.5 rounded-lg text-xs bg-blue-600 hover:bg-blue-700 text-white"
                          >
                            Redeem
                          </button>
                        ) : (
                          <span className="shrink-0 text-xs text-slate-400 dark:text-slate-500">
                            {reward.cost - balance} more ⭐ to go
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

function ChoreCard({
  chore, isFamily, isParent, onMarkDone, onUndo, big,
}: { chore: Chore; isFamily: boolean; isParent: boolean; onMarkDone: () => void; onUndo: () => void; big: boolean }) {
  const points = chore.points ?? 1;
  // Tall enough for small hands to tap reliably -- at least 64px under
  // ordinary use, bigger still on the kiosk where the screen is mounted at
  // arm's length rather than held.
  const heightClass = big ? (KIOSK ? "min-h-24" : "min-h-16") : KIOSK ? "min-h-16" : "min-h-12";
  const textClass = big ? (KIOSK ? "text-xl" : "text-lg") : "text-sm";

  // A parent's own chore never enters the approval workflow -- it's always
  // approval "none" server-side (routes/chores.ts's isParentAssignee), so
  // there's no "approved"/"waiting" state to render, ever. Tap toggles
  // done/not-done directly, with no stars (parents don't earn points) and no
  // "Family" tag (myChores above only ever hands this a parent's own chore).
  if (isParent) {
    if (chore.status === "done") {
      return (
        <div
          className={`${heightClass} ${textClass} flex items-center justify-between gap-2 px-4 rounded-xl border-2 border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-200 font-semibold`}
        >
          <span className="truncate flex-1 min-w-0 flex items-center gap-2">
            <Check size={big ? 20 : 16} className="shrink-0" />
            {chore.title}
          </span>
          <button
            onClick={onUndo}
            className={
              KIOSK
                ? "shrink-0 min-h-11 px-4 text-sm font-normal rounded-lg border border-emerald-300 dark:border-emerald-700 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-900/40"
                : "shrink-0 text-xs font-normal underline text-emerald-700 dark:text-emerald-300 hover:text-emerald-900 dark:hover:text-emerald-100"
            }
          >
            Undo
          </button>
        </div>
      );
    }

    return (
      <button
        onClick={onMarkDone}
        className={`${heightClass} ${textClass} w-full flex items-center gap-2 px-4 rounded-xl border-2 border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 text-left font-semibold`}
      >
        <span className="truncate flex-1 min-w-0">{chore.title}</span>
      </button>
    );
  }

  if (chore.approval === "approved") {
    return (
      <div
        className={`${heightClass} ${textClass} flex items-center justify-between gap-2 px-4 rounded-xl border-2 border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-200 font-semibold`}
      >
        <span className="truncate flex-1 min-w-0">
          {chore.title}
          {isFamily && <span className="ml-2 text-xs font-normal opacity-70">Family</span>}
        </span>
        <span className="shrink-0 flex items-center gap-1">
          ✓ +{points} <Star size={big ? 18 : 14} className="fill-current" />
        </span>
      </div>
    );
  }

  if (chore.status === "done" && chore.approval === "waiting") {
    return (
      <div
        className={`${heightClass} ${textClass} flex items-center justify-between gap-2 px-4 rounded-xl border-2 border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-200 font-semibold`}
      >
        <span className="truncate flex-1 min-w-0">
          {chore.title}
          {isFamily && <span className="ml-2 text-xs font-normal opacity-70">Family</span>}
        </span>
        <span className="shrink-0 flex items-center gap-2">
          <span className="text-sm font-normal">Waiting for a grown-up ⏳</span>
          <button
            onClick={onUndo}
            className={
              KIOSK
                ? "min-h-11 px-4 text-sm font-normal rounded-lg border border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/40"
                : "text-xs font-normal underline text-amber-700 dark:text-amber-300 hover:text-amber-900 dark:hover:text-amber-100"
            }
          >
            Undo
          </button>
        </span>
      </div>
    );
  }

  // Pending -- big tappable card.
  return (
    <button
      onClick={onMarkDone}
      className={`${heightClass} ${textClass} w-full flex items-center justify-between gap-2 px-4 rounded-xl border-2 border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 text-left font-semibold`}
    >
      <span className="truncate flex-1 min-w-0">
        {chore.title}
        {isFamily && <span className="ml-2 text-xs font-normal text-slate-400 dark:text-slate-500">Family</span>}
      </span>
      <span className="shrink-0 text-xs font-normal text-slate-400 dark:text-slate-500 flex items-center gap-1">
        +{points} <Star size={big ? 16 : 13} />
      </span>
    </button>
  );
}
