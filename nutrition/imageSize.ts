// What an uploaded picture really is: JPEG, PNG or WebP, and its pixel size, read from the file's own
// header. The progress-photo upload uses it so the server never trusts the client's word about the type
// or the size, and refuses anything that is not one of the three (an SVG, a PDF, an HTML page...).
//
// Header parsing only -- nothing is decoded, so a hostile file cannot cost more than a few reads.

export type ImageMime = "image/jpeg" | "image/png" | "image/webp";

export interface ImageInfo {
  mime: ImageMime;
  width: number;
  height: number;
}

const be16 = (b: Uint8Array, i: number): number => (b[i] << 8) | b[i + 1];
const be32 = (b: Uint8Array, i: number): number => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const le16 = (b: Uint8Array, i: number): number => b[i] | (b[i + 1] << 8);
const le24 = (b: Uint8Array, i: number): number => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
const ascii = (b: Uint8Array, i: number, n: number): string => String.fromCharCode(...b.subarray(i, i + n));

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function png(b: Uint8Array): ImageInfo | null {
  if (b.length < 24 || !PNG_SIGNATURE.every((v, i) => b[i] === v) || ascii(b, 12, 4) !== "IHDR") return null;
  return { mime: "image/png", width: be32(b, 16), height: be32(b, 20) };
}

/** Start-of-frame markers carry the size; 0xC4 (DHT), 0xC8 (JPG) and 0xCC (DAC) share the range but do not. */
const isSof = (m: number): boolean => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;

function jpeg(b: Uint8Array): ImageInfo | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) return null;
  let i = 2;
  while (i + 3 < b.length) {
    if (b[i] !== 0xff) return null;
    while (b[i] === 0xff && i + 1 < b.length) i++; // fill bytes
    const marker = b[i];
    i++;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue; // no length
    if (marker === 0xd9 || marker === 0xda) return null; // end of image / start of scan, with no frame header before it
    if (i + 2 > b.length) return null;
    const length = be16(b, i);
    if (isSof(marker)) {
      if (i + 7 > b.length) return null;
      return { mime: "image/jpeg", height: be16(b, i + 3), width: be16(b, i + 5) };
    }
    if (length < 2) return null;
    i += length;
  }
  return null;
}

function webp(b: Uint8Array): ImageInfo | null {
  if (b.length < 30 || ascii(b, 0, 4) !== "RIFF" || ascii(b, 8, 4) !== "WEBP") return null;
  const kind = ascii(b, 12, 4);
  if (kind === "VP8 ") {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { mime: "image/webp", width: le16(b, 26) & 0x3fff, height: le16(b, 28) & 0x3fff };
  }
  if (kind === "VP8L") {
    if (b[20] !== 0x2f) return null;
    const bits = (b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)) >>> 0;
    return { mime: "image/webp", width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (kind === "VP8X") return { mime: "image/webp", width: le24(b, 24) + 1, height: le24(b, 27) + 1 };
  return null;
}

/** The type and pixel size of a JPEG, PNG or WebP, or null when the bytes are anything else (or too damaged to say). */
export function imageInfo(bytes: Uint8Array): ImageInfo | null {
  const info = png(bytes) ?? jpeg(bytes) ?? webp(bytes);
  return info && info.width > 0 && info.height > 0 ? info : null;
}
