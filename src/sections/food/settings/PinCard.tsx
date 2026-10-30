// Food settings > Require the PIN for my food diary (routes/nutrition/pin.ts): a per-login option, off by default.
// Moved here from the header settings' Account tab with its behaviour and API unchanged: turning it ON needs nothing;
// turning it OFF needs an unlocked session, so a 423 opens the household PIN keypad and then applies the change.
// It applies to this login only, a watch can't open a locked diary, and it also locks the data other logins can
// see of yours (they need the PIN too).

import { useEffect, useState } from "react";
import { Lock } from "lucide-react";
import { ApiError, type FoodDiaryPinStatus } from "../../../api.ts";
import { KIOSK } from "../../../kiosk.ts";
import PinPrompt from "../../../PinPrompt.tsx";
import { foodApi } from "../api.ts";
import SettingsCard from "./SettingsCard.tsx";

interface Props {
  /** Re-reads the lock status in App.tsx (it decides whether the Food section shows its lock screen). */
  refreshLockStatus: () => void;
}

export default function PinCard({ refreshLockStatus }: Props) {
  const [status, setStatus] = useState<FoodDiaryPinStatus | null>(null);
  const [error, setError] = useState("");
  // Set while the PIN prompt is open: the value to apply once unlocked (turning the option OFF needs an unlocked session).
  const [unlockFor, setUnlockFor] = useState<boolean | null>(null);

  useEffect(() => {
    foodApi.pinSetting().then(setStatus).catch(() => setStatus(null));
  }, []);

  async function setRequirePin(requirePin: boolean) {
    setError("");
    try {
      setStatus(await foodApi.setPinSetting(requirePin));
      refreshLockStatus();
    } catch (err) {
      if (err instanceof ApiError && err.status === 423) setUnlockFor(requirePin);
      else setError(err instanceof ApiError ? err.message : "Something went wrong.");
    }
  }

  if (!status) return null;
  return (
    <>
      <SettingsCard title="Lock my food diary">
        <label className="flex items-start gap-2.5 text-sm font-medium text-slate-900 dark:text-slate-100">
          <input type="checkbox" className="mt-1" checked={status.requirePin} onChange={(e) => void setRequirePin(e.target.checked)} />
          <span className="flex items-center gap-1.5">
            <Lock size={14} /> Require the PIN for my food diary
          </span>
        </label>
        <p className="text-xs text-slate-500 dark:text-slate-400 leading-normal">
          Off by default. When on, your food diary, weights and recipe calories ask for the household PIN, the same
          way Budget does. It applies to this login only, and a watch can't open it. What you share with the other
          logins is locked the same way: they need the PIN to see it.
        </p>
        {!status.householdPinSet && (
          <p className="text-xs font-medium text-amber-700 dark:text-amber-400">
            No household PIN is set yet, so this does nothing until an admin sets one (header settings, Security tab).
          </p>
        )}
        {status.requirePin && status.householdPinSet && !status.unlocked && (
          <p className="text-xs text-slate-500 dark:text-slate-400">Turning it off will ask for the PIN first.</p>
        )}
        {error && <p className="text-xs font-medium text-rose-600 dark:text-rose-400">{error}</p>}
      </SettingsCard>
      {unlockFor !== null && (
        <PinPrompt
          defaultTrusted={!KIOSK}
          onClose={() => setUnlockFor(null)}
          onUnlocked={() => {
            const wanted = unlockFor;
            setUnlockFor(null);
            refreshLockStatus();
            void setRequirePin(wanted);
          }}
        />
      )}
    </>
  );
}
