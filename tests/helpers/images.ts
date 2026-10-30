// Tiny hand-built pictures for the progress-photo tests. They carry real, correct HEADERS (the only part the
// server reads: nutrition/imageSize.ts) followed by filler, so they are not viewable images -- which is the
// point: the tests are about what the server accepts and keeps, not about decoding.

/** A real 1x1 PNG (decodable). */
export const PNG_1X1_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const u16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const u32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const filler = (n: number) => Array.from({ length: n }, (_, i) => i % 251);

/** A PNG header (signature + IHDR) for width x height, then `extra` filler bytes. */
export function pngBytes(width: number, height: number, extra = 0): Buffer {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...u32(13), 0x49, 0x48, 0x44, 0x52, ...u32(width), ...u32(height), 8, 2, 0, 0, 0, ...filler(extra)]);
}

/** A JPEG with a JFIF segment, a comment, and a baseline frame header for width x height, then filler. */
export function jpegBytes(width: number, height: number, extra = 0): Buffer {
  const app0 = [0xff, 0xe0, ...u16(16), 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, ...u16(1), ...u16(1), 0, 0];
  const comment = [0xff, 0xfe, ...u16(6), 0x68, 0x69, 0x21, 0x21];
  const sof = [0xff, 0xc0, ...u16(17), 8, ...u16(height), ...u16(width), 3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1];
  return Buffer.from([0xff, 0xd8, ...app0, ...comment, ...sof, 0xff, 0xda, ...filler(extra), 0xff, 0xd9]);
}

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const le = (n: number, bytes: number) => Array.from({ length: bytes }, (_, i) => (n >>> (8 * i)) & 0xff);

/** A WebP of one of the three flavours, with the size in the place that flavour keeps it. */
export function webpBytes(kind: "lossy" | "lossless" | "extended", width: number, height: number, extra = 0): Buffer {
  let chunk: number[];
  if (kind === "lossy") chunk = [...ascii("VP8 "), ...le(10 + extra, 4), 0, 0, 0, 0x9d, 0x01, 0x2a, ...le(width, 2), ...le(height, 2), ...filler(extra)];
  else if (kind === "lossless") {
    const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
    chunk = [...ascii("VP8L"), ...le(5 + extra, 4), 0x2f, ...le(bits >>> 0, 4), ...filler(extra)];
  } else chunk = [...ascii("VP8X"), ...le(10, 4), 0, 0, 0, 0, ...le(width - 1, 3), ...le(height - 1, 3), ...filler(extra)];
  return Buffer.from([...ascii("RIFF"), ...le(4 + chunk.length, 4), ...ascii("WEBP"), ...chunk]);
}
