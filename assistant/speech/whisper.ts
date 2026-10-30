// Runs whisper.cpp's `whisper-server` on this PC and turns a WAV into text. This is what makes voice input private:
// the audio goes browser -> this app -> a process bound to 127.0.0.1, and never to anyone's cloud.
//
// The server is started lazily on the first transcription and killed after WHISPER_IDLE_MINUTES of quiet. That matters
// because the GPU build holds ~1 GB of VRAM for as long as it is alive, and this PC is also a gaming PC.
//
// Env (all read at call time, so a test or a restart-less edit of the process env behaves; see .env.example):
//   WHISPER_SERVER_BIN      the CUDA build of whisper-server.exe
//   WHISPER_SERVER_BIN_CPU  the CPU build (the fallback)
//   WHISPER_MODEL           a ggml model, e.g. ggml-small.en.bin
//   WHISPER_DEVICE          "gpu" (default) or "cpu"
//   WHISPER_PORT            default 8178 (the dev copy uses 8179 so both can run)
//   WHISPER_THREADS         CPU threads, default 8
//   WHISPER_IDLE_MINUTES    default 10
//
// The GPU is never trusted: a CUDA build quietly runs on the CPU when the driver or DLLs don't load, and a game can take
// the VRAM at any moment. So the GPU server is checked at startup (stderr must say the CUDA backend loaded) and, if it
// fails to start or fails a request, this falls back to the CPU build and retries that request once.
//
// Everything that touches the outside world (spawning, fetch, timers, the filesystem) is a dependency, so the tests
// run the whole state machine without the real binary.

import { spawn as nodeSpawn } from "node:child_process";
import fs from "node:fs";

type Listener = (...args: any[]) => void;
type Readable = { on(event: "data", cb: (chunk: Buffer | string) => void): unknown } | null | undefined;

/** The slice of a ChildProcess this file uses, so a test can hand in an EventEmitter. */
export interface WhisperChild {
  stdout?: Readable;
  stderr?: Readable;
  on(event: string, cb: Listener): unknown;
  kill(): boolean;
}

export interface WhisperSettings {
  model?: string;
  gpuBin?: string;
  cpuBin?: string;
  device: "gpu" | "cpu";
  port: number;
  threads: number;
  idleMs: number;
}

export interface WhisperDeps {
  env: () => NodeJS.ProcessEnv;
  exists: (path: string) => boolean;
  spawn: (bin: string, args: string[]) => WhisperChild;
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  log: (line: string) => void;
  /** Called once, when the first child is spawned: how the real instance arranges to kill it when the app exits. */
  installProcessHooks?: (stopAll: () => void) => void;
  /** How long to wait for a freshly spawned server to start answering. */
  startTimeoutMs: number;
  /** How long one transcription may take. A 30 s clip takes a few seconds even on the CPU build. */
  requestTimeoutMs: number;
}

const positiveInt = (raw: string | undefined, fallback: number): number => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

const blank = (raw: string | undefined): string | undefined => (raw && raw.trim() ? raw.trim() : undefined);

export function whisperSettings(env: NodeJS.ProcessEnv = process.env): WhisperSettings {
  const port = positiveInt(env.WHISPER_PORT, 8178);
  return {
    model: blank(env.WHISPER_MODEL),
    gpuBin: blank(env.WHISPER_SERVER_BIN),
    cpuBin: blank(env.WHISPER_SERVER_BIN_CPU),
    device: env.WHISPER_DEVICE?.trim().toLowerCase() === "cpu" ? "cpu" : "gpu",
    port: port <= 65535 ? port : 8178,
    threads: positiveInt(env.WHISPER_THREADS, 8),
    idleMs: positiveInt(env.WHISPER_IDLE_MINUTES, 10) * 60_000,
  };
}

/** True when the model and at least one server binary are named and really exist on disk. */
export function whisperConfigured(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = fs.existsSync): boolean {
  const s = whisperSettings(env);
  return !!s.model && exists(s.model) && [s.gpuBin, s.cpuBin].some((bin) => !!bin && exists(bin));
}

/**
 * The model's text with the non-speech tags Whisper invents for silence and noise removed ("[BLANK_AUDIO]", "(coughing)",
 * "[Music]"): nobody says brackets out loud, and a tag typed into the chat box as if it were a question would be silly.
 */
export function cleanTranscript(text: string): string {
  return text.replace(/\[[^\]]*\]|\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
}

type Device = "gpu" | "cpu";

interface Running {
  child: WhisperChild;
  device: Device;
  port: number;
  exited: boolean;
  /** The last few KB of the server's output, for the CUDA check and for a useful log line if it dies. */
  tail: string;
  cuda: boolean;
  fellBackToCpu: boolean;
}

export class WhisperRunner {
  private readonly deps: WhisperDeps;
  private current: Running | null = null;
  private starting: Promise<Running> | null = null;
  private readonly alive = new Set<Running>();
  private idleTimer: unknown = null;
  private active = 0;
  /** Set after the GPU server failed; stays until the idle shutdown, so a game that took the VRAM isn't retried per request. */
  private cpuOnly = false;
  private hooked = false;

  constructor(deps: Partial<WhisperDeps> = {}) {
    this.deps = {
      env: () => process.env,
      exists: fs.existsSync,
      spawn: (bin, args) => nodeSpawn(bin, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }),
      fetch: (...args) => fetch(...args),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: Date.now,
      setTimer: (fn, ms) => {
        const handle = setTimeout(fn, ms);
        // A pending idle shutdown must never keep the app from exiting.
        handle.unref();
        return handle;
      },
      clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
      log: (line) => console.log(line),
      startTimeoutMs: 20_000,
      requestTimeoutMs: 30_000,
      ...deps,
    };
  }

  /** True while a whisper-server child is alive (or starting). Mostly for tests and the smoke script. */
  get running(): boolean {
    return this.alive.size > 0;
  }

  /** Which build is serving right now, if any. */
  get device(): Device | null {
    return this.current && !this.current.exited ? this.current.device : null;
  }

  async transcribe(wav: Buffer, opts: { prompt?: string } = {}): Promise<string> {
    this.active++;
    this.clearIdle();
    try {
      let run = await this.ensure();
      try {
        return await this.post(run, wav, opts.prompt);
      } catch (err) {
        // A CPU server that fails is just a failure. A GPU server that fails is probably a game that took the VRAM (or
        // a driver hiccup), which the CPU build doesn't care about, so swap and try this one request again.
        if (run.device !== "gpu") throw err;
        this.deps.log(`Whisper: the GPU server failed a request (${reason(err)}); switching to the CPU build.`);
        run = await this.fallBackToCpu(run);
        return await this.post(run, wav, opts.prompt);
      }
    } finally {
      this.active--;
      this.armIdle();
    }
  }

  /** Kills the server now (and forgets that the GPU failed, so the next start tries it again). */
  stop(): void {
    this.clearIdle();
    this.killAll();
    this.cpuOnly = false;
  }

  /** Kills every child this runner spawned. Synchronous, so it is safe in a process 'exit' handler. */
  killAll(): void {
    for (const run of [...this.alive]) this.kill(run);
    this.current = null;
  }

  // -- starting ---------------------------------------------------------------------------------------------------

  /** One start shared by everyone who arrives while it is in progress. */
  private ensure(): Promise<Running> {
    if (this.current && !this.current.exited) return Promise.resolve(this.current);
    if (!this.starting) {
      this.starting = this.startBest()
        .then((run) => (this.current = run))
        .finally(() => {
          this.starting = null;
        });
    }
    return this.starting;
  }

  private async startBest(): Promise<Running> {
    const s = whisperSettings(this.deps.env());
    if (s.device === "gpu" && s.gpuBin && !this.cpuOnly) {
      try {
        return await this.launch("gpu");
      } catch (err) {
        this.deps.log(`Whisper: the GPU build didn't start (${reason(err)}); using the CPU build instead.`);
      }
    }
    return this.launch("cpu");
  }

  private async fallBackToCpu(failed: Running): Promise<Running> {
    this.cpuOnly = true;
    // Whoever notices first does the swap; a concurrent request that failed on the same server finds it already gone
    // and just joins the CPU start (or the CPU server) that is there.
    if (this.current === failed) {
      this.kill(failed);
      this.current = null;
    }
    return this.ensure();
  }

  private async launch(device: Device): Promise<Running> {
    const s = whisperSettings(this.deps.env());
    // The CPU path also accepts the CUDA binary run with -ng, so a machine with only one build still works.
    const bin = device === "gpu" ? s.gpuBin : (s.cpuBin ?? s.gpuBin);
    if (!s.model || !bin) throw new Error("WHISPER_MODEL and a server binary aren't both set");
    if (!this.deps.exists(s.model)) throw new Error("the Whisper model file is missing");
    if (!this.deps.exists(bin)) throw new Error("the whisper-server binary is missing");
    // A leftover server from a crashed run would answer the readiness poll for us and hide that ours never bound.
    if (await this.answers(s.port)) throw new Error(`port ${s.port} is already in use (a leftover whisper-server?)`);

    const args = ["-m", s.model, "--host", "127.0.0.1", "--port", String(s.port), "-t", String(s.threads), "-l", "en", "-nt"];
    if (device === "cpu") args.push("-ng");
    const child = this.deps.spawn(bin, args);
    const run: Running = { child, device, port: s.port, exited: false, tail: "", cuda: false, fellBackToCpu: false };
    this.alive.add(run);
    if (!this.hooked) {
      this.hooked = true;
      this.deps.installProcessHooks?.(() => this.killAll());
    }

    const onOutput = (chunk: Buffer | string) => {
      run.tail = (run.tail + String(chunk)).slice(-4000);
      if (run.tail.includes("load_backend: loaded CUDA backend")) run.cuda = true;
      if (run.tail.includes("whisper_backend_init_gpu: device 0: CPU")) run.fellBackToCpu = true;
    };
    child.stdout?.on("data", onOutput);
    child.stderr?.on("data", onOutput);
    child.on("error", (err: Error) => {
      run.exited = true;
      run.tail += `\nspawn error: ${err.message}`;
    });
    child.on("exit", () => {
      run.exited = true;
      this.alive.delete(run);
      if (this.current === run) this.current = null;
    });

    try {
      await this.waitUntilListening(run);
      if (device === "gpu" && (!run.cuda || run.fellBackToCpu)) throw new Error("the CUDA backend didn't load");
    } catch (err) {
      this.kill(run);
      throw err;
    }
    return run;
  }

  private async waitUntilListening(run: Running): Promise<void> {
    const deadline = this.deps.now() + this.deps.startTimeoutMs;
    for (;;) {
      if (run.exited) throw new Error(`whisper-server exited while starting${lastLine(run.tail)}`);
      if (await this.answers(run.port)) return;
      if (this.deps.now() >= deadline) throw new Error("whisper-server didn't start answering in time");
      await this.deps.sleep(250);
    }
  }

  /** Does anything answer an HTTP GET on that loopback port? Any status counts; only a refused connection doesn't. */
  private async answers(port: number): Promise<boolean> {
    try {
      const res = await this.deps.fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) });
      // Drained so the socket is released rather than left half-open.
      await res.arrayBuffer().catch(() => {});
      return true;
    } catch {
      return false;
    }
  }

  // -- requests ---------------------------------------------------------------------------------------------------

  private async post(run: Running, wav: Buffer, prompt: string | undefined): Promise<string> {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "audio.wav");
    form.append("response_format", "json");
    form.append("temperature", "0");
    // The household's names: without them "Bea" comes back as "Beah".
    if (prompt) form.append("prompt", prompt);
    const res = await this.deps.fetch(`http://127.0.0.1:${run.port}/inference`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(this.deps.requestTimeoutMs),
    });
    if (!res.ok) throw new Error(`whisper-server answered ${res.status}`);
    const data = (await res.json()) as { text?: unknown };
    if (typeof data?.text !== "string") throw new Error("whisper-server sent no text");
    return cleanTranscript(data.text);
  }

  // -- shutting down ----------------------------------------------------------------------------------------------

  private kill(run: Running): void {
    run.exited = true;
    this.alive.delete(run);
    if (this.current === run) this.current = null;
    try {
      run.child.kill();
    } catch {
      // Already gone.
    }
  }

  private clearIdle(): void {
    if (this.idleTimer !== null) this.deps.clearTimer(this.idleTimer);
    this.idleTimer = null;
  }

  /** Restarts the quiet-period countdown. Never kills a server that is in the middle of a request. */
  private armIdle(): void {
    this.clearIdle();
    if (this.alive.size === 0) return;
    const { idleMs } = whisperSettings(this.deps.env());
    this.idleTimer = this.deps.setTimer(() => {
      this.idleTimer = null;
      if (this.active > 0) return this.armIdle();
      this.deps.log("Whisper: idle, shutting the server down to free its memory.");
      this.stop();
    }, idleMs);
  }
}

const reason = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The server's last output line, to make "exited while starting" say why; paths in it stay in the server log. */
function lastLine(tail: string): string {
  const line = tail.trim().split(/\r?\n/).pop();
  return line ? `: ${line.slice(0, 200)}` : "";
}

/**
 * Kill the child when the app goes away. An 'exit' handler covers a normal exit and process.exit(); the signal handlers
 * cover Ctrl+C / a stop request. Merely adding a signal listener switches off Node's default "die on SIGINT", so after
 * cleaning up the handler removes itself and, if nobody else is listening, re-raises the signal to get that default
 * back -- it must not swallow the app's own shutdown.
 */
export function installProcessHooks(stopAll: () => void): void {
  process.on("exit", stopAll);
  for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"] as const) {
    const handler = () => {
      stopAll();
      process.removeListener(signal, handler);
      if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
    };
    process.on(signal, handler);
  }
}

/** The one runner the app uses. */
export const whisper = new WhisperRunner({ installProcessHooks });
