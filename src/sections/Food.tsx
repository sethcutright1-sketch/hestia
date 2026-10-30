// The Food tab: the signed-in person's own food diary, with two tabs: Diary and Weight & progress.
//
//   header   the tabs, a small person switcher ("Me · Bea") when another login shares something with you, and the
//            gear that opens Food settings (profile, calorie goals, meals, snack allowance, who can see my food data,
//            and the food-diary PIN)
//   Diary    your day (food/Diary.tsx), or -- with the switcher on someone else -- a READ-ONLY view of them
//   Weight & progress   your weigh-ins, steps and private progress photos, or a read-only view of theirs
//
// Only admin and parent logins have diaries. The kiosk login never reaches this section (App.tsx hides it,
// and the server answers 403 to the kiosk on every /api/nutrition route but its own).
//
// Who sees what: each login chooses what the others can see of theirs (nothing / daily totals / everything). The
// server enforces it; the switcher only lists the people who share something, so with nobody sharing it is not shown.
// Progress photos are never shared and never appear in someone else's view.
//
// The PIN: each login can choose "Require the PIN for my food diary" (the gear). While that is on and the household
// PIN isn't entered, `locked` is true and this shows a lock screen, the same way Budget does; a 423 from the server
// mid-session (the lock re-armed while the page was open) does the same.
//
// One narrow centred column on every screen size, like a phone app; dialogs open over it as sheets.

import { useCallback, useEffect, useState } from "react";
import { Lock, Settings } from "lucide-react";
import { useLiveRefresh } from "../useLiveRefresh.ts";
import Diary from "./food/Diary.tsx";
import { foodApi } from "./food/api.ts";
import FoodSettings, { type SettingsCardId } from "./food/FoodSettings.tsx";
import PersonSwitcher from "./food/PersonSwitcher.tsx";
import { SharedDayView, SharedProgressView } from "./food/SharedViews.tsx";
import { stillShared, switcherPeople } from "./food/sharing.ts";
import { FoodToasts, useFoodToasts } from "./food/Toasts.tsx";
import type { Profile, Sharer } from "./food/types.ts";
import WeightTab from "./food/WeightTab.tsx";

type View = "diary" | "progress";

const VIEWS: { id: View; label: string }[] = [
  { id: "diary", label: "Diary" },
  { id: "progress", label: "Weight & progress" },
];

interface Props {
  /** The food-diary PIN lock is on for this login and the household PIN hasn't been entered. */
  locked: boolean;
  onRequestUnlock: () => void;
  /** Bumped by App.tsx each time the PIN prompt succeeds, so a lock found by the server clears and the diary reloads. */
  unlockCount: number;
  /** Re-reads the lock status in App.tsx (the PIN option in the gear changes what it shows). */
  refreshLockStatus: () => void;
}

export default function Food({ locked, onRequestUnlock, unlockCount, refreshLockStatus }: Props) {
  const [view, setView] = useState<View>("diary");
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** A settings card to scroll to when the settings open (the Weight & progress tab links to "I started my weight loss on"). */
  const [settingsCard, setSettingsCard] = useState<SettingsCardId | null>(null);
  /** Bumped when the weight loss start day changed in settings, so the Weight & progress tab reads its headline again. */
  const [weightStartVersion, setWeightStartVersion] = useState(0);
  const [serverLocked, setServerLocked] = useState(false);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [sharers, setSharers] = useState<Sharer[]>([]);
  /** The login being looked at read-only; null = me. */
  const [viewing, setViewing] = useState<string | null>(null);
  /** Bumped when something outside the diary changed the day's numbers, so the diary reads its day again. */
  const [diaryVersion, setDiaryVersion] = useState(0);
  const { toasts, show, dismiss } = useFoodToasts();
  const bumpDiary = useCallback(() => setDiaryVersion((v) => v + 1), []);
  const onLocked = useCallback(() => setServerLocked(true), []);

  useEffect(() => {
    setServerLocked(false);
  }, [unlockCount]);

  const loadProfile = useCallback(() => {
    foodApi.profile().then(setProfile).catch(() => {});
  }, []);

  const loadSharers = useCallback(async () => {
    try {
      setSharers(await foodApi.sharing());
    } catch {
      // A failed check changes nothing on screen; the next one (or the next visit) tries again.
    }
  }, []);

  const isLocked = locked || serverLocked;
  useEffect(() => {
    if (isLocked) return;
    loadProfile();
    void loadSharers();
  }, [isLocked, loadProfile, loadSharers, unlockCount]);

  // Somebody may start or stop sharing while this is open: check now and then, and whenever the page comes back.
  useLiveRefresh(() => { if (!isLocked) return loadSharers(); }, 60_000);

  // The person being looked at stopped sharing: back to Me.
  useEffect(() => {
    if (!stillShared(sharers, viewing)) setViewing(null);
  }, [sharers, viewing]);

  if (isLocked) {
    return (
      <div className="max-w-md mx-auto bg-white dark:bg-slate-900 border border-amber-200 dark:border-amber-900/60 rounded-2xl p-6 text-center space-y-3">
        <div className="w-12 h-12 mx-auto rounded-full bg-amber-50 dark:bg-amber-950/30 flex items-center justify-center">
          <Lock className="w-6 h-6 text-amber-600 dark:text-amber-400" />
        </div>
        <h2 className="font-bold text-slate-900 dark:text-slate-100 text-sm">Your food diary is locked</h2>
        <p className="text-xs text-slate-500 dark:text-slate-400">Unlock it with the household PIN to see or change anything here.</p>
        <button
          onClick={onRequestUnlock}
          className="px-4 py-2 min-h-10 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-xs font-bold"
        >
          Unlock
        </button>
      </div>
    );
  }

  const people = switcherPeople(sharers);
  const person = viewing ? sharers.find((s) => s.userId === viewing) ?? null : null;

  function openWeight() {
    setSettingsOpen(false);
    setViewing(null);
    setView("progress");
  }

  function openSettings(card: SettingsCardId | null = null) {
    setSettingsCard(card);
    setSettingsOpen(true);
  }

  function closeSettings() {
    setSettingsOpen(false);
    setSettingsCard(null);
    void loadSharers();
  }

  function noLongerShared(name: string) {
    setViewing(null);
    void loadSharers();
    show(`${name} doesn't share that with you any more.`);
  }

  return (
    <div className="max-w-xl mx-auto">
      <h2 className="sr-only">Food</h2>

      {/* Food settings take the column's place, with a Back button; the diary below stays mounted (hidden). */}
      {settingsOpen && (
        <FoodSettings
          profile={profile}
          onProfileSaved={setProfile}
          onDiaryChanged={bumpDiary}
          refreshLockStatus={refreshLockStatus}
          onLocked={onLocked}
          onBack={closeSettings}
          scrollTo={settingsCard}
          onWeightStartChanged={() => setWeightStartVersion((v) => v + 1)}
        />
      )}

      <div hidden={settingsOpen}>
        <div className="flex items-end gap-1 mb-4 border-b border-slate-200 dark:border-slate-800">
          <div role="tablist" className="flex gap-1 flex-1 min-w-0">
            {VIEWS.map(({ id, label }) => (
              <button
                key={id}
                role="tab"
                aria-selected={view === id}
                onClick={() => setView(id)}
                className={`px-3 py-1.5 text-sm border-b-2 -mb-px whitespace-nowrap ${
                  view === id
                    ? "border-blue-600 text-blue-600 dark:text-blue-400 font-medium"
                    : "border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            onClick={() => openSettings()}
            aria-label="Food settings"
            title="Food settings"
            className="p-2 mb-1 rounded-lg text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 shrink-0"
          >
            <Settings size={18} />
          </button>
        </div>

        {people && <PersonSwitcher people={people} value={viewing} onChange={setViewing} />}

        {/* Mine. The diary stays mounted (just hidden) while anything else shows, so coming back keeps the day you were on. */}
        <div hidden={person !== null || view !== "diary"}>
          <Diary
            key={unlockCount}
            onLocked={onLocked}
            toast={show}
            onOpenSettings={() => openSettings()}
            onOpenWeight={openWeight}
            reloadToken={diaryVersion}
          />
        </div>
        {person === null && view === "progress" && (
          <WeightTab
            profile={profile}
            toast={show}
            onLocked={onLocked}
            onWeightChanged={bumpDiary}
            onOpenSettings={() => openSettings()}
            onOpenSettingsCard={openSettings}
            reloadToken={weightStartVersion}
          />
        )}

        {/* Theirs: read-only, at the level they chose. */}
        {person !== null && view === "diary" && (
          <SharedDayView key={person.userId} person={person} unlockCount={unlockCount} onRequestUnlock={onRequestUnlock} onNoLongerShared={() => noLongerShared(person.name)} />
        )}
        {person !== null && view === "progress" && (
          <SharedProgressView key={person.userId} person={person} profile={profile} unlockCount={unlockCount} onRequestUnlock={onRequestUnlock} onNoLongerShared={() => noLongerShared(person.name)} />
        )}
      </div>

      <FoodToasts toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
