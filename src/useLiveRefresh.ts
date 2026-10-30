import { useEffect, useRef } from "react";

// Re-runs `refresh` when this tab becomes the one being looked at, plus a slow
// background poll -- so a device left open on a section (the fridge, most of
// all) picks up a change made from somewhere else without anyone touching it.
//
// This is read-only refetching, NOT a write path -- do not use this for
// src/sections/budget/useSyncedTable.ts's tables. That hook diffs local state
// against what it last wrote and PUTs the difference; feeding it a poll
// response would look exactly like a local edit and get echoed straight back
// as a write, possibly resurrecting a row someone just deleted elsewhere.
// Budget's six useSyncedTable instances are deliberately never wired to this.
//
// Also deliberately NOT the same thing as bumping App.tsx's `dataVersion`:
// that remounts the whole section (`<Grocery key={dataVersion} />`), which
// throws away in-progress UI state (a selected item, an open form, a
// half-typed field). `refresh` here is expected to be a section's own
// in-place reloader (e.g. Grocery.tsx's `refresh(keepId?)`, which already
// preserves the current selection across a reload).
export function useLiveRefresh(refresh: () => void | Promise<void>, intervalMs: number): void {
  // Held in a ref so the effect below doesn't need to re-subscribe (and
  // therefore re-fire) every time the caller passes a new function identity --
  // same technique useSyncedTable uses for its onErrorRef.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    function onVisible() {
      // The one that actually matters day to day: a screen that sleeps and
      // wakes (the fridge door, a phone) should show current data the instant
      // someone looks at it again, not after the next timer tick.
      if (document.visibilityState === "visible") refreshRef.current();
    }
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);

    const id = setInterval(() => {
      // No point polling a screen nobody can see, and it saves the removable
      // drive a read every tick for every hidden tab.
      if (!document.hidden) refreshRef.current();
    }, intervalMs);

    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      clearInterval(id);
    };
  }, [intervalMs]);
}
