// The PIN lock in front of financial data (Stage: always-on). Budget/backup
// routes and the assistant's financial tools sit behind requireUnlocked
// (auth.ts); this file is how a session actually becomes unlocked, and how
// the PIN itself gets set, changed, or removed.
//
// Deliberately one shared PIN, not a per-user one -- there's already one
// shared household login (see auth.ts), and a second per-person secret here
// would just be one more thing to keep straight. Anyone who can sign in and
// knows the PIN can unlock; anyone who can sign in and knows the *account*
// password can always set a new PIN (see PUT /pin below) even if the PIN
// itself is forgotten.
import express from "express";
import bcrypt from "bcryptjs";
import { getConfig, setConfig } from "../db.ts";
import { currentUserId, requireUnlocked, verifyPassword, requireAdmin } from "../auth.ts";
import { appendSecurityEvent as logSecurityEvent } from "../securityLog.ts";
import { authAttempts, tooManyAttempts, unlockKey } from "../rateLimit.ts";

export const lockRoutes = express.Router();

const PIN_PATTERN = /^\d{4,6}$/;
const DEFAULT_KIOSK_MINUTES = 5;
const DEFAULT_TRUSTED_MINUTES = 120;
const MIN_TIMEOUT_MINUTES = 1;
const MAX_TIMEOUT_MINUTES = 1440; // 24h

function pinHash(): string | null {
  return getConfig("lock_pin_hash", null);
}

function kioskMinutes(): number {
  return getConfig("lock_timeout_kiosk_minutes", DEFAULT_KIOSK_MINUTES);
}

function trustedMinutes(): number {
  return getConfig("lock_timeout_trusted_minutes", DEFAULT_TRUSTED_MINUTES);
}

// A 4-6 digit PIN is a small space (10,000-1,000,000 codes) -- rate limiting is not
// optional. The limiter is the shared one in rateLimit.ts (also behind login and register),
// keyed on the session id + address, so devices behind the same Tailscale exit or home NAT
// don't share one budget. A device token is refused outright below: a cookie-less request
// gets a new session id every time, which is how the old per-session limiter was bypassed
// (the project notes 10.4), and a token can never reach Budget anyway (requireUnlocked).

// Reachable while locked -- the client needs this to know whether to show a
// "set a PIN" nudge or an unlock keypad in the first place.
lockRoutes.get("/status", (req, res) => {
  const hash = pinHash();
  const unlockedUntil = req.session.unlockedUntil ?? 0;
  res.json({
    pinSet: !!hash,
    unlocked: !hash || unlockedUntil > Date.now(),
    unlockedUntil: hash ? unlockedUntil : null,
    kioskMinutes: kioskMinutes(),
    trustedMinutes: trustedMinutes(),
  });
});

lockRoutes.post("/unlock", async (req, res) => {
  if (req.deviceUserId) return res.status(403).json({ error: "Unlock from a signed-in browser, not a paired device." });
  const hash = pinHash();
  if (!hash) return res.json({ success: true, unlocked: true }); // nothing to unlock

  const attemptKey = unlockKey(req);
  const limited = authAttempts.status(attemptKey);
  if (limited.locked) return tooManyAttempts(res, limited);

  const { code, trusted } = req.body || {};
  if (typeof code !== "string" || !PIN_PATTERN.test(code) || !(await bcrypt.compare(code, hash))) {
    const lockedOut = authAttempts.fail(attemptKey);
    logSecurityEvent("Incorrect PIN entered.", "warning");
    if (lockedOut) logSecurityEvent("PIN entry paused after repeated wrong PINs.", "critical");
    return res.status(401).json({ error: "Incorrect PIN." });
  }

  authAttempts.clear(attemptKey);
  req.session.lockTrusted = trusted === true;
  const minutes = req.session.lockTrusted ? trustedMinutes() : kioskMinutes();
  req.session.unlockedUntil = Date.now() + minutes * 60_000;
  res.json({ success: true, unlocked: true, unlockedUntil: req.session.unlockedUntil, trusted: req.session.lockTrusted });
});

lockRoutes.post("/lock", (req, res) => {
  req.session.unlockedUntil = 0;
  res.json({ success: true });
});

lockRoutes.put("/settings", requireUnlocked, requireAdmin, (req, res) => {
  const { kioskMinutes: kMin, trustedMinutes: tMin } = req.body || {};
  const clamp = (n: unknown, fallback: number) =>
    typeof n === "number" && Number.isFinite(n)
      ? Math.min(MAX_TIMEOUT_MINUTES, Math.max(MIN_TIMEOUT_MINUTES, Math.round(n)))
      : fallback;

  setConfig("lock_timeout_kiosk_minutes", clamp(kMin, kioskMinutes()));
  setConfig("lock_timeout_trusted_minutes", clamp(tMin, trustedMinutes()));
  res.json({ success: true, kioskMinutes: kioskMinutes(), trustedMinutes: trustedMinutes() });
});

// No requireUnlocked here, deliberately: this is the recovery path for a
// forgotten PIN. Anyone who knows the *account* password (already re-checked
// the same way /api/backup/download does) can set a new one even from a
// fully locked session -- and it's also how the very first PIN gets set,
// before there's anything to unlock.
lockRoutes.put("/pin", requireAdmin, async (req, res) => {
  const { pin, password } = req.body || {};
  if (typeof pin !== "string" || !PIN_PATTERN.test(pin)) {
    return res.status(400).json({ error: "PIN must be 4-6 digits." });
  }
  if (!(await verifyPassword(currentUserId(req), password))) {
    return res.status(401).json({ error: "Incorrect password." });
  }

  const hadPinAlready = !!pinHash();
  setConfig("lock_pin_hash", await bcrypt.hash(pin, 12));
  logSecurityEvent(hadPinAlready ? "PIN changed." : "PIN set.", "success");
  res.json({ success: true });
});

lockRoutes.delete("/pin", requireUnlocked, requireAdmin, async (req, res) => {
  const { password } = req.body || {};
  if (!(await verifyPassword(currentUserId(req), password))) {
    return res.status(401).json({ error: "Incorrect password." });
  }

  setConfig("lock_pin_hash", null);
  logSecurityEvent("PIN lock removed.", "warning");
  res.json({ success: true });
});
