// Checks that an upload really is the one audio format the transcribe endpoint takes before it is handed to
// whisper-server: 16 kHz, mono, 16-bit PCM WAV, at most 30 seconds. The browser resamples to exactly this (it is what
// Whisper wants anyway), so anything else is a client bug or someone poking the endpoint -- and a strict gate keeps a
// hostile file from ever reaching a native binary's parser.

export const WAV_SAMPLE_RATE = 16000;
export const WAV_MAX_SECONDS = 30;
export const WAV_MIN_SECONDS = 0.2;
/** 30 s of 16-bit mono at 16 kHz, plus a 44-byte header: the biggest valid upload (the route's limit leaves slack for extra chunks). */
export const WAV_MAX_BYTES = 44 + WAV_SAMPLE_RATE * 2 * WAV_MAX_SECONDS;

export type WavCheck = { ok: true; seconds: number } | { ok: false; error: string };

const bad = (error: string): WavCheck => ({ ok: false, error });

/** Walks the RIFF chunks (a header isn't always exactly 44 bytes) and reports why a file is refused, in plain English. */
export function checkWav(buf: Buffer): WavCheck {
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    return bad("That doesn't look like a WAV recording.");
  }

  let fmt: { format: number; channels: number; rate: number; bits: number } | null = null;
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      if (size < 16 || body + 16 > buf.length) return bad("That recording's header is damaged.");
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        rate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      if (!fmt) return bad("That recording's header is damaged.");
      if (fmt.format !== 1 || fmt.bits !== 16) return bad("The recording must be 16-bit PCM audio.");
      if (fmt.channels !== 1) return bad("The recording must be mono.");
      if (fmt.rate !== WAV_SAMPLE_RATE) return bad("The recording must be 16 kHz.");
      // A declared length longer than what arrived means the upload was cut off; trusting it would feed
      // whisper-server a file that lies about its own size.
      if (size > buf.length - body) return bad("That recording looks cut off.");
      const seconds = Math.floor(size / 2) / WAV_SAMPLE_RATE;
      if (seconds > WAV_MAX_SECONDS) return bad(`Recordings can be at most ${WAV_MAX_SECONDS} seconds.`);
      if (seconds < WAV_MIN_SECONDS) return bad("That recording is too short.");
      return { ok: true, seconds };
    }
    // Chunks are padded to an even length.
    offset = body + size + (size % 2);
  }
  return bad("That recording has no audio in it.");
}
