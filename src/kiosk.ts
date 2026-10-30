// Split out from App.tsx so sections can read this without importing the root
// component (which imports every section itself -- a circular import). Read
// once at module scope, not inside a component: it never changes for the
// life of the page, and a re-render must never lose it.
//
// Sticky per device: `?kiosk=1` turns kiosk mode on AND remembers it in
// localStorage, so a later load without the param (the fridge's browser
// autocompleting the address down to `/?`, a power cycle landing on a bare
// URL) stays in kiosk mode. `?kiosk=0` turns it off and forgets it -- the only
// way out, since kiosk mode hides sign-out. Any other value of `kiosk`
// (including the bare `?kiosk`) counts as on, same as before this was sticky.
// If storage is unavailable, it falls back to the URL alone.
//
// Not a security boundary anywhere it's used -- see auth.ts's requireUnlocked
// for the actual PIN-lock gate. This only ever picks a UI default (the unlock
// prompt's "keep this device unlocked longer" checkbox), a poll interval, or
// which tabs/controls are shown.
const STORAGE_KEY = "household.kiosk";

function readKiosk(): boolean {
  const param = new URLSearchParams(location.search).get("kiosk");
  try {
    if (param === "0") {
      localStorage.removeItem(STORAGE_KEY);
      return false;
    }
    if (param !== null) {
      localStorage.setItem(STORAGE_KEY, "1");
      return true;
    }
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return param !== null && param !== "0";
  }
}

export const KIOSK = readKiosk();
