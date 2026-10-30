// One member's calendar: their own events plus family-wide events shown
// "inherited" (Stage 10.2, PLAN.md). Reuses FamilyGrid's grid via its
// `memberId` prop rather than a second rendering path -- the plan's data
// model is date-keyed, not member-column-native, so there's only one grid
// implementation, not two.
//
// Bolder-calendar pass (Stage 10.2 follow-up, PLAN.md): adds a theme banner
// above the grid, styled per the active member's palette.ts theme (soft /
// bold / gradient), and a "Customize" popover -- this app prefers inline
// popovers over modals -- for picking color and theme without leaving the
// tab. FamilyGrid derives the same theme itself from `members` + `memberId`
// rather than a separate prop, since it already receives both.
//
// `setColor`/`setTheme` come from Calendar.tsx's own `useMembers()` call
// rather than a second one here -- useMembers.ts's own comment is explicit
// that splitting the code talking to /api/members, even across two screens
// that both edit it, is exactly how this app's member state got flaky before.

import { useEffect, useState } from "react";
import { ArrowRight, Palette, Star } from "lucide-react";
import type { HouseholdMember } from "../../api.ts";
import { resolveMemberColor, resolveMemberTheme } from "./palette.ts";
import { ColorSwatches, ThemePicker } from "../members/ColorSwatches.tsx";
import FamilyGrid from "./FamilyGrid.tsx";
import { useChores } from "./useChores.ts";
import { useRewards } from "./useRewards.ts";

// Local, deliberately not shared with FamilyGrid.tsx's own copies -- same
// "each section owns its date math" precedent as routes/recurrence.ts's
// todayISO vs FamilyGrid's, noted in that file's own comment.
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

interface Props {
  members: HouseholdMember[];
  setColor: (member: HouseholdMember, color: string) => Promise<void>;
  setTheme: (member: HouseholdMember, theme: HouseholdMember["theme"]) => Promise<void>;
  // Threaded straight through to FamilyGrid below -- see its own comment.
  locked: boolean;
  onRequestUnlock: () => void;
}

export default function PersonalView({ members, setColor, setTheme, locked, onRequestUnlock }: Props) {
  const [activeId, setActiveId] = useState(members[0]?.id || "");
  const [customizeOpen, setCustomizeOpen] = useState(false);

  // Keeps the active tab valid as members are added/removed elsewhere (the
  // Family tab), since this screen only reads the roster, never edits it.
  useEffect(() => {
    if (!members.some((m) => m.id === activeId)) {
      setActiveId(members[0]?.id || "");
    }
  }, [members, activeId]);

  useEffect(() => { setCustomizeOpen(false); }, [activeId]);

  // Stage 10.4: the sticker strip counts THIS member's chores APPROVED in
  // the current week (Sun-Sat) -- a separate useChores call from FamilyGrid's
  // own (which the person can navigate away from the current week), so the
  // strip always reflects "this week" regardless of what week the grid below
  // happens to be showing. Only approval === "approved" counts, matching
  // pointsByMember on the server -- a done-but-waiting chore doesn't earn its
  // sticker yet (Phase 4 fix: this used to count status === "done", which
  // handed out a sticker before a parent had approved anything).
  const weekStart = startOfWeek(todayISO());
  const weekEnd = addDaysISO(weekStart, 6);
  const { chores: weekChores } = useChores({ from: weekStart, to: weekEnd });
  const stickerCount = weekChores.filter((c) => c.memberId === activeId && c.approval === "approved").length;

  // Balance lives in useRewards.ts, separate from useChores -- see
  // FamilyGrid's onChoreStatusChange comment for why ticking a chore there
  // has to explicitly call this refresh. The catalog/redeem/adjustments UI
  // that used to live here moved to the Chores tab (Phase 4, PLAN.md); this
  // view keeps only the balance badge those parts fed.
  const { balances, refresh: refreshRewards } = useRewards(activeId);
  const balance = balances[activeId]?.balance ?? 0;

  if (members.length === 0) {
    return (
      <p className="text-sm text-slate-400 dark:text-slate-500 py-8 text-center">
        Add a household member on the Family tab first.
      </p>
    );
  }

  const active = members.find((m) => m.id === activeId);
  const color = active ? resolveMemberColor(active) : undefined;
  const theme = active ? resolveMemberTheme(active) : "soft";

  const bannerClass =
    theme === "gradient" ? `bg-linear-to-r ${color?.gradient} text-white` :
    theme === "bold" ? color?.solid :
    `${color?.bg} ${color?.text}`;

  // Parents don't earn stars (Stage 6.5, PLAN.md) -- the balance badge and
  // sticker strip below are a kid's progress toward rewards, so a parent's
  // own personal view skips both entirely rather than showing a permanent 0.
  const isParent = active?.role === "parent";

  return (
    <div>
      <div className="flex flex-wrap gap-1.5 mb-3">
        {members.map((member) => {
          const c = resolveMemberColor(member);
          const isActive = member.id === activeId;
          return (
            <button
              key={member.id}
              onClick={() => setActiveId(member.id)}
              className={`px-2.5 py-1 rounded-lg text-sm flex items-center gap-1.5 border ${
                isActive
                  ? `${c.bg} ${c.text} ${c.border}`
                  : "border-transparent text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
              }`}
            >
              <span className={`w-2 h-2 rounded-full shrink-0 ${c.dot}`} />
              {member.name}
            </button>
          );
        })}
      </div>

      {active && (
        <div className="mb-3">
          <div className={`rounded-lg px-3 py-2.5 flex items-center justify-between ${bannerClass}`}>
            <div className="flex items-center gap-2 min-w-0">
              <span className="font-semibold truncate">{active.name}</span>
              {/* Points badge -- Stage 10.4, PLAN.md. Hidden for a parent:
                  parents don't earn stars, so there's no balance to show. */}
              {!isParent && (
                <span data-slot="points-badge" className="text-sm font-medium opacity-90 flex items-center gap-0.5 shrink-0">
                  <Star size={13} className="fill-current" /> {balance}
                </span>
              )}
            </div>
            <button
              onClick={() => setCustomizeOpen((open) => !open)}
              className={`flex items-center gap-1 px-2 py-1 rounded-lg text-xs shrink-0 ${
                theme === "soft" ? "hover:bg-black/5 dark:hover:bg-white/10" : "hover:bg-white/20"
              }`}
              aria-expanded={customizeOpen}
            >
              <Palette size={13} />
              Customize
            </button>
          </div>

          {customizeOpen && (
            <div className="mt-1.5 p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 space-y-2.5 max-w-full overflow-hidden">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] uppercase tracking-wide text-slate-400 dark:text-slate-500 w-14 shrink-0">Color</span>
                <ColorSwatches member={active} onChange={(c) => setColor(active, c)} />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] uppercase tracking-wide text-slate-400 dark:text-slate-500 w-14 shrink-0">Theme</span>
                <ThemePicker member={active} onChange={(t) => setTheme(active, t)} />
              </div>
            </div>
          )}

          {!isParent && (
            <>
              {/* Sticker chart: one star per chore this member had APPROVED
                  this week (Sun-Sat) -- a simple count, not a calendar grid,
                  since the week grid right below already shows which day
                  each one landed on. Wraps at phone width rather than
                  scrolling the page. */}
              <div className="mt-1.5 flex flex-wrap items-center gap-1 px-1" aria-label={`${stickerCount} chores approved this week`}>
                {stickerCount === 0 ? (
                  <span className="text-xs text-slate-400 dark:text-slate-500">No stickers yet this week</span>
                ) : (
                  Array.from({ length: stickerCount }, (_, i) => (
                    <Star key={i} size={16} className={`${color?.text || "text-amber-500"} fill-current`} />
                  ))
                )}
              </div>

              {/* Rewards (catalog, redeem, adjustments) moved to the Chores
                  tab's Parent section (Phase 4, PLAN.md) -- this is just a
                  pointer there, not a duplicate of that UI. */}
              <button
                onClick={() => { location.hash = "chores"; }}
                className="mt-1.5 ml-1 text-xs text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-0.5"
              >
                Rewards <ArrowRight size={11} /> Chores tab
              </button>
            </>
          )}
        </div>
      )}

      {activeId && (
        <FamilyGrid
          members={members}
          memberId={activeId}
          onChoreStatusChange={refreshRewards}
          locked={locked}
          onRequestUnlock={onRequestUnlock}
        />
      )}
    </div>
  );
}
