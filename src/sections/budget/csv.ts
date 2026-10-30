// src/sections/budget/csv.ts -- pure CSV building for the Transactions tab's
// export button. Pulled out of Budget.tsx (which used to build and download
// the file inline) so the escaping rules have their own tests; the actual
// Blob/anchor download dance stays in the component, since that part needs
// the DOM.

import type { Transaction } from './types';

// Formats one CSV cell: doubles embedded quotes (a merchant name containing a
// " used to corrupt every column after it) and, for a text cell, prefixes a
// leading =, +, - or @ with a bare quote -- the standard guard against a cell
// being interpreted as a formula when the file is opened in Excel/Sheets. Not
// applied to the numeric amount column, which is written as a plain number.
function csvCell(value: unknown, isNumeric = false): string {
  if (isNumeric) return String(value);
  let text = String(value ?? '');
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function buildTransactionsCsv(transactions: Transaction[]): string {
  const header = 'Date,Description,Merchant,Amount,Category,Scope,Bank\n';
  const rows = transactions
    .map((t) =>
      [
        csvCell(t.date),
        csvCell(t.description),
        csvCell(t.merchantName),
        csvCell(t.amount, true),
        csvCell(t.category),
        csvCell(t.scope || 'personal'),
        csvCell(t.bankName),
      ].join(',')
    )
    .join('\n');
  return header + rows;
}
