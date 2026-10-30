// Unified account/security settings, opened by clicking the signed-in user's
// name in the header (App.tsx). Replaces two previously scattered spots: the
// old header gear icon (AccountSettings.tsx, just password change) and
// Budget's own Settings modal's "Security Guard" tab (PIN/lock/kiosk
// timeouts/merchant rules). Budget's currency/accent-color picker and its
// backup/import/export/factory-reset tools stay in Budget's own Settings
// modal -- those are budget-data-specific, not app-wide.
//
// The household roster is deliberately NOT here. It briefly was, alongside a
// second copy at the bottom of Meal Plan; it's now the top-level Family tab
// instead. Editing who lives here isn't an administrative setting the way a
// password or a PIN is -- it's everyday content, and burying it two clicks
// deep behind a modal is what led to Meal Plan growing its own copy.
import { useEffect, useState } from "react";
import { Apple, KeyRound, MonitorSmartphone, ShieldCheck, ShoppingCart, Smartphone, X } from "lucide-react";
import { CloudHealthSwitches, FoodAdminTab, KioskFoodAccess } from "./AdminFood.tsx";
import { GroceriesAdminTab, type KrogerReturn } from "./KrogerSettings.tsx";
import { PasswordGatedToggle } from "./PasswordGatedToggle.tsx";
import { api, ApiError, type AssistantSettings, type CloudFinanceSettings, type DeviceToken, type HouseholdPinStatus, type KioskLoginStatus, type LockStatus, type NewDeviceToken, type SessionUser } from "./api.ts";

interface AdminSettingsProps {
  onClose: () => void;
  user: SessionUser;
  lockStatus: LockStatus | null;
  refreshLockStatus: () => void;
  lockNow: () => Promise<void>;
  /** Opens on this tab instead of Account (after Kroger's sign-in sends the admin back). */
  initialTab?: AdminTab;
  /** How connecting Kroger went, shown on the Groceries tab. */
  krogerReturn?: KrogerReturn | null;
}

export type AdminTab = "account" | "security" | "devices" | "kiosk" | "food" | "groceries";

const TABS: { id: AdminTab; label: string; icon: typeof KeyRound }[] = [
  { id: "account", label: "Account", icon: KeyRound },
  { id: "security", label: "Security", icon: ShieldCheck },
  { id: "devices", label: "Devices", icon: Smartphone },
  { id: "kiosk", label: "Kiosk", icon: MonitorSmartphone },
  { id: "food", label: "Food", icon: Apple },
  { id: "groceries", label: "Groceries", icon: ShoppingCart },
];

export default function AdminSettings({ onClose, user, lockStatus, refreshLockStatus, lockNow, initialTab, krogerReturn }: AdminSettingsProps) {
  const [activeTab, setActiveTab] = useState<AdminTab>(initialTab && user.role === "admin" ? initialTab : "account");
  // Three tiers, not two: the kiosk login only ever sees Account (change its
  // own password) -- every other tab here either manages things it's already
  // forbidden from reaching or manages the kiosk credential itself, which it
  // shouldn't be trusted to do to its own account. A parent sees Account and
  // Devices (pairing their own watch, forbidKiosk-gated, not admin-gated) but
  // not Security or Kiosk -- those are requireAdmin server-side now (auth.ts).
  // Only admin sees every tab.
  const tabs =
    user.role === "kiosk" ? TABS.filter((t) => t.id === "account") :
    user.role === "admin" ? TABS :
    TABS.filter((t) => t.id === "account" || t.id === "devices");

  return (
    <div className="fixed inset-0 z-[70] bg-slate-950/70 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 w-full max-w-2xl rounded-2xl shadow-2xl flex flex-col md:flex-row overflow-hidden max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="bg-slate-50 dark:bg-slate-950 border-b md:border-b-0 md:border-r border-slate-100 dark:border-slate-800 p-3 md:w-44 shrink-0">
          <nav className="flex md:flex-col gap-1">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex-1 md:flex-none flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium text-left ${
                  activeTab === tab.id
                    ? "bg-white dark:bg-slate-800 text-blue-600 dark:text-blue-400 shadow-sm"
                    : "text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
                }`}
              >
                <tab.icon size={15} />
                <span className="hidden sm:inline md:inline">{tab.label}</span>
              </button>
            ))}
          </nav>
        </div>

        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="flex items-center justify-between p-4 border-b border-slate-100 dark:border-slate-800 shrink-0">
            <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">
              {activeTab === "account" && "Account"}
              {activeTab === "security" && "Security"}
              {activeTab === "devices" && "Devices"}
              {activeTab === "kiosk" && "Kiosk"}
              {activeTab === "food" && "Food"}
              {activeTab === "groceries" && "Groceries"}
            </h3>
            <button onClick={onClose} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200" aria-label="Close">
              <X size={16} />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-5">
            {activeTab === "account" && <AccountTab user={user} />}
            {activeTab === "security" && (
              <SecurityTab lockStatus={lockStatus} refreshLockStatus={refreshLockStatus} lockNow={lockNow} />
            )}
            {activeTab === "devices" && <DevicesTab />}
            {activeTab === "kiosk" && <KioskTab />}
            {activeTab === "food" && <FoodAdminTab />}
            {activeTab === "groceries" && <GroceriesAdminTab notice={krogerReturn} />}
          </div>
        </div>
      </div>
    </div>
  );
}

function AccountTab({ user }: { user: SessionUser }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSuccess(false);
    if (newPassword !== confirmPassword) {
      setError("New passwords don't match.");
      return;
    }
    setBusy(true);
    try {
      await api.post("/api/auth/change-password", { currentPassword, newPassword });
      setSuccess(true);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4 max-w-sm">
      <p className="text-xs text-slate-500 dark:text-slate-400">
        Signed in as <span className="font-semibold text-slate-700 dark:text-slate-300">{user.displayName}</span>{" "}
        <span className="text-slate-400 dark:text-slate-500">(@{user.username})</span>
      </p>

      <form onSubmit={submit} className="space-y-3">
        <div className="text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wide flex items-center gap-1.5">
          <KeyRound size={13} /> Change password
        </div>
        <input
          type="password"
          required
          autoComplete="current-password"
          className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
          placeholder="Current password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
        />
        <input
          type="password"
          required
          minLength={8}
          autoComplete="new-password"
          className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
          placeholder="New password (min 8 characters)"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
        />
        <input
          type="password"
          required
          autoComplete="new-password"
          className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
          placeholder="Confirm new password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
        />

        {error && <p className="text-xs font-medium text-rose-600 dark:text-rose-400">{error}</p>}
        {success && <p className="text-xs font-medium text-emerald-600 dark:text-emerald-400">Password changed.</p>}

        <button
          type="submit"
          disabled={busy}
          className="w-full py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-xl text-sm font-bold"
        >
          {busy ? "Saving…" : "Change password"}
        </button>
      </form>
    </div>
  );
}

interface MerchantRule {
  merchantKey: string;
  merchantDisplay: string;
  category: string;
}

function SecurityTab({
  lockStatus,
  refreshLockStatus,
  lockNow,
}: {
  lockStatus: LockStatus | null;
  refreshLockStatus: () => void;
  lockNow: () => Promise<void>;
}) {
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [busy, setBusy] = useState(false);
  const [showPinForm, setShowPinForm] = useState(false);
  const [newPin, setNewPin] = useState("");
  const [pinPassword, setPinPassword] = useState("");
  const [showRemovePinForm, setShowRemovePinForm] = useState(false);
  const [removePinPassword, setRemovePinPassword] = useState("");
  const [kioskMinutesInput, setKioskMinutesInput] = useState("5");
  const [trustedMinutesInput, setTrustedMinutesInput] = useState("120");
  const [merchantRules, setMerchantRules] = useState<MerchantRule[]>([]);
  const [noFinanceVoiceData, setNoFinanceVoiceData] = useState(true);
  const [voiceSettingBusy, setVoiceSettingBusy] = useState(false);
  const [cloudFinance, setCloudFinance] = useState<CloudFinanceSettings>({ anthropic: false, gemini: false });
  const [shareGroceryBudget, setShareGroceryBudget] = useState(false);
  const [speechBackend, setSpeechBackend] = useState<AssistantSettings["speechBackend"]>("off");
  const [whisperConfigured, setWhisperConfigured] = useState(false);
  const [speechBusy, setSpeechBusy] = useState(false);
  const [speechError, setSpeechError] = useState("");

  // Deliberately its own set of state, distinct from the budget PIN lock's above --
  // these two PINs gate different things (who can create an account vs. what a
  // signed-in person can reach) and sharing state between their forms would make
  // that easy to blur.
  const [householdPinStatus, setHouseholdPinStatus] = useState<HouseholdPinStatus | null>(null);
  const [showHouseholdPinForm, setShowHouseholdPinForm] = useState(false);
  const [newHouseholdPin, setNewHouseholdPin] = useState("");
  const [householdPinPassword, setHouseholdPinPassword] = useState("");
  const [householdPinBusy, setHouseholdPinBusy] = useState(false);
  const [householdPinError, setHouseholdPinError] = useState("");
  const [householdPinSuccess, setHouseholdPinSuccess] = useState("");

  useEffect(() => {
    if (lockStatus) {
      setKioskMinutesInput(String(lockStatus.kioskMinutes));
      setTrustedMinutesInput(String(lockStatus.trustedMinutes));
    }
  }, [lockStatus]);

  useEffect(() => {
    api
      .get<{ rules: MerchantRule[] }>("/api/budget/merchant-rules")
      .then((d) => setMerchantRules(d.rules || []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    api
      .get<AssistantSettings>("/api/assistant/settings")
      .then((d) => {
        setNoFinanceVoiceData(d.noFinanceVoiceData);
        setCloudFinance(d.allowCloudFinance);
        setShareGroceryBudget(d.shareGroceryBudget);
        setSpeechBackend(d.speechBackend ?? "off");
        setWhisperConfigured(!!d.whisperConfigured);
      })
      .catch(() => {});
  }, []);

  function loadHouseholdPinStatus() {
    api
      .get<HouseholdPinStatus>("/api/auth/household-pin")
      .then(setHouseholdPinStatus)
      .catch(() => {});
  }

  useEffect(loadHouseholdPinStatus, []);

  async function saveCloudFinance(provider: keyof CloudFinanceSettings, allow: boolean, password?: string) {
    const d = await api.put<{ allowCloudFinance: CloudFinanceSettings }>("/api/assistant/settings/cloud-finance", {
      provider,
      allow,
      password,
    });
    setCloudFinance(d.allowCloudFinance);
  }

  async function saveShareGroceryBudget(allow: boolean, password?: string) {
    const d = await api.put<{ shareGroceryBudget: boolean }>("/api/assistant/settings/grocery-budget", { allow, password });
    setShareGroceryBudget(d.shareGroceryBudget);
  }

  async function handleToggleNoFinanceVoiceData() {
    const next = !noFinanceVoiceData;
    setVoiceSettingBusy(true);
    setError("");
    try {
      await api.put<AssistantSettings>("/api/assistant/settings", { noFinanceVoiceData: next });
      setNoFinanceVoiceData(next);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to save.");
    } finally {
      setVoiceSettingBusy(false);
    }
  }

  async function handleSetSpeechBackend(next: AssistantSettings["speechBackend"]) {
    if (next === speechBackend) return;
    setSpeechBusy(true);
    setSpeechError("");
    try {
      const d = await api.put<{ speechBackend: AssistantSettings["speechBackend"] }>("/api/assistant/settings/speech", { speechBackend: next });
      setSpeechBackend(d.speechBackend);
    } catch (err) {
      setSpeechError(err instanceof ApiError ? err.message : "Failed to save.");
    } finally {
      setSpeechBusy(false);
    }
  }

  async function handleForgetMerchant(merchantKey: string) {
    try {
      await api.del(`/api/budget/merchant-rules/${encodeURIComponent(merchantKey)}`);
      setMerchantRules((prev) => prev.filter((r) => r.merchantKey !== merchantKey));
    } catch {
      setError("Failed to forget that merchant rule.");
    }
  }

  async function handleSetHouseholdPin() {
    if (!/^\d{4,6}$/.test(newHouseholdPin)) {
      setHouseholdPinError("Household PIN must be 4-6 digits.");
      return;
    }
    if (!householdPinPassword) {
      setHouseholdPinError("Enter your account password to confirm.");
      return;
    }
    setHouseholdPinBusy(true);
    setHouseholdPinError("");
    setHouseholdPinSuccess("");
    try {
      await api.put("/api/auth/household-pin", { pin: newHouseholdPin, password: householdPinPassword });
      setNewHouseholdPin("");
      setHouseholdPinPassword("");
      setShowHouseholdPinForm(false);
      setHouseholdPinSuccess("Household PIN updated.");
      loadHouseholdPinStatus(); // refetch so the "still the factory PIN" warning clears
    } catch (err) {
      setHouseholdPinError(err instanceof ApiError ? err.message : "Failed to set household PIN.");
    } finally {
      setHouseholdPinBusy(false);
    }
  }

  async function handleSetPin() {
    if (!/^\d{4,6}$/.test(newPin)) {
      setError("PIN must be 4-6 digits.");
      return;
    }
    if (!pinPassword) {
      setError("Enter your account password to confirm.");
      return;
    }
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      await api.put("/api/lock/pin", { pin: newPin, password: pinPassword });
      setNewPin("");
      setPinPassword("");
      setShowPinForm(false);
      setSuccess("PIN updated.");
      refreshLockStatus();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to set PIN.");
    } finally {
      setBusy(false);
    }
  }

  // The confirming password comes from an inline field, not window.prompt:
  // prompt() is blocked outright in some embedded/kiosk browsers (it threw
  // "prompt() is not supported" in the desktop app's browser pane), which made
  // this button silently do nothing there.
  async function handleRemovePin() {
    if (!removePinPassword) {
      setError("Enter your account password to confirm.");
      return;
    }
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      await api.del("/api/lock/pin", { password: removePinPassword });
      setShowRemovePinForm(false);
      setRemovePinPassword("");
      setSuccess("PIN lock removed — budget data is no longer PIN-protected.");
      refreshLockStatus();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to remove PIN.");
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveLockTimeouts() {
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      await api.put("/api/lock/settings", {
        kioskMinutes: parseInt(kioskMinutesInput, 10),
        trustedMinutes: parseInt(trustedMinutesInput, 10),
      });
      setSuccess("Lock timeouts updated.");
      refreshLockStatus();
    } catch (err) {
      if (err instanceof ApiError && err.status === 423) {
        setError("Unlock with your PIN first to change these settings.");
      } else {
        setError(err instanceof ApiError ? err.message : "Failed to save.");
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleLockNowClick() {
    await lockNow();
    setSuccess("Locked.");
  }

  return (
    <div className="space-y-5 max-w-sm">
      <div className="space-y-2">
        <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wide">Household PIN</label>
        <p className="text-xs text-slate-500 dark:text-slate-400 leading-normal">
          Required to create a new household account in the first place — this is not the
          budget PIN lock below, which only gates what an already-signed-in person can reach.
        </p>

        {householdPinStatus?.isDefault && (
          <div className="p-3 bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800/60 rounded-lg">
            <p className="text-xs font-bold text-amber-800 dark:text-amber-400">
              Still the factory household PIN (1234). It's published in this app's own
              README, so anyone who can reach the app can create their own account until
              it's changed here.
            </p>
          </div>
        )}

        {showHouseholdPinForm ? (
          <div className="space-y-2 p-3 border border-slate-200 dark:border-slate-700 rounded-lg">
            <input
              type="text"
              inputMode="numeric"
              placeholder="New household PIN (4-6 digits)"
              value={newHouseholdPin}
              onChange={(e) => setNewHouseholdPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
              className="w-full px-3 py-2 border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 rounded-lg text-sm"
            />
            <input
              type="password"
              placeholder="Your account password"
              value={householdPinPassword}
              onChange={(e) => setHouseholdPinPassword(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 rounded-lg text-sm"
            />
            <div className="flex gap-2">
              <button
                onClick={() => { setShowHouseholdPinForm(false); setNewHouseholdPin(""); setHouseholdPinPassword(""); setHouseholdPinError(""); }}
                className="flex-1 py-1.5 border border-slate-300 dark:border-slate-700 rounded-lg text-xs font-bold text-slate-600 dark:text-slate-400"
              >
                Cancel
              </button>
              <button
                onClick={handleSetHouseholdPin}
                disabled={householdPinBusy}
                className="flex-1 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg text-xs font-bold"
              >
                {householdPinBusy ? "Saving…" : "Save household PIN"}
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => { setShowHouseholdPinForm(true); setHouseholdPinError(""); }}
            className="w-full py-2 px-3 bg-blue-50 dark:bg-blue-950/20 hover:bg-blue-100 dark:hover:bg-blue-950/40 border border-blue-200 dark:border-blue-800/60 rounded-lg text-xs font-bold text-blue-700 dark:text-blue-400"
          >
            Change household PIN
          </button>
        )}

        {householdPinError && <p className="text-xs font-medium text-rose-600 dark:text-rose-400">{householdPinError}</p>}
        {householdPinSuccess && <p className="text-xs font-medium text-emerald-600 dark:text-emerald-400">{householdPinSuccess}</p>}
      </div>

      <div className="space-y-2 pt-3 border-t border-slate-100 dark:border-slate-800">
        <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wide">PIN lock</label>
        <p className="text-xs text-slate-500 dark:text-slate-400 leading-normal">
          Requires a 4-6 digit PIN before the Budget section, the database backup, or the assistant's spending
          questions can be reached — on every device, including one left signed in on a kitchen screen. Not the
          household PIN above, which only gates creating a new account.
        </p>

        {!lockStatus ? (
          <p className="text-xs text-slate-400">Loading…</p>
        ) : (
          <>
            <div className="flex items-center justify-between p-3 bg-slate-50 dark:bg-slate-800/50 border border-slate-100 dark:border-slate-800 rounded-lg">
              <span className="text-xs font-medium text-slate-700 dark:text-slate-300">
                {lockStatus.pinSet
                  ? lockStatus.unlocked
                    ? "Unlocked right now"
                    : "Locked right now"
                  : "No PIN set — open to everyone signed in"}
              </span>
              {lockStatus.pinSet && lockStatus.unlocked && (
                <button
                  onClick={handleLockNowClick}
                  className="px-2.5 py-1 text-xs font-bold rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800"
                >
                  Lock now
                </button>
              )}
            </div>

            {showPinForm ? (
              <div className="space-y-2 p-3 border border-slate-200 dark:border-slate-700 rounded-lg">
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="New 4-6 digit PIN"
                  value={newPin}
                  onChange={(e) => setNewPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  className="w-full px-3 py-2 border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 rounded-lg text-sm"
                />
                <input
                  type="password"
                  placeholder="Your account password"
                  value={pinPassword}
                  onChange={(e) => setPinPassword(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 rounded-lg text-sm"
                />
                <div className="flex gap-2">
                  <button
                    onClick={() => { setShowPinForm(false); setNewPin(""); setPinPassword(""); setError(""); }}
                    className="flex-1 py-1.5 border border-slate-300 dark:border-slate-700 rounded-lg text-xs font-bold text-slate-600 dark:text-slate-400"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleSetPin}
                    disabled={busy}
                    className="flex-1 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg text-xs font-bold"
                  >
                    {busy ? "Saving…" : "Save PIN"}
                  </button>
                </div>
              </div>
            ) : showRemovePinForm ? (
              <div className="space-y-2 p-3 border border-slate-200 dark:border-slate-700 rounded-lg">
                <p className="text-xs text-slate-600 dark:text-slate-400">
                  {lockStatus.unlocked
                    ? "Budget data will no longer need a PIN."
                    : "Unlock Budget first — the PIN can only be removed from an unlocked session."}
                </p>
                <input
                  type="password"
                  placeholder="Your account password"
                  value={removePinPassword}
                  onChange={(e) => setRemovePinPassword(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleRemovePin(); }}
                  className="w-full px-3 py-2 border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 rounded-lg text-sm"
                />
                <div className="flex gap-2">
                  <button
                    onClick={() => { setShowRemovePinForm(false); setRemovePinPassword(""); setError(""); }}
                    className="flex-1 py-1.5 border border-slate-300 dark:border-slate-700 rounded-lg text-xs font-bold text-slate-600 dark:text-slate-400"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleRemovePin}
                    disabled={busy || !lockStatus.unlocked}
                    className="flex-1 py-1.5 bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white rounded-lg text-xs font-bold"
                  >
                    {busy ? "Removing…" : "Remove PIN"}
                  </button>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => { setShowPinForm(true); setError(""); }}
                  className="py-2 px-3 bg-blue-50 dark:bg-blue-950/20 hover:bg-blue-100 dark:hover:bg-blue-950/40 border border-blue-200 dark:border-blue-800/60 rounded-lg text-xs font-bold text-blue-700 dark:text-blue-400"
                >
                  {lockStatus.pinSet ? "Change PIN" : "Set a PIN"}
                </button>
                <button
                  onClick={() => { setShowRemovePinForm(true); setError(""); setSuccess(""); }}
                  disabled={!lockStatus.pinSet}
                  className="py-2 px-3 border border-slate-300 dark:border-slate-700 disabled:opacity-40 rounded-lg text-xs font-bold text-slate-600 dark:text-slate-400"
                >
                  Remove PIN
                </button>
              </div>
            )}

            <div className="grid grid-cols-2 gap-2 pt-2">
              <label className="space-y-1">
                <span className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider">Relock after (kiosk), min</span>
                <input
                  type="number"
                  min={1}
                  max={1440}
                  value={kioskMinutesInput}
                  onChange={(e) => setKioskMinutesInput(e.target.value)}
                  className="w-full px-2.5 py-1.5 border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 rounded-lg text-xs"
                />
              </label>
              <label className="space-y-1">
                <span className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider">Relock after (trusted), min</span>
                <input
                  type="number"
                  min={1}
                  max={1440}
                  value={trustedMinutesInput}
                  onChange={(e) => setTrustedMinutesInput(e.target.value)}
                  className="w-full px-2.5 py-1.5 border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 rounded-lg text-xs"
                />
              </label>
            </div>
            <button
              onClick={handleSaveLockTimeouts}
              disabled={busy}
              className="w-full py-1.5 border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50 rounded-lg text-xs font-bold text-slate-700 dark:text-slate-300"
            >
              Save timeouts
            </button>
          </>
        )}

        {error && <p className="text-xs font-medium text-rose-600 dark:text-rose-400">{error}</p>}
        {success && <p className="text-xs font-medium text-emerald-600 dark:text-emerald-400">{success}</p>}
      </div>

      <div className="space-y-2 pt-3 border-t border-slate-100 dark:border-slate-800">
        <label className="flex items-start gap-2.5 cursor-pointer">
          <input
            type="checkbox"
            checked={noFinanceVoiceData}
            disabled={voiceSettingBusy}
            onChange={handleToggleNoFinanceVoiceData}
            className="mt-0.5 shrink-0"
          />
          <span>
            <span className="block text-xs font-bold text-slate-700 dark:text-slate-300">Block spoken questions about money</span>
            <span className="block text-xs text-slate-500 dark:text-slate-400 leading-normal mt-0.5">
              When on, a spoken question that sounds financial from the Wear OS app (whose speech-to-text may use
              Google) is refused before it reaches the assistant — you'll need to type it instead. The microphone button
              below isn't affected, because this PC does that listening. Applies regardless of the PIN lock above.
            </span>
          </span>
        </label>
      </div>

      <fieldset className="space-y-2 pt-3 border-t border-slate-100 dark:border-slate-800" disabled={speechBusy}>
        <legend className="text-xs font-bold text-slate-700 dark:text-slate-300">Voice input</legend>
        <p className="text-xs text-slate-500 dark:text-slate-400 leading-normal">
          Adds a microphone button to the assistant. Applies to every device signed in to this app. Because the
          recording is turned into text on this PC, spoken questions about money or food diaries are answered like typed
          ones; the blocks above and in the Food tab only apply to the Wear OS app.
        </p>
        <label className={`flex items-start gap-2.5 ${whisperConfigured ? "cursor-pointer" : "opacity-60"}`}>
          <input
            type="radio"
            name="speechBackend"
            checked={speechBackend === "off"}
            onChange={() => handleSetSpeechBackend("off")}
            className="mt-0.5 shrink-0"
          />
          <span className="text-xs font-medium text-slate-700 dark:text-slate-300">Off</span>
        </label>
        <label className={`flex items-start gap-2.5 ${whisperConfigured ? "cursor-pointer" : "opacity-60"}`}>
          <input
            type="radio"
            name="speechBackend"
            checked={speechBackend === "whisper_local"}
            disabled={!whisperConfigured}
            onChange={() => handleSetSpeechBackend("whisper_local")}
            className="mt-0.5 shrink-0"
          />
          <span className="text-xs font-medium text-slate-700 dark:text-slate-300">
            On — speech is turned into text on this PC (Whisper); audio never leaves the house
          </span>
        </label>
        {!whisperConfigured && (
          <p className="text-xs text-slate-500 dark:text-slate-400">Whisper isn't set up on this server.</p>
        )}
        {speechError && <p className="text-xs font-medium text-rose-600 dark:text-rose-400">{speechError}</p>}
      </fieldset>

      <PasswordGatedToggle
        label="Let Claude answer money questions"
        enabled={cloudFinance.anthropic}
        onSave={(allow, password) => saveCloudFinance("anthropic", allow, password)}
        confirmLabel="Allow Claude to see financial data"
        enabledNote="Financial data can currently leave this machine when Claude is selected."
        description="Off by default: budget questions always run on the local model. When on, and Claude is picked in the assistant, your transactions, merchants, balances and income are sent to Anthropic to answer them. Data already sent can't be recalled by turning this back off."
      />
      <PasswordGatedToggle
        label="Let Gemini answer money questions"
        enabled={cloudFinance.gemini}
        onSave={(allow, password) => saveCloudFinance("gemini", allow, password)}
        confirmLabel="Allow Gemini to see financial data"
        enabledNote="Financial data can currently leave this machine when Gemini is selected."
        description="Off by default. When on, and Gemini is picked in the assistant, your transactions, merchants, balances and income are sent to Google to answer them. Data already sent can't be recalled by turning this back off."
        extraWarning="Only turn this on if your GEMINI_API_KEY's Google Cloud project has billing enabled (shown as the Paid tier under AI Studio → API keys). On the free tier Google may use your prompts, including your transactions, to improve its products and have people review them. A Gemini Pro subscription does not change this; it covers the Gemini app, not the API key this app uses."
      />
      <CloudHealthSwitches />
      <PasswordGatedToggle
        label="Share the grocery budget with meal planning"
        enabled={shareGroceryBudget}
        onSave={saveShareGroceryBudget}
        confirmLabel="Share the grocery budget"
        enabledNote="The Groceries budgeted amount is visible to meal planning, on any provider, even while the budget is locked."
        description="Off by default. When on, the assistant is told your Groceries category's monthly budgeted amount (and a weekly figure worked out from it) so meal plans fit it. Only that one number is shared: no transactions, no spent-so-far, no other category. It's included with every assistant message, so Claude or Gemini will see it when picked."
      />

      <div className="space-y-2 pt-3 border-t border-slate-100 dark:border-slate-800">
        <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wide">
          Remembered merchants ({merchantRules.length})
        </label>
        <p className="text-xs text-slate-500 dark:text-slate-400 leading-normal">
          Merchants you've told the ledger to always categorize a certain way. New transactions from these are
          auto-suggested that category.
        </p>
        {merchantRules.length === 0 ? (
          <p className="text-xs text-slate-400 dark:text-slate-500 italic">None remembered yet.</p>
        ) : (
          <div className="space-y-1.5 max-h-40 overflow-y-auto pr-1">
            {merchantRules.map((rule) => (
              <div
                key={rule.merchantKey}
                className="flex items-center justify-between gap-2 p-2 bg-slate-50 dark:bg-slate-800/50 border border-slate-100 dark:border-slate-800 rounded-lg"
              >
                <span className="text-xs font-medium text-slate-700 dark:text-slate-300 truncate">
                  {rule.merchantDisplay} <span className="text-slate-400 dark:text-slate-500">→ {rule.category}</span>
                </span>
                <button
                  onClick={() => handleForgetMerchant(rule.merchantKey)}
                  className="shrink-0 text-xs font-bold text-rose-600 dark:text-rose-400 hover:underline"
                >
                  Forget
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function DevicesTab() {
  const [tokens, setTokens] = useState<DeviceToken[]>([]);
  const [label, setLabel] = useState("");
  const [newToken, setNewToken] = useState<NewDeviceToken | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  function loadTokens() {
    api
      .get<{ tokens: DeviceToken[] }>("/api/auth/devices")
      .then((d) => setTokens(d.tokens || []))
      .catch(() => {});
  }

  useEffect(loadTokens, []);

  async function handleGenerate() {
    if (!label.trim()) {
      setError("Give the device a name first (e.g. \"Alex's watch\").");
      return;
    }
    setBusy(true);
    setError("");
    setCopied(false);
    try {
      const created = await api.post<NewDeviceToken>("/api/auth/devices", { label: label.trim() });
      setNewToken(created);
      setLabel("");
      loadTokens();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to generate a token.");
    } finally {
      setBusy(false);
    }
  }

  async function handleRevoke(id: string) {
    if (!window.confirm("Revoke this device? It will need a new token to sign in again.")) return;
    try {
      await api.del(`/api/auth/devices/${id}`);
      setTokens((prev) => prev.filter((t) => t.id !== id));
      if (newToken?.id === id) setNewToken(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to revoke.");
    }
  }

  async function handleCopy() {
    if (!newToken) return;
    try {
      await navigator.clipboard.writeText(newToken.token);
      setCopied(true);
    } catch {
      // Clipboard access can be denied (permissions, non-HTTPS LAN context) --
      // the token is still selectable text in the box below either way.
    }
  }

  return (
    <div className="space-y-5 max-w-sm">
      <div className="space-y-2">
        <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wide">Paired devices</label>
        <p className="text-xs text-slate-500 dark:text-slate-400 leading-normal">
          A device token signs a device (like the Wear OS app) in without a password or a browser session — it can
          reach everything a normal login can, except the PIN-locked budget data, which stays off-limits to every
          device token regardless of the PIN.
        </p>

        <div className="flex gap-2">
          <input
            type="text"
            placeholder="Device name, e.g. Alex's watch"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            className="flex-1 px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
          />
          <button
            onClick={handleGenerate}
            disabled={busy}
            className="px-3 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg text-xs font-bold shrink-0"
          >
            {busy ? "Generating…" : "Generate"}
          </button>
        </div>

        {error && <p className="text-xs font-medium text-rose-600 dark:text-rose-400">{error}</p>}

        {newToken && (
          <div className="p-3 bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800/60 rounded-lg space-y-2">
            <p className="text-xs font-bold text-amber-800 dark:text-amber-400">
              Token for "{newToken.label}" — this is shown only once, copy it now:
            </p>
            <code className="block text-xs bg-white dark:bg-slate-950 border border-amber-200 dark:border-amber-800/60 rounded p-2 break-all select-all">
              {newToken.token}
            </code>
            <button
              onClick={handleCopy}
              className="text-xs font-bold text-amber-700 dark:text-amber-400 hover:underline"
            >
              {copied ? "Copied!" : "Copy to clipboard"}
            </button>
          </div>
        )}

        {tokens.length === 0 ? (
          <p className="text-xs text-slate-400 dark:text-slate-500 italic">No devices paired yet.</p>
        ) : (
          <div className="space-y-1.5">
            {tokens.map((t) => (
              <div
                key={t.id}
                className="flex items-center justify-between gap-2 p-2 bg-slate-50 dark:bg-slate-800/50 border border-slate-100 dark:border-slate-800 rounded-lg"
              >
                <span className="text-xs font-medium text-slate-700 dark:text-slate-300 truncate">
                  {t.label}
                  <span className="block text-[10px] text-slate-400 dark:text-slate-500 font-normal">
                    {t.lastUsedAt ? `Last used ${new Date(t.lastUsedAt).toLocaleString()}` : "Never used"}
                  </span>
                </span>
                <button
                  onClick={() => handleRevoke(t.id)}
                  className="shrink-0 text-xs font-bold text-rose-600 dark:text-rose-400 hover:underline"
                >
                  Revoke
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// The kiosk login itself (see forbidKiosk, auth.ts) is blocked from every
// route this tab calls -- it never even gets an entry point to this tab (see
// the tabs filter above) -- so everything here is for an already-signed-in
// household member setting up or resetting the shared device's credential.
function KioskTab() {
  const [status, setStatus] = useState<KioskLoginStatus | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [showRemoveForm, setShowRemoveForm] = useState(false);
  const [removePassword, setRemovePassword] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [busy, setBusy] = useState(false);

  function loadStatus() {
    api.get<KioskLoginStatus>("/api/auth/kiosk").then(setStatus).catch(() => {});
  }

  useEffect(loadStatus, []);

  async function handleSave() {
    setError("");
    setSuccess("");
    if (password !== confirmPassword) {
      setError("New passwords don't match.");
      return;
    }
    if (!currentPassword) {
      setError("Enter your own account password to confirm.");
      return;
    }
    setBusy(true);
    try {
      const result = await api.put<{ username: string }>("/api/auth/kiosk", { username, password, currentPassword });
      setUsername("");
      setPassword("");
      setConfirmPassword("");
      setCurrentPassword("");
      setShowForm(false);
      setSuccess(`Kiosk login saved as "${result.username}".`);
      loadStatus();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to save the kiosk login.");
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove() {
    if (!removePassword) {
      setError("Enter your own account password to confirm.");
      return;
    }
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      await api.del("/api/auth/kiosk", { currentPassword: removePassword });
      setShowRemoveForm(false);
      setRemovePassword("");
      setSuccess("Kiosk login removed. That device will need a new one to sign back in.");
      loadStatus();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to remove the kiosk login.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4 max-w-sm">
      <div className="space-y-2">
        <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wide">Kiosk login</label>
        <p className="text-xs text-slate-500 dark:text-slate-400 leading-normal">
          A separate sign-in for an always-on shared screen (the fridge, a wall tablet). It can use every
          section — Groceries, Pantry, Meal Plan, Family, Calendar, Chores, Fridge, the assistant — the same
          as a normal login. Budget is the one place it's narrower: it only ever sees shared transactions,
          budgets and accounts, never anyone's personal ones, and it still needs the budget PIN like anyone
          else. It can't pair a device token, download the full database backup, or manage its own login or
          the household/lock PINs.
        </p>

        {!status ? (
          <p className="text-xs text-slate-400">Loading…</p>
        ) : (
          <div className="p-3 bg-slate-50 dark:bg-slate-800/50 border border-slate-100 dark:border-slate-800 rounded-lg">
            <span className="text-xs font-medium text-slate-700 dark:text-slate-300">
              {status.exists ? (
                <>
                  Signed in as <span className="font-semibold">@{status.username}</span>
                </>
              ) : (
                "No kiosk login set up yet."
              )}
            </span>
          </div>
        )}

        {showForm ? (
          <div className="space-y-2 p-3 border border-slate-200 dark:border-slate-700 rounded-lg">
            <input
              type="text"
              placeholder="Kiosk username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 rounded-lg text-sm"
            />
            <input
              type="password"
              autoComplete="new-password"
              placeholder="Kiosk password (min 8 characters)"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 rounded-lg text-sm"
            />
            <input
              type="password"
              autoComplete="new-password"
              placeholder="Confirm kiosk password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 rounded-lg text-sm"
            />
            <input
              type="password"
              placeholder="Your account password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 rounded-lg text-sm"
            />
            <div className="flex gap-2">
              <button
                onClick={() => { setShowForm(false); setUsername(""); setPassword(""); setConfirmPassword(""); setCurrentPassword(""); setError(""); }}
                className="flex-1 py-1.5 border border-slate-300 dark:border-slate-700 rounded-lg text-xs font-bold text-slate-600 dark:text-slate-400"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={busy}
                className="flex-1 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg text-xs font-bold"
              >
                {busy ? "Saving…" : status?.exists ? "Reset kiosk login" : "Create kiosk login"}
              </button>
            </div>
          </div>
        ) : showRemoveForm ? (
          <div className="space-y-2 p-3 border border-slate-200 dark:border-slate-700 rounded-lg">
            <p className="text-xs text-slate-600 dark:text-slate-400">
              That device will be signed out immediately and need a new login to get back in.
            </p>
            <input
              type="password"
              placeholder="Your account password"
              value={removePassword}
              onChange={(e) => setRemovePassword(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleRemove(); }}
              className="w-full px-3 py-2 border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 rounded-lg text-sm"
            />
            <div className="flex gap-2">
              <button
                onClick={() => { setShowRemoveForm(false); setRemovePassword(""); setError(""); }}
                className="flex-1 py-1.5 border border-slate-300 dark:border-slate-700 rounded-lg text-xs font-bold text-slate-600 dark:text-slate-400"
              >
                Cancel
              </button>
              <button
                onClick={handleRemove}
                disabled={busy}
                className="flex-1 py-1.5 bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white rounded-lg text-xs font-bold"
              >
                {busy ? "Removing…" : "Remove kiosk login"}
              </button>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => { setShowForm(true); setError(""); setSuccess(""); }}
              className="py-2 px-3 bg-blue-50 dark:bg-blue-950/20 hover:bg-blue-100 dark:hover:bg-blue-950/40 border border-blue-200 dark:border-blue-800/60 rounded-lg text-xs font-bold text-blue-700 dark:text-blue-400"
            >
              {status?.exists ? "Reset kiosk login" : "Create kiosk login"}
            </button>
            <button
              onClick={() => { setShowRemoveForm(true); setError(""); setSuccess(""); }}
              disabled={!status?.exists}
              className="py-2 px-3 border border-slate-300 dark:border-slate-700 disabled:opacity-40 rounded-lg text-xs font-bold text-slate-600 dark:text-slate-400"
            >
              Remove
            </button>
          </div>
        )}

        {error && <p className="text-xs font-medium text-rose-600 dark:text-rose-400">{error}</p>}
        {success && <p className="text-xs font-medium text-emerald-600 dark:text-emerald-400">{success}</p>}
      </div>

      <KioskFoodAccess />
    </div>
  );
}
