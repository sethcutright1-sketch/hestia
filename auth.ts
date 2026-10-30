// Session-based auth: a login sets a signed, httpOnly cookie holding a session
// id; express-session looks that id up server-side (in a SQLite-backed store,
// see sessionStore.ts) and attaches req.session on every request after that.
// requireAuth below is the gate every other route sits behind (see how
// server.ts applies it: `app.use("/api/pantry", requireAuth, pantryRoutes)`);
// currentUserId() is how a handler learns *who* is asking once that gate has
// already passed.
import express from "express";
import session from "express-session";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { getUserByUsername, getUserById, getHouseholdMemberCount, createUser, updateUserPasswordHash, getConfig, setConfig, getDeviceTokenByHash, touchDeviceToken, hashDeviceToken, getKioskUser, deleteKioskUser, deleteSessionsForUser, deleteDeviceTokensForUser, deleteAllSessionsAndDeviceTokens } from "./db.ts";
import { SqliteSessionStore } from "./sessionStore.ts";
import { appendSecurityEvent } from "./securityLog.ts";
import { authAttempts, clientIp, loginKey, registerKey, tooManyAttempts } from "./rateLimit.ts";

// One login for the whole suite. Every section -- budget, groceries, calendar --
// reads the same session, so there is no cross-app identity to reconcile: there is
// just a signed-in user. Financial data is protected separately by the PIN lock
// below, not by a second account -- see isUnlocked/requireUnlocked.
//
// Raised from 2 for the Budget Sync import, then from 3 (2026-09-06) once the
// account cap actually blocked adding a real household member with the two
// test accounts already using up the other slots. PLAN.md's Stage 0.1 note
// still recommends replacing this with a configurable app_config setting once
// Stage 6.5 (child accounts) is actually built -- this is a stopgap number,
// not a redesign.
const MAX_HOUSEHOLD_USERS = 6;

declare global {
  namespace Express {
    interface Request {
      // Set by deviceTokenAuth when an Authorization: Bearer <token> header
      // matches a live device_tokens row. requireAuth/currentUserId treat
      // this the same as req.session.userId; requireUnlocked deliberately
      // does not -- see its own comment.
      deviceUserId?: string;
    }
  }
}

declare module "express-session" {
  interface SessionData {
    userId?: string;
    // Epoch ms until which this session may reach budget/backup/financial-tool
    // routes without re-entering the PIN. Sliding: requireUnlocked below bumps
    // it forward on every gated request, so active use never interrupts itself
    // and idling (e.g. walking away from the fridge) relocks it on its own.
    unlockedUntil?: number;
    // Set from the "keep this device unlocked longer" checkbox on the unlock
    // prompt -- decides which of the two configurable timeouts applies to this
    // session's sliding window. Never affects whether the lock applies, only
    // how long an unlock lasts.
    lockTrusted?: boolean;
  }
}

// Prefers an operator-set secret in .env.local (see .env.example) over one
// generated and remembered in the database, because POST /api/backup/download
// ships the whole database file to a browser and data/backups/ keeps 14 daily
// copies -- a secret stored in app_config would ride along inside every one of
// those. Falls back to generating + persisting one via getConfig/setConfig so
// the app still works with zero configuration.
function sessionSecret(): string {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  let secret = getConfig("session_secret", null) as string | null;
  if (!secret) {
    secret = crypto.randomBytes(32).toString("hex");
    setConfig("session_secret", secret);
  }
  return secret;
}

export function sessionMiddleware() {
  return session({
    store: new SqliteSessionStore(),
    secret: sessionSecret(),
    resave: false,
    saveUninitialized: false,
    // Refreshes cookie.expires (and, via SqliteSessionStore's touch(), the
    // stored row) on every response -- an always-on household screen is used
    // constantly, and a fixed 30-day clock from first login would eventually
    // expire it mid-use with no way to notice until it happened.
    rolling: true,
    name: "household.sid",
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      // "auto" marks the cookie `secure` only on requests that arrived over HTTPS (Cloudflare
      // Tunnel, Tailscale Serve), judged from req.secure. A plain `true` would break the LAN
      // address (http://192.168.x.x:3200): the browser never sends a secure cookie over HTTP,
      // so login would seem to work and then never stick. req.secure only believes
      // X-Forwarded-Proto from a loopback peer -- see `trust proxy` in server.ts.
      secure: "auto",
      maxAge: 30 * 24 * 60 * 60 * 1000,
    },
  });
}

/** Populates req.deviceUserId from an `Authorization: Bearer <token>` header,
 * if it matches a live device_tokens row -- a long-lived credential for
 * clients (the Wear OS app) that can't reasonably hold a username+password
 * or a rolling session cookie. Mounted globally, right after
 * sessionMiddleware() and before any route -- an invalid or missing header
 * just means "no device auth," same as a request with no cookie, so this
 * always calls next() rather than rejecting anything itself. */
export function deviceTokenAuth(req: express.Request, _res: express.Response, next: express.NextFunction) {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    const token = getDeviceTokenByHash(hashDeviceToken(header.slice("Bearer ".length)));
    if (token) {
      req.deviceUserId = token.owner_user_id;
      touchDeviceToken(token.id);
    }
  }
  next();
}

export function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const userId = req.session.userId ?? req.deviceUserId;
  if (!userId || !getUserById(userId)) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  next();
}

/** Gate for the one thing left that's "any real person, just not the kiosk"
 * rather than admin-only: pairing a device token for yourself (routes/devices.ts,
 * already scoped to the caller's own account). Everything that used to also sit
 * behind just this check -- the household/lock PIN, kiosk credential
 * management, Plaid credentials, backup download -- now needs requireAdmin
 * below instead, since those are shared household policy, not "am I a kiosk."
 * Everything else -- Groceries, Pantry, Meal Plan, Family, Calendar, Chores,
 * Fridge, Budget, the assistant -- is open to a kiosk login; Budget in
 * particular needs no special-casing here because getScopedItems' ownership
 * filter already limits a session that owns no personal rows of its own to
 * joint data, the same mechanism that keeps one real member from seeing
 * another's personal transactions. See server.ts for where this actually gets
 * mounted. Must run after requireAuth, which is what guarantees
 * getUserById(userId) below finds a real row. */
export function forbidKiosk(req: express.Request, res: express.Response, next: express.NextFunction) {
  const userId = req.session.userId ?? req.deviceUserId;
  const user = userId ? getUserById(userId) : undefined;
  if (user?.role === "kiosk") {
    return res.status(403).json({ error: "Not available to the kiosk login." });
  }
  next();
}

/** Gate for the account/security-settings tier: Plaid credentials, the
 * household PIN, the budget/lock PIN settings, kiosk login management, backup
 * download, the full budget reset, and the cloud-finance voice toggle. Strictly
 * stricter than forbidKiosk (a kiosk is never admin), so a route gated by this
 * doesn't also need forbidKiosk. A "parent" account -- today's full member
 * access otherwise -- is refused here the same as a kiosk is. Must run after
 * requireAuth, same reasoning as forbidKiosk above. */
export function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction) {
  const userId = req.session.userId ?? req.deviceUserId;
  const user = userId ? getUserById(userId) : undefined;
  if (user?.role !== "admin") {
    return res.status(403).json({ error: "Admins only." });
  }
  next();
}

/** True if no PIN has been configured yet, or this session's unlock window
 * hasn't expired. Does not itself extend the window -- see requireUnlocked. */
export function isUnlocked(req: express.Request): boolean {
  if (!getConfig("lock_pin_hash", null)) return true;
  return (req.session.unlockedUntil ?? 0) > Date.now();
}

/** Gate for budget routes, the backup download, and (applied manually, since
 * it only filters a tool list rather than rejecting a whole request) the
 * assistant's financial tools. Returns 423 Locked rather than 403 so the
 * client can tell "needs a PIN" apart from "wrong account" and show the
 * keypad instead of a generic error. */
export function requireUnlocked(req: express.Request, res: express.Response, next: express.NextFunction) {
  // A device token must never reach financial data, full stop -- independent
  // of PIN state and of whatever else this function checks below. Without
  // this line the same effect would usually hold anyway (a token request has
  // no unlockedUntil to have set), but that's incidental to how sessions
  // happen to work, not a guarantee -- this makes the rule explicit.
  if (req.deviceUserId) return res.status(423).json({ error: "locked" });
  if (!isUnlocked(req)) return res.status(423).json({ error: "locked" });
  if (getConfig("lock_pin_hash", null)) {
    const minutes = req.session.lockTrusted
      ? (getConfig("lock_timeout_trusted_minutes", 120) as number)
      : (getConfig("lock_timeout_kiosk_minutes", 5) as number);
    req.session.unlockedUntil = Date.now() + minutes * 60_000;
  }
  next();
}

/** For changes the shared kitchen screen may make only with the household PIN (recipe edits): a kiosk login goes through
 * requireUnlocked (423 `locked`, the keypad, the sliding window); every other login passes. With no PIN configured the
 * lock is open, exactly as for Budget. Must run after requireAuth. */
export function requireKioskPin(req: express.Request, res: express.Response, next: express.NextFunction) {
  const userId = req.session.userId ?? req.deviceUserId;
  const user = userId ? getUserById(userId) : undefined;
  if (user?.role !== "kiosk") return next();
  return requireUnlocked(req, res, next);
}

/** For settings a paired watch must never change: refuses a device token, and anything that
 * isn't an interactive sign-in (the routes/devices.ts rule, as a middleware). Must run after
 * requireAuth. the project notes 10.5: PUT /api/assistant/settings was reachable by the
 * watch, and that setting is the one that keeps the watch's voice questions about money
 * away from a model. */
export function requireRealSession(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (req.deviceUserId || !req.session.userId) {
    return res.status(403).json({ error: "Sign in with your account to change this." });
  }
  next();
}

/** Convenience for handlers that already ran through requireAuth. */
export function currentUserId(req: express.Request): string {
  return (req.session.userId ?? req.deviceUserId)!;
}

/** Re-checks the signed-in user's password against their stored hash — for
 * gating a sensitive action (e.g. a full database download) behind more than
 * just having a live session cookie. */
export async function verifyPassword(userId: string, password: string): Promise<boolean> {
  const user = getUserById(userId);
  if (!user || !password) return false;
  return bcrypt.compare(password, user.password_hash);
}

// Stopgap for the project notes 10.1: POST /register sat outside requireAuth with
// only the account cap gating it, so anyone who could reach the server on the LAN or
// Tailnet could self-register a full household account. A shared household PIN --
// unrelated to the budget PIN lock in routes/lock.ts, which gates what a signed-in
// person can *reach*, not who can create an account -- is a speed bump, not a real
// defense on its own: the default below is published in this repo's own README. Wrong
// guesses are rate limited per address (rateLimit.ts, 10.3).
const DEFAULT_HOUSEHOLD_PIN = "1234";
const HOUSEHOLD_PIN_PATTERN = /^\d{4,6}$/;

// Lazily seeds the default household PIN into app_config on first use, so an existing
// install (already has real users, already past the account-cap concern) silently starts
// trusting "1234" the moment this ships, rather than needing a migration step that could
// be skipped. Mirrors sessionSecret()'s getConfig/setConfig-on-first-read pattern above.
async function householdPinHash(): Promise<string> {
  let hash = getConfig("household_pin_hash", null) as string | null;
  if (!hash) {
    hash = await bcrypt.hash(DEFAULT_HOUSEHOLD_PIN, 12);
    setConfig("household_pin_hash", hash);
    setConfig("household_pin_is_default", true);
  }
  return hash;
}

export const authRoutes = express.Router();

// Deliberately says nothing about the household PIN (set, default, anything) --
// this is the one auth route an unauthenticated visitor can always reach, and telling
// them whether "1234" still works would just be a roadmap. See GET /household-pin below
// for the authenticated version AdminSettings actually polls.
authRoutes.get("/status", (req, res) => {
  const userCount = getHouseholdMemberCount();
  const user = req.session.userId ? getUserById(req.session.userId) : undefined;
  res.json({
    userCount,
    canRegister: userCount < MAX_HOUSEHOLD_USERS,
    authenticated: !!user,
    user: user ? { id: user.id, username: user.username, displayName: user.display_name, role: user.role } : null,
  });
});

authRoutes.post("/register", async (req, res) => {
  const { username, password, displayName, pin } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: "username and password are required" });
  }
  if (String(password).length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters." });
  }
  // The household PIN is checked before the account cap and the username-taken check
  // below -- otherwise someone without the PIN could still use this route as an oracle
  // for both "are there slots left" and "does this username exist", no PIN required.
  if (typeof pin !== "string" || !HOUSEHOLD_PIN_PATTERN.test(pin)) {
    return res.status(400).json({ error: "Household PIN must be 4-6 digits." });
  }
  // Checked only once the PIN is well-formed, so a malformed one never counts as a guess.
  const attemptKey = registerKey(req);
  const limited = authAttempts.status(attemptKey);
  if (limited.locked) return tooManyAttempts(res, limited);
  if (!(await bcrypt.compare(pin, await householdPinHash()))) {
    const lockedOut = authAttempts.fail(attemptKey);
    appendSecurityEvent(`Wrong household PIN on account sign-up from ${clientIp(req)}.`, "warning");
    if (lockedOut) appendSecurityEvent(`Account sign-up paused for ${clientIp(req)} after repeated wrong household PINs.`, "critical");
    return res.status(403).json({ error: "That household PIN isn't right." });
  }
  authAttempts.clear(attemptKey);
  if (getHouseholdMemberCount() >= MAX_HOUSEHOLD_USERS) {
    return res.status(403).json({ error: "This household already has all its accounts set up." });
  }
  if (getUserByUsername(username)) {
    return res.status(409).json({ error: "That username is taken." });
  }

  const hash = await bcrypt.hash(password, 12);
  const id = createUser(username, hash, displayName || username);

  // Regenerate the session id before trusting it with a userId -- otherwise
  // anyone who planted this session's cookie on the browser beforehand (e.g.
  // the fridge's always-open shared browser) inherits the new account the
  // moment it registers. See the matching comment on /login below.
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: "Could not start a session." });
    req.session.userId = id;
    res.json({ success: true, user: { id, username, displayName: displayName || username, role: "parent" } });
  });
});

authRoutes.post("/login", async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: "username and password are required" });
  }
  // Checked before the password, so a locked-out caller gets no answer about it at all.
  // Keyed on username + address (rateLimit.ts): guessing one account's password gets slow,
  // and nobody can lock the other parent out from a different device.
  const attemptKey = loginKey(req, String(username));
  const limited = authAttempts.status(attemptKey);
  if (limited.locked) return tooManyAttempts(res, limited);
  const user = getUserByUsername(username);
  // Same message whether the username or the password was wrong, so this can't be
  // used to discover which accounts exist.
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    const lockedOut = authAttempts.fail(attemptKey);
    // An unknown username is never written to the log as typed: people sometimes type their
    // password into the username box, and the log is visible in Budget settings.
    const who = user ? `"${user.username}"` : "an unknown username";
    appendSecurityEvent(`Failed sign-in for ${who} from ${clientIp(req)}.`, "warning");
    if (lockedOut) appendSecurityEvent(`Sign-in for ${who} from ${clientIp(req)} paused after repeated failures.`, "critical");
    return res.status(401).json({ error: "Invalid username or password" });
  }
  authAttempts.clear(attemptKey);
  // Regenerate before assigning userId: prevents session fixation (someone
  // planting a household.sid cookie before a real person signs in on that
  // browser inheriting the session) and stops a pre-login session id from
  // carrying over across a login. Relevant here specifically because
  // cookie.secure is false (LAN is plain HTTP) and the fridge stays
  // signed-in in a shared browser -- see the project notes 10.2.
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: "Could not start a session." });
    req.session.userId = user.id;
    res.json({ success: true, user: { id: user.id, username: user.username, displayName: user.display_name, role: user.role } });
  });
});

authRoutes.post("/logout", (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

// Requires the current password, not just a live session -- same reasoning as
// verifyPassword's use for the backup download: a stolen/left-open session
// shouldn't be enough on its own to take over the account.
authRoutes.post("/change-password", requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: "currentPassword and newPassword are required" });
  }
  if (String(newPassword).length < 8) {
    return res.status(400).json({ error: "New password must be at least 8 characters." });
  }
  const userId = currentUserId(req);
  if (!(await verifyPassword(userId, currentPassword))) {
    return res.status(401).json({ error: "Current password is incorrect." });
  }
  const hash = await bcrypt.hash(newPassword, 12);
  updateUserPasswordHash(userId, hash);
  // M4: a stolen password or session must not outlive the password change. Keep only the
  // session that made this request; every other browser and every paired watch is signed out.
  const signedOut = deleteSessionsForUser(userId, req.session.userId ? req.sessionID : undefined);
  const revokedDevices = deleteDeviceTokensForUser(userId);
  appendSecurityEvent(`Password changed for "${getUserById(userId)?.username}"; ${signedOut} other session(s) and ${revokedDevices} device token(s) signed out.`, "info");
  res.json({ success: true, signedOutSessions: signedOut, revokedDevices });
});

// Admin panic button: signs every device of every user out, this one included, and revokes all
// device tokens. Needs the admin's password like the other account-wide actions here.
authRoutes.post("/sign-out-everywhere", requireAuth, requireAdmin, requireRealSession, async (req, res) => {
  if (!(await verifyPassword(currentUserId(req), req.body?.password))) {
    return res.status(401).json({ error: "Incorrect password." });
  }
  const removed = deleteAllSessionsAndDeviceTokens();
  appendSecurityEvent(`Admin signed everyone out: ${removed.sessions} session(s), ${removed.deviceTokens} device token(s).`, "warning");
  res.json({ success: true, ...removed });
});

// Behind requireAuth so an unauthenticated visitor can never learn whether the
// household PIN is still the published default -- see GET /status above, which is
// deliberately silent about this for the same reason. AdminSettings' Security tab
// polls this to show (or clear) the "still the factory PIN" warning.
authRoutes.get("/household-pin", requireAuth, requireAdmin, async (req, res) => {
  await householdPinHash(); // seeds the default if no install has ever read this before
  res.json({ isDefault: !!getConfig("household_pin_is_default", false) });
});

// Same "prove you hold the account password" pattern as PUT /api/lock/pin
// (routes/lock.ts) -- a different PIN gating a different thing, same reasoning: a
// live session alone shouldn't be enough to change what gates account creation.
authRoutes.put("/household-pin", requireAuth, requireAdmin, async (req, res) => {
  const { pin, password } = req.body || {};
  if (typeof pin !== "string" || !HOUSEHOLD_PIN_PATTERN.test(pin)) {
    return res.status(400).json({ error: "Household PIN must be 4-6 digits." });
  }
  if (!(await verifyPassword(currentUserId(req), password))) {
    return res.status(401).json({ error: "Incorrect password." });
  }
  setConfig("household_pin_hash", await bcrypt.hash(pin, 12));
  // A real flag, not derived by bcrypt.compare(pin, DEFAULT_HOUSEHOLD_PIN) at read
  // time -- GET /household-pin above is a routinely-polled status route, and a
  // cost-12 compare (~250ms) has no business running on every poll.
  setConfig("household_pin_is_default", pin === DEFAULT_HOUSEHOLD_PIN);
  res.json({ success: true });
});

// The kiosk login: a third class of account, deliberately weaker than a real
// household member's -- see forbidKiosk above for what it can't reach. Managing
// it (here) is admin-only, same reasoning as the household PIN above: at most
// one exists at a time (getKioskUser/deleteKioskUser in db.ts). Created and
// reset here by an already-signed-in admin, not through the self-service
// POST /register + household-PIN flow above -- this isn't a new person
// joining the household, it's a credential for a shared device, and handing
// it out should require more than just knowing a PIN anyone who's read this
// repo's README also knows.
authRoutes.get("/kiosk", requireAuth, requireAdmin, (req, res) => {
  const kiosk = getKioskUser();
  res.json({ exists: !!kiosk, username: kiosk?.username ?? null });
});

// Wholesale replace rather than edit-in-place -- simpler than a separate
// rename path, and there's normally at most one kiosk device to reset anyway.
// Requires the CALLER's account password, the same "prove this isn't just a
// left-open session" pattern as the household/lock PINs above: creating or
// resetting the one credential that gets a shared screen into Budget
// shouldn't ride on a stolen cookie alone.
authRoutes.put("/kiosk", requireAuth, requireAdmin, async (req, res) => {
  const { username, password, currentPassword } = req.body || {};
  if (typeof username !== "string" || !username.trim()) {
    return res.status(400).json({ error: "Username is required." });
  }
  if (typeof password !== "string" || password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters." });
  }
  if (!(await verifyPassword(currentUserId(req), currentPassword))) {
    return res.status(401).json({ error: "Incorrect password." });
  }
  const trimmedUsername = username.trim();
  const existing = getUserByUsername(trimmedUsername);
  const kiosk = getKioskUser();
  if (existing && existing.id !== kiosk?.id) {
    return res.status(409).json({ error: "That username is taken." });
  }
  deleteKioskUser();
  const hash = await bcrypt.hash(password, 12);
  createUser(trimmedUsername, hash, "Kiosk", "kiosk");
  res.json({ success: true, username: trimmedUsername });
});

authRoutes.delete("/kiosk", requireAuth, requireAdmin, async (req, res) => {
  const { currentPassword } = req.body || {};
  if (!(await verifyPassword(currentUserId(req), currentPassword))) {
    return res.status(401).json({ error: "Incorrect password." });
  }
  deleteKioskUser();
  res.json({ success: true });
});
