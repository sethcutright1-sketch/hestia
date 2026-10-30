// The app's root component (rendered by main.tsx, the real entry point --
// this is where the interesting structure lives). Three jobs: check
// auth/render AuthGate if signed out, render the header/nav, and swap in
// whichever section component is selected. `section` is plain useState, not
// a router -- there's only ever one URL, so there's nothing for a router to
// sync against. It does track a URL hash (see hashSegment / resolveSection in
// startSection.ts), just not through a routing library: with exactly one
// param to persist, a hash listener is the whole job a router would otherwise
// do here.
import { useEffect, useRef, useState } from "react";
import { Home, ShoppingCart, Refrigerator, ChefHat, Apple, Wallet, CalendarDays, ListChecks, LogOut, Sparkles, Users, X, Snowflake, Lock, LockOpen, Sun, Moon, UserCog, Maximize, Minimize } from "lucide-react";
import { api, type AuthStatus, type FoodDiaryPinStatus, type LockStatus, type SessionUser } from "./api.ts";
import AuthGate from "./AuthGate.tsx";
import Assistant from "./Assistant.tsx";
import PinPrompt from "./PinPrompt.tsx";
import AdminSettings from "./AdminSettings.tsx";
import type { KrogerReturn } from "./KrogerSettings.tsx";
import { useLiveRefresh } from "./useLiveRefresh.ts";
import { KIOSK } from "./kiosk.ts";
import { hashSegment, resolveSection } from "./startSection.ts";
import Grocery from "./sections/Grocery.tsx";
import Pantry from "./sections/Pantry.tsx";
import MealPlan from "./sections/MealPlan.tsx";
import Members from "./sections/Members.tsx";
import Budget from "./sections/Budget.tsx";
import Calendar from "./sections/Calendar.tsx";
import Fridge from "./sections/Fridge.tsx";
import Chores from "./sections/Chores.tsx";
import Food from "./sections/Food.tsx";

type Section = "grocery" | "pantry" | "mealplan" | "family" | "food" | "budget" | "calendar" | "chores" | "fridge";

// Family sits next to Meal Plan on purpose: who's in the household and what
// they won't eat is what drives the per-person meal tabs and the dislike
// warnings next to a planned meal, so the two get used together. It used to be
// two places at once -- a roster editor buried at the bottom of Meal Plan and a
// second copy behind Settings -- which meant edits made in one spot only showed
// up in the other after a refresh, and the Meal Plan copy silently couldn't
// edit likes or rename anyone.
//
// Food (the signed-in person's own food diary) comes after Family. The kiosk
// login has no diary, so it never sees that button (see `available` below).
const SECTIONS: { id: Section; label: string; icon: typeof Home }[] = [
  { id: "grocery", label: "Groceries", icon: ShoppingCart },
  { id: "pantry", label: "Pantry", icon: Refrigerator },
  { id: "mealplan", label: "Meal Plan", icon: ChefHat },
  { id: "family", label: "Family", icon: Users },
  { id: "food", label: "Food", icon: Apple },
  { id: "budget", label: "Budget", icon: Wallet },
  { id: "calendar", label: "Calendar", icon: CalendarDays },
  { id: "chores", label: "Chores", icon: ListChecks },
  { id: "fridge", label: "Fridge", icon: Snowflake },
];

// Which section shows comes from startSection.ts. Only the first hash segment
// names a section -- anything after a "/" is a section's own business (e.g.
// Chores.tsx reads "#chores/parent" itself to pick its Kid/Parent sub-tab).
// Splitting there, rather than requiring every hash to be an exact section id,
// is what lets that sub-hash round-trip through browser back/forward without
// bouncing away. With no usable hash, a phone opens the Food diary and
// everything else (tablet, PC, kiosk) opens the Calendar.

export default function App() {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [user, setUser] = useState<SessionUser | null>(null);
  // The section named by the URL hash ("" when none). What actually shows is `section`, further down: this
  // when the signed-in login can use it, else the start page.
  const [hashSection, setHashSection] = useState<string>(() => hashSegment(location.hash));
  // Bumped each time the PIN prompt succeeds, so the Food section can clear a lock the server reported.
  const [unlockCount, setUnlockCount] = useState(0);
  // Does this login lock its food diary behind the household PIN? (GET /api/nutrition/settings/pin; the kiosk has no diary.)
  const [foodPinRequired, setFoodPinRequired] = useState(false);
  // The start page for this sign-in, worked out once: a window resized later must not flip the section under you.
  const startRef = useRef<{ userId: string; section: Section } | null>(null);
  const [assistantOpen, setAssistantOpen] = useState(false);
  // The phone bottom sheet starts just below the header instead of at a fixed
  // 85% height: below md the header wraps to two rows, so 85% ran up over it.
  // Measured rather than hardcoded because that wrap depends on width. A
  // callback ref (state, not useRef) because the header only mounts once
  // sign-in resolves, after this component's first render.
  const [headerEl, setHeaderEl] = useState<HTMLElement | null>(null);
  const [headerHeight, setHeaderHeight] = useState(0);
  useEffect(() => {
    if (!headerEl) return;
    const observer = new ResizeObserver(() => setHeaderHeight(headerEl.offsetHeight));
    observer.observe(headerEl);
    return () => observer.disconnect();
  }, [headerEl]);
  // Bumped when the assistant changes data, so the visible section re-reads it
  // instead of showing a stale copy.
  const [dataVersion, setDataVersion] = useState(0);

  const [lockStatus, setLockStatus] = useState<LockStatus | null>(null);
  const [pinPromptOpen, setPinPromptOpen] = useState(false);
  const [adminSettingsOpen, setAdminSettingsOpen] = useState(false);
  // Kroger's sign-in sends the admin back to /?kroger=connected (or =failed&reason=...), see
  // routes/kroger.ts. Read once, then dropped from the address bar so a reload doesn't repeat it;
  // the settings panel reopens on Groceries to say how it went.
  const [krogerReturn, setKrogerReturn] = useState<KrogerReturn | null>(() => {
    const params = new URLSearchParams(location.search);
    const result = params.get("kroger");
    if (result !== "connected" && result !== "failed") return null;
    const reason = params.get("reason");
    params.delete("kroger");
    params.delete("reason");
    const query = params.toString();
    history.replaceState(null, "", `${location.pathname}${query ? `?${query}` : ""}${location.hash}`);
    return { result, reason };
  });

  // Stage 0.3: hoisted here from Budget's own SettingsModal, which is now the
  // only place this state lives -- previously toggling dark mode only worked
  // from inside the Budget section, even though every section now has dark:
  // classes. Same key as index.html's pre-paint boot script reads, so there's
  // no flash on load.
  const [darkMode, setDarkMode] = useState<boolean>(() => {
    const stored = localStorage.getItem("household_dark");
    return stored === null ? window.matchMedia("(prefers-color-scheme: dark)").matches : stored === "true";
  });

  useEffect(() => {
    localStorage.setItem("household_dark", String(darkMode));
    document.documentElement.classList.toggle("dark", darkMode);
  }, [darkMode]);
  // What to do once the PIN prompt succeeds -- e.g. actually switch to Budget,
  // for the click that opened the prompt in the first place. A ref because
  // storing a plain function in useState needs the `() => fn` two-step;
  // nothing here needs to be reactive.
  const pendingAfterUnlock = useRef<(() => void) | null>(null);

  // Tracks OS/browser-level fullscreen (the address bar / chrome hidden),
  // distinct from any in-page "maximized" notion. Kept in sync via
  // fullscreenchange rather than only set on click, since the user can also
  // leave fullscreen with Escape or the browser's own controls.
  const [isFullscreen, setIsFullscreen] = useState(() => !!document.fullscreenElement);

  useEffect(() => {
    function onFullscreenChange() {
      setIsFullscreen(!!document.fullscreenElement);
    }
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  function toggleFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      // .catch swallows NotAllowedError -- e.g. if this somehow fires outside
      // a direct user gesture, or the page is embedded in a context (an
      // iframe without allowfullscreen) that refuses the request.
      document.documentElement.requestFullscreen().catch(() => {});
    }
  }

  useEffect(() => {
    api.get<AuthStatus>("/api/auth/status")
      .then((s) => { setStatus(s); setUser(s.user); })
      .catch(() => setStatus({ userCount: 0, canRegister: true, authenticated: false, user: null }));
  }, []);

  function refreshLockStatus() {
    api.get<LockStatus>("/api/lock/status").then(setLockStatus).catch(() => {});
    if (user && user.role !== "kiosk") {
      api.get<FoodDiaryPinStatus>("/api/nutrition/settings/pin").then((s) => setFoodPinRequired(s.requirePin)).catch(() => {});
    }
  }

  useEffect(() => {
    if (user) refreshLockStatus();
  }, [user]);

  // Back from Kroger's sign-in: only an admin can have started it, so only an admin gets the panel.
  useEffect(() => {
    if (user && krogerReturn) {
      if (user.role === "admin") setAdminSettingsOpen(true);
      else setKrogerReturn(null);
    }
  }, [user]);

  // Kiosk polls faster (30s) since it's the screen someone's standing in front
  // of expecting to see the relock actually happen; a phone/desktop checks less
  // often. GET /status never itself extends the unlock window (only routes
  // behind requireUnlocked do that -- see auth.ts), so polling this can never
  // hold a lock open on its own.
  useLiveRefresh(refreshLockStatus, KIOSK ? 30_000 : 60_000);

  // Keeps the section in sync with browser back/forward and a hash typed or
  // bookmarked directly, so a fridge parked on e.g. #mealplan and power-cycled
  // comes back to the same place instead of resetting to the start page.
  useEffect(() => {
    function onHashChange() {
      setHashSection(hashSegment(location.hash));
    }
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  // Escape closes the assistant. Matters most on a phone, where it covers the
  // section as a sheet rather than sitting beside it.
  useEffect(() => {
    if (!assistantOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setAssistantOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [assistantOpen]);

  function navigateToSection(id: Section) {
    location.hash = id;
    setHashSection(id);
  }

  // One household PIN lock, shared by Budget and the Chores tab's "Manage"
  // area (the owner's decision: reuse the existing lock rather than invent a
  // second PIN) -- the variable name predates Chores using it too, kept
  // as-is since renaming it would touch every line below that already reads it.
  const budgetLocked = !!(lockStatus?.pinSet && !lockStatus.unlocked);
  // A kiosk login reaches every section like a real member -- see forbidKiosk's
  // comment (auth.ts) for what it's actually blocked from. This only affects
  // what Budget itself shows (hiding the full-database-backup button, which
  // stays blocked at the server regardless of section access).
  const isKioskAccount = user?.role === "kiosk";
  // Account/security settings tier -- see requireAdmin's comment (auth.ts).
  const isAdmin = user?.role === "admin";

  // The food diary is locked only for a login that turned on "Require the PIN for my food diary", and only
  // while the household PIN is set and not entered; the server enforces it the same way it does Budget.
  const foodLocked = foodPinRequired && budgetLocked;

  function handleNavClick(id: Section) {
    if ((id === "budget" && budgetLocked) || (id === "food" && foodLocked)) {
      pendingAfterUnlock.current = () => navigateToSection(id);
      setPinPromptOpen(true);
      return;
    }
    navigateToSection(id);
  }

  function openUnlockPrompt() {
    pendingAfterUnlock.current = null;
    setPinPromptOpen(true);
  }

  function handleUnlocked() {
    refreshLockStatus();
    setUnlockCount((n) => n + 1);
    pendingAfterUnlock.current?.();
    pendingAfterUnlock.current = null;
  }

  async function lockNow() {
    await api.post("/api/lock/lock").catch(() => {});
    refreshLockStatus();
  }

  async function signOut() {
    await api.post("/api/auth/logout");
    setUser(null);
    const s = await api.get<AuthStatus>("/api/auth/status");
    setStatus(s);
  }

  if (!status) {
    return <div className="min-h-full flex items-center justify-center text-sm text-slate-500">Loading…</div>;
  }

  if (!user) {
    return <AuthGate status={status} onSignedIn={setUser} />;
  }

  // The kiosk login has no food diary, so Food isn't offered to it (the server refuses it too).
  const visibleSections = SECTIONS.filter((s) => !(s.id === "food" && isKioskAccount));
  const available = visibleSections.map((s) => s.id);
  if (startRef.current?.userId !== user.id) {
    startRef.current = {
      userId: user.id,
      section: resolveSection({ hash: "", available, role: user.role, kioskDevice: KIOSK, widthPx: window.innerWidth }) as Section,
    };
  }
  const section: Section = available.includes(hashSection as Section) ? (hashSection as Section) : startRef.current.section;

  // Nine sections have to fit on one 375px row as icons, so the padding is tighter below `sm`.
  const navPad = KIOSK ? "px-4 py-3" : "px-2 sm:px-3 py-1.5";
  // Nine sections plus the header's other controls don't fit as icon+text
  // below `xl` (kiosk: `lg`, since kiosk nav padding is already bigger) --
  // labels show only from there up; below it, icons plus each button's
  // `title` are the whole affordance.
  const navLabelClass = KIOSK ? "hidden lg:inline" : "hidden xl:inline";

  return (
    // h-full rather than h-screen: html/body/#root are already 100%, and on mobile
    // browsers 100vh is the *expanded* viewport, so h-screen pushed the assistant's
    // input box down under the address bar.
    <div className="h-full flex flex-col">
      <header ref={setHeaderEl} className="border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
        {/* Nine nav icons plus the logo, Assistant, dark-mode, account and
            sign-out controls don't fit on one 56px-tall row below `md` even
            with the wordmark and nav labels gone (see navLabelClass) -- so
            below `md` the row wraps and nav (order-3, w-full) drops to its
            own second line instead of hiding icons behind a hidden
            scrollbar. At `md` and up there's room for one row again. */}
        <div className="max-w-6xl mx-auto px-4 py-2 md:h-14 md:py-0 flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="flex items-center gap-2 font-semibold shrink-0">
            <div className="p-1.5 rounded-lg bg-blue-600 text-white">
              <Home size={16} />
            </div>
            {/* The wordmark is the first thing to go at 375px -- the logo and
                right-side controls alone are tight enough on the top row
                without it. */}
            <span className="hidden sm:inline">Household</span>
          </div>

          <nav className="flex flex-wrap gap-1 order-3 w-full md:order-none md:w-auto md:ml-2">
            {visibleSections.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => handleNavClick(id)}
                className={`relative ${navPad} rounded-lg text-sm flex items-center gap-1.5 shrink-0 ${
                  section === id
                    ? "bg-slate-200 dark:bg-slate-800 font-medium"
                    : "text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
                }`}
                aria-label={label}
                title={label}
              >
                <Icon size={15} />
                <span className={navLabelClass}>{label}</span>
                {/* Cosmetic -- the actual gate is requireUnlocked on the server
                    (auth.ts). This just tells you not to bother clicking yet. */}
                {((id === "budget" && budgetLocked) || (id === "food" && foodLocked)) && (
                  <Lock size={11} className="absolute -top-1 -right-1 text-amber-500 bg-white dark:bg-slate-900 rounded-full p-0.5" />
                )}
              </button>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-2 shrink-0">
            {lockStatus?.pinSet && lockStatus.unlocked && (
              <button
                onClick={lockNow}
                className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500 dark:text-slate-400"
                aria-label="Lock budget data now"
                title="Lock budget data now"
              >
                <LockOpen size={16} />
              </button>
            )}
            <button
              onClick={() => setAssistantOpen((v) => !v)}
              className={`px-3 py-1.5 rounded-lg text-sm flex items-center gap-1.5 ${
                assistantOpen ? "bg-blue-600 text-white" : "hover:bg-slate-100 dark:hover:bg-slate-800"
              }`}
              aria-label="Assistant"
              aria-expanded={assistantOpen}
            >
              <Sparkles size={15} />
              <span className="hidden sm:inline">Assistant</span>
            </button>
            <button
              onClick={toggleFullscreen}
              className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500 dark:text-slate-400"
              aria-label={isFullscreen ? "Exit full screen" : "Enter full screen"}
              title={isFullscreen ? "Exit full screen" : "Enter full screen"}
            >
              {isFullscreen ? <Minimize size={16} /> : <Maximize size={16} />}
            </button>
            {/* Kiosk devices (the fridge, a wall tablet) shouldn't be one tap
                from a login screen nobody at the fridge can type into. */}
            <button
              onClick={() => setDarkMode((v) => !v)}
              className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500 dark:text-slate-400"
              aria-label={darkMode ? "Switch to light mode" : "Switch to dark mode"}
              title={darkMode ? "Switch to light mode" : "Switch to dark mode"}
            >
              {darkMode ? <Sun size={16} /> : <Moon size={16} />}
            </button>
            {!KIOSK && (
              <>
                <button
                  onClick={() => setAdminSettingsOpen(true)}
                  className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500 dark:text-slate-400 flex items-center gap-1.5 text-sm"
                  aria-label="Account and household settings"
                  title="Account and household settings"
                >
                  <UserCog size={16} />
                  <span className="hidden md:inline">{user.displayName}</span>
                </button>
                <button onClick={signOut} className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800" aria-label="Sign out">
                  <LogOut size={16} />
                </button>
              </>
            )}
          </div>
        </div>
      </header>

      <div className="flex-1 flex min-h-0">
        <main className="flex-1 overflow-y-auto">
          <div className="max-w-6xl mx-auto p-4 md:p-6">
            {section === "grocery" && <Grocery key={dataVersion} />}
            {section === "pantry" && <Pantry key={dataVersion} />}
            {section === "mealplan" && <MealPlan key={dataVersion} onRequestUnlock={openUnlockPrompt} canCalculateCalories={!isKioskAccount} isKioskLogin={isKioskAccount} />}
            {section === "family" && <Members key={dataVersion} isAdmin={isAdmin} />}
            {section === "food" && <Food key={dataVersion} locked={foodLocked} onRequestUnlock={openUnlockPrompt} unlockCount={unlockCount} refreshLockStatus={refreshLockStatus} />}
            {section === "budget" && (
              <Budget key={dataVersion} locked={budgetLocked} onRequestUnlock={openUnlockPrompt} isKioskAccount={isKioskAccount} isAdmin={isAdmin} />
            )}
            {section === "calendar" && (
              <Calendar key={dataVersion} locked={budgetLocked} onRequestUnlock={openUnlockPrompt} />
            )}
            {section === "chores" && (
              <Chores
                key={dataVersion}
                locked={budgetLocked}
                lockStatus={lockStatus}
                onRequestUnlock={openUnlockPrompt}
                lockNow={lockNow}
                refreshLockStatus={refreshLockStatus}
              />
            )}
            {section === "fridge" && <Fridge key={dataVersion} />}
          </div>
        </main>

        {assistantOpen && (
          <>
            {/* Phone only. At md and up the assistant sits beside the section, so
                there is nothing to dim and nothing to tap through to. */}
            <div
              className="fixed inset-x-0 bottom-0 z-30 bg-slate-900/40 md:hidden"
              style={{ top: headerHeight }}
              onClick={() => setAssistantOpen(false)}
              aria-hidden="true"
            />

            {/* One element, two shapes: a bottom sheet under md, the original side
                panel at md and up. Deliberately not two <Assistant> instances --
                that would be two conversations and two tool-manifest fetches,
                diverging the moment the window crossed the breakpoint. */}
            <aside
              aria-label="Assistant"
              // `top` only takes effect while fixed (below md); md:static ignores it.
              style={{ top: headerHeight + 8 }}
              className="fixed inset-x-0 bottom-0 z-40 rounded-t-2xl shadow-2xl border-t border-slate-200 dark:border-slate-800 md:static md:z-auto md:h-auto md:w-full md:max-w-sm md:rounded-none md:shadow-none md:border-t-0 md:border-l bg-slate-50 dark:bg-slate-900 flex flex-col min-h-0"
            >
              {/* The header's Assistant button can scroll out of reach on a narrow
                  nav, so the sheet carries its own way out. */}
              <div className="md:hidden flex items-center justify-between px-4 py-2 border-b border-slate-200 dark:border-slate-800 shrink-0">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <Sparkles size={15} /> Assistant
                </div>
                <button
                  onClick={() => setAssistantOpen(false)}
                  className="p-1.5 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-800"
                  aria-label="Close assistant"
                >
                  <X size={16} />
                </button>
              </div>

              {/* Assistant is h-full; this wrapper is what gives it a bounded height
                  to be 100% of, once the sheet header has taken its share. */}
              <div className="flex-1 min-h-0">
                <Assistant
                  onMutated={() => setDataVersion((v) => v + 1)}
                  financialLocked={budgetLocked}
                  onRequestUnlock={openUnlockPrompt}
                />
              </div>
            </aside>
          </>
        )}
      </div>

      {pinPromptOpen && (
        <PinPrompt
          defaultTrusted={!KIOSK}
          onClose={() => setPinPromptOpen(false)}
          onUnlocked={handleUnlocked}
        />
      )}

      {adminSettingsOpen && (
        <AdminSettings
          onClose={() => {
            setAdminSettingsOpen(false);
            setKrogerReturn(null);
            refreshLockStatus();
          }}
          initialTab={krogerReturn ? "groceries" : undefined}
          krogerReturn={krogerReturn}
          user={user}
          lockStatus={lockStatus}
          refreshLockStatus={refreshLockStatus}
          lockNow={lockNow}
        />
      )}
    </div>
  );
}
