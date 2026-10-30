// Plaid access tokens from a link that happened moments ago, kept in memory only (per user and
// Plaid item, 30 minutes). Linking a bank exchanges the public token on the server; the browser
// then spends a minute choosing which accounts to keep before any bank_connections row exists.
// The first sync (routes/budget-plaid.ts, by itemId) and the save of the chosen rows (db.ts
// putScopedItemAs, which attaches the token to each row) both read it from here, so the token
// never has to travel to the browser and back (the project notes 10.7).
//
// Its own module, with no imports, so db.ts can use it without importing a route file.

export const FRESH_LINK_TTL_MS = 30 * 60_000;

const freshLinks = new Map<string, { token: string; at: number }>();

const keyFor = (userId: string, itemId: string): string => `${userId}|${itemId}`;

/** Remembers the token of an item this user just linked. Sweeps expired entries while it's here. */
export function rememberFreshLink(userId: string, itemId: unknown, token: string): void {
  if (typeof itemId !== "string" || !itemId || !token) return;
  const now = Date.now();
  for (const [k, v] of freshLinks) if (now - v.at > FRESH_LINK_TTL_MS) freshLinks.delete(k);
  freshLinks.set(keyFor(userId, itemId), { token, at: now });
}

/** The token of an item THIS user linked in the last 30 minutes, or null. */
export function freshLinkToken(userId: string, itemId: unknown): string | null {
  if (typeof itemId !== "string" || !itemId) return null;
  const fresh = freshLinks.get(keyFor(userId, itemId));
  return fresh && Date.now() - fresh.at <= FRESH_LINK_TTL_MS ? fresh.token : null;
}
