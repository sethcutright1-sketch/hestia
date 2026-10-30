// The Manage half of the Chores tab (Phase 3, PLAN.md; renamed from "Parent"
// and gated behind the household PIN in the 64de4b1 pass): the approval
// queue plus all four management tools -- manage chores, manage rewards, a
// weekly overview, and point adjustments. A parent ticking their own chore
// no longer happens here -- that's the name button on the main Chores screen
// now (KidView.tsx's `isParent` mode) -- so this view is management only,
// same PIN as Budget (auth.ts's requireUnlocked, routes/chores.ts's
// passesUnlockCheck).
//
// Five cards, stacked top to bottom (the plan's fixed panel order):
//   0. Waiting for approval -- every kid's `waiting` occurrences
//   1. This week -- a kid x day grid with week navigation
//   2. Chores -- add/edit/delete the chore catalog (series, not occurrences)
//   3. Rewards -- the reward catalog, balances, redemption history
//   4. Adjust points -- a manual +/- with a note
//
// Data comes from three independent range-scoped fetches plus the shared
// rewards hook, not one big fetch: Panel 0 fits inside "the last 14 days
// through the end of this week" via its own useChores() call; Panel 1
// navigates its own week and needs its own. See useChoreAdmin.ts's header
// comment for why approve/reject/adjust refresh those via an explicit
// `onChanged` callback instead of a shared store.

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Trash2 } from "lucide-react";
import type { Chore, HouseholdMember, PointAdjustment, Redemption, Reward } from "../../api.ts";
import { useMembers } from "../members/useMembers.ts";
import { useChores } from "../calendar/useChores.ts";
import { useRewards } from "../calendar/useRewards.ts";
import { resolveMemberColor, FAMILY_COLOR, type MemberColor } from "../calendar/palette.ts";
import { useChoreAdmin, type ChoreSeriesFields } from "./useChoreAdmin.ts";
import ChoreFields, { type ChoreFieldsValues } from "./ChoreFields.tsx";
import { addDaysISO, formatRepeatSummary, isParentMember, occurrenceMark, startOfWeek, todayISO } from "./parentHelpers.ts";

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function formatShortDate(date: string): string {
  const d = new Date(date + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

interface Props {
  // Chores.tsx's own waiting-count badge (useChoreAdmin.ts's
  // useWaitingApprovalCount) -- called after anything here that can move the
  // waiting count, so the badge updates immediately instead of on the next
  // poll. See useWaitingApprovalCount's own comment for why it's a separate
  // fetch rather than this component's state being lifted up.
  onWaitingChanged?: () => void | Promise<void>;
  // Called when a mutation here comes back 423 (the household PIN lock --
  // auth.ts's requireUnlocked -- expired or was locked from elsewhere mid-
  // session). Chores.tsx uses this to drop back to the kid view and refresh
  // the shared lock status, rather than leaving this panel sitting there
  // with a bare "locked" error and every button still visible but broken.
  onLocked?: () => void;
}

export default function ParentView({ onWaitingChanged, onLocked }: Props) {
  const { members, error: membersError } = useMembers();
  const kids = useMemo(() => members.filter((m) => !isParentMember(m)), [members]);

  const today = todayISO();
  const thisWeekEnd = addDaysISO(startOfWeek(today), 6);
  // Phase 3 plan: "look back roughly the last 14 days" so the approval queue
  // catches something a kid checked off a while ago and nobody's opened
  // Parent since.
  const wideFrom = addDaysISO(today, -14);

  const {
    chores: wideChores, error: wideChoresError, loading: wideChoresLoading,
    refresh: refreshWideChores,
  } = useChores({ from: wideFrom, to: thisWeekEnd });

  const {
    rewards, balances, redemptions, error: rewardsError, loading: rewardsLoading,
    addReward, removeReward, refresh: refreshRewards,
  } = useRewards();

  const [gridWeekStart, setGridWeekStart] = useState(() => startOfWeek(today));
  const gridWeekEnd = addDaysISO(gridWeekStart, 6);
  const { chores: gridChores, error: gridChoresError, loading: gridChoresLoading, refresh: refreshGridChores } =
    useChores({ from: gridWeekStart, to: gridWeekEnd });

  // Approving/rejecting/adjusting moves a balance or a chore's status that
  // the three hooks above own -- see useChoreAdmin.ts's header comment for
  // why this callback, rather than a shared store, is what keeps them in
  // sync immediately instead of waiting on the next live-refresh tick. Also
  // refreshes Chores.tsx's waiting-count badge for the same reason -- approve/
  // reject/approveAll all move that count.
  const onChanged = useCallback(async () => {
    await Promise.all([refreshWideChores(), refreshRewards(), refreshGridChores(), onWaitingChanged?.()]);
  }, [refreshWideChores, refreshRewards, refreshGridChores, onWaitingChanged]);

  const choreAdmin = useChoreAdmin(onChanged);

  const error =
    membersError || wideChoresError || rewardsError || gridChoresError ||
    choreAdmin.seriesError || choreAdmin.adjustmentsError;

  // requireUnlocked's 423 body is always exactly `{ error: "locked" }`
  // (auth.ts) -- every hook above stores a caught error's `.message` as-is
  // (see e.g. useChores.ts's refresh), so this is the one string that means
  // "the PIN lock caught this action," as opposed to a real validation error
  // or a network hiccup.
  useEffect(() => {
    if (error === "locked") onLocked?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [error]);

  return (
    <div className="space-y-4">
      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      <WaitingPanel
        kids={kids}
        chores={wideChores}
        loading={wideChoresLoading}
        approve={choreAdmin.approve}
        reject={choreAdmin.reject}
        approveAll={choreAdmin.approveAll}
      />

      <WeekGridPanel
        kids={kids}
        chores={gridChores}
        loading={gridChoresLoading}
        today={today}
        weekStart={gridWeekStart}
        setWeekStart={setGridWeekStart}
      />

      <SeriesPanel
        series={choreAdmin.series}
        loading={choreAdmin.seriesLoading}
        members={members}
        addSeries={choreAdmin.addSeries}
        editSeries={choreAdmin.editSeries}
        deleteSeries={choreAdmin.deleteSeries}
      />

      <RewardsPanel
        rewards={rewards}
        balances={balances}
        redemptions={redemptions}
        members={members}
        kids={kids}
        loading={rewardsLoading}
        addReward={addReward}
        removeReward={removeReward}
      />

      <AdjustPanel
        kids={kids}
        adjustments={choreAdmin.adjustments}
        loading={choreAdmin.adjustmentsLoading}
        adjust={choreAdmin.adjust}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panel 0: Waiting for approval

function WaitingPanel({
  kids, chores, loading, approve, reject, approveAll,
}: {
  kids: HouseholdMember[];
  chores: Chore[];
  loading: boolean;
  approve: (chore: Chore) => Promise<void>;
  reject: (chore: Chore) => Promise<void>;
  approveAll: (chores: Chore[]) => Promise<void>;
}) {
  const waiting = useMemo(() => chores.filter((c) => c.approval === "waiting"), [chores]);

  const groups = useMemo(() => {
    const kidGroups = kids
      .map((kid) => ({ key: kid.id, label: kid.name, color: resolveMemberColor(kid), items: waiting.filter((c) => c.memberId === kid.id) }))
      .filter((g) => g.items.length > 0);
    const familyItems = waiting.filter((c) => !c.memberId);
    const familyGroup = familyItems.length > 0 ? [{ key: "family", label: "Family", color: FAMILY_COLOR, items: familyItems }] : [];
    return [...kidGroups, ...familyGroup];
  }, [kids, waiting]);

  return (
    <section className="rounded-lg border border-slate-200 dark:border-slate-800 p-3">
      <h3 className="text-sm font-semibold mb-2 text-slate-600 dark:text-slate-300">Waiting for approval</h3>

      {loading ? (
        <p className="text-sm text-slate-400 dark:text-slate-500">Loading…</p>
      ) : groups.length === 0 ? (
        <p className="text-sm text-slate-400 dark:text-slate-500">Nothing waiting</p>
      ) : (
        <div className="space-y-3">
          {groups.map((group) => (
            <div key={group.key}>
              <div className="flex items-center justify-between mb-1">
                <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${group.color.bg} ${group.color.text}`}>
                  {group.label}
                </span>
                {group.items.length > 1 && (
                  <button
                    onClick={() => approveAll(group.items)}
                    className="text-xs px-2 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white"
                  >
                    Approve all
                  </button>
                )}
              </div>
              <ul className="space-y-1">
                {group.items.map((chore) => (
                  <li key={chore.id} className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-amber-50 dark:bg-amber-950/30 text-sm">
                    <span className="truncate flex-1 min-w-0">{chore.title}</span>
                    <span className="shrink-0 text-xs text-slate-500 dark:text-slate-400">
                      {formatShortDate(chore.date)} · +{chore.points ?? 1}
                    </span>
                    <button
                      onClick={() => approve(chore)}
                      className="shrink-0 px-2 py-1 rounded-lg text-xs bg-emerald-600 hover:bg-emerald-700 text-white"
                    >
                      Approve
                    </button>
                    <button
                      onClick={() => reject(chore)}
                      className="shrink-0 px-2 py-1 rounded-lg text-xs bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-200"
                    >
                      Not done
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Panel 1: This week (grid)

function WeekGridPanel({
  kids, chores, loading, today, weekStart, setWeekStart,
}: {
  kids: HouseholdMember[];
  chores: Chore[];
  loading: boolean;
  today: string;
  weekStart: string;
  setWeekStart: (date: string) => void;
}) {
  const weekEnd = addDaysISO(weekStart, 6);
  const days = Array.from({ length: 7 }, (_, i) => addDaysISO(weekStart, i));

  return (
    <section className="rounded-lg border border-slate-200 dark:border-slate-800 p-3">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-slate-600 dark:text-slate-300">This week</h3>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setWeekStart(addDaysISO(weekStart, -7))}
            className="p-1 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800"
            aria-label="Previous week"
          >
            <ChevronLeft size={16} />
          </button>
          <button
            onClick={() => setWeekStart(startOfWeek(today))}
            className="px-2 py-1 rounded-lg text-xs bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700"
          >
            Today
          </button>
          <button
            onClick={() => setWeekStart(addDaysISO(weekStart, 7))}
            className="p-1 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800"
            aria-label="Next week"
          >
            <ChevronRight size={16} />
          </button>
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-slate-400 dark:text-slate-500">Loading…</p>
      ) : kids.length === 0 ? (
        <p className="text-sm text-slate-400 dark:text-slate-500">No kids yet -- add household members on the Family tab.</p>
      ) : (
        <>
          {/* Scrolls inside its own box at 375px -- never the page (see
              document.documentElement.scrollWidth check in the plan). */}
          <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr>
                  <th className="sticky left-0 bg-white dark:bg-slate-900 text-left px-2 py-1.5 font-medium text-slate-500 dark:text-slate-400 min-w-[5rem]">
                    Kid
                  </th>
                  {days.map((day) => (
                    <th
                      key={day}
                      className={`px-2 py-1.5 font-medium min-w-[2.75rem] ${
                        day === today ? "text-blue-600 dark:text-blue-400" : "text-slate-500 dark:text-slate-400"
                      }`}
                    >
                      {WEEKDAY_LABELS[new Date(day + "T00:00:00").getDay()]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {kids.map((kid) => {
                  const color = resolveMemberColor(kid);
                  return (
                    <tr key={kid.id} className="border-t border-slate-100 dark:border-slate-800">
                      <td className={`sticky left-0 bg-white dark:bg-slate-900 px-2 py-1.5 font-medium ${color.text} truncate max-w-[6rem]`}>
                        {kid.name}
                      </td>
                      {days.map((day) => {
                        const occurrences = chores.filter((c) => c.memberId === kid.id && c.date === day);
                        return (
                          <td key={day} className="px-2 py-1.5 text-center align-middle">
                            {occurrences.length === 0 ? (
                              <span className="text-slate-300 dark:text-slate-700">·</span>
                            ) : (
                              <span className="inline-flex gap-0.5">
                                {occurrences.map((occ) => (
                                  <span key={occ.id} title={occ.title}>
                                    {occurrenceMark(occ, today)}
                                  </span>
                                ))}
                              </span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-1.5 text-[11px] text-slate-400 dark:text-slate-500">
            ✓ approved · ⏳ waiting · ✗ missed · ○ upcoming
          </p>
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Panel 2: Chores (series management)

// A group's key is its shared groupId, or (for a chore that's never been
// grouped) its own id -- same convention as the server's group routes (see
// routes/chores.ts's findGroupChores). Each entry in `chores` is one
// member's copy; `template` (the first, alphabetically-irrelevant -- just
// "a" representative row) supplies every shared field for display/edit.
interface ChoreGroup {
  key: string;
  template: Chore;
  chores: Chore[];
}

function groupSeries(series: Chore[]): ChoreGroup[] {
  const byKey = new Map<string, Chore[]>();
  for (const chore of series) {
    const key = chore.groupId || chore.id;
    const list = byKey.get(key);
    if (list) list.push(chore);
    else byKey.set(key, [chore]);
  }
  return [...byKey.entries()]
    .map(([key, chores]) => ({ key, template: chores[0], chores }))
    .sort((a, b) => a.template.title.localeCompare(b.template.title));
}

function SeriesPanel({
  series, loading, members, addSeries, editSeries, deleteSeries,
}: {
  series: Chore[];
  loading: boolean;
  members: HouseholdMember[];
  addSeries: (fields: ChoreSeriesFields) => Promise<void>;
  editSeries: (chore: Chore, fields: ChoreSeriesFields) => Promise<void>;
  deleteSeries: (chore: Chore) => Promise<void>;
}) {
  const [adding, setAdding] = useState(false);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [confirmingDeleteKey, setConfirmingDeleteKey] = useState<string | null>(null);

  const groups = useMemo(() => groupSeries(series), [series]);

  async function submitAdd(values: ChoreFieldsValues) {
    await addSeries(values);
    setAdding(false);
  }
  async function submitEdit(group: ChoreGroup, values: ChoreFieldsValues) {
    await editSeries(group.template, values);
    setEditingKey(null);
  }

  return (
    <section className="rounded-lg border border-slate-200 dark:border-slate-800 p-3">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-slate-600 dark:text-slate-300">Chores</h3>
        {!adding && (
          <button
            onClick={() => { setAdding(true); setEditingKey(null); }}
            className="px-2.5 py-1 rounded-lg text-xs bg-blue-600 hover:bg-blue-700 text-white"
          >
            Add chore
          </button>
        )}
      </div>

      {adding && (
        <div className="mb-3">
          <ChoreFields members={members} submitLabel="Add" onCancel={() => setAdding(false)} onSubmit={submitAdd} />
        </div>
      )}

      {loading ? (
        <p className="text-sm text-slate-400 dark:text-slate-500">Loading…</p>
      ) : groups.length === 0 ? (
        <p className="text-sm text-slate-400 dark:text-slate-500">No chores set up yet.</p>
      ) : (
        <ul className="space-y-1.5">
          {groups.map((group) => {
            const { template } = group;
            // Every member assigned to this chore, in the group's storage
            // order -- undefined memberId (a family chore) never happens
            // here since a group always has 1+ real assignees.
            const assignees = group.chores
              .map((c) => members.find((m) => m.id === c.memberId))
              .filter((m): m is HouseholdMember => !!m);
            const isFamily = !template.memberId;
            const hidePoints = assignees.length > 0 && assignees.every(isParentMember);
            const isEditing = editingKey === group.key;
            const isConfirmingDelete = confirmingDeleteKey === group.key;

            if (isEditing) {
              return (
                <li key={group.key}>
                  <ChoreFields
                    members={members}
                    submitLabel="Save"
                    // A real multi-member group can't be edited down to
                    // "Whole family" through this form -- see ChoreFields'
                    // allowFamily prop and useChoreAdmin.ts's editSeries.
                    allowFamily={group.chores.length <= 1}
                    initial={{
                      title: template.title, date: template.date,
                      memberIds: group.chores.map((c) => c.memberId).filter((id): id is string => !!id),
                      time: template.time, points: template.points, recurrence: template.recurrence,
                    }}
                    onCancel={() => setEditingKey(null)}
                    onSubmit={(values) => submitEdit(group, values)}
                  />
                </li>
              );
            }

            return (
              <li key={group.key} className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-slate-50 dark:bg-slate-800/60 text-sm">
                <span className="shrink-0 flex flex-wrap gap-1">
                  {isFamily ? (
                    <span className={`px-1.5 py-0.5 rounded text-[11px] ${FAMILY_COLOR.bg} ${FAMILY_COLOR.text}`}>
                      Family
                    </span>
                  ) : (
                    assignees.map((m) => {
                      const c = resolveMemberColor(m);
                      return (
                        <span key={m.id} className={`px-1.5 py-0.5 rounded text-[11px] ${c.bg} ${c.text}`}>
                          {m.name}
                        </span>
                      );
                    })
                  )}
                </span>
                <span className="truncate flex-1 min-w-0">{template.title}</span>
                {!hidePoints && (
                  <span className="shrink-0 text-xs text-slate-500 dark:text-slate-400">+{template.points ?? 1}</span>
                )}
                {template.time && <span className="shrink-0 text-xs text-slate-400 dark:text-slate-500">{template.time}</span>}
                <span className="shrink-0 text-xs text-slate-400 dark:text-slate-500">{formatRepeatSummary(template)}</span>
                {isConfirmingDelete ? (
                  <span className="shrink-0 flex items-center gap-1">
                    <span className="text-xs text-red-600 dark:text-red-400">Remove every occurrence?</span>
                    <button
                      onClick={() => { deleteSeries(template); setConfirmingDeleteKey(null); }}
                      className="px-2 py-1 rounded-lg text-xs bg-red-600 hover:bg-red-700 text-white"
                    >
                      Delete
                    </button>
                    <button
                      onClick={() => setConfirmingDeleteKey(null)}
                      className="px-2 py-1 rounded-lg text-xs bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-200"
                    >
                      Cancel
                    </button>
                  </span>
                ) : (
                  <span className="shrink-0 flex items-center gap-1">
                    <button
                      onClick={() => { setEditingKey(group.key); setAdding(false); }}
                      className="text-xs px-2 py-1 rounded-lg bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-200"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => setConfirmingDeleteKey(group.key)}
                      className="text-slate-400 hover:text-red-600 dark:hover:text-red-400"
                      aria-label={`Delete ${template.title}`}
                    >
                      <Trash2 size={14} />
                    </button>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Panel 3: Rewards

function RewardsPanel({
  rewards, balances, redemptions, members, kids, loading, addReward, removeReward,
}: {
  rewards: Reward[];
  balances: Record<string, { earned: number; adjusted: number; spent: number; balance: number }>;
  redemptions: Redemption[];
  members: HouseholdMember[];
  kids: HouseholdMember[];
  loading: boolean;
  addReward: (fields: { title: string; cost: number }) => Promise<void>;
  removeReward: (reward: Reward) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [cost, setCost] = useState(5);

  function nameFor(memberId: string): string {
    return members.find((m) => m.id === memberId)?.name || "Someone";
  }

  async function submitAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    await addReward({ title: title.trim(), cost });
    setTitle("");
    setCost(5);
  }

  return (
    <section className="rounded-lg border border-slate-200 dark:border-slate-800 p-3">
      <h3 className="text-sm font-semibold mb-2 text-slate-600 dark:text-slate-300">Rewards</h3>

      {loading ? (
        <p className="text-sm text-slate-400 dark:text-slate-500">Loading…</p>
      ) : (
        <>
          {rewards.length > 0 && (
            <ul className="space-y-1 mb-2">
              {rewards.map((reward) => (
                <li key={reward.id} className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-slate-50 dark:bg-slate-800/60 text-sm">
                  <span className="truncate flex-1 min-w-0">{reward.title}</span>
                  <span className="shrink-0 text-xs text-slate-500 dark:text-slate-400">{reward.cost} pts</span>
                  <button
                    onClick={() => removeReward(reward)}
                    className="shrink-0 text-slate-400 hover:text-red-600 dark:hover:text-red-400"
                    aria-label={`Remove reward ${reward.title}`}
                  >
                    <Trash2 size={13} />
                  </button>
                </li>
              ))}
            </ul>
          )}

          <form onSubmit={submitAdd} className="flex flex-wrap gap-1.5 mb-4">
            <input
              className="flex-1 min-w-[8rem] px-2 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm"
              placeholder="New reward…"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            <input
              type="number"
              min={1}
              max={1000}
              value={cost}
              onChange={(e) => setCost(Number(e.target.value))}
              aria-label="Cost in points"
              className="w-16 px-2 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm"
            />
            <button className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm">Add</button>
          </form>

          <h4 className="text-xs font-semibold mb-1 text-slate-500 dark:text-slate-400">Balances</h4>
          {kids.length === 0 ? (
            <p className="text-sm text-slate-400 dark:text-slate-500 mb-4">No kids yet.</p>
          ) : (
            <div className="overflow-x-auto mb-4">
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr className="text-left text-slate-500 dark:text-slate-400">
                    <th className="py-1 pr-2 font-medium">Kid</th>
                    <th className="py-1 px-2 font-medium text-right">Earned</th>
                    <th className="py-1 px-2 font-medium text-right">Adjusted</th>
                    <th className="py-1 px-2 font-medium text-right">Spent</th>
                    <th className="py-1 pl-2 font-medium text-right">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {kids.map((kid) => {
                    const b = balances[kid.id] || { earned: 0, adjusted: 0, spent: 0, balance: 0 };
                    const color = resolveMemberColor(kid);
                    return (
                      <tr key={kid.id} className="border-t border-slate-100 dark:border-slate-800">
                        <td className={`py-1 pr-2 font-medium ${color.text}`}>{kid.name}</td>
                        <td className="py-1 px-2 text-right">{b.earned}</td>
                        <td className="py-1 px-2 text-right">{b.adjusted > 0 ? `+${b.adjusted}` : b.adjusted}</td>
                        <td className="py-1 px-2 text-right">{b.spent}</td>
                        <td className="py-1 pl-2 text-right font-semibold">{b.balance}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <h4 className="text-xs font-semibold mb-1 text-slate-500 dark:text-slate-400">Redemption history</h4>
          {redemptions.length === 0 ? (
            <p className="text-sm text-slate-400 dark:text-slate-500">No redemptions yet.</p>
          ) : (
            <ul className="space-y-1 text-xs text-slate-500 dark:text-slate-400">
              {redemptions.slice(0, 20).map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-2">
                  <span className="truncate flex-1 min-w-0">
                    <span className="font-medium text-slate-700 dark:text-slate-300">{nameFor(r.memberId)}</span> · {r.rewardTitle}
                  </span>
                  <span className="shrink-0">-{r.cost} · {new Date(r.redeemedAt).toLocaleDateString()}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Panel 4: Adjust points

function AdjustPanel({
  kids, adjustments, loading, adjust,
}: {
  kids: HouseholdMember[];
  adjustments: PointAdjustment[];
  loading: boolean;
  adjust: (memberId: string, amount: number, note: string) => Promise<void>;
}) {
  const [memberId, setMemberId] = useState(kids[0]?.id || "");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");

  function nameFor(id: string): string {
    return kids.find((k) => k.id === id)?.name || "Someone";
  }

  const parsed = Number(amount);
  const valid = Number.isInteger(parsed) && parsed !== 0 && parsed >= -100 && parsed <= 100 && !!memberId;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid) return;
    await adjust(memberId, parsed, note);
    setAmount("");
    setNote("");
  }

  return (
    <section className="rounded-lg border border-slate-200 dark:border-slate-800 p-3">
      <h3 className="text-sm font-semibold mb-2 text-slate-600 dark:text-slate-300">Adjust points</h3>

      {kids.length === 0 ? (
        <p className="text-sm text-slate-400 dark:text-slate-500">No kids yet -- add household members on the Family tab.</p>
      ) : (
        <>
          <form onSubmit={submit} className="flex flex-wrap gap-1.5 mb-3">
            <select
              className="px-2 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm"
              value={memberId}
              onChange={(e) => setMemberId(e.target.value)}
              aria-label="Kid"
            >
              {kids.map((kid) => (
                <option key={kid.id} value={kid.id}>{kid.name}</option>
              ))}
            </select>
            <input
              type="number"
              min={-100}
              max={100}
              placeholder="± amount"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              aria-label="Amount (-100 to 100, non-zero)"
              className="w-24 px-2 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm"
            />
            <input
              className="flex-1 min-w-[8rem] px-2 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm"
              placeholder="Note (optional)…"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <button
              disabled={!valid}
              className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:bg-slate-200 disabled:dark:bg-slate-700 disabled:text-slate-400 text-white text-sm"
            >
              Apply
            </button>
          </form>

          <h4 className="text-xs font-semibold mb-1 text-slate-500 dark:text-slate-400">Recent adjustments</h4>
          {loading ? (
            <p className="text-sm text-slate-400 dark:text-slate-500">Loading…</p>
          ) : adjustments.length === 0 ? (
            <p className="text-sm text-slate-400 dark:text-slate-500">No adjustments yet.</p>
          ) : (
            <ul className="space-y-1 text-xs text-slate-500 dark:text-slate-400">
              {adjustments.slice(0, 20).map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-2">
                  <span className="truncate flex-1 min-w-0">
                    <span className="font-medium text-slate-700 dark:text-slate-300">{nameFor(a.memberId)}</span>
                    {a.note ? ` · ${a.note}` : ""}
                  </span>
                  <span className={`shrink-0 ${a.amount > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>
                    {a.amount > 0 ? `+${a.amount}` : a.amount} · {new Date(a.createdAt).toLocaleDateString()}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
