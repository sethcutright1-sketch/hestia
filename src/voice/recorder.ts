// Records the microphone and hands back a 16 kHz mono 16-bit WAV -- the exact format
// POST /api/assistant/transcribe validates. Nothing here talks to a network: the audio only
// leaves the page when the caller sends the returned Blob to our own server.

import { TARGET_RATE, concatFloat32, encodeWav, resample, rms } from "./wav.ts";

/** Server accepts 0.2-30 s. Stay a hair under the top so rounding never tips a clip over. */
const MAX_SECONDS = 29.9;
/** Pad very short taps up to this so the server's 0.2 s floor can't reject them. */
const MIN_SECONDS = 0.3;
/** Don't auto-stop during the first moments -- people take a breath before they talk. */
const MIN_BEFORE_AUTOSTOP = 0.8;
const SILENCE_AFTER_SPEECH = 1.5;
/** Louder than this counts as speech starting; quieter than SILENCE_RMS counts as a pause. Two
 *  thresholds so a quiet word in the middle of a sentence doesn't flicker between the states. */
const SPEECH_RMS = 0.02;
const SILENCE_RMS = 0.012;

export interface RecorderOptions {
  /** Loudness 0..1 for each captured block (a few times a second) -- drives the pulsing button. */
  onLevel?: (level: number) => void;
  /** Seconds recorded so far. */
  onTick?: (seconds: number) => void;
}

export interface RecorderHandle {
  /** Ends the recording and resolves with the WAV. Safe to call after an auto-stop. */
  stop(): Promise<Blob>;
  /** Throws the recording away and releases the mic. */
  cancel(): void;
  /** Resolves with the WAV when recording ends by ANY route (stop(), silence, 30 s cap).
   *  Rejects with an Error named "RecordingCancelled" if cancel() was called. */
  finished: Promise<Blob>;
}

export function voiceSupported(): boolean {
  if (typeof window === "undefined") return false;
  const hasAudioContext = !!(window.AudioContext || (window as any).webkitAudioContext);
  return window.isSecureContext && !!navigator.mediaDevices?.getUserMedia && hasAudioContext;
}

// Source of the AudioWorklet, loaded from a Blob URL so Vite doesn't need a separate asset file.
// It batches ~2048 samples per message instead of posting every 128-sample render quantum.
const WORKLET_SOURCE = `
class HestiaPcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(2048);
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.buf.length) {
          this.port.postMessage(this.buf.slice(0));
          this.n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor("hestia-pcm-capture", HestiaPcmCapture);
`;

type AudioContextCtor = typeof AudioContext;

export async function startRecording(opts: RecorderOptions = {}): Promise<RecorderHandle> {
  if (!voiceSupported()) throw new Error("Voice input isn't supported in this browser.");

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });

  let ctx: AudioContext | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let node: AudioNode | null = null;
  let sink: GainNode | null = null;
  let workletUrl: string | null = null;

  // Everything below can throw (unsupported rate, worklet blocked). If it does, the mic must still
  // be released -- otherwise the browser's recording indicator stays on with nothing to stop it.
  const release = () => {
    try { node?.disconnect(); } catch { /* already disconnected */ }
    try { source?.disconnect(); } catch { /* already disconnected */ }
    try { sink?.disconnect(); } catch { /* already disconnected */ }
    if (node && "port" in node) {
      try { (node as AudioWorkletNode).port.onmessage = null; } catch { /* ignore */ }
    }
    if (node && "onaudioprocess" in node) (node as ScriptProcessorNode).onaudioprocess = null;
    stream.getTracks().forEach((t) => t.stop());
    ctx?.close().catch(() => {});
    if (workletUrl) URL.revokeObjectURL(workletUrl);
  };

  const chunks: Float32Array[] = [];
  let capturedSamples = 0;
  let sampleRate = TARGET_RATE;
  let heardSpeech = false;
  let silentSeconds = 0;
  let ended = false;
  let cancelled = false;

  let resolveFinished!: (b: Blob) => void;
  let rejectFinished!: (e: Error) => void;
  const finished = new Promise<Blob>((res, rej) => {
    resolveFinished = res;
    rejectFinished = rej;
  });
  // A cancel rejects `finished`; callers that only use stop() would otherwise log an unhandled rejection.
  finished.catch(() => {});

  function end() {
    if (ended) return;
    ended = true;
    release();
    if (cancelled) {
      rejectFinished(Object.assign(new Error("Recording cancelled."), { name: "RecordingCancelled" }));
      return;
    }
    let samples = resample(concatFloat32(chunks), sampleRate, TARGET_RATE);
    const max = Math.floor(MAX_SECONDS * TARGET_RATE);
    if (samples.length > max) samples = samples.subarray(0, max);
    const min = Math.floor(MIN_SECONDS * TARGET_RATE);
    if (samples.length < min) {
      const padded = new Float32Array(min);
      padded.set(samples);
      samples = padded;
    }
    resolveFinished(new Blob([encodeWav(samples, TARGET_RATE)], { type: "audio/wav" }));
  }

  function onSamples(block: Float32Array) {
    if (ended) return;
    chunks.push(block);
    capturedSamples += block.length;
    const seconds = capturedSamples / sampleRate;
    const level = rms(block);
    opts.onLevel?.(Math.min(1, level * 6));
    opts.onTick?.(seconds);

    if (level >= SPEECH_RMS) {
      heardSpeech = true;
      silentSeconds = 0;
    } else if (heardSpeech && level < SILENCE_RMS) {
      silentSeconds += block.length / sampleRate;
    }
    if (seconds >= MAX_SECONDS) end();
    else if (heardSpeech && seconds >= MIN_BEFORE_AUTOSTOP && silentSeconds >= SILENCE_AFTER_SPEECH) end();
  }

  try {
    const Ctor: AudioContextCtor = window.AudioContext || (window as any).webkitAudioContext;

    // Ask for 16 kHz so no resampling is needed. Some browsers (Firefox, older Safari) throw, or
    // refuse to connect a mic running at another rate -- in that case fall back to the device's own
    // rate and resample ourselves at the end.
    try {
      ctx = new Ctor({ sampleRate: TARGET_RATE });
      source = ctx.createMediaStreamSource(stream);
    } catch {
      source?.disconnect();
      ctx?.close().catch(() => {});
      ctx = new Ctor();
      source = ctx.createMediaStreamSource(stream);
    }
    sampleRate = ctx.sampleRate;
    // Browsers start a context "suspended" until a gesture; this runs from a tap, but be explicit.
    if (ctx.state === "suspended") await ctx.resume();

    // The capture node's output goes nowhere audible: it has to be connected to the destination for
    // some browsers to pull audio through it, so route it via a muted gain to avoid echoing the mic.
    sink = ctx.createGain();
    sink.gain.value = 0;
    sink.connect(ctx.destination);

    let usedWorklet = false;
    if (ctx.audioWorklet && typeof AudioWorkletNode !== "undefined") {
      try {
        workletUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "application/javascript" }));
        await ctx.audioWorklet.addModule(workletUrl);
        const worklet = new AudioWorkletNode(ctx, "hestia-pcm-capture", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
        worklet.port.onmessage = (ev: MessageEvent<Float32Array>) => onSamples(ev.data);
        node = worklet;
        usedWorklet = true;
      } catch {
        // Blocked or unsupported -- fall through to the older API below.
      }
    }
    if (!usedWorklet) {
      const proc = ctx.createScriptProcessor(4096, 1, 1);
      proc.onaudioprocess = (ev) => onSamples(ev.inputBuffer.getChannelData(0).slice());
      node = proc;
    }
    source.connect(node!);
    node!.connect(sink);
  } catch (err) {
    release();
    throw err;
  }

  return {
    finished,
    stop() {
      end();
      return finished;
    },
    cancel() {
      cancelled = true;
      end();
    },
  };
}
