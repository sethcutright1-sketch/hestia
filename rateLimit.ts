// One failed-attempt limiter for every guessable secret the app checks: the account
// password (POST /api/auth/login), the household PIN on POST /api/auth/register, and the
// budget PIN (POST /api/lock/unlock). the project notes 10.3 and 10.4: login and register
// had no limit at all, and the PIN lock kept its own private copy keyed on req.sessionID,
// which a cookie-less device-token request gets fresh every time.
//
// Each caller builds its own key (see the *Key helpers below), prefixed by what is being
// guessed, so a login lockout never blocks a PIN unlock and vice versa. In memory on
// purpose: a restart is supervisor-driven (scripts/launch-household.ps1), not something a
// person at the fridge can trigger, and a persisted counter would need its own cleanup.
import type express from "express";

/** Every 5th failure starts a lockout, and each lockout doubles: 60s, 120s, 240s, ... */
const FAILURES_PER_STRIKE = 5;
const BASE_LOCKOUT_MS = 60_000;
/** Longest single lockout, so a forgotten counter can never shut a real person out for days. */
const MAX_LOCKOUT_MS = 60 * 60_000;
/** A key with no failure for this long, and no lockout running, is forgotten. */
const FORGET_AFTER_MS = 24 * 60 * 60_000;
/** Hard cap on tracked keys. A wrong username skips bcrypt, so new keys are cheap to make. */
const MAX_KEYS = 10_000;
const SWEEP_EVERY_MS = 10 * 60_000;

interface AttemptState {
  failures: number;
  lockedUntil: number;
  lastFailure: number;
}

export interface LimitStatus {
  locked: boolean;
  retryAfterMs: number;
}

export class AttemptLimiter {
  private readonly attempts = new Map<string, AttemptState>();
  private readonly now: () => number;
  private readonly maxKeys: number;

  /** Both options exist for tests: a fake clock, and a cap small enough to reach. */
  constructor(opts: { now?: () => number; maxKeys?: number } = {}) {
    this.now = opts.now ?? Date.now;
    this.maxKeys = opts.maxKeys ?? MAX_KEYS;
  }

  status(key: string): LimitStatus {
    const state = this.attempts.get(key);
    const now = this.now();
    if (!state || state.lockedUntil <= now) return { locked: false, retryAfterMs: 0 };
    return { locked: true, retryAfterMs: state.lockedUntil - now };
  }

  /** Records one failure. Returns true when this failure started a new lockout. */
  fail(key: string): boolean {
    const now = this.now();
    // Re-inserted rather than updated in place, so the Map's insertion order stays
    // "least recently failed first" -- that is what the size cap below evicts by.
    const state = this.attempts.get(key) ?? { failures: 0, lockedUntil: 0, lastFailure: 0 };
    this.attempts.delete(key);
    state.failures += 1;
    state.lastFailure = now;
    let startedLockout = false;
    if (state.failures % FAILURES_PER_STRIKE === 0) {
      const strikes = state.failures / FAILURES_PER_STRIKE;
      state.lockedUntil = now + Math.min(MAX_LOCKOUT_MS, BASE_LOCKOUT_MS * 2 ** (strikes - 1));
      startedLockout = true;
    }
    this.attempts.set(key, state);
    if (this.attempts.size > this.maxKeys) this.sweep();
    return startedLockout;
  }

  clear(key: string): void {
    this.attempts.delete(key);
  }

  /** Drops keys that are neither locked nor recently failed. If that still leaves more than
   *  the cap, it evicts the least recently failed keys that are not locked, and only then
   *  locked ones. Otherwise a flood of throwaway usernames could push a real lockout out.
   *  Runs on a timer and whenever the cap is passed. */
  sweep(): void {
    const now = this.now();
    for (const [key, state] of this.attempts) {
      if (state.lockedUntil <= now && now - state.lastFailure >= FORGET_AFTER_MS) this.attempts.delete(key);
    }
    for (const evictLocked of [false, true]) {
      for (const [key, state] of this.attempts) {
        if (this.attempts.size <= this.maxKeys) return;
        if (evictLocked || state.lockedUntil <= now) this.attempts.delete(key);
      }
    }
  }

  get size(): number {
    return this.attempts.size;
  }
}

/** The one shared instance the three routes use. */
export const authAttempts = new AttemptLimiter();

// unref() so the timer never keeps a test process (or a script importing auth.ts) alive.
setInterval(() => authAttempts.sweep(), SWEEP_EVERY_MS).unref();

/** The socket's address, read directly. `trust proxy` is set for loopback (server.ts) so req.secure
 *  works, which also makes req.ip follow X-Forwarded-For -- a header any client can forge -- so
 *  this deliberately does not use req.ip when there is a socket. Cloudflare Tunnel and Tailscale
 *  Serve connect from loopback, which is why login also keys on the username and unlock on the
 *  session -- the IP alone would lump every remote device together. (Tests pass a bare req.ip.) */
export function clientIp(req: express.Request): string {
  return req.socket?.remoteAddress || req.ip || "unknown";
}

export function loginKey(req: express.Request, username: string): string {
  return `login:${username.trim().toLowerCase()}|${clientIp(req)}`;
}

/** The household PIN is the same for every username, so only the address can key it. */
export function registerKey(req: express.Request): string {
  return `register:${clientIp(req)}`;
}

export function unlockKey(req: express.Request): string {
  return `unlock:${req.deviceUserId ?? req.sessionID}|${clientIp(req)}`;
}

export function tooManyAttempts(res: express.Response, status: LimitStatus) {
  res.setHeader("Retry-After", String(Math.ceil(status.retryAfterMs / 1000)));
  return res.status(429).json({ error: "Too many attempts. Try again shortly.", retryAfterMs: status.retryAfterMs });
}

// ---------------------------------------------------------------------------------------------------
// Request-rate limiter for POST /api/assistant/chat. A different job from AttemptLimiter above: that
// one counts *failed guesses*; this one counts *every* turn a signed-in login starts, because each
// turn can run up to 8 model generations (the local GPU, or a paid Claude/Gemini API) and the app is
// public. Keyed on the login (currentUserId), not the address -- Cloudflare Tunnel makes every remote
// request look like loopback, and a kiosk or watch token resolves to a user id too. In memory on
// purpose, for the same reason as AttemptLimiter: a restart clears it, and nothing here needs to
// outlive one.
// ---------------------------------------------------------------------------------------------------

/** A burst this size is a person typing quickly (Plan the week alone is two turns); sustained, it
 *  is one turn every 15 seconds, faster than anyone reads an answer. */
const TURNS_PER_WINDOW = 20;
const TURN_WINDOW_MS = 5 * 60_000;
/** A household sends a handful of messages an hour, so ~300 a day is far above real use but small
 *  enough that a stolen session cannot run up a cloud bill overnight. */
const TURNS_PER_DAY = 300;
const TURN_DAY_MS = 24 * 60 * 60_000;
/** A turn that has not released its slot after this long is treated as dead (a provider that never
 *  settles and a client that never disconnects), so one wedged request cannot lock a person out
 *  until the next restart. Well past the slowest legitimate 8-generation local turn. */
const STUCK_TURN_MS = 15 * 60_000;
/** What an "already answering" refusal tells the client to wait; the turn itself decides the real time. */
const IN_FLIGHT_RETRY_SECONDS = 5;
/** Refusals within this long of the last one on the same key are one burst, announced once. */
const REFUSAL_BURST_MS = 5 * 60_000;
/** Hard cap on tracked logins. Keys are user ids behind requireAuth, so this is a backstop only. */
const MAX_TURN_KEYS = 1_000;

interface TurnState {
  /** Start times of counted turns, oldest first, never older than a day. A sliding log rather than
   *  fixed buckets: a bucket lets someone send 20 at 4:59 and 20 more at 5:01; this does not.
   *  At most TURNS_PER_DAY entries, so it is small. */
  starts: number[];
  /** Identity of the turn holding the in-flight slot, or 0 for none. */
  claim: number;
  claimedAt: number;
  lastRefusal: number;
  /** Last time this key was touched, for the key cap. */
  lastSeen: number;
}

export type TurnRefusal = {
  ok: false;
  reason: "in_flight" | "window" | "day";
  retryAfterSeconds: number;
  /** True for the first window/day refusal of a burst, so the caller logs one line rather than one per request. */
  announce: boolean;
};
export type TurnGrant = {
  ok: true;
  /** Frees the in-flight slot. Safe to call any number of times, from any exit path. */
  release: () => void;
};

export class RequestRateLimiter {
  private readonly states = new Map<string, TurnState>();
  private readonly now: () => number;
  private readonly maxKeys: number;
  private nextClaim = 1;

  /** Both options exist for tests: a fake clock, and a cap small enough to reach. */
  constructor(opts: { now?: () => number; maxKeys?: number } = {}) {
    this.now = opts.now ?? Date.now;
    this.maxKeys = opts.maxKeys ?? MAX_TURN_KEYS;
  }

  /** Asks to start one turn. A grant counts the turn and takes the in-flight slot; a refusal
   *  changes nothing about the counts, so hammering a limit never extends it. */
  acquire(key: string): TurnGrant | TurnRefusal {
    const now = this.now();
    // Re-inserted so the Map's order stays "least recently used first" -- what the cap evicts by.
    const state = this.states.get(key) ?? { starts: [], claim: 0, claimedAt: 0, lastRefusal: 0, lastSeen: now };
    this.states.delete(key);
    this.states.set(key, state);
    state.lastSeen = now;
    while (state.starts.length > 0 && state.starts[0] <= now - TURN_DAY_MS) state.starts.shift();

    if (state.claim !== 0 && now - state.claimedAt < STUCK_TURN_MS) {
      return { ok: false, reason: "in_flight", retryAfterSeconds: IN_FLIGHT_RETRY_SECONDS, announce: false };
    }

    const inWindow = state.starts.filter((t) => t > now - TURN_WINDOW_MS);
    let waitMs = 0;
    let reason: "window" | "day" = "window";
    if (inWindow.length >= TURNS_PER_WINDOW) waitMs = inWindow[0] + TURN_WINDOW_MS - now;
    if (state.starts.length >= TURNS_PER_DAY) {
      const dayWait = state.starts[0] + TURN_DAY_MS - now;
      if (dayWait > waitMs) {
        waitMs = dayWait;
        reason = "day";
      }
    }
    if (waitMs > 0) {
      const announce = now - state.lastRefusal >= REFUSAL_BURST_MS;
      state.lastRefusal = now;
      return { ok: false, reason, retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)), announce };
    }

    state.starts.push(now);
    const claim = this.nextClaim++;
    state.claim = claim;
    state.claimedAt = now;
    if (this.states.size > this.maxKeys) this.sweep();
    return {
      ok: true,
      release: () => {
        // Only the turn that holds the slot may free it, so a late release from a turn whose claim
        // expired cannot free a newer turn's slot.
        if (state.claim === claim) state.claim = 0;
      },
    };
  }

  /** Drops logins with nothing in flight and no turn in the last day. If that still leaves more
   *  than the cap, evicts the least recently used ones with nothing in flight. Runs on a timer
   *  and whenever the cap is passed. */
  sweep(): void {
    const now = this.now();
    const idle = (s: TurnState) => s.claim === 0 || now - s.claimedAt >= STUCK_TURN_MS;
    for (const [key, state] of this.states) {
      if (idle(state) && now - state.lastSeen >= TURN_DAY_MS) this.states.delete(key);
    }
    for (const [key, state] of this.states) {
      if (this.states.size <= this.maxKeys) return;
      if (idle(state)) this.states.delete(key);
    }
  }

  get size(): number {
    return this.states.size;
  }
}

/** The one shared instance POST /api/assistant/chat uses. */
export const assistantTurns = new RequestRateLimiter();

/** The one shared instance POST /api/assistant/transcribe uses. Separate from the chat one so a person dictating
 *  isn't counted twice (the transcript then becomes a chat turn of its own) and so one can't starve the other, but
 *  with the same limits: a recording is one question. */
export const transcribeTurns = new RequestRateLimiter();

setInterval(() => assistantTurns.sweep(), SWEEP_EVERY_MS).unref();
setInterval(() => transcribeTurns.sweep(), SWEEP_EVERY_MS).unref();

/** The 429 for a refused chat turn. Sent before any SSE header is written, so it is a plain JSON
 *  response the client can read like any other error. */
export function tooManyTurns(res: express.Response, refusal: TurnRefusal) {
  const minutes = Math.max(1, Math.ceil(refusal.retryAfterSeconds / 60));
  const error =
    refusal.reason === "in_flight"
      ? "Still answering your last message — wait for it to finish or press Stop."
      : `You've sent a lot of messages in a short time. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`;
  res.setHeader("Retry-After", String(refusal.retryAfterSeconds));
  return res.status(429).json({ error, retryAfterSeconds: refusal.retryAfterSeconds });
}
