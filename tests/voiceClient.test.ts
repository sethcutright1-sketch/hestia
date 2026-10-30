// The pure parts of the browser's voice input: the WAV the server insists on, the resampler that
// gets mic audio down to 16 kHz, and the markdown stripping done before text is read aloud.
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeWav, resample, rms, concatFloat32 } from "../src/voice/wav.ts";
import { stripMarkdown } from "../src/voice/speak.ts";

test("encodeWav writes a 16 kHz mono 16-bit PCM header the server will accept", () => {
  const samples = new Float32Array([0, 0.5, -0.5, 1, -1, 2, -2]);
  const buf = encodeWav(samples, 16000);
  const v = new DataView(buf);
  const text = (o: number, n: number) => String.fromCharCode(...new Uint8Array(buf, o, n));
  assert.equal(buf.byteLength, 44 + samples.length * 2);
  assert.equal(text(0, 4), "RIFF");
  assert.equal(v.getUint32(4, true), 36 + samples.length * 2);
  assert.equal(text(8, 4), "WAVE");
  assert.equal(text(12, 4), "fmt ");
  assert.equal(v.getUint16(20, true), 1); // PCM
  assert.equal(v.getUint16(22, true), 1); // mono
  assert.equal(v.getUint32(24, true), 16000);
  assert.equal(v.getUint32(28, true), 32000);
  assert.equal(v.getUint16(32, true), 2);
  assert.equal(v.getUint16(34, true), 16);
  assert.equal(text(36, 4), "data");
  assert.equal(v.getUint32(40, true), samples.length * 2);
});

test("encodeWav scales and clamps samples", () => {
  const v = new DataView(encodeWav(new Float32Array([0, 0.5, -0.5, 1, -1, 2, -2])));
  const at = (i: number) => v.getInt16(44 + i * 2, true);
  assert.equal(at(0), 0);
  assert.equal(at(1), 16384);
  assert.equal(at(2), -16384);
  assert.equal(at(3), 32767);
  assert.equal(at(4), -32768);
  assert.equal(at(5), 32767); // clipped, not wrapped
  assert.equal(at(6), -32768);
});

test("resample 48 kHz -> 16 kHz keeps the length ratio and averages", () => {
  const input = new Float32Array(4800).fill(0.25);
  const out = resample(input, 48000, 16000);
  assert.equal(out.length, 1600);
  assert.ok(out.every((x) => Math.abs(x - 0.25) < 1e-6));

  const ramp = resample(new Float32Array([0, 3, 6, 9, 12, 15]), 48000, 16000);
  assert.deepEqual(Array.from(ramp), [3, 12]);
});

test("resample handles non-integer ratios and upsampling", () => {
  assert.equal(resample(new Float32Array(44100), 44100, 16000).length, 16000);
  const up = resample(new Float32Array([0, 1]), 8000, 16000);
  assert.equal(up.length, 4);
  assert.deepEqual(Array.from(up), [0, 0.5, 1, 1]);
  const same = new Float32Array([1, 2, 3]);
  assert.equal(resample(same, 16000, 16000), same);
});

test("rms and concatFloat32", () => {
  assert.equal(rms(new Float32Array(0)), 0);
  assert.equal(rms(new Float32Array([0.5, -0.5, 0.5, -0.5])), 0.5);
  assert.deepEqual(Array.from(concatFloat32([new Float32Array([1, 2]), new Float32Array([3])])), [1, 2, 3]);
});

test("stripMarkdown makes a reply sound natural", () => {
  assert.equal(stripMarkdown("**Milk** and `eggs`"), "Milk and eggs.");
  assert.equal(stripMarkdown("## Plan\n- Eggs\n- [Bread](https://x.test/b)"), "Plan. Eggs. Bread.");
  assert.equal(stripMarkdown("See https://example.com now"), "See now.");
  assert.equal(stripMarkdown("Before\n```js\nconst a = 1;\n```\nAfter"), "Before. After.");
  assert.equal(stripMarkdown("_soft_ and __loud__ text"), "soft and loud text.");
  assert.equal(stripMarkdown("Done!"), "Done!");
  assert.equal(stripMarkdown("  \n\n "), "");
  assert.equal(stripMarkdown("snake_case_name stays"), "snake_case_name stays.");
});
