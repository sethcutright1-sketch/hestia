// Barcode normalisation shared by the diary, the food data layer and the one barcode service (nutrition/lookup.ts).
//
// Every retail barcode is a GTIN: UPC-A is a GTIN-12, EAN-13 a GTIN-13, EAN-8 a
// GTIN-8. They are all the same number space once left-padded with zeros, so the
// canonical key is the 14-digit form. Databases do NOT agree on which width they
// store, which is why `lookupVariants` exists.

/** GS1 mod-10 check: works for any GTIN length (8, 12, 13, 14). */
export function gs1CheckDigitValid(digits: string): boolean {
  if (!/^\d+$/.test(digits) || digits.length < 2) return false;
  const body = digits.slice(0, -1);
  const check = Number(digits[digits.length - 1]);
  // Weights alternate 3,1,3,1... starting from the digit next to the check digit,
  // so walk right-to-left; that keeps the rule independent of total length.
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    const d = Number(body[body.length - 1 - i]);
    sum += i % 2 === 0 ? d * 3 : d;
  }
  return (10 - (sum % 10)) % 10 === check;
}

/**
 * Expand UPC-E (zero-suppressed) to the 12-digit UPC-A it stands for.
 * Accepts 6 digits (no number system/check), 7 (number system + 6) or 8 (full).
 * The check digit is the same in both forms, so for 8-digit input it carries
 * over; for 6/7-digit input it is computed. Returns "" if the input is unusable.
 */
export function expandUpcE(upce: string): string {
  const d = upce.replace(/\D/g, "");
  let system: string;
  let core: string;
  let check: string | null = null;
  if (d.length === 6) {
    system = "0";
    core = d;
  } else if (d.length === 7) {
    system = d[0];
    core = d.slice(1);
  } else if (d.length === 8) {
    system = d[0];
    core = d.slice(1, 7);
    check = d[7];
  } else {
    return "";
  }
  // UPC-E only exists for number systems 0 and 1.
  if (system !== "0" && system !== "1") return "";

  const [a, b, c, dd, e, f] = core.split("");
  let manufacturer: string;
  let product: string;
  switch (f) {
    case "0":
    case "1":
    case "2":
      manufacturer = `${a}${b}${f}00`;
      product = `00${c}${dd}${e}`;
      break;
    case "3":
      manufacturer = `${a}${b}${c}00`;
      product = `000${dd}${e}`;
      break;
    case "4":
      manufacturer = `${a}${b}${c}${dd}0`;
      product = `0000${e}`;
      break;
    default: // 5-9
      manufacturer = `${a}${b}${c}${dd}${e}`;
      product = `0000${f}`;
  }
  const body = `${system}${manufacturer}${product}`;
  if (check === null) {
    // Compute the GS1 check digit by appending a placeholder and solving for it.
    for (let k = 0; k <= 9; k++) {
      if (gs1CheckDigitValid(body + k)) return body + k;
    }
    return "";
  }
  return body + check;
}

/**
 * Normalise a scanned/typed code to a validated GTIN-14.
 * 8-digit codes are only treated as UPC-E when `format` says so: EAN-8 is also
 * 8 digits and the two are indistinguishable by length.
 */
export function canonicalGtin(raw: string, format?: string): { gtin14: string; raw: string } | null {
  const digits = raw.replace(/\D/g, "");
  let code = digits;
  if (format === "upc_e" && (digits.length === 8 || digits.length === 7 || digits.length === 6)) {
    code = expandUpcE(digits);
    if (!code) return null;
  }
  if (![8, 12, 13, 14].includes(code.length)) return null;
  if (!gs1CheckDigitValid(code)) return null;
  return { gtin14: code.padStart(14, "0"), raw: digits };
}

/**
 * The distinct 8/12/13/14-digit spellings of a GTIN-14. USDA FDC stores `gtinUpc`
 * as 12, 13 or 14 digits depending on the record and matches only the exact
 * string (Cheerios is `00016000275287`; searching `016000275287` misses).
 */
export function lookupVariants(gtin14: string): string[] {
  const out = new Set<string>();
  out.add(gtin14);
  for (const len of [13, 12, 8]) {
    const head = gtin14.slice(0, 14 - len);
    if (/^0*$/.test(head)) out.add(gtin14.slice(14 - len));
  }
  // Longest first matches how most FDC records are stored.
  return [...out].sort((a, b) => b.length - a.length);
}

/**
 * Best-effort: UPC-A codes starting with 2 (and EAN-13 starting 02) are in-store
 * variable-weight labels (deli, produce, meat) that embed a price/weight, so the
 * code is not a stable product id. Unverified against real store labels.
 */
export function isRandomWeight(gtin14: string): boolean {
  // EAN-13 prefix 2 is "02..." in GTIN-14; a UPC-A starting 2 is the same code as EAN-13 "02...", so "002...".
  return /^0(0?2)/.test(gtin14);
}
