// Which section opens when the URL names none, and which hash names a section at all. Pure, so it
// can be tested without a browser; App.tsx supplies the facts (who is signed in, how wide the
// screen is, whether this device is in kiosk mode).
//
// With no section in the hash:
//   - the kiosk login, and a device running in kiosk mode, open the Calendar;
//   - a phone (narrower than the `md` breakpoint, 768px, the width the header already switches
//     layout at) opens the Food diary;
//   - a tablet or PC opens the Calendar.
// A hash that names a section the signed-in login can use always wins.

export const PHONE_BREAKPOINT_PX = 768;

/** "Phone" = narrower than the header's own `md` breakpoint. */
export const isPhoneWidth = (widthPx: number): boolean => widthPx < PHONE_BREAKPOINT_PX;

/** The first "/"-separated segment of a location hash ("#chores/parent" -> "chores"); "" when there is none. */
export const hashSegment = (hash: string): string => hash.replace(/^#/, "").split("/")[0];

export interface StartFacts {
  /** location.hash */
  hash: string;
  /** The section ids this login can reach (Food is not among them for the kiosk login). */
  available: readonly string[];
  /** The signed-in login's role. */
  role: string | undefined;
  /** This device runs in kiosk mode (?kiosk=1), whoever is signed in. */
  kioskDevice: boolean;
  /** window.innerWidth */
  widthPx: number;
}

export function resolveSection(f: StartFacts): string {
  const named = hashSegment(f.hash);
  if (named && f.available.includes(named)) return named;
  const kiosk = f.role === "kiosk" || f.kioskDevice;
  const wanted = !kiosk && isPhoneWidth(f.widthPx) ? "food" : "calendar";
  // If the wanted section isn't reachable (it always is today), fall back to the first one there is.
  return f.available.includes(wanted) ? wanted : f.available[0] ?? "calendar";
}
