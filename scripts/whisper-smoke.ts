// A real end-to-end check of local voice input against the actual whisper-server on this PC, with no web server and no
// database: it feeds one WAV file through the same assistant/speech/whisper.ts the app uses and prints the text and timing.
//
//   npx tsx scripts/whisper-smoke.ts path\to\clip.wav [--allow-gpu]
//
// CPU only unless you pass --allow-gpu: this PC is also a gaming PC, and starting the CUDA build takes VRAM from the game.
// Everything else comes from the WHISPER_* variables in .env.local (see .env.example); use a different WHISPER_PORT from
// the running app's. The whisper-server it starts is always stopped again before this exits.
//
// The clip must be what the app's endpoint takes: 16 kHz, mono, 16-bit PCM WAV, up to 30 seconds.

// First, for the same reason as in server.ts: env.ts has to load .env.local before anything reads process.env.
import "../env.ts";

import fs from "node:fs";
import { whisper, whisperConfigured, whisperSettings } from "../assistant/speech/whisper.ts";
import { checkWav } from "../assistant/speech/wav.ts";

// The same shape of hint the app builds from the household's names (assistant/speech/prompt.ts). Written out here so this
// script never opens the household database.
const HINT = "Household assistant. Family: Alex, Bea. Meal plan, grocery list, pantry, chores, calendar, budget.";

async function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--"));
  if (!file) {
    console.error("Usage: npx tsx scripts/whisper-smoke.ts <clip.wav> [--allow-gpu]");
    process.exitCode = 2;
    return;
  }
  if (!args.includes("--allow-gpu")) process.env.WHISPER_DEVICE = "cpu";

  if (!whisperConfigured()) {
    console.error("Whisper isn't set up: WHISPER_MODEL and a server binary must name files that exist (see .env.example).");
    process.exitCode = 1;
    return;
  }
  const wav = fs.readFileSync(file);
  const check = checkWav(wav);
  if (!check.ok) {
    console.error(`${file}: ${check.error}`);
    process.exitCode = 1;
    return;
  }

  const settings = whisperSettings();
  console.log(`Clip: ${file} (${check.seconds.toFixed(1)} s). Device: ${settings.device}, port ${settings.port}, ${settings.threads} threads.`);

  try {
    const started = Date.now();
    const first = await whisper.transcribe(wav, { prompt: HINT });
    const firstMs = Date.now() - started;
    console.log(`Text: ${JSON.stringify(first)}`);
    console.log(`First request (includes starting whisper-server, running on the ${whisper.device} build): ${firstMs} ms`);

    const again = Date.now();
    await whisper.transcribe(wav, { prompt: HINT });
    console.log(`Second request (server already warm): ${Date.now() - again} ms`);
  } catch (err) {
    console.error("Transcription failed:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  } finally {
    whisper.stop();
  }
}

await main();
