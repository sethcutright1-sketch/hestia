// Shrinking a progress photo in the browser before it is uploaded (merge plan: new photos are shrunk to about
// 1600 px on the long side, roughly 300-500 KB as a JPEG). The size maths is plain and tested
// (tests/foodImageResize.test.ts); `shrinkPhoto` is the canvas part, which only runs in a browser.
//
// EXIF orientation: a phone saves the pixels sideways and a tag says how to turn them. Decoding with
// createImageBitmap(file, { imageOrientation: "from-image" }) hands back the picture already turned, so the
// canvas gets it the right way up; a browser that does not know the option throws, and the fallback draws an
// <img>, which every current browser also turns by its EXIF tag when drawn to a canvas. Re-encoding through the
// canvas also drops the EXIF block, GPS position included, so the stored photo carries no location.

/** The long side of a new photo, in pixels. */
export const PHOTO_MAX_SIDE = 1600;
/** JPEG quality of the re-encoded photo: 0.85 keeps a 1600 px photo around 300-500 KB. */
export const PHOTO_JPEG_QUALITY = 0.85;

/** The size to draw at: the long side brought down to `max`, the shape kept, never enlarged. */
export function fitWithin(width: number, height: number, max: number = PHOTO_MAX_SIDE): { width: number; height: number; scaled: boolean } {
  if (!(width > 0) || !(height > 0)) return { width: 0, height: 0, scaled: false };
  const long = Math.max(width, height);
  if (long <= max) return { width: Math.round(width), height: Math.round(height), scaled: false };
  const k = max / long;
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)), scaled: true };
}

/** The base64 of a data: URL (what the upload sends: no prefix). */
export const base64Of = (dataUrl: string): string => dataUrl.slice(dataUrl.indexOf(",") + 1);

async function decode(file: Blob): Promise<{ source: CanvasImageSource; width: number; height: number; release: () => void }> {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
  } catch {
    // An older browser: let an <img> decode it (it applies the EXIF turn itself).
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.decoding = "async";
      img.src = url;
      await img.decode();
      return { source: img, width: img.naturalWidth, height: img.naturalHeight, release: () => URL.revokeObjectURL(url) };
    } catch (err) {
      URL.revokeObjectURL(url);
      throw err;
    }
  }
}

export interface ShrunkPhoto {
  /** The JPEG, as a data: URL, ready to preview. */
  dataUrl: string;
  /** The same JPEG as base64 without the prefix, ready to upload. */
  base64: string;
  width: number;
  height: number;
}

/** A recipe photo: about 800 px, roughly 80-150 KB (the server keeps at most 1 MB for one). */
export const RECIPE_PHOTO_MAX_SIDE = 800;
export const RECIPE_PHOTO_JPEG_QUALITY = 0.8;

/**
 * Decode a picked photo, turn it upright, scale it to PHOTO_MAX_SIDE (or `opts.maxSide`) and re-encode it as a JPEG
 * (quality PHOTO_JPEG_QUALITY, or `opts.quality`). Throws a plain Error a person can read.
 */
export async function shrinkPhoto(file: Blob, opts: { maxSide?: number; quality?: number } = {}): Promise<ShrunkPhoto> {
  let decoded;
  try {
    decoded = await decode(file);
  } catch {
    throw new Error("That file couldn't be read as a picture. Try a JPEG, PNG or WebP photo.");
  }
  try {
    const size = fitWithin(decoded.width, decoded.height, opts.maxSide ?? PHOTO_MAX_SIDE);
    if (size.width === 0) throw new Error("That picture has no size.");
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("This browser can't resize pictures.");
    ctx.fillStyle = "#ffffff"; // a PNG with see-through parts would turn black as a JPEG otherwise
    ctx.fillRect(0, 0, size.width, size.height);
    ctx.drawImage(decoded.source, 0, 0, size.width, size.height);
    const dataUrl = canvas.toDataURL("image/jpeg", opts.quality ?? PHOTO_JPEG_QUALITY);
    return { dataUrl, base64: base64Of(dataUrl), width: size.width, height: size.height };
  } finally {
    decoded.release();
  }
}
