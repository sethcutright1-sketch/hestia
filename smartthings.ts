// Thin SmartThings REST client. Deliberately isolated from routes/fridge.ts:
// this file owns all auth handling, so when that changes (as it just did --
// see the OAuth section below), only this file needs to, not the
// routes/tools/UI built against it.

import { getConfig, setConfig } from "./db.ts";

const API_BASE = "https://api.smartthings.com/v1";
const OAUTH_BASE = "https://api.smartthings.com/oauth";

// Thrown on a 401/403 so callers can distinguish "token expired, reconnect"
// from every other kind of failure rather than surfacing a generic error.
export class FridgeDisconnectedError extends Error {}

async function stRequest(token: string, path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });

  if (res.status === 401 || res.status === 403) {
    throw new FridgeDisconnectedError("SmartThings token expired or invalid");
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`SmartThings request failed (${res.status}): ${body}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

export interface SmartThingsDevice {
  deviceId: string;
  label: string;
  name: string;
}

export async function listDevices(token: string): Promise<SmartThingsDevice[]> {
  const data = await stRequest(token, "/devices");
  return (data.items || []).map((d: any) => ({ deviceId: d.deviceId, label: d.label, name: d.name }));
}

/** Raw per-component status JSON -- shape varies by model/firmware, mapped by the caller. */
export async function getDeviceStatus(token: string, deviceId: string): Promise<any> {
  return stRequest(token, `/devices/${deviceId}/status`);
}

// Best-effort raw AI Vision Inside camera snapshot. This calls an undocumented,
// reverse-engineered endpoint (there is no official API for it) -- Samsung can
// change or block it with no notice, so any failure here (including an expired
// token) just means "no image right now," not a FridgeDisconnectedError to
// react to. Shared by routes/fridge.ts and assistant/tools/fridge.ts so the
// undocumented-endpoint knowledge lives in exactly one place.
export async function getCameraImageUrl(token: string, deviceId: string): Promise<string | null> {
  try {
    const res = await fetch(`${API_BASE}/devices/${deviceId}/components/main/capabilities/samsungce.viewInside/status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    return data?.imageUri?.value || data?.image?.value || null;
  } catch {
    return null;
  }
}

export async function sendCommand(
  token: string,
  deviceId: string,
  component: string,
  capability: string,
  command: string,
  args: unknown[] = []
): Promise<void> {
  await stRequest(token, `/devices/${deviceId}/commands`, {
    method: "POST",
    body: JSON.stringify({
      commands: [{ component, capability, command, arguments: args }],
    }),
  });
}

// --- OAuth (authorization_code + auto-refresh) -----------------------------
//
// Personal access tokens expire after 24h and can only ever be created by a
// human clicking through account.smartthings.com -- there is no API to
// automate that. This is the real alternative: an OAuth-In app (registered
// once via the SmartThings CLI, outside this app) exchanges an authorization
// code for an access_token + refresh_token, and the refresh_token mints new
// access tokens indefinitely with no further user interaction.
//
// The one real wrinkle: SmartThings rotates the refresh_token on every use --
// each refresh response carries a *new* refresh_token that must overwrite the
// stored one immediately, or the next refresh has no valid token to use.

interface FridgeOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  deviceId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: string; // ISO
}

// Refresh this far ahead of actual expiry so a normal API call is never the
// one that discovers the token just expired.
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

function getFridgeConfig(): FridgeOAuthConfig | null {
  return getConfig("fridge.smartthings", null);
}

export function isFridgeConfigured(): boolean {
  return !!getFridgeConfig();
}

export function getFridgeDeviceId(): string | null {
  return getFridgeConfig()?.deviceId || null;
}

export function disconnectFridge(): void {
  setConfig("fridge.smartthings", null);
}

// Scopes cover everything the fridge feature needs: reading status and
// sending commands. Built client-side by the UI too (same template), so the
// two must stay in sync if this ever changes.
const FRIDGE_SCOPES = "r:devices:* x:devices:*";

export function buildAuthorizationUrl(clientId: string, redirectUri: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: FRIDGE_SCOPES,
  });
  return `${OAUTH_BASE}/authorize?${params.toString()}`;
}

async function tokenRequest(clientId: string, clientSecret: string, body: Record<string, string>): Promise<any> {
  const res = await fetch(`${OAUTH_BASE}/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
    },
    body: new URLSearchParams(body).toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`SmartThings token request failed (${res.status}): ${text}`);
  }
  return res.json();
}

export async function connectFridge(params: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
  deviceId: string;
}): Promise<void> {
  const data = await tokenRequest(params.clientId, params.clientSecret, {
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: params.redirectUri,
  });
  setConfig("fridge.smartthings", {
    clientId: params.clientId,
    clientSecret: params.clientSecret,
    redirectUri: params.redirectUri,
    deviceId: params.deviceId,
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: new Date(Date.now() + data.expires_in * 1000).toISOString(),
  } satisfies FridgeOAuthConfig);
}

// Collapses concurrent callers into one refresh -- the refresh token is
// single-use, so two calls both trying to consume it would strand the
// connection (the second would fail with an already-used token).
let refreshInFlight: Promise<string> | null = null;

async function getValidAccessToken(): Promise<string> {
  const cfg = getFridgeConfig();
  if (!cfg) throw new FridgeDisconnectedError("The fridge isn't connected yet.");

  if (new Date(cfg.expiresAt).getTime() - Date.now() > REFRESH_BUFFER_MS) {
    return cfg.accessToken;
  }

  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      try {
        const data = await tokenRequest(cfg.clientId, cfg.clientSecret, {
          grant_type: "refresh_token",
          refresh_token: cfg.refreshToken,
        });
        const updated: FridgeOAuthConfig = {
          ...cfg,
          accessToken: data.access_token,
          refreshToken: data.refresh_token,
          expiresAt: new Date(Date.now() + data.expires_in * 1000).toISOString(),
        };
        setConfig("fridge.smartthings", updated);
        return updated.accessToken;
      } catch {
        // The refresh token itself is dead -- only a fresh authorize/connect
        // flow can recover this, same as an expired PAT before it.
        throw new FridgeDisconnectedError("The fridge's connection expired -- reconnect it in the Fridge section.");
      } finally {
        refreshInFlight = null;
      }
    })();
  }
  return refreshInFlight;
}

// Stateful wrappers -- routes/tools call these instead of resolving config
// and passing a token around themselves.
export async function getFridgeStatus(): Promise<any> {
  const token = await getValidAccessToken();
  return getDeviceStatus(token, getFridgeConfig()!.deviceId);
}

export async function setFridgeCommand(
  component: string,
  capability: string,
  command: string,
  args: unknown[] = []
): Promise<void> {
  const token = await getValidAccessToken();
  return sendCommand(token, getFridgeConfig()!.deviceId, component, capability, command, args);
}

export async function getFridgeCameraImageUrl(): Promise<string | null> {
  const token = await getValidAccessToken();
  return getCameraImageUrl(token, getFridgeConfig()!.deviceId);
}
