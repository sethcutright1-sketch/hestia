// Progress photos as the grid shows them: grouped by month (newest first), each photo labelled with its day.
// The server already sends them newest day first; this only groups. Tested in tests/foodPhotoGroups.test.ts.

import type { Photo } from "./types.ts";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export interface PhotoGroup {
  /** "2026-10". */
  key: string;
  /** "October 2026". */
  label: string;
  photos: Photo[];
}

/** "October 2026" for a "YYYY-MM-DD" date. */
export function monthLabel(date: string): string {
  const [y, m] = date.split("-").map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

/** Newest day first, then newest upload first for the same day; consecutive photos of one month share a group. */
export function groupPhotosByMonth(photos: Photo[]): PhotoGroup[] {
  const sorted = [...photos].sort((a, b) => (a.takenOn === b.takenOn ? b.createdAt.localeCompare(a.createdAt) : b.takenOn.localeCompare(a.takenOn)));
  const groups: PhotoGroup[] = [];
  for (const p of sorted) {
    const key = p.takenOn.slice(0, 7);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.photos.push(p);
    else groups.push({ key, label: monthLabel(p.takenOn), photos: [p] });
  }
  return groups;
}

/** "412 KB" / "1.3 MB": a size for the photo viewer. */
export function sizeText(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${Math.round((bytes / 1024 / 1024) * 10) / 10} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
