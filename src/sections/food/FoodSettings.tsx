// Food settings: the signed-in person's own settings, opened from the gear in the Food header. It takes the place of
// the tabs (with a Back button) so each card has the whole column.
//
//   Profile · Calorie goals (with the calorie schedule and the day you started your weight loss) · Meals · Snack allowance ·
//   Who can see my food data · Require the PIN for my food diary · Import from Lose It!
//
// The admin-only food items (the kiosk's food access, barcodes we couldn't find) live in the header settings
// panel's Kiosk and Food tabs, not here; the "cloud AI may see health data" switch comes with the assistant (phase 6).

import { useEffect, useMemo } from "react";
import { ArrowLeft } from "lucide-react";
import { failWith } from "./fail.ts";
import GoalsCard from "./settings/GoalsCard.tsx";
import ImportCard from "./settings/ImportCard.tsx";
import MealsCard from "./settings/MealsCard.tsx";
import PinCard from "./settings/PinCard.tsx";
import ProfileCard from "./settings/ProfileCard.tsx";
import SnackCard from "./settings/SnackCard.tsx";
import VisibilityCard from "./settings/VisibilityCard.tsx";
import type { Profile } from "./types.ts";

/** A card the Weight & progress tab can open the settings at. */
export type SettingsCardId = "weight-start";

interface Props {
  profile: Profile | null;
  onProfileSaved: (profile: Profile) => void;
  /** Meals, goals or the profile changed: the diary's day should be read again. */
  onDiaryChanged: () => void;
  refreshLockStatus: () => void;
  onLocked: () => void;
  onBack: () => void;
  /** Scroll to this card once the settings are showing. */
  scrollTo?: SettingsCardId | null;
  /** "I started my weight loss on" was saved or cleared: the Weight & progress tab should read its headline again. */
  onWeightStartChanged?: () => void;
}

export default function FoodSettings({ profile, onProfileSaved, onDiaryChanged, refreshLockStatus, onLocked, onBack, scrollTo, onWeightStartChanged }: Props) {
  const fail = useMemo(() => failWith(onLocked), [onLocked]);

  // The cards (and so the element) exist once the profile has loaded.
  useEffect(() => {
    if (!scrollTo || !profile) return;
    document.getElementById(scrollTo)?.scrollIntoView({ block: "start" });
  }, [scrollTo, profile !== null]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <button onClick={onBack} className="inline-flex items-center gap-1.5 px-2 py-1.5 -ml-2 rounded-lg text-sm text-blue-600 dark:text-blue-400 hover:bg-slate-100 dark:hover:bg-slate-800">
          <ArrowLeft size={16} /> Back
        </button>
        <h2 className="font-semibold text-slate-900 dark:text-slate-100">Food settings</h2>
      </div>

      {profile ? (
        <>
          <ProfileCard profile={profile} fail={fail} onSaved={(p) => { onProfileSaved(p); onDiaryChanged(); }} />
          <GoalsCard profile={profile} fail={fail} onSaved={onDiaryChanged} onWeightStartChanged={onWeightStartChanged} />
          <MealsCard fail={fail} onChanged={onDiaryChanged} />
          <SnackCard fail={fail} />
          <VisibilityCard fail={fail} />
          <PinCard refreshLockStatus={refreshLockStatus} />
          <ImportCard profile={profile} fail={fail} onChanged={onDiaryChanged} />
        </>
      ) : (
        <p className="text-sm text-slate-500 dark:text-slate-400">Loading…</p>
      )}
    </div>
  );
}
