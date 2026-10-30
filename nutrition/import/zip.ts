// Getting an export's files into memory from a ZIP buffer (the web upload and the CLI's --zip).
//
// Two kinds of file are read:
//   - text (.csv / .txt / .json), decoded to strings and keyed by lowercase basename, so everything after
//     this point doesn't care how the archive was laid out;
//   - progress photos (progress-photos/*.jpg|png|webp), kept as raw bytes keyed the same way. Every other
//     picture in the archive (meal photos) is never inflated, only counted, so it costs no memory.

import { unzipSync } from "fflate";
import { NutritionError } from "../data/errors.ts";

/**
 * Zip-bomb guard: the total UNCOMPRESSED size of the files that are actually read (text and progress
 * photos). A household's whole history is a few MB of text plus a few photos; refuse anything near this.
 * Pictures that are skipped are never inflated, so they don't count.
 */
export const MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;

export type ExportFiles = Map<string, string>;

export interface LoseItExport {
  /** Text files, by lowercase basename. */
  files: ExportFiles;
  /** Progress photos (raw bytes), by lowercase basename: `<date>-<token>-photo.jpg`. */
  photos: Map<string, Uint8Array>;
  /** Pictures in the archive that are not progress photos (meal photos): counted, never read. */
  ignoredImages: number;
}

// Only text is decoded. CSV is what the export is; .txt/.json are kept so an unexpected file still shows
// up in the inventory instead of vanishing.
const TEXT_FILE = /\.(csv|txt|json)$/i;
const IMAGE_FILE = /\.(jpe?g|png|webp|heic|gif)$/i;
const PROGRESS_PHOTO = /(^|\/)progress-photos\/[^/]+\.(jpe?g|png|webp)$/i;

export function isZip(bytes: Uint8Array): boolean {
  // Local file header (PK\3\4) or, for an empty archive, the end-of-central-directory record (PK\5\6).
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && ((bytes[2] === 3 && bytes[3] === 4) || (bytes[2] === 5 && bytes[3] === 6));
}

/** UTF-8 (BOM stripped), UTF-16 with a BOM (what Excel's "Unicode text" writes), else Windows-1252. */
export function decodeText(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

const normPath = (p: string): string => p.replace(/\\/g, "/").replace(/^\/+/, "");
const baseOf = (full: string): string => full.slice(full.lastIndexOf("/") + 1);

/**
 * Add one text file under its lowercase basename ("Export/Food-Logs.csv" -> "food-logs.csv").
 * Archive junk (macOS resource forks) is dropped. If two folders hold the same basename the first keeps the
 * plain name and later ones keep their full path, so they still appear in the inventory but can't be
 * mistaken for the real file.
 */
function addFile(files: ExportFiles, relPath: string, bytes: Uint8Array): void {
  const full = normPath(relPath);
  const base = baseOf(full);
  if (!base || !TEXT_FILE.test(base) || base.startsWith("._") || /^__macosx\//i.test(full)) return;
  const name = base.toLowerCase();
  const key = files.has(name) ? full.toLowerCase() : name;
  if (!files.has(key)) files.set(key, decodeText(bytes));
}

const isJunk = (full: string): boolean => baseOf(full).startsWith("._") || /^__macosx\//i.test(full);

export function readZip(data: Uint8Array, maxBytes = MAX_UNCOMPRESSED_BYTES): LoseItExport {
  if (!isZip(data)) throw new NutritionError(400, "That file isn't a ZIP archive. Use the .zip that Lose It! gives you at loseit.com/export/data.");
  const tooBig = () => new NutritionError(400, `The ZIP expands to more than ${Math.round(maxBytes / 1024 / 1024)} MB, which is far more than a Lose It! export. Refusing to open it.`);
  const wanted = (name: string): boolean => {
    const full = normPath(name);
    return !full.endsWith("/") && !isJunk(full) && (TEXT_FILE.test(full) || PROGRESS_PHOTO.test(full));
  };
  try {
    // Pass 1 reads only the central directory (nothing is inflated): sum the declared sizes of what will be
    // read, and count the pictures that won't be. fflate caps each entry's output at its declared size, so this
    // total bounds memory.
    let total = 0;
    let ignoredImages = 0;
    unzipSync(data, {
      filter: (f) => {
        if (wanted(f.name)) {
          total += f.originalSize;
          if (total > maxBytes) throw tooBig();
        } else if (IMAGE_FILE.test(f.name) && !isJunk(normPath(f.name))) {
          ignoredImages++;
        }
        return false;
      },
    });
    const files: ExportFiles = new Map();
    const photos = new Map<string, Uint8Array>();
    const entries = unzipSync(data, { filter: (f) => wanted(f.name) });
    for (const [name, bytes] of Object.entries(entries)) {
      const full = normPath(name);
      if (PROGRESS_PHOTO.test(full)) {
        const key = baseOf(full).toLowerCase();
        if (!photos.has(key)) photos.set(key, bytes);
      } else {
        addFile(files, name, bytes);
      }
    }
    return { files, photos, ignoredImages };
  } catch (err) {
    if (err instanceof NutritionError) throw err;
    throw new NutritionError(400, "Couldn't read that ZIP (it looks damaged or password-protected).");
  }
}
