// Reads the assistant's reply aloud with the browser's own speech synthesis. That is a voice built
// into the device -- nothing is sent anywhere.

export type ReadAloudPref = "off" | "spoken" | "always";

const PREF_KEY = "hestia.voice.readAloud";

export function speechSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined";
}

/** "spoken" (default) = read the reply aloud only when the question was spoken. Per device. */
export function getReadAloudPref(): ReadAloudPref {
  try {
    const v = localStorage.getItem(PREF_KEY);
    if (v === "off" || v === "spoken" || v === "always") return v;
  } catch { /* storage blocked -- use the default */ }
  return "spoken";
}

export function setReadAloudPref(pref: ReadAloudPref): void {
  try {
    localStorage.setItem(PREF_KEY, pref);
  } catch { /* storage blocked -- the choice just won't stick */ }
}

/** Turns a markdown reply into text that sounds natural when read out loud. */
export function stripMarkdown(md: string): string {
  const lines = md
    .replace(/```[\s\S]*?```/g, " ") // a spoken code block is just noise
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // image -> alt text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // link -> link text
    .replace(/https?:\/\/\S+/g, "") // bare URLs are unreadable aloud
    .split("\n");

  const spoken: string[] = [];
  for (const raw of lines) {
    let line = raw.trim();
    if (!line) continue;
    if (/^\|?[\s:|-]+\|?$/.test(line) && line.includes("-")) continue; // table divider row, or a --- rule
    line = line
      .replace(/^#{1,6}\s+/, "")
      .replace(/^>\s?/, "")
      .replace(/^[-*+•]\s+/, "")
      .replace(/\|/g, ", ")
      .replace(/(\*\*|__)(.*?)\1/g, "$2")
      .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,!?:;]|$)/g, "$1$2")
      .replace(/~~(.*?)~~/g, "$1")
      .replace(/`+/g, "")
      .replace(/\s+/g, " ")
      .replace(/^[,\s]+|[,\s]+$/g, "")
      .trim();
    if (!line) continue;
    // Each line becomes its own sentence, so list items get a pause instead of running together.
    spoken.push(/[.!?:]$/.test(line) ? line : line + ".");
  }
  return spoken.join(" ").trim();
}

/** Splits into pieces short enough that Chrome doesn't silently cut off a long utterance (~15 s). */
function chunkForSpeech(text: string, maxLen = 220): string[] {
  const sentences = text.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) ?? [text];
  const out: string[] = [];
  let cur = "";
  for (const s of sentences) {
    if (cur && (cur + s).length > maxLen) {
      out.push(cur.trim());
      cur = "";
    }
    cur += s;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function pickVoice(): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis.getVoices();
  const english = voices.filter((v) => v.lang?.toLowerCase().startsWith("en"));
  return (
    english.find((v) => v.default) ??
    english.find((v) => v.lang.toLowerCase() === "en-us" && v.localService) ??
    english.find((v) => v.localService) ??
    english[0] ??
    null
  );
}

export function speak(text: string): void {
  if (!speechSupported()) return;
  const clean = stripMarkdown(text);
  if (!clean) return;
  const synth = window.speechSynthesis;
  synth.cancel();
  const voice = pickVoice();
  for (const piece of chunkForSpeech(clean)) {
    const u = new SpeechSynthesisUtterance(piece);
    if (voice) {
      u.voice = voice;
      u.lang = voice.lang;
    } else {
      u.lang = "en-US";
    }
    synth.speak(u);
  }
}

export function stopSpeaking(): void {
  if (!speechSupported()) return;
  try {
    window.speechSynthesis.cancel();
  } catch { /* nothing was speaking */ }
}
