// src/sections/budget/format.ts -- the one place that turns a number into a
// displayed money string, so every list in the Budget panel gets thousands
// separators and consistent decimals instead of each component rolling its
// own `${currency}${n.toFixed(2)}` (which drops the comma in "$1,200.00").

export interface FormatMoneyOptions {
  // Prefixes a '+' for positive amounts (negatives always get a leading '-'
  // regardless of this flag). Off by default -- most lists show plain
  // magnitudes and use icons/color for direction instead.
  sign?: boolean;
  // Decimal places to show. Defaults to 2 (cents); pass 0 for a rounded
  // whole-dollar figure (e.g. a compact legend).
  decimals?: 0 | 2;
}

export function formatMoney(amount: number, currency: string, options: FormatMoneyOptions = {}): string {
  const { sign = false, decimals = 2 } = options;
  const isNegative = amount < 0;
  const magnitude = Math.abs(amount).toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  if (isNegative) return `-${currency}${magnitude}`;
  if (sign && amount > 0) return `+${currency}${magnitude}`;
  return `${currency}${magnitude}`;
}
