// The Chores tab (PLAN.md Stage 10.4 / 6.5, revised twice now): one screen
// for everyone, not a Kid/Parent sub-tab split. The old split hid Parent
// only on the kiosk (`?kiosk=1`) and had no real protection anywhere else --
// any signed-in member on a phone or computer could open it. That's replaced
// here with the SAME household PIN lock Budget already uses (auth.ts's
// requireUnlocked, routes/lock.ts, src/PinPrompt.tsx) -- but, per Alex's
// second call, the PIN only gates *managing* chores/rewards, not ticking one
// off: kids AND parents get a name button on the main screen (KidView.tsx's
// `isParent` mode for a selected parent), and a "Manage 🔒" button opens the
// PIN prompt for the add/edit/approve/rewards/points panels (ParentView.tsx,
// renamed from "Parent"). Every mutating route still enforces this
// server-side regardless of what this component shows (see
// routes/chores.ts's passesUnlockCheck and routes/rewards.ts). This
// component's own state is a UI convenience for which panel to show, exactly
// like Budget's `locked` prop -- the real gate is the server.
//
// `locked`/`lockStatus`/`onRequestUnlock`/`lockNow`/`refreshLockStatus` all
// come from App.tsx, which already owns this state for Budget -- reused
// as-is rather than duplicated (there is only ever one lock).
//
// The sub-hash (`#chores` / `#chores/parent`) still round-trips through
// back/forward -- same reasoning as before, just now meaning "which panel is
// showing" rather than "which sub-tab". The hash's own name ("parent") is a
// holdover from before the Manage rename -- not worth changing along with
// everything else since it's an internal routing detail, not user-facing
// text. Unlike before, it no longer implies access: landing on
// `#chores/parent` while locked still shows the PIN prompt first.

import { useEffect, useState } from "react";
import { Lock } from "lucide-react";
import type { LockStatus } from "../api.ts";
import KidView from "./chores/KidView.tsx";
import ParentView from "./chores/ParentView.tsx";
import { useWaitingApprovalCount } from "./chores/useChoreAdmin.ts";
import { KIOSK } from "../kiosk.ts";

function wantsManageFromHash(): boolean {
  return location.hash.replace(/^#/, "") === "chores/parent";
}

interface Props {
  locked: boolean;
  lockStatus: LockStatus | null;
  onRequestUnlock: () => void;
  lockNow: () => Promise<void>;
  refreshLockStatus: () => void;
}

export default function Chores({ locked, lockStatus, onRequestUnlock, lockNow, refreshLockStatus }: Props) {
  // "Wants the Manage panel", independent of whether the PIN has actually
  // been entered yet -- set the moment Manage is tapped, and left alone
  // while the PinPrompt (rendered by App.tsx, not here) is up. Combined with
  // `locked` below to decide what's actually on screen.
  const [wantsManage, setWantsManage] = useState(wantsManageFromHash);

  useEffect(() => {
    function onHashChange() {
      setWantsManage(wantsManageFromHash());
    }
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const pinSet = lockStatus?.pinSet ?? false;
  // No PIN configured yet -- Manage opens directly, same as `locked` itself
  // always being false in that case (see auth.ts's isUnlocked comment: no
  // PIN means everything reads as unlocked). Alex will set one; until then
  // this is the documented gap (see the project notes).
  const showingManage = wantsManage && (!pinSet || !locked);

  // A cheap separate fetch (see useChoreAdmin.ts's useWaitingApprovalCount
  // comment) rather than lifting ParentView's own state up here: this badge
  // needs to be visible while the Manage panel isn't even mounted (the name-
  // button view is showing), and this component only ever mounts one of
  // KidView/ParentView. `refresh` is handed down as `onWaitingChanged` so an
  // approve/reject/tick inside ParentView updates the badge immediately
  // instead of waiting on the next poll.
  const { count: waitingCount, refresh: refreshWaitingCount } = useWaitingApprovalCount();

  function openManage() {
    location.hash = "chores/parent";
    setWantsManage(true);
    if (pinSet && locked) onRequestUnlock();
  }

  function backToNames() {
    location.hash = "chores";
    setWantsManage(false);
  }

  async function handleLockNow() {
    await lockNow();
    backToNames();
  }

  // A management action's mutation can 423 mid-session (the sliding window
  // expired, or another tab/device locked it) -- ParentView surfaces that
  // through its own aggregated error state and calls this so the panel
  // doesn't sit there half-broken waiting on the next poll. refreshLockStatus
  // is App.tsx's own -- it's what makes `locked` above flip back to true.
  function handleLockedMidSession() {
    refreshLockStatus();
    backToNames();
  }

  const manageButton = (
    <button
      onClick={openManage}
      className={`relative ${KIOSK ? "py-4 px-6 text-xl" : "px-4 py-3 text-base"} rounded-xl font-semibold border-2 border-dashed border-slate-300 dark:border-slate-600 text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center gap-1.5`}
    >
      <Lock size={KIOSK ? 20 : 16} />
      Manage
      {waitingCount > 0 && (
        <span className="min-w-[1.1rem] h-[1.1rem] px-1 rounded-full bg-amber-500 text-white text-[10px] font-semibold flex items-center justify-center">
          {waitingCount}
        </span>
      )}
    </button>
  );

  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-1">
        <h2 className="text-lg font-semibold">Chores</h2>
        {showingManage && (
          <button
            onClick={handleLockNow}
            className="px-2.5 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300"
          >
            <Lock size={13} /> Lock
          </button>
        )}
      </div>
      <p className="text-sm text-slate-500 dark:text-slate-400 mb-3">
        {showingManage
          ? "Add chores, approve stars, manage rewards."
          : "Tap your name, then tick off what's done."}
      </p>

      {showingManage ? (
        <ParentView onWaitingChanged={refreshWaitingCount} onLocked={handleLockedMidSession} />
      ) : (
        <KidView onWaitingChanged={refreshWaitingCount} trailingButton={manageButton} />
      )}
    </div>
  );
}
