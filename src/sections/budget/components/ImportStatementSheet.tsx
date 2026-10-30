// src/sections/budget/components/ImportStatementSheet.tsx -- the Transactions
// tab's "Import statement" button opens this instead of the old
// StatementImporter, which used to live buried in Settings and imported
// straight from the AI's response with no chance to fix a bad amount sign, a
// wrong category, or catch an accidental double-import before it landed on
// the ledger. This adds a preview step: pick Mine/Joint for the whole batch,
// uncheck anything that looks like a duplicate of an existing transaction,
// flip a sign, fix a category -- then import only what's checked.

import { useState } from 'react';
import { UploadCloud, Sparkles, FileText, X, AlertTriangle, ArrowUpDown } from 'lucide-react';
import type { Transaction } from '../types';
import { markLikelyDuplicates } from '../budgetMath';
import { formatMoney } from '../format';

interface ImportStatementSheetProps {
  isOpen: boolean;
  onClose: () => void;
  categories: string[];
  existingTransactions: Transaction[];
  currency: string;
  onImportStatement: (transactions: Transaction[]) => void;
  onNewCategories?: (categories: string[]) => void;
}

const SAMPLE_STATEMENTS = [
  {
    title: 'Chase Statement Copy-Paste',
    text: `06/10 STARBUCKS COFFEE NYC $14.50
06/12 AMAZON.COM*AMZN INDIVIDU -$68.22
06/13 J.G. LANDLORD RENT DEP -$1,200.00
06/15 PAYROLL DIRECT DEPOSIT CO +$2,450.00
06/15 CONEDISON NY UTILITY $89.10
06/16 UBER TRIP RIDE SHARE $22.40`,
  },
  {
    title: 'Citibank Credit Statement',
    text: `06/11/2026 CVS PHARMACY FL $42.15
06/13/2026 NETFLIX SERVICES CA $19.99
06/14/2026 CHIPOTLE MEXICAN GRILL $18.25
06/15/2026 SHELL OIL COUSTON $45.00
06/16/2026 WALMART SUPERSTORE $112.50`,
  },
];

interface PreviewRow {
  id: string;
  include: boolean;
  date: string;
  merchantName: string;
  amount: number;
  category: string;
  isDuplicate: boolean;
}

export default function ImportStatementSheet({
  isOpen,
  onClose,
  categories,
  existingTransactions,
  currency,
  onImportStatement,
  onNewCategories,
}: ImportStatementSheetProps) {
  const [statementText, setStatementText] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [rows, setRows] = useState<PreviewRow[] | null>(null);
  const [scope, setScope] = useState<'personal' | 'joint'>('personal');

  if (!isOpen) return null;

  const reset = () => {
    setStatementText('');
    setStatusMessage('');
    setRows(null);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleParse = async () => {
    if (!statementText.trim()) return;
    setIsProcessing(true);
    setStatusMessage('');
    setRows(null);

    try {
      const response = await fetch('/api/budget/parse-statement', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rawText: statementText }),
      });
      if (!response.ok) throw new Error('Server returned an error while processing');

      const data = await response.json();
      const parsed: Transaction[] = data.transactions || [];
      if (parsed.length === 0) {
        setStatusMessage('No transactions were found. Try pasting differently formatted lines.');
        return;
      }

      const duplicateFlags = markLikelyDuplicates(existingTransactions, parsed);
      setRows(
        parsed.map((t, idx) => ({
          id: t.id,
          include: !duplicateFlags[idx],
          date: t.date,
          merchantName: t.merchantName,
          amount: t.amount,
          category: t.category,
          isDuplicate: duplicateFlags[idx],
        }))
      );
      // Shown even on the happy path -- the server sets `message` when it fell
      // back to the regex parser (Ollama down or too slow) instead of the AI.
      if (data.message) setStatusMessage(data.message);
    } catch (err: any) {
      console.error(err);
      setStatusMessage(`Failed to process statement: ${err.message}`);
    } finally {
      setIsProcessing(false);
    }
  };

  const updateRow = (id: string, patch: Partial<PreviewRow>) => {
    setRows((prev) => (prev ? prev.map((r) => (r.id === id ? { ...r, ...patch } : r)) : prev));
  };

  const checkedCount = rows?.filter((r) => r.include).length ?? 0;

  const handleImport = () => {
    if (!rows) return;
    const chosen = rows.filter((r) => r.include);
    if (chosen.length === 0) return;

    const finalTransactions: Transaction[] = chosen.map((r) => ({
      id: r.id,
      date: r.date,
      description: r.merchantName,
      merchantName: r.merchantName,
      amount: r.amount,
      category: r.category,
      bankName: 'Statement Import',
      status: 'cleared',
      scope,
    }));

    const newCategories = Array.from(new Set(finalTransactions.map((t) => t.category))).filter(
      (c) => !categories.includes(c)
    );

    onImportStatement(finalTransactions);
    if (newCategories.length > 0) onNewCategories?.(newCategories);

    reset();
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center bg-slate-950/60 dark:bg-slate-950/75 backdrop-blur-xs p-0 sm:p-4"
      onClick={handleClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-statement-title"
        onClick={(e) => e.stopPropagation()}
        className="w-full sm:max-w-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-t-2xl sm:rounded-2xl shadow-2xl p-5 space-y-4 animate-in slide-in-from-bottom-4 sm:zoom-in-95 duration-150 max-h-[90vh] overflow-y-auto"
      >
        <div className="flex items-center justify-between">
          <h3 id="import-statement-title" className="text-sm font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
            <UploadCloud className="w-4 h-4 text-indigo-600 dark:text-indigo-400" /> Import statement
          </h3>
          <button
            type="button"
            onClick={handleClose}
            aria-label="Close"
            className="flex items-center justify-center min-h-10 min-w-10 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {!rows && (
          <>
            <p className="text-xs text-slate-500 dark:text-slate-400 leading-normal">
              Paste raw lines from a bank or card statement. Your local Ollama model cleans and categorizes them --
              you'll get a chance to review everything before it's saved.
            </p>
            <div className="flex flex-wrap gap-2">
              {SAMPLE_STATEMENTS.map((s) => (
                <button
                  key={s.title}
                  type="button"
                  onClick={() => setStatementText(s.text)}
                  className="text-xs min-h-9 px-3 py-1.5 bg-gray-50 dark:bg-slate-800 hover:bg-indigo-50 dark:hover:bg-indigo-950/30 hover:text-indigo-700 dark:hover:text-indigo-400 text-gray-700 dark:text-slate-300 border border-gray-200 dark:border-slate-700 rounded-lg font-medium transition-all flex items-center gap-1 cursor-pointer"
                >
                  <FileText className="w-3.5 h-3.5" />
                  {s.title}
                </button>
              ))}
            </div>
            <textarea
              rows={6}
              value={statementText}
              onChange={(e) => setStatementText(e.target.value)}
              placeholder={`Paste line transactions here... e.g.:\n06/15 MCDONALDS RESTAURANT $12.30\n06/16 RENT TRANSFERS -$1,450.00`}
              className="w-full p-3 text-xs font-mono text-gray-900 dark:text-slate-100 border border-gray-200 dark:border-slate-700 rounded-xl outline-none focus:ring-2 focus:ring-indigo-100 dark:focus:ring-indigo-900/40 focus:border-indigo-500 resize-none bg-slate-50/30 dark:bg-slate-800/60"
            />
            {statusMessage && (
              <p className="text-xs text-rose-600 dark:text-rose-400 font-medium">{statusMessage}</p>
            )}
            <button
              type="button"
              onClick={handleParse}
              disabled={isProcessing || !statementText.trim()}
              className="w-full min-h-11 py-2.5 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 dark:disabled:bg-indigo-900 rounded-lg flex items-center justify-center gap-1.5 transition-all cursor-pointer"
            >
              {isProcessing ? (
                <>
                  <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  Reading statement…
                </>
              ) : (
                <>
                  <Sparkles className="w-3.5 h-3.5" /> Parse statement
                </>
              )}
            </button>
          </>
        )}

        {rows && (
          <>
            {statusMessage && (
              <div className="p-2.5 rounded-xl bg-indigo-50/70 dark:bg-indigo-950/20 border border-indigo-100 dark:border-indigo-900 text-[11px] text-indigo-800 dark:text-indigo-300">
                {statusMessage}
              </div>
            )}

            <div className="flex items-center justify-between gap-2 flex-wrap">
              <span className="text-xs font-semibold text-slate-600 dark:text-slate-300">
                {rows.length} row{rows.length === 1 ? '' : 's'} parsed -- {checkedCount} selected
              </span>
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wide">Import as</span>
                <div className="flex p-0.5 bg-slate-100 dark:bg-slate-800 rounded-lg" role="group" aria-label="Import scope">
                  <button
                    type="button"
                    onClick={() => setScope('personal')}
                    aria-pressed={scope === 'personal'}
                    className={`min-h-9 px-2.5 text-[10px] font-bold rounded-md cursor-pointer ${
                      scope === 'personal' ? 'bg-white dark:bg-slate-700 text-indigo-700 dark:text-indigo-400 shadow-xs' : 'text-slate-500 dark:text-slate-400'
                    }`}
                  >
                    Mine
                  </button>
                  <button
                    type="button"
                    onClick={() => setScope('joint')}
                    aria-pressed={scope === 'joint'}
                    className={`min-h-9 px-2.5 text-[10px] font-bold rounded-md cursor-pointer ${
                      scope === 'joint' ? 'bg-white dark:bg-slate-700 text-sky-700 dark:text-sky-400 shadow-xs' : 'text-slate-500 dark:text-slate-400'
                    }`}
                  >
                    Joint
                  </button>
                </div>
              </div>
            </div>

            <div className="space-y-2 max-h-[45vh] overflow-y-auto pr-1">
              {rows.map((row) => (
                <div
                  key={row.id}
                  className={`flex flex-wrap items-center gap-2 p-2.5 rounded-xl border ${
                    row.isDuplicate
                      ? 'border-amber-300 dark:border-amber-800 bg-amber-50/60 dark:bg-amber-950/20'
                      : 'border-slate-200 dark:border-slate-800 bg-slate-50/40 dark:bg-slate-800/30'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={row.include}
                    onChange={(e) => updateRow(row.id, { include: e.target.checked })}
                    aria-label={`Include ${row.merchantName}`}
                    className="w-4 h-4 min-h-10 min-w-10 sm:min-h-4 sm:min-w-4 accent-indigo-600 cursor-pointer shrink-0"
                  />
                  <input
                    type="date"
                    value={row.date}
                    onChange={(e) => updateRow(row.id, { date: e.target.value })}
                    className="min-h-9 px-2 py-1 text-[11px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 rounded-lg text-slate-700 dark:text-slate-300 shrink-0"
                  />
                  <input
                    type="text"
                    value={row.merchantName}
                    onChange={(e) => updateRow(row.id, { merchantName: e.target.value })}
                    className="flex-1 min-w-[100px] min-h-9 px-2 py-1 text-[11px] border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 rounded-lg text-slate-700 dark:text-slate-300"
                  />
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() => updateRow(row.id, { amount: -row.amount })}
                      title="Flip income/expense sign"
                      aria-label="Flip amount sign"
                      className="flex items-center justify-center min-h-9 min-w-9 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-400 dark:text-slate-500 hover:text-indigo-600 dark:hover:text-indigo-400 hover:bg-white dark:hover:bg-slate-900 cursor-pointer"
                    >
                      <ArrowUpDown className="w-3.5 h-3.5" />
                    </button>
                    <span
                      className={`font-mono text-[11px] font-semibold w-20 text-right ${
                        row.amount < 0 ? 'text-slate-900 dark:text-slate-100' : 'text-emerald-600 dark:text-emerald-400'
                      }`}
                    >
                      {formatMoney(row.amount, currency, { sign: true })}
                    </span>
                  </div>
                  <select
                    value={row.category}
                    onChange={(e) => updateRow(row.id, { category: e.target.value })}
                    className="min-h-9 px-2 py-1 text-[11px] font-semibold border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 rounded-lg text-slate-700 dark:text-slate-300 cursor-pointer shrink-0 max-w-[140px] truncate"
                  >
                    {[row.category, ...categories.filter((c) => c !== row.category)].map((cat) => (
                      <option key={cat} value={cat}>
                        {cat}
                      </option>
                    ))}
                  </select>
                  {row.isDuplicate && (
                    <span className="flex items-center gap-1 text-[10px] font-bold text-amber-700 dark:text-amber-400 shrink-0">
                      <AlertTriangle className="w-3 h-3" /> Possible duplicate
                    </span>
                  )}
                </div>
              ))}
            </div>

            <div className="flex flex-col-reverse sm:flex-row gap-2 pt-1">
              <button
                type="button"
                onClick={reset}
                className="w-full py-2.5 px-4 rounded-xl text-xs font-bold border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer min-h-11"
              >
                Back
              </button>
              <button
                type="button"
                onClick={handleImport}
                disabled={checkedCount === 0}
                className="w-full py-2.5 px-4 rounded-xl text-xs font-bold text-white bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 dark:disabled:bg-indigo-900 cursor-pointer min-h-11"
              >
                Import {checkedCount} transaction{checkedCount === 1 ? '' : 's'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
