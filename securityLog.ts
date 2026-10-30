// The budget section's server-side security/audit log. Lives next to db.ts
// rather than under routes/ because two different route modules append to it
// (routes/lock.ts for PIN lockouts, routes/budget.ts for everything else) and
// neither should own the other's copy of the logic.
//
// Moved here from routes/lock.ts, which used to keep a private copy of this
// same function. The client (src/sections/Budget.tsx's logSecurityEvent) used
// to PUT its whole local array to /store-config/securityLog on every event,
// which meant a page load followed by a PIN lockout, followed by any client
// event, would overwrite the lockout entry the server had just appended --
// the client's stale in-memory copy would win. Routing every append through
// this one function (server-authoritative, read-modify-write against the
// current config value) is what fixes that.
import { getConfig, setConfig } from "./db.ts";
import type { SecurityEvent } from "./src/sections/budget/types.ts";

// Appends one event to the shared budget.securityLog config key, same shape
// and same 50-entry cap as the client's own (now-optimistic-only) log.
// Applied server-side too since a locked-out session by definition can't be
// trusted to log its own lockout honestly.
export function appendSecurityEvent(event: string, type: SecurityEvent["type"]): SecurityEvent {
  const entry: SecurityEvent = {
    id: `sec-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`,
    timestamp: new Date().toLocaleTimeString(),
    event,
    type,
  };
  try {
    const existing = (getConfig("budget.securityLog", []) as SecurityEvent[]) || [];
    setConfig("budget.securityLog", [entry, ...existing].slice(0, 50));
  } catch (err) {
    console.error("Failed to record security event:", err);
  }
  return entry;
}
