// RFC 4180 CSV parsing for the Lose It! importer, tolerant of what spreadsheets and
// exporters really emit: a leading UTF-8 BOM, CRLF / LF / lone-CR line ends, quoted
// fields holding commas, doubled quotes and line breaks, ragged rows and blank lines.
// Pure and dependency-free, so the whole parsing layer is unit-testable without a
// database (the real export's shape is described in loseitParse.ts).

/** Lowercase, trim, collapse runs of whitespace: the key every record is stored under. */
export function normHeader(header: string): string {
  return header.replace(/^﻿/, "").trim().toLowerCase().replace(/\s+/g, " ");
}

/** Split text into rows of cells. Blank lines are dropped; nothing else is interpreted. */
export function parseCsvGrid(input: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;   // inside "..."
  let wasQuoted = false; // this cell started with a quote, so a later quote is literal
  let i = 0;

  const endCell = () => { row.push(cell); cell = ""; wasQuoted = false; };
  const endRow = () => {
    endCell();
    // A line with a single empty cell is a blank line, not a record.
    if (!(row.length === 1 && row[0].trim() === "")) rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 2; continue; } // "" is an escaped quote
        quoted = false;
        i++;
        continue;
      }
      cell += c;
      i++;
      continue;
    }
    // An opening quote only counts at the start of a cell (spaces before it are tolerated);
    // a quote mid-text like 5" pizza stays literal.
    if (c === '"' && !wasQuoted && cell.trim() === "") { cell = ""; quoted = true; wasQuoted = true; i++; continue; }
    if (c === ",") { endCell(); i++; continue; }
    if (c === "\r" || c === "\n") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      i++;
      endRow();
      continue;
    }
    cell += c;
    i++;
  }
  // A file with no trailing newline still has a last record. Checking `row.length`
  // (not just the cell) is what keeps a trailing empty cell: `a,b,` ends in an empty cell.
  if (cell !== "" || wasQuoted || row.length > 0) endRow();
  return rows;
}

export interface CsvTable {
  /** Header cells as written (trimmed), for reports. */
  headers: string[];
  /** The same headers, normalized with normHeader. Every record is keyed by these. */
  keys: string[];
  rows: Array<Record<string, string>>;
  /** Record number in the file (the header is record 1) of each entry in `rows`, for messages. */
  rowNumbers: number[];
  /** Data rows with more non-empty cells than the header has columns (the extras are dropped). */
  raggedRows: number;
}

export function parseCsv(text: string): CsvTable {
  const grid = parseCsvGrid(text);
  const empty: CsvTable = { headers: [], keys: [], rows: [], rowNumbers: [], raggedRows: 0 };
  if (grid.length === 0) return empty;

  const headers = grid[0].map((h) => h.replace(/^﻿/, "").trim());
  const keys = headers.map(normHeader);
  const table: CsvTable = { headers, keys, rows: [], rowNumbers: [], raggedRows: 0 };

  for (let r = 1; r < grid.length; r++) {
    const cells = grid[r];
    if (cells.every((c) => c.trim() === "")) continue;
    if (cells.length > keys.length && cells.slice(keys.length).some((c) => c.trim() !== "")) table.raggedRows++;
    const rec: Record<string, string> = {};
    keys.forEach((k, c) => {
      const v = (cells[c] ?? "").trim();
      // Duplicate headers: the first column wins unless it is blank in this row.
      if (!(k in rec) || rec[k] === "") rec[k] = v;
    });
    table.rows.push(rec);
    table.rowNumbers.push(r + 1);
  }
  return table;
}

// ---- header aliases -------------------------------------------------------------

const squash = (s: string): string => s.replace(/[^\p{L}\p{N}]+/gu, "");
// "Fat (g)" -> "fat": drop a trailing parenthetical unit before comparing.
const unitless = (s: string): string => squash(s.replace(/\s*[([][^)\]]*[)\]]\s*$/, ""));

/**
 * Map each wanted field to the header that holds it. Aliases are tried in order; for
 * each, an exact normalized match beats a punctuation-insensitive one, which beats one
 * that ignores a trailing "(unit)". A header is claimed by at most one field.
 */
export function resolveColumns<K extends string>(
  keys: readonly string[],
  wanted: Record<K, readonly string[]>,
): Record<K, string | undefined> {
  const claimed = new Set<string>();
  const out = {} as Record<K, string | undefined>;
  for (const field of Object.keys(wanted) as K[]) {
    let found: string | undefined;
    for (const alias of wanted[field]) {
      const a = normHeader(alias);
      const tests = [(k: string) => k === a, (k: string) => squash(k) === squash(a), (k: string) => unitless(k) === unitless(a)];
      for (const test of tests) {
        found = keys.find((k) => !claimed.has(k) && test(k));
        if (found) break;
      }
      if (found) break;
    }
    if (found) claimed.add(found);
    out[field] = found;
  }
  return out;
}

/** A record's cell for a resolved column, or "" when the column doesn't exist. */
export const cell = (row: Record<string, string>, key: string | undefined): string => (key === undefined ? "" : row[key] ?? "");
