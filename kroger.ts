// Kroger's public API (developer.kroger.com): the household's one Kroger account, connected by an
// admin, so a grocery list can be added to its real Kroger cart. Checkout always happens in
// Kroger's own app -- the public Cart API can only ADD items (no read, no remove, no order), so
// nothing here can spend money.
//
// Two kinds of token:
//   - an app token (client_credentials, scope product.compact) for store and product search,
//     which needs no person, kept in memory only;
//   - the household's sign-in (authorization_code + PKCE, scope cart.basic:write). Its refresh
//     token lives in app_config `grocery.kroger`, encrypted with DB_ENCRYPTION_KEY like the Plaid
//     tokens, and never leaves the server: krogerStatus() is the only shape routes hand out.
//     Access tokens (30 min) stay in memory.
//
// Kroger's terms forbid keeping copies of its catalogue beyond what its cache headers allow (it
// sends none), so product data -- prices, images, stock -- is always fetched live and never stored.
import crypto from "node:crypto";
import { getConfig, setConfig, encryptSecret, decryptSecret } from "./db.ts";
import type { KrogerPicks } from "./krogerMatch.ts";

export const KROGER_CONFIG_KEY = "grocery.kroger";

const TIMEOUT_MS = 10_000;
// Treat a token as expired this long before Kroger says it is, so a request never starts with one
// that dies on the way.
const EXPIRY_MARGIN_MS = 60_000;
// Refresh tokens last "typically 24 hours" (Kroger's spec) and every refresh returns a new one, so
// refreshing at least this often keeps the household connected without anyone signing in again.
export const KEEP_ALIVE_AFTER_MS = 12 * 60 * 60 * 1000;
// Kroger rejects a product search of more than 8 words (PRODUCT-2019).
const MAX_SEARCH_WORDS = 8;

export interface KrogerStore {
  locationId: string;
  name: string;
  address: string;
}

/** What app_config `grocery.kroger` holds. `refreshToken` is `enc:v1:` and server-only. */
interface KrogerConfig {
  refreshToken?: string;
  connectedAt?: string;
  refreshedAt?: string;
  needsReconnect?: boolean;
  store?: KrogerStore;
}

/** The only view of the connection that routes return. Never carries a token. */
export interface KrogerStatus {
  /** The server has an app ID, secret and redirect address. */
  configured: boolean;
  connected: boolean;
  /** Kroger refused the stored sign-in; an admin has to connect again. */
  needsReconnect: boolean;
  connectedAt: string | null;
  store: KrogerStore | null;
  /** The address Hestia must be open at to connect: Kroger only sends the sign-in back to the
   *  registered KROGER_REDIRECT_URI, and the PKCE verifier lives in that browser's session. */
  connectOrigin: string | null;
}

/** Calories in one serving, from the Nutrition section's barcode lookup (krogerNutrition.ts) --
 *  Kroger itself sends none. `serving` is the label's wording, e.g. "1 cup (240 ml)". */
export interface ProductCalories {
  kcal: number;
  serving: string | null;
}

export interface KrogerProduct {
  upc: string;
  /** Added by the preview and search routes; absent from getProducts(). Null when nobody has data. */
  calories?: ProductCalories | null;
  description: string;
  brand: string;
  size: string;
  /** Regular and promo price at the chosen store; null when Kroger gives none. */
  price: { regular: number; promo: number | null } | null;
  stockLevel: "HIGH" | "LOW" | "TEMPORARILY_OUT_OF_STOCK" | null;
  curbside: boolean;
  delivery: boolean;
  imageUrl: string | null;
  /** WEIGHT items (produce, deli, meat) are priced per pound, but Kroger's cart still counts pieces:
   *  quantity 2 of bananas is 2 bunches (real cart test, 2026-10-16). */
  soldBy: "UNIT" | "WEIGHT";
  /** For WEIGHT items, Kroger's average (else stated) weight of one piece in pounds -- bananas 2.1,
   *  a deli turkey pack 1.0. Null when Kroger gives none, and for UNIT items. */
  pieceWeightLb: number | null;
}

export interface KrogerCartItem {
  upc: string;
  quantity: number;
}

/** `message` is safe to show a person: it never contains a token or Kroger's raw response. */
export class KrogerError extends Error {
  constructor(message: string, readonly status: number, readonly reconnect = false) {
    super(message);
  }
}

interface KrogerSettings {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

function settings(): KrogerSettings | null {
  const clientId = process.env.KROGER_CLIENT_ID?.trim();
  const clientSecret = process.env.KROGER_CLIENT_SECRET?.trim();
  const redirectUri = process.env.KROGER_REDIRECT_URI?.trim();
  return clientId && clientSecret && redirectUri ? { clientId, clientSecret, redirectUri } : null;
}

function redirectOrigin(): string | null {
  const uri = settings()?.redirectUri;
  try {
    return uri ? new URL(uri).origin : null;
  } catch {
    return null;
  }
}

function requireSettings(): KrogerSettings {
  const s = settings();
  if (!s) throw new KrogerError("Kroger isn't set up on this server.", 503);
  return s;
}

// Always Kroger's real host unless KROGER_API_BASE is set, which exists for a local mock (same
// idea as PLAID_API_BASE). Operator-set only -- never derived from request data.
function apiBase(): string {
  return (process.env.KROGER_API_BASE || "https://api.kroger.com").replace(/\/$/, "");
}

function readConfig(): KrogerConfig {
  return (getConfig(KROGER_CONFIG_KEY, null) as KrogerConfig | null) ?? {};
}

function writeConfig(config: KrogerConfig): void {
  setConfig(KROGER_CONFIG_KEY, config);
}

async function send(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new KrogerError("Kroger didn't answer. Try again in a minute.", 504);
  }
}

// ---------------------------------------------------------------------------------------------
// Tokens

interface TokenBody {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
}

let appToken: { token: string; expiresAt: number } | null = null;
// Same for the app token: a preview searches several items at once, and each would otherwise ask
// Kroger for its own token.
let fetchingAppToken: Promise<string> | null = null;
let userToken: { token: string; expiresAt: number } | null = null;
// One refresh at a time: each refresh hands out a new refresh token, and two racing requests
// could each spend the same old one, leaving the loser's newer token unsaved.
let refreshing: Promise<string> | null = null;

function expiresAt(body: TokenBody): number {
  const seconds = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 1800;
  return Date.now() + seconds * 1000 - EXPIRY_MARGIN_MS;
}

/** POSTs to Kroger's token endpoint as this app (Basic client ID:secret). A 400/401 is reported
 *  with `rejected`, so a refused sign-in can be told apart from Kroger being unreachable. */
async function tokenRequest(params: Record<string, string>, rejected: KrogerError): Promise<TokenBody> {
  const s = requireSettings();
  const res = await send(`${apiBase()}/v1/connect/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      Authorization: `Basic ${Buffer.from(`${s.clientId}:${s.clientSecret}`).toString("base64")}`,
    },
    body: new URLSearchParams(params).toString(),
  });
  const body = (await res.json().catch(() => ({}))) as Partial<TokenBody>;
  if (res.status === 400 || res.status === 401) throw rejected;
  if (!res.ok || typeof body.access_token !== "string") {
    throw new KrogerError("Kroger's sign-in service had a problem. Try again in a minute.", 502);
  }
  return body as TokenBody;
}

/** A token for store and product search, which act as the app rather than a person. */
async function appAccessToken(): Promise<string> {
  if (appToken && appToken.expiresAt > Date.now()) return appToken.token;
  if (!fetchingAppToken) {
    fetchingAppToken = tokenRequest(
      { grant_type: "client_credentials", scope: "product.compact" },
      new KrogerError("Kroger didn't accept this server's app keys.", 502)
    )
      .then((body) => {
        appToken = { token: body.access_token, expiresAt: expiresAt(body) };
        return body.access_token;
      })
      .finally(() => (fetchingAppToken = null));
  }
  return fetchingAppToken;
}

/** Saves a new sign-in. The refresh token is written before anything else happens: Kroger may
 *  stop honouring the old one the moment it issues this one. */
function saveUserTokens(body: TokenBody, extra: Partial<KrogerConfig> = {}): void {
  const config = readConfig();
  writeConfig({
    ...config,
    ...extra,
    refreshToken: body.refresh_token ? encryptSecret(body.refresh_token) : config.refreshToken,
    refreshedAt: new Date().toISOString(),
    needsReconnect: false,
  });
  userToken = { token: body.access_token, expiresAt: expiresAt(body) };
}

async function refreshUserToken(): Promise<string> {
  const config = readConfig();
  if (!config.refreshToken || config.needsReconnect) {
    throw new KrogerError("Kroger isn't connected. An admin can connect it in Settings.", 409, true);
  }
  try {
    const body = await tokenRequest(
      { grant_type: "refresh_token", refresh_token: decryptSecret(config.refreshToken) },
      new KrogerError("The Kroger sign-in has expired. An admin needs to connect Kroger again in Settings.", 409, true)
    );
    saveUserTokens(body);
    return body.access_token;
  } catch (err) {
    if (err instanceof KrogerError && err.reconnect) {
      writeConfig({ ...readConfig(), needsReconnect: true });
      userToken = null;
    }
    throw err;
  }
}

/** The household's access token, refreshed when needed. */
async function userAccessToken(): Promise<string> {
  if (userToken && userToken.expiresAt > Date.now()) return userToken.token;
  if (!refreshing) refreshing = refreshUserToken().finally(() => (refreshing = null));
  return refreshing;
}

// ---------------------------------------------------------------------------------------------
// Connecting (an admin, once)

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** PKCE (RFC 7636, S256). The verifier stays in the admin's session; only the challenge goes to Kroger. */
export function newPkce(): { verifier: string; challenge: string } {
  const verifier = base64url(crypto.randomBytes(32));
  return { verifier, challenge: base64url(crypto.createHash("sha256").update(verifier).digest()) };
}

export function newState(): string {
  return base64url(crypto.randomBytes(24));
}

/** Kroger's sign-in page for the household account, asking only to add to its cart. */
export function authorizeUrl(state: string, codeChallenge: string): string {
  const s = requireSettings();
  const url = new URL(`${apiBase()}/v1/connect/oauth2/authorize`);
  url.search = new URLSearchParams({
    scope: "cart.basic:write",
    response_type: "code",
    client_id: s.clientId,
    redirect_uri: s.redirectUri,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

/** Turns the code from Kroger's redirect into the household's stored sign-in. */
export async function exchangeCode(code: string, codeVerifier: string): Promise<void> {
  const s = requireSettings();
  const body = await tokenRequest(
    { grant_type: "authorization_code", code, redirect_uri: s.redirectUri, code_verifier: codeVerifier },
    new KrogerError("Kroger didn't accept the sign-in. Try connecting again.", 400)
  );
  if (!body.refresh_token) {
    throw new KrogerError("Kroger signed in but didn't allow staying connected. Try connecting again.", 502);
  }
  saveUserTokens(body, { connectedAt: new Date().toISOString() });
}

/** Forgets the sign-in. The chosen store stays, since it isn't tied to the account. */
export function disconnectKroger(): void {
  const { store } = readConfig();
  writeConfig(store ? { store } : {});
  userToken = null;
}

export function krogerStatus(): KrogerStatus {
  const config = readConfig();
  return {
    configured: settings() !== null,
    connected: !!config.refreshToken,
    needsReconnect: !!config.refreshToken && !!config.needsReconnect,
    connectedAt: config.refreshToken ? config.connectedAt ?? null : null,
    store: config.store ?? null,
    connectOrigin: redirectOrigin(),
  };
}

/** Called on a timer (server.ts). Refreshes a sign-in that hasn't been used for KEEP_ALIVE_AFTER_MS,
 *  so it never reaches Kroger's expiry. Returns what it did, for the log line. */
export async function krogerKeepAlive(now = Date.now()): Promise<"refreshed" | "skipped"> {
  const config = readConfig();
  if (!settings() || !config.refreshToken || config.needsReconnect) return "skipped";
  const last = Date.parse(config.refreshedAt ?? config.connectedAt ?? "");
  if (Number.isFinite(last) && now - last < KEEP_ALIVE_AFTER_MS) return "skipped";
  userToken = null; // force a real refresh rather than reusing a live access token
  await userAccessToken();
  return "refreshed";
}

// ---------------------------------------------------------------------------------------------
// Stores

interface KrogerLocation {
  locationId?: string;
  name?: string;
  address?: { addressLine1?: string; city?: string; state?: string; zipCode?: string };
}

function toStore(loc: KrogerLocation): KrogerStore | null {
  if (typeof loc?.locationId !== "string" || !/^\w{1,20}$/.test(loc.locationId)) return null;
  const a = loc.address ?? {};
  const cityLine = [a.city, [a.state, a.zipCode].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  return {
    locationId: loc.locationId,
    name: String(loc.name || "Kroger"),
    address: [a.addressLine1, cityLine].filter(Boolean).join(", "),
  };
}

async function appGet(path: string): Promise<Response> {
  return send(`${apiBase()}${path}`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${await appAccessToken()}` },
  });
}

/** Kroger-family stores near a US ZIP code, nearest first. */
export async function findStores(zip: string): Promise<KrogerStore[]> {
  if (!/^\d{5}$/.test(zip)) throw new KrogerError("Enter a 5-digit ZIP code.", 400);
  const res = await appGet(`/v1/locations?${new URLSearchParams({ "filter.zipCode.near": zip, "filter.limit": "10" })}`);
  if (!res.ok) throw new KrogerError("Kroger couldn't look up stores right now.", 502);
  const body = (await res.json().catch(() => ({}))) as { data?: KrogerLocation[] };
  return (body.data ?? []).map(toStore).filter((s): s is KrogerStore => s !== null);
}

/** Saves the household's store. Its name and address come from Kroger, not from the request. */
export async function chooseStore(locationId: string): Promise<KrogerStore> {
  if (!/^\w{1,20}$/.test(locationId)) throw new KrogerError("That isn't a Kroger store ID.", 400);
  const res = await appGet(`/v1/locations/${encodeURIComponent(locationId)}`);
  if (res.status === 404) throw new KrogerError("Kroger doesn't know that store.", 400);
  if (!res.ok) throw new KrogerError("Kroger couldn't look up that store right now.", 502);
  const body = (await res.json().catch(() => ({}))) as { data?: KrogerLocation };
  const store = body.data ? toStore(body.data) : null;
  if (!store) throw new KrogerError("Kroger couldn't look up that store right now.", 502);
  writeConfig({ ...readConfig(), store });
  return store;
}

// ---------------------------------------------------------------------------------------------
// Products

interface KrogerProductBody {
  upc?: string;
  description?: string;
  brand?: string;
  images?: { perspective?: string; sizes?: { size?: string; url?: string }[] }[];
  itemInformation?: { averageWeightPerUnit?: string; netWeight?: string };
  items?: {
    size?: string;
    soldBy?: string;
    price?: { regular?: number; promo?: number };
    inventory?: { stockLevel?: string };
    fulfillment?: { curbside?: boolean; delivery?: boolean };
  }[];
}

const STOCK_LEVELS = new Set(["HIGH", "LOW", "TEMPORARILY_OUT_OF_STOCK"]);

function toProduct(p: KrogerProductBody): KrogerProduct | null {
  if (typeof p?.upc !== "string" || !/^\d{13}$/.test(p.upc)) return null;
  const item = p.items?.[0] ?? {};
  const regular = typeof item.price?.regular === "number" && item.price.regular > 0 ? item.price.regular : null;
  const promo = typeof item.price?.promo === "number" && item.price.promo > 0 ? item.price.promo : null;
  const image = p.images?.find((i) => i.perspective === "front") ?? p.images?.[0];
  const stock = item.inventory?.stockLevel;
  return {
    upc: p.upc,
    description: String(p.description || ""),
    brand: String(p.brand || ""),
    size: String(item.size || ""),
    price: regular !== null ? { regular, promo } : null,
    stockLevel: stock && STOCK_LEVELS.has(stock) ? (stock as KrogerProduct["stockLevel"]) : null,
    curbside: item.fulfillment?.curbside === true,
    delivery: item.fulfillment?.delivery === true,
    imageUrl: image?.sizes?.find((s) => s.size === "thumbnail")?.url ?? image?.sizes?.[0]?.url ?? null,
    soldBy: item.soldBy === "WEIGHT" ? "WEIGHT" : "UNIT",
    pieceWeightLb:
      item.soldBy === "WEIGHT" ? pounds(p.itemInformation?.averageWeightPerUnit) ?? pounds(p.itemInformation?.netWeight) : null,
  };
}

/** Kroger writes weights as "2.1 [lb_av]" or "12 [oz_av]". */
function pounds(value: string | undefined): number | null {
  const m = String(value ?? "").match(/^\s*(\d+(?:\.\d+)?)\s*\[(lb|oz)_av\]/);
  if (!m) return null;
  const lb = m[2] === "oz" ? Number(m[1]) / 16 : Number(m[1]);
  return lb > 0 ? lb : null;
}

/** Kroger's matches for a list item's name at the chosen store. Kroger's search is fuzzy and its
 *  order can change between calls; that's why the plan remembers a person's pick. */
export async function searchProducts(term: string, locationId: string, limit = 5): Promise<KrogerProduct[]> {
  const words = String(term || "").trim().split(/\s+/).filter(Boolean).slice(0, MAX_SEARCH_WORDS);
  if (words.length === 0) return [];
  const query = new URLSearchParams({
    "filter.term": words.join(" "),
    "filter.locationId": locationId,
    "filter.limit": String(Math.min(Math.max(1, limit), 20)),
  });
  const res = await appGet(`/v1/products?${query}`);
  if (!res.ok) throw new KrogerError("Kroger couldn't search products right now.", 502);
  const body = (await res.json().catch(() => ({}))) as { data?: KrogerProductBody[] };
  return (body.data ?? []).map(toProduct).filter((p): p is KrogerProduct => p !== null);
}

// Kroger answers a multi-ID lookup in any order and silently leaves out codes it doesn't carry at
// that store. The documented limit on IDs per call isn't stated, so stay well under a URL's length.
const LOOKUP_CHUNK = 25;

/** Live details for known product codes at the chosen store, keyed by UPC. A code Kroger doesn't
 *  carry there is simply absent from the map. */
export async function getProducts(upcs: string[], locationId: string): Promise<Map<string, KrogerProduct>> {
  const wanted = [...new Set(upcs.filter((u) => /^\d{13}$/.test(u)))];
  const found = new Map<string, KrogerProduct>();
  for (let i = 0; i < wanted.length; i += LOOKUP_CHUNK) {
    const chunk = wanted.slice(i, i + LOOKUP_CHUNK);
    const res = await appGet(`/v1/products?${new URLSearchParams({ "filter.productId": chunk.join(","), "filter.locationId": locationId })}`);
    if (!res.ok) throw new KrogerError("Kroger couldn't look up products right now.", 502);
    const body = (await res.json().catch(() => ({}))) as { data?: KrogerProductBody[] };
    for (const p of body.data ?? []) {
      const product = toProduct(p);
      if (product && chunk.includes(product.upc)) found.set(product.upc, product);
    }
  }
  return found;
}

// ---------------------------------------------------------------------------------------------
// Cart

/** Adds items to the household's Kroger cart. Kroger has no way to take them out again, so the
 *  caller is responsible for not sending the same list twice by accident. No pickup/delivery is
 *  sent: Kroger keeps one mode for the whole cart, chosen in its app at checkout, and the API's
 *  per-item `modality` didn't change it (real cart test, 2026-10-16). */
export async function addToCart(items: KrogerCartItem[]): Promise<void> {
  if (items.length === 0) throw new KrogerError("Nothing to send.", 400);
  for (const item of items) {
    if (typeof item.upc !== "string" || !/^\d{13}$/.test(item.upc)) throw new KrogerError("One of the products has an invalid code.", 400);
    if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 99) {
      throw new KrogerError("Quantities must be whole numbers from 1 to 99.", 400);
    }
  }
  const body = JSON.stringify({ items: items.map(({ upc, quantity }) => ({ upc, quantity })) });

  const put = async () =>
    send(`${apiBase()}/v1/cart/add`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${await userAccessToken()}` },
      body,
    });

  let res = await put();
  if (res.status === 401) {
    // The access token was refused before its time (revoked, or Kroger restarted): refresh once.
    userToken = null;
    res = await put();
    if (res.status === 401) {
      writeConfig({ ...readConfig(), needsReconnect: true });
      userToken = null;
      throw new KrogerError("Kroger refused the sign-in. An admin needs to connect Kroger again in Settings.", 409, true);
    }
  }
  if (res.status === 204 || res.ok) return;
  if (res.status === 400) throw new KrogerError("Kroger couldn't add one of the items. Check the products and try again.", 400);
  // Not "nothing was added": Kroger doesn't say whether a failed request added some items.
  throw new KrogerError("Kroger couldn't add the items right now. Check your Kroger cart before trying again.", 502);
}

// ---------------------------------------------------------------------------------------------
// Remembered picks

export const KROGER_PICKS_KEY = "grocery.krogerPicks";
// Far more than a household buys; past it, the oldest picks are forgotten first.
const MAX_PICKS = 2000;

/** The household's chosen product per list-item name (krogerMatch.ts's pickKey). Holds Kroger
 *  product codes and a short label, never prices or images: those are always fetched live. */
export function loadPicks(): KrogerPicks {
  const picks = getConfig(KROGER_PICKS_KEY, null);
  return picks && typeof picks === "object" && !Array.isArray(picks) ? (picks as KrogerPicks) : {};
}

export function rememberPicks(entries: { key: string; upc: string; label: string }[]): void {
  if (entries.length === 0) return;
  const picks = loadPicks();
  const pickedAt = new Date().toISOString();
  for (const { key, upc, label } of entries) {
    delete picks[key]; // re-inserted so it counts as the newest
    picks[key] = { upc, label, pickedAt };
  }
  const keys = Object.keys(picks);
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_PICKS))) delete picks[key];
  setConfig(KROGER_PICKS_KEY, picks);
}

export function clearPicks(): void {
  setConfig(KROGER_PICKS_KEY, {});
}

/** Test seam: forgets the in-memory tokens, as a server restart would. */
export function resetKrogerTokenCacheForTests(): void {
  appToken = null;
  userToken = null;
  refreshing = null;
  fetchingAppToken = null;
}
