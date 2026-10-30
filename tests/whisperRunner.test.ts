// assistant/speech/whisper.ts -- the lazily started, idle-stopped, GPU-then-CPU whisper-server runner -- driven entirely
// through its injected dependencies, so no real binary is spawned and (importantly on a gaming PC) nothing touches the GPU.
// The fakes: a child process that is an EventEmitter, a fetch that answers like whisper-server only while a fake child is
// alive, a clock that sleeps instantly, and timers the test fires by hand.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { WhisperRunner, whisperConfigured, whisperSettings, cleanTranscript, type WhisperChild } from "../assistant/speech/whisper.ts";

const GPU_BIN = "C:\\fake\\gpu\\whisper-server.exe";
const CPU_BIN = "C:\\fake\\cpu\\whisper-server.exe";
const MODEL = "C:\\fake\\ggml-small.en.bin";
const CUDA_OK = "load_backend: loaded CUDA backend from ggml-cuda.dll\nwhisper_backend_init_gpu: using CUDA0 backend\n";
const CUDA_MISSING = "whisper_backend_init_gpu: no GPU found\nwhisper_backend_init_gpu: device 0: CPU\n";

class FakeChild extends EventEmitter implements WhisperChild {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  gone = false;
  killCount = 0;
  constructor(readonly bin: string, readonly args: string[]) {
    super();
  }
  kill(): boolean {
    this.killCount++;
    this.die();
    return true;
  }
  die() {
    if (this.gone) return;
    this.gone = true;
    this.emit("exit", 1, null);
  }
}

interface Behaviour {
  /** What the server prints on stderr right after it starts. */
  stderr?: string;
  /** Dies straight away, as a binary with a missing DLL does. */
  dies?: boolean;
  /** Spawns but never starts answering. */
  neverReady?: boolean;
}

interface Timer {
  fn: () => void;
  ms: number;
  cleared: boolean;
}

function setup(opts: {
  env?: Record<string, string | undefined>;
  behave?: (child: FakeChild) => Behaviour;
  inference?: (child: FakeChild, form: FormData) => Response | Promise<Response>;
  portBusy?: boolean;
  /** Make the readiness poll yield to the event loop between tries, so a test can act while the start is still going. */
  yieldWhileWaiting?: boolean;
} = {}) {
  const env: Record<string, string | undefined> = {
    WHISPER_SERVER_BIN: GPU_BIN,
    WHISPER_SERVER_BIN_CPU: CPU_BIN,
    WHISPER_MODEL: MODEL,
    ...opts.env,
  };
  const children: FakeChild[] = [];
  const timers: Timer[] = [];
  const logs: string[] = [];
  const forms: FormData[] = [];
  const hooks: Array<() => void> = [];
  const never = new Set<FakeChild>();
  let clock = 1_000_000;

  const runner = new WhisperRunner({
    env: () => env as NodeJS.ProcessEnv,
    exists: () => true,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
      if (opts.yieldWhileWaiting) await new Promise((r) => setImmediate(r));
    },
    log: (line) => void logs.push(line),
    setTimer: (fn, ms) => {
      const timer: Timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => void ((handle as Timer).cleared = true),
    installProcessHooks: (stopAll) => void hooks.push(stopAll),
    spawn: (bin, args) => {
      const child = new FakeChild(bin, args);
      children.push(child);
      const b = opts.behave?.(child) ?? {};
      if (b.neverReady) never.add(child);
      queueMicrotask(() => {
        if (b.stderr) child.stderr.emit("data", Buffer.from(b.stderr));
        if (b.dies) child.die();
      });
      return child;
    },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      await null; // let anything queued at spawn time (stderr, an immediate death) happen first
      const url = String(input);
      const port = Number(new URL(url).port);
      const pathname = new URL(url).pathname;
      const server = children.find((c) => !c.gone && !never.has(c) && c.args.includes(String(port)));
      if (pathname === "/") {
        if (opts.portBusy || server) return new Response("<html>whisper.cpp server</html>");
        throw new TypeError("fetch failed");
      }
      if (!server) throw new TypeError("fetch failed");
      const form = init?.body as FormData;
      forms.push(form);
      return opts.inference ? opts.inference(server, form) : Response.json({ text: " Did Bea finish her chores today?\n" });
    }) as typeof fetch,
  });
  return { runner, env, children, timers, logs, forms, hooks, advance: (ms: number) => void (clock += ms) };
}

const WAV = Buffer.from("RIFF....WAVE");
const gpuBehaviour = (child: FakeChild): Behaviour => (child.bin === GPU_BIN ? { stderr: CUDA_OK } : {});
const isCpuBuild = (child: FakeChild) => child.args.includes("-ng");

describe("starting the server", () => {
  test("is lazy: nothing runs until the first transcription", async () => {
    const t = setup({ behave: gpuBehaviour });
    assert.equal(t.children.length, 0);
    assert.equal(t.runner.running, false);
    assert.equal(await t.runner.transcribe(WAV), "Did Bea finish her chores today?");
    assert.equal(t.children.length, 1);
    assert.equal(t.runner.device, "gpu");
  });

  test("GPU build by default: loopback only, the configured port and threads, English, no timestamps, GPU left on", async () => {
    const t = setup({ env: { WHISPER_PORT: "8179", WHISPER_THREADS: "4" }, behave: gpuBehaviour });
    await t.runner.transcribe(WAV);
    const [child] = t.children;
    assert.equal(child.bin, GPU_BIN);
    assert.deepEqual(child.args, ["-m", MODEL, "--host", "127.0.0.1", "--port", "8179", "-t", "4", "-l", "en", "-nt"]);
  });

  test("defaults: port 8178, 8 threads, 10 idle minutes, gpu", () => {
    const s = whisperSettings({});
    assert.deepEqual([s.port, s.threads, s.idleMs, s.device], [8178, 8, 600_000, "gpu"]);
    assert.equal(whisperSettings({ WHISPER_DEVICE: "CPU", WHISPER_PORT: "junk", WHISPER_THREADS: "0" }).device, "cpu");
    assert.equal(whisperSettings({ WHISPER_PORT: "junk" }).port, 8178);
    assert.equal(whisperSettings({ WHISPER_PORT: "99999" }).port, 8178);
    assert.equal(whisperSettings({ WHISPER_THREADS: "0" }).threads, 8);
  });

  test("WHISPER_DEVICE=cpu uses the CPU build with -ng and never starts the GPU one", async () => {
    const t = setup({ env: { WHISPER_DEVICE: "cpu" } });
    await t.runner.transcribe(WAV);
    assert.equal(t.children.length, 1);
    assert.equal(t.children[0].bin, CPU_BIN);
    assert.ok(t.children[0].args.includes("-ng"));
    assert.equal(t.runner.device, "cpu");
  });

  test("with only the GPU binary configured, the CPU path runs it with -ng", async () => {
    const t = setup({ env: { WHISPER_DEVICE: "cpu", WHISPER_SERVER_BIN_CPU: "" } });
    await t.runner.transcribe(WAV);
    assert.equal(t.children[0].bin, GPU_BIN);
    assert.ok(t.children[0].args.includes("-ng"));
  });

  test("concurrent first requests share one start", async () => {
    const t = setup({ behave: gpuBehaviour });
    const results = await Promise.all([t.runner.transcribe(WAV), t.runner.transcribe(WAV), t.runner.transcribe(WAV)]);
    assert.deepEqual(results, Array(3).fill("Did Bea finish her chores today?"));
    assert.equal(t.children.length, 1, "one whisper-server, not three");
    assert.equal(t.hooks.length, 1, "the exit hook is installed once");
  });

  test("a second request reuses the running server", async () => {
    const t = setup({ behave: gpuBehaviour });
    await t.runner.transcribe(WAV);
    await t.runner.transcribe(WAV);
    assert.equal(t.children.length, 1);
  });

  test("a server that died on its own is started again on the next request", async () => {
    const t = setup({ behave: gpuBehaviour });
    await t.runner.transcribe(WAV);
    t.children[0].die();
    assert.equal(t.runner.running, false);
    await t.runner.transcribe(WAV);
    assert.equal(t.children.length, 2);
  });

  test("a port something else already answers on is refused, and nothing is spawned", async () => {
    const t = setup({ portBusy: true, behave: gpuBehaviour });
    await assert.rejects(t.runner.transcribe(WAV), /already in use/);
    assert.equal(t.children.length, 0);
  });

  test("a server that never answers is killed after the start timeout", async () => {
    const t = setup({ env: { WHISPER_DEVICE: "cpu" }, behave: () => ({ neverReady: true }) });
    await assert.rejects(t.runner.transcribe(WAV), /in time/);
    assert.equal(t.children[0].gone, true, "the stuck child does not linger");
    assert.equal(t.runner.running, false);
  });

  test("a missing model or binary is a plain failure, not a spawn", async () => {
    const none = setup({ env: { WHISPER_MODEL: "" } });
    await assert.rejects(none.runner.transcribe(WAV), /aren't both set/);
    assert.equal(none.children.length, 0);
  });
});

describe("the GPU is checked, not trusted", () => {
  test("a GPU server whose stderr shows it fell back to the CPU is replaced by the CPU build", async () => {
    const t = setup({ behave: (c) => (c.bin === GPU_BIN ? { stderr: CUDA_MISSING } : {}) });
    assert.equal(await t.runner.transcribe(WAV), "Did Bea finish her chores today?");
    assert.deepEqual(t.children.map((c) => c.bin), [GPU_BIN, CPU_BIN]);
    assert.equal(t.children[0].gone, true, "the useless GPU server is killed");
    assert.ok(isCpuBuild(t.children[1]));
    assert.equal(t.runner.device, "cpu");
    assert.equal(t.logs.filter((l) => /GPU build didn't start/.test(l)).length, 1, "one log line saying why");
    assert.match(t.logs[0], /CUDA backend didn't load/);
  });

  test("a GPU server that prints no CUDA line at all is also not trusted", async () => {
    const t = setup({ behave: (c) => (c.bin === GPU_BIN ? { stderr: "ggml_cuda_init: failed\n" } : {}) });
    await t.runner.transcribe(WAV);
    assert.deepEqual(t.children.map((c) => c.bin), [GPU_BIN, CPU_BIN]);
  });

  test("a GPU server that exits while starting falls back to the CPU build", async () => {
    const t = setup({ behave: (c) => (c.bin === GPU_BIN ? { dies: true, stderr: "cudart64_12.dll was not found\n" } : {}) });
    await t.runner.transcribe(WAV);
    assert.deepEqual(t.children.map((c) => c.bin), [GPU_BIN, CPU_BIN]);
    assert.match(t.logs[0], /exited while starting/);
  });

  test("a GPU request that fails restarts on the CPU build and retries that request once", async () => {
    let gpuCalls = 0;
    const t = setup({
      behave: gpuBehaviour,
      inference: (child) => {
        if (!isCpuBuild(child)) {
          gpuCalls++;
          return new Response("out of memory", { status: 500 });
        }
        return Response.json({ text: "from the cpu" });
      },
    });
    assert.equal(await t.runner.transcribe(WAV), "from the cpu");
    assert.equal(gpuCalls, 1);
    assert.deepEqual(t.children.map((c) => c.bin), [GPU_BIN, CPU_BIN]);
    assert.equal(t.children[0].gone, true);
    assert.equal(t.forms.length, 2, "one attempt on each server");
    assert.equal(t.logs.filter((l) => /GPU server failed a request/.test(l)).length, 1);

    // The GPU is not tried again for every request while a game may still be holding the VRAM.
    assert.equal(await t.runner.transcribe(WAV), "from the cpu");
    assert.equal(t.children.length, 2);
  });

  test("a GPU server that drops the connection mid-request is handled the same way", async () => {
    const t = setup({
      behave: gpuBehaviour,
      inference: (child) => {
        if (!isCpuBuild(child)) throw new TypeError("fetch failed");
        return Response.json({ text: "ok" });
      },
    });
    assert.equal(await t.runner.transcribe(WAV), "ok");
  });

  test("the retry happens once: a CPU server that fails too gives up", async () => {
    let calls = 0;
    const t = setup({ behave: gpuBehaviour, inference: () => (calls++, new Response("nope", { status: 500 })) });
    await assert.rejects(t.runner.transcribe(WAV), /answered 500/);
    assert.equal(calls, 2, "one GPU attempt, one CPU attempt, no more");
  });

  test("a CPU-only failure is not retried at all", async () => {
    let calls = 0;
    const t = setup({ env: { WHISPER_DEVICE: "cpu" }, inference: () => (calls++, new Response("nope", { status: 500 })) });
    await assert.rejects(t.runner.transcribe(WAV));
    assert.equal(calls, 1);
    assert.equal(t.children.length, 1);
  });

  test("several requests failing on the same GPU server share one CPU restart", async () => {
    const t = setup({
      behave: gpuBehaviour,
      inference: (child) => (isCpuBuild(child) ? Response.json({ text: "cpu" }) : new Response("boom", { status: 500 })),
    });
    const results = await Promise.all([t.runner.transcribe(WAV), t.runner.transcribe(WAV), t.runner.transcribe(WAV)]);
    assert.deepEqual(results, ["cpu", "cpu", "cpu"]);
    assert.equal(t.children.filter(isCpuBuild).length, 1, "one CPU server, not three");
    assert.equal(t.children.length, 2);
  });
});

describe("the request", () => {
  test("posts the clip as multipart form-data with the documented fields", async () => {
    const t = setup({ behave: gpuBehaviour });
    await t.runner.transcribe(Buffer.from("RIFFxxxxWAVEdata"), { prompt: "Family: Alex, Bea." });
    const form = t.forms[0];
    const file = form.get("file") as File;
    assert.equal(file.type, "audio/wav");
    assert.equal(Buffer.from(await file.arrayBuffer()).toString(), "RIFFxxxxWAVEdata");
    assert.equal(form.get("response_format"), "json");
    assert.equal(form.get("temperature"), "0");
    assert.equal(form.get("prompt"), "Family: Alex, Bea.");
  });

  test("no prompt means no prompt field", async () => {
    const t = setup({ behave: gpuBehaviour });
    await t.runner.transcribe(WAV);
    assert.equal(t.forms[0].has("prompt"), false);
  });

  test("a reply with no text is an error, not an empty transcript", async () => {
    const t = setup({ env: { WHISPER_DEVICE: "cpu" }, inference: () => Response.json({ error: "bad" }) });
    await assert.rejects(t.runner.transcribe(WAV), /no text/);
  });

  test("cleanTranscript trims, joins lines and drops the tags Whisper writes for silence and noise", () => {
    assert.equal(cleanTranscript(" Did Bea finish her chores today?\n"), "Did Bea finish her chores today?");
    assert.equal(cleanTranscript("add milk\nand eggs"), "add milk and eggs");
    assert.equal(cleanTranscript(" [BLANK_AUDIO]\n"), "");
    assert.equal(cleanTranscript("[Music]"), "");
    assert.equal(cleanTranscript("(coughing) add milk [ Silence ]"), "add milk");
  });

  test("silence comes back as an empty string", async () => {
    const t = setup({ env: { WHISPER_DEVICE: "cpu" }, inference: () => Response.json({ text: " [BLANK_AUDIO]\n" }) });
    assert.equal(await t.runner.transcribe(WAV), "");
  });
});

describe("idle shutdown", () => {
  test("after WHISPER_IDLE_MINUTES of quiet the child is killed, and the next request starts a fresh one", async () => {
    const t = setup({ env: { WHISPER_IDLE_MINUTES: "3" }, behave: gpuBehaviour });
    await t.runner.transcribe(WAV);
    const live = t.timers.filter((x) => !x.cleared);
    assert.equal(live.length, 1);
    assert.equal(live[0].ms, 3 * 60_000);

    live[0].fn();
    assert.equal(t.children[0].gone, true);
    assert.equal(t.runner.running, false);
    assert.ok(t.logs.some((l) => /idle/.test(l)));

    await t.runner.transcribe(WAV);
    assert.equal(t.children.length, 2);
  });

  test("defaults to 10 minutes, and every request restarts the countdown", async () => {
    const t = setup({ behave: gpuBehaviour });
    await t.runner.transcribe(WAV);
    const first = t.timers[t.timers.length - 1];
    await t.runner.transcribe(WAV);
    assert.equal(first.cleared, true, "the old countdown is cancelled");
    const live = t.timers.filter((x) => !x.cleared);
    assert.equal(live.length, 1);
    assert.equal(live[0].ms, 10 * 60_000);
  });

  test("the countdown never kills a server in the middle of a request", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const t = setup({
      behave: gpuBehaviour,
      inference: async () => {
        await gate;
        return Response.json({ text: "slow one" });
      },
    });
    const slow = t.runner.transcribe(WAV);
    await new Promise((r) => setImmediate(r));
    const idle = t.timers.filter((x) => !x.cleared);
    assert.equal(idle.length, 0, "no countdown is running while a request is in flight");
    release();
    assert.equal(await slow, "slow one");
    assert.equal(t.children[0].gone, false);
  });

  test("a countdown that fires during a request re-arms instead of killing", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let calls = 0;
    const t = setup({
      behave: gpuBehaviour,
      inference: async () => {
        if (++calls === 2) await gate;
        return Response.json({ text: "ok" });
      },
    });
    await t.runner.transcribe(WAV);
    const stale = t.timers.filter((x) => !x.cleared)[0];
    const slow = t.runner.transcribe(WAV);
    await new Promise((r) => setImmediate(r));
    stale.fn(); // a timer that raced the second request
    assert.equal(t.children[0].gone, false);
    release();
    await slow;
    assert.equal(t.children[0].gone, false);
  });

  test("stopping forgets that the GPU failed, so the next start tries it again", async () => {
    const t = setup({
      behave: (c) => (c.bin === GPU_BIN ? { stderr: CUDA_MISSING } : {}),
    });
    await t.runner.transcribe(WAV);
    assert.deepEqual(t.children.map((c) => c.bin), [GPU_BIN, CPU_BIN]);
    t.runner.stop();
    await t.runner.transcribe(WAV);
    assert.deepEqual(t.children.map((c) => c.bin), [GPU_BIN, CPU_BIN, GPU_BIN, CPU_BIN]);
  });
});

describe("cleaning up", () => {
  test("killAll (what the exit hook runs) kills every child", async () => {
    const t = setup({ behave: gpuBehaviour });
    await t.runner.transcribe(WAV);
    assert.equal(t.hooks.length, 1);
    t.hooks[0]();
    assert.equal(t.children.every((c) => c.gone), true);
    assert.equal(t.runner.running, false);
  });

  test("killing the server in the middle of starting it makes the start fail rather than hang", async () => {
    const t = setup({ env: { WHISPER_DEVICE: "cpu" }, behave: () => ({ neverReady: true }), yieldWhileWaiting: true });
    const pending = t.runner.transcribe(WAV);
    await new Promise((r) => setImmediate(r));
    t.runner.stop();
    await assert.rejects(pending);
  });
});

describe("whisperConfigured", () => {
  const exists = (...present: string[]) => (p: string) => present.includes(p);
  test("needs the model and at least one binary, all present on disk", () => {
    const env = { WHISPER_MODEL: MODEL, WHISPER_SERVER_BIN: GPU_BIN, WHISPER_SERVER_BIN_CPU: CPU_BIN };
    assert.equal(whisperConfigured(env, exists(MODEL, GPU_BIN, CPU_BIN)), true);
    assert.equal(whisperConfigured(env, exists(MODEL, CPU_BIN)), true, "the CPU build alone is enough");
    assert.equal(whisperConfigured(env, exists(MODEL, GPU_BIN)), true, "so is the GPU build alone");
    assert.equal(whisperConfigured(env, exists(GPU_BIN, CPU_BIN)), false, "no model file");
    assert.equal(whisperConfigured(env, exists(MODEL)), false, "no binary file");
    assert.equal(whisperConfigured({ WHISPER_SERVER_BIN: GPU_BIN }, exists(MODEL, GPU_BIN)), false, "WHISPER_MODEL unset");
    assert.equal(whisperConfigured({ WHISPER_MODEL: MODEL }, exists(MODEL, GPU_BIN)), false, "no binary named");
    assert.equal(whisperConfigured({}, () => true), false);
  });
});
