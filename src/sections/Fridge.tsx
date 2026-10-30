// The smart fridge section -- door/temperature dashboard, setpoint + ice-boost
// control, and a best-effort camera snapshot, all over the SmartThings API.
// Personal access tokens expire after ~24h (see routes/fridge.ts), so any call
// can come back "disconnected" -- that always flips the UI back to the connect
// form with a plain explanation, never a raw error or a silently stale screen.
import { useEffect, useState } from "react";
import { Snowflake, DoorOpen, RefreshCw, Camera, ScanEye, Upload } from "lucide-react";
import { api, type FridgeStatus, type VisionConfig, type PantryScanSuggestion } from "../api.ts";
import PantryScanSuggestions from "./PantryScanSuggestions.tsx";

type ConnectState = "checking" | "disconnected" | "connected";

// Reads a File as base64 without the "data:image/...;base64," prefix, which
// is what the vision endpoints expect.
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Mirrors smartthings.ts's buildAuthorizationUrl -- kept in sync manually
// since this is a pure string template with nothing worth a server round trip.
const FRIDGE_SCOPES = "r:devices:* x:devices:*";
function buildAuthorizationUrl(clientId: string, redirectUri: string): string {
  const params = new URLSearchParams({ client_id: clientId, response_type: "code", redirect_uri: redirectUri, scope: FRIDGE_SCOPES });
  return `https://api.smartthings.com/oauth/authorize?${params.toString()}`;
}

export default function Fridge() {
  const [connectState, setConnectState] = useState<ConnectState>("checking");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [redirectUri, setRedirectUri] = useState("https://httpbin.org/get");
  const [code, setCode] = useState("");
  const [deviceId, setDeviceId] = useState("");
  const [status, setStatus] = useState<FridgeStatus | null>(null);
  const [error, setError] = useState("");
  const [camera, setCamera] = useState<{ loading: boolean; imageUrl?: string; unavailable?: boolean }>({ loading: false });
  const [visionConfig, setVisionConfig] = useState<VisionConfig | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState("");
  const [suggestions, setSuggestions] = useState<PantryScanSuggestion[] | null>(null);
  const [addedMessage, setAddedMessage] = useState("");

  function handleDisconnect(message?: string) {
    setConnectState("disconnected");
    setStatus(null);
    if (message) setError(message);
  }

  async function refreshStatus() {
    try {
      const res = await api.get<{ status: FridgeStatus }>("/api/fridge/status");
      setStatus(res.status);
      setConnectState("connected");
      setError("");
    } catch (err: any) {
      handleDisconnect(err.message);
    }
  }

  useEffect(() => {
    api.get<{ configured: boolean; deviceId?: string }>("/api/fridge/config").then((cfg) => {
      if (cfg.configured) refreshStatus();
      else setConnectState("disconnected");
    }).catch(() => setConnectState("disconnected"));
    api.get<VisionConfig>("/api/vision/config").then(setVisionConfig).catch(() => {});
  }, []);

  async function changeVisionProvider(provider: string) {
    try {
      await api.put("/api/vision/config", { provider });
      setVisionConfig((prev) => (prev ? { ...prev, provider: provider as VisionConfig["provider"] } : prev));
    } catch (err: any) {
      setScanError(err.message);
    }
  }

  async function connect(e: React.FormEvent) {
    e.preventDefault();
    if (!clientId.trim() || !clientSecret.trim() || !redirectUri.trim() || !code.trim() || !deviceId.trim()) return;
    try {
      await api.post("/api/fridge/config", { clientId, clientSecret, redirectUri, code, deviceId });
      setCode("");
      await refreshStatus();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function disconnect() {
    try {
      await api.post("/api/fridge/disconnect");
    } catch {
      // Best-effort -- flip to the disconnected view regardless.
    }
    setClientId("");
    setClientSecret("");
    setCode("");
    handleDisconnect();
    setError("");
  }

  async function setSetpoint(component: "cooler" | "freezer", temperature: number) {
    try {
      await api.put("/api/fridge/setpoint", { component, temperature });
      await refreshStatus();
    } catch (err: any) {
      handleDisconnect(err.message);
    }
  }

  async function toggleIceBoost(on: boolean) {
    try {
      await api.post("/api/fridge/ice-boost", { on });
      await refreshStatus();
    } catch (err: any) {
      handleDisconnect(err.message);
    }
  }

  async function refreshCamera() {
    setCamera({ loading: true });
    try {
      const res = await api.get<{ unavailable: boolean; imageUrl?: string }>("/api/fridge/camera");
      setCamera({ loading: false, imageUrl: res.imageUrl, unavailable: res.unavailable });
    } catch {
      setCamera({ loading: false, unavailable: true });
    }
  }

  async function scanCamera() {
    setScanning(true);
    setScanError("");
    setAddedMessage("");
    try {
      const res = await api.post<{ unavailable?: boolean; items?: PantryScanSuggestion[] }>("/api/fridge/camera/scan");
      if (res.unavailable) setScanError("Snapshot unavailable right now.");
      else setSuggestions(res.items || []);
    } catch (err: any) {
      if (err.message?.toLowerCase().includes("connect")) handleDisconnect(err.message);
      else setScanError(err.message);
    } finally {
      setScanning(false);
    }
  }

  async function scanUploadedPhoto(file: File) {
    setScanning(true);
    setScanError("");
    setAddedMessage("");
    try {
      const image = await fileToBase64(file);
      const res = await api.post<{ items: PantryScanSuggestion[] }>("/api/vision/scan", { image, mediaType: file.type });
      setSuggestions(res.items);
    } catch (err: any) {
      setScanError(err.message);
    } finally {
      setScanning(false);
    }
  }

  if (connectState === "checking") {
    return <div className="text-sm text-slate-500 dark:text-slate-400">Loading…</div>;
  }

  if (connectState === "disconnected") {
    const authorizeUrl = clientId.trim() && redirectUri.trim() ? buildAuthorizationUrl(clientId.trim(), redirectUri.trim()) : null;
    return (
      <div className="max-w-md">
        <h2 className="text-lg font-semibold mb-3 flex items-center gap-2">
          <Snowflake size={18} /> Fridge
        </h2>
        <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">
          {error || "Connect the fridge to see its status and control it from here."} Authorize once
          and this renews itself automatically -- no more pasting a new token every day.
        </p>
        <ol className="text-xs text-slate-500 dark:text-slate-400 list-decimal list-inside mb-4 space-y-1">
          <li>
            Register an OAuth-In app with the{" "}
            <a className="underline" href="https://developer.smartthings.com/docs/connected-services/oauth-integrations" target="_blank" rel="noreferrer">
              SmartThings CLI
            </a>{" "}
            to get a client id and secret.
          </li>
          <li>Fill in the client id/secret and a redirect URI below (any HTTPS page that echoes back the query string works -- httpbin.org's is filled in by default).</li>
          <li>Open "Authorize with SmartThings", approve access, then copy the <code>code</code> value from the page you land on.</li>
        </ol>
        <form onSubmit={connect} className="space-y-2">
          <input
            className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
            placeholder="Client id"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
          />
          <input
            className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
            placeholder="Client secret"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
          />
          <input
            className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
            placeholder="Redirect URI"
            value={redirectUri}
            onChange={(e) => setRedirectUri(e.target.value)}
          />
          {authorizeUrl && (
            <a
              href={authorizeUrl}
              target="_blank"
              rel="noreferrer"
              className="block text-center px-3 py-2 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-sm"
            >
              Authorize with SmartThings
            </a>
          )}
          <input
            className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
            placeholder="Code from the redirect page"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <input
            className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
            placeholder="Device id"
            value={deviceId}
            onChange={(e) => setDeviceId(e.target.value)}
          />
          <button className="px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm">
            Connect
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="max-w-2xl">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <Snowflake size={18} /> Fridge
        </h2>
        <button onClick={disconnect} className="text-xs text-slate-400 hover:text-red-600 dark:hover:text-red-400">
          Disconnect fridge
        </button>
      </div>
      {error && <p className="mb-3 text-sm text-red-600 dark:text-red-400">{error}</p>}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
        {(["cooler", "freezer"] as const).map((component) => (
          <div key={component} className="rounded-lg border border-slate-200 dark:border-slate-800 p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium capitalize">{component}</span>
              {status?.doorOpen?.[component] && (
                <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 flex items-center gap-1">
                  <DoorOpen size={12} /> Door open
                </span>
              )}
            </div>
            <p className="text-2xl font-semibold">
              {status?.temperature?.[component] ?? "—"}
              <span className="text-sm font-normal text-slate-500 dark:text-slate-400">°</span>
            </p>
            <div className="mt-2 flex items-center gap-2">
              <label className="text-xs text-slate-500 dark:text-slate-400">Setpoint</label>
              <input
                type="number"
                className="w-20 px-2 py-1 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                defaultValue={status?.setpoint?.[component]}
                onBlur={(e) => {
                  const v = Number(e.target.value);
                  if (!Number.isNaN(v) && v !== status?.setpoint?.[component]) setSetpoint(component, v);
                }}
              />
            </div>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-3 mb-4">
        <label className="text-sm flex items-center gap-2">
          <input
            type="checkbox"
            checked={!!status?.iceBoostOn}
            onChange={(e) => toggleIceBoost(e.target.checked)}
          />
          Ice boost
        </label>
        {status?.powerSaveOn && (
          <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300">
            Power save on
          </span>
        )}
        <button
          onClick={refreshStatus}
          className="ml-auto text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
          aria-label="Refresh status"
        >
          <RefreshCw size={15} />
        </button>
      </div>

      <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3">
        <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
          <span className="text-sm font-medium flex items-center gap-1.5">
            <Camera size={14} /> Inside the fridge
          </span>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={refreshCamera}
              disabled={camera.loading}
              className="text-xs px-2 py-1 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 disabled:opacity-50"
            >
              {camera.loading ? "Loading…" : "Refresh snapshot"}
            </button>
            <button
              onClick={scanCamera}
              disabled={scanning}
              className="text-xs px-2 py-1 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 disabled:opacity-50 flex items-center gap-1"
            >
              <ScanEye size={12} /> {scanning ? "Scanning…" : "Scan for pantry items"}
            </button>
            <label className="text-xs px-2 py-1 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 cursor-pointer flex items-center gap-1">
              <Upload size={12} /> Import a photo
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) scanUploadedPhoto(file);
                  e.target.value = "";
                }}
              />
            </label>
          </div>
        </div>

        {visionConfig && (
          <div className="mb-3 flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
            <label htmlFor="vision-provider">Vision provider</label>
            <select
              id="vision-provider"
              className="px-2 py-1 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
              value={visionConfig.provider}
              onChange={(e) => changeVisionProvider(e.target.value)}
            >
              <option value="auto">Auto</option>
              {visionConfig.providers.map((p) => (
                <option key={p.id} value={p.id} disabled={!p.available}>
                  {p.label}
                  {!p.available ? " (unavailable)" : ""}
                </option>
              ))}
            </select>
          </div>
        )}

        {camera.imageUrl ? (
          <img src={camera.imageUrl} alt="Inside the fridge" className="rounded-lg w-full" />
        ) : (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {camera.unavailable ? "Snapshot unavailable right now." : "Not fetched yet."}
          </p>
        )}

        {scanError && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{scanError}</p>}
        {addedMessage && <p className="mt-2 text-sm text-emerald-600 dark:text-emerald-400">{addedMessage}</p>}
        {suggestions && (
          <PantryScanSuggestions
            items={suggestions}
            onCancel={() => setSuggestions(null)}
            onDone={(added) => {
              setSuggestions(null);
              setAddedMessage(added.length ? `Added ${added.length} item${added.length === 1 ? "" : "s"} to the pantry.` : "Nothing added.");
            }}
          />
        )}
      </div>
    </div>
  );
}
