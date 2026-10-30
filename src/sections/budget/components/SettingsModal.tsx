import React, { useEffect, useState } from 'react';
import {
  X,
  Settings2,
  Coins,
  Sliders,
  Trash2,
  RotateCcw,
  Database,
  Sparkles,
  ArrowRight,
  Download,
  AlertTriangle,
} from 'lucide-react';
import type { ConfirmFn } from './ConfirmDialog';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  currency: string;
  onCurrencyChange: (c: string) => void;
  onResetAllData: (password: string) => Promise<void>;
  onExportJSON: () => void;
  securityLogLength: number;
  onClearSecurityLog: () => void;
  showToast: (msg: string, type: 'success' | 'warning' | 'info' | 'critical') => void;
  confirm: ConfirmFn;
  // Hides the full-database-backup button below -- that download is app-wide
  // (every section, not just Budget), and the kiosk login is blocked from it
  // server-side (requireAdmin on POST /api/backup/download in server.ts). This
  // just keeps a non-admin session from seeing a button that would only 403.
  hideFullBackup?: boolean;
  // Same reasoning, for the Factory Hard Reset button below -- POST
  // /api/budget/store/reset is requireAdmin now too (the project notes 10.20).
  hideReset?: boolean;
}

export default function SettingsModal({
  isOpen,
  onClose,
  currency,
  onCurrencyChange,
  onResetAllData,
  onExportJSON,
  securityLogLength,
  onClearSecurityLog,
  showToast,
  confirm,
  hideFullBackup = false,
  hideReset = false,
}: SettingsModalProps) {
  const [activeSubTab, setActiveSubTab] = useState<'general' | 'developer'>('general');
  const [backupPasswordPrompt, setBackupPasswordPrompt] = useState(false);
  const [backupPassword, setBackupPassword] = useState('');
  const [backupError, setBackupError] = useState('');
  const [backupBusy, setBackupBusy] = useState(false);
  const [resetPasswordPrompt, setResetPasswordPrompt] = useState(false);
  const [resetPassword, setResetPassword] = useState('');
  const [resetError, setResetError] = useState('');
  const [resetBusy, setResetBusy] = useState(false);

  // Remembered merchant->category rules (see the "Remember this merchant" checkbox
  // in TransactionList). Rendered in the "developer" subtab (labelled "Controls &
  // Logs" in the UI) alongside backup/export, not "security" -- matching where the
  // adjacent backup/export/reset controls already lived. the project notes
  // DELETE /merchant-rules/:merchant existed with no caller anywhere -- there was
  // no way to see or remove a remembered rule once set. Fetched fresh on open,
  // same pattern as the PIN lock status above.
  const [merchantRules, setMerchantRules] = useState<{ merchantKey: string; merchantDisplay: string; category: string }[]>([]);

  useEffect(() => {
    if (!isOpen) return;
    fetch('/api/budget/merchant-rules', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => setMerchantRules(data?.rules || []))
      .catch(() => {});
  }, [isOpen]);

  async function handleForgetMerchant(merchantKey: string) {
    try {
      await fetch(`/api/budget/merchant-rules/${encodeURIComponent(merchantKey)}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      setMerchantRules((prev) => prev.filter((r) => r.merchantKey !== merchantKey));
      showToast('Merchant rule forgotten.', 'info');
    } catch {
      showToast('Failed to forget that merchant rule.', 'critical');
    }
  }

  if (!isOpen) return null;

  const handleResetConfirm = async () => {
    // window.confirm is blocked outright in the desktop app's embedded
    // browser and some kiosk browsers -- an in-app dialog works everywhere.
    const confirmed = await confirm({
      title: 'Reset all budget data',
      message: 'This will wipe all budget transactions, category budgets, and bank links, and reset budget settings to defaults. Your groceries, pantry, and other sections are not affected.',
      confirmLabel: 'Reset everything',
      tone: 'danger',
    });
    if (confirmed) {
      setResetError('');
      setResetPassword('');
      setResetPasswordPrompt(true);
    }
  };

  const handleResetPasswordConfirm = async () => {
    if (!resetPassword) return;
    setResetBusy(true);
    setResetError('');
    try {
      await onResetAllData(resetPassword);
      setResetPasswordPrompt(false);
      setResetPassword('');
      showToast('Budget data reset to default state.', 'warning');
      onClose();
    } catch (err: any) {
      // onResetAllData already shows a toast for this; the inline message here
      // is so the password dialog itself explains why it's still open.
      setResetError(err?.message || 'Reset failed.');
    } finally {
      setResetBusy(false);
    }
  };

  const handleClearLogConfirm = async () => {
    const confirmed = await confirm({
      title: 'Clear security log',
      message: 'This wipes the complete security trace log history.',
      confirmLabel: 'Clear log',
      tone: 'danger',
    });
    if (confirmed) {
      onClearSecurityLog();
      showToast('Security audit log wiped successfully.', 'info');
    }
  };

  const handleBackupConfirm = async () => {
    if (!backupPassword) return;
    setBackupBusy(true);
    setBackupError('');
    try {
      const res = await fetch('/api/backup/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ password: backupPassword }),
      });
      if (!res.ok) {
        setBackupError(res.status === 401 ? 'Incorrect password.' : 'Backup download failed.');
        return;
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `household-backup-${new Date().toISOString().slice(0, 10)}.db`;
      a.click();
      URL.revokeObjectURL(url);
      showToast('Downloading full database backup...', 'info');
      setBackupPasswordPrompt(false);
      setBackupPassword('');
    } catch {
      setBackupError('Backup download failed.');
    } finally {
      setBackupBusy(false);
    }
  };

  return (
    <div 
      className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-center justify-center p-4 overflow-y-auto animate-fade-in"
      id="settings-modal-overlay"
    >
      <div 
        className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 w-full max-w-2xl rounded-3xl shadow-2xl flex flex-col md:flex-row overflow-hidden max-h-[90vh] md:max-h-[580px] animate-in slide-in-from-bottom-4 duration-300"
        id="settings-modal-container"
      >
        {/* Sidebar Nav section */}
        <div className="bg-slate-50 dark:bg-slate-950 border-r border-slate-100 dark:border-slate-800/60 p-6 md:w-56 shrink-0 flex flex-col justify-between">
          <div className="space-y-6">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center text-white shrink-0 shadow-md shadow-indigo-600/10">
                <Settings2 className="w-4 h-4" />
              </div>
              <div>
                <h3 className="font-extrabold text-slate-900 dark:text-slate-100 text-xs uppercase tracking-wider">Common Settings</h3>
                <p className="text-[10px] text-slate-400 font-bold font-mono text-indigo-600 dark:text-indigo-400">LEDGERSTREAM V4</p>
              </div>
            </div>

            <nav className="space-y-1">
              <button
                onClick={() => setActiveSubTab('general')}
                className={`w-full flex items-center gap-2 px-3 py-2 text-left rounded-xl text-xs font-bold transition-all cursor-pointer ${
                  activeSubTab === 'general'
                    ? 'bg-white dark:bg-slate-800 text-indigo-600 dark:text-indigo-500 border border-slate-200/60 dark:border-slate-700 shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:bg-slate-200/45 dark:hover:bg-slate-800/40 hover:text-slate-800 dark:hover:text-slate-100'
                }`}
              >
                <Coins className="w-4 h-4" />
                Aesthetic & Core
              </button>
              <button
                onClick={() => setActiveSubTab('developer')}
                className={`w-full flex items-center gap-2 px-3 py-2 text-left rounded-xl text-xs font-bold transition-all cursor-pointer ${
                  activeSubTab === 'developer'
                    ? 'bg-white dark:bg-slate-800 text-indigo-600 dark:text-indigo-500 border border-slate-200/60 dark:border-slate-700 shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:bg-slate-200/45 dark:hover:bg-slate-800/40 hover:text-slate-800 dark:hover:text-slate-100'
                }`}
              >
                <Sliders className="w-4 h-4" />
                Controls & Logs
              </button>
            </nav>
          </div>

          <div className="pt-4 mt-4 border-t border-slate-200/55 dark:border-slate-800/80 hidden md:block">
            <p className="text-[9px] text-slate-400 leading-normal font-medium">
              Changes auto-save directly to device local sandbox memory.
            </p>
          </div>
        </div>

        {/* Content Area section */}
        <div className="flex-1 flex flex-col justify-between overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between p-5 border-b border-slate-100 dark:border-slate-800/80">
            <div>
              <h4 className="text-sm font-extrabold text-slate-900 dark:text-slate-100 tracking-tight capitalize">
                {activeSubTab === 'general' && 'Aesthetic & Coin Preferences'}
                {activeSubTab === 'developer' && 'Data Import, Backup & Factory Reset'}
              </h4>
              <p className="text-[10px] text-slate-400">Configure parameters for personalized budgeting</p>
            </div>
            <button
              onClick={onClose}
              aria-label="Close settings"
              className="flex items-center justify-center min-h-10 min-w-10 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 rounded-xl transition-all cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Settings Panels */}
          <div className="flex-1 p-6 space-y-6 overflow-y-auto max-h-[350px]">
            {/* General Tab */}
            {activeSubTab === 'general' && (
              <div className="space-y-5">
                {/* Currency preference selection */}
                <div className="space-y-2">
                  <label className="block text-xs font-bold text-slate-700 dark:text-slate-400 uppercase tracking-wide">
                    Ledger Currency Unit
                  </label>
                  <p className="text-[10px] text-slate-400 dark:text-slate-500 leading-normal">
                    This dynamically reformats all balances, target thresholds, budgets and manually configured ledger rows.
                  </p>
                  <div className="grid grid-cols-5 gap-2 pt-1.5">
                    {[
                      { unicode: '$', code: 'USD', name: 'Dollar' },
                      { unicode: '€', code: 'EUR', name: 'Euro' },
                      { unicode: '£', code: 'GBP', name: 'Pound' },
                      { unicode: '¥', code: 'JPY', name: 'Yen' },
                      { unicode: '₿', code: 'BTC', name: 'Bitcoin' },
                    ].map((cur) => (
                      <button
                        key={cur.unicode}
                        onClick={() => {
                          onCurrencyChange(cur.unicode);
                          showToast(`System active currency updated to ${cur.code} (${cur.unicode})`, 'success');
                        }}
                        className={`p-2 rounded-xl border flex flex-col items-center justify-center transition-all cursor-pointer ${
                          currency === cur.unicode
                            ? 'bg-indigo-50/75 dark:bg-slate-800 border-indigo-500/55 dark:border-indigo-400/50 text-indigo-800 dark:text-indigo-400 shadow-xs'
                            : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800'
                        }`}
                      >
                        <span className="font-mono text-base font-black leading-none">{cur.unicode}</span>
                        <span className="text-[8.5px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mt-1">{cur.code}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
            {/* Developer or Debug log trace */}
            {activeSubTab === 'developer' && (
              <div className="space-y-5">
                {/* Full Database Backup */}
                {!hideFullBackup && (
                  <div className="space-y-2">
                    <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wide">
                      Full Database Backup
                    </label>
                    <p className="text-[10px] text-slate-400 dark:text-slate-400 leading-normal">
                      Downloads the complete household database — every account, transaction, budget, and rule for both members. The app also keeps its own daily snapshots automatically, but those live on this machine only; save this file somewhere else (Drive, another drive) for real disaster recovery.
                    </p>
                    <button
                      onClick={() => {
                        setBackupError('');
                        setBackupPassword('');
                        setBackupPasswordPrompt(true);
                      }}
                      className="w-full py-2 px-3 bg-indigo-50 dark:bg-indigo-950/20 hover:bg-indigo-100 dark:hover:bg-indigo-950/40 border border-indigo-200 dark:border-indigo-800/60 rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-2 text-indigo-700 dark:text-indigo-400 cursor-pointer"
                    >
                      <Download className="w-4 h-4" /> Download Database Backup
                    </button>
                  </div>
                )}

                {/* Sandbox JSON Export */}
                <div className="space-y-2 pt-3 border-t border-slate-100 dark:border-slate-800">
                  <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wide">
                    Sandbox Ledger Data Export
                  </label>
                  <p className="text-[10px] text-slate-400 dark:text-slate-400 leading-normal">
                    Export just your currently visible categories, budgets, and transactions as readable JSON.
                  </p>
                  <button
                    onClick={onExportJSON}
                    className="w-full py-2 px-3 bg-white dark:bg-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-2 text-slate-700 dark:text-slate-300 cursor-pointer"
                  >
                    <Download className="w-4 h-4 text-slate-500 dark:text-slate-400" /> Export JSON Ledger Spec
                  </button>
                </div>

                {/* Remembered merchant rules */}
                <div className="space-y-2 pt-3 border-t border-slate-100 dark:border-slate-800">
                  <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wide">
                    Remembered Merchants ({merchantRules.length})
                  </label>
                  <p className="text-[10px] text-slate-400 dark:text-slate-400 leading-normal">
                    Merchants you've told the ledger to always categorize a certain way. New transactions
                    from these are auto-suggested that category.
                  </p>
                  {merchantRules.length === 0 ? (
                    <p className="text-[10px] text-slate-400 dark:text-slate-500 italic">None remembered yet.</p>
                  ) : (
                    <div className="space-y-1.5 max-h-40 overflow-y-auto pr-1">
                      {merchantRules.map((rule) => (
                        <div
                          key={rule.merchantKey}
                          className="flex items-center justify-between gap-2 p-2 bg-slate-50 dark:bg-slate-800/50 border border-slate-100 dark:border-slate-800/80 rounded-lg"
                        >
                          <span className="text-[11px] font-medium text-slate-700 dark:text-slate-300 truncate">
                            {rule.merchantDisplay} <span className="text-slate-400 dark:text-slate-500">→ {rule.category}</span>
                          </span>
                          <button
                            onClick={() => handleForgetMerchant(rule.merchantKey)}
                            className="shrink-0 min-h-10 px-2 flex items-center text-[10px] font-bold text-rose-600 dark:text-rose-400 hover:underline cursor-pointer"
                          >
                            Forget
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Audit trace cleaner reset */}
                <div className="space-y-2 pt-3 border-t border-slate-100 dark:border-slate-800">
                  <label className="block text-xs font-bold text-slate-800 dark:text-slate-400 uppercase tracking-wide text-rose-700 dark:text-rose-500 flex items-center gap-1.5">
                    <AlertTriangle className="w-3.5 h-3.5" />
                    Destructive Supervisor Operations
                  </label>
                  <div className={`grid gap-2 pt-1.5 ${hideReset ? 'grid-cols-1' : 'grid-cols-2'}`}>
                    <button
                      onClick={handleClearLogConfirm}
                      disabled={securityLogLength === 0}
                      className="px-3 py-2 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-900 disabled:opacity-40 disabled:hover:bg-white rounded-xl text-xs font-bold text-center text-slate-600 dark:text-slate-400 transition-all cursor-pointer bg-transparent"
                    >
                      Wipe Audit Log ({securityLogLength})
                    </button>
                    {!hideReset && (
                      <button
                        onClick={handleResetConfirm}
                        className="px-3 py-2 bg-rose-50 dark:bg-rose-950/25 text-rose-700 dark:text-rose-400 border border-rose-200 dark:border-rose-900 hover:bg-rose-100 rounded-xl text-xs font-bold text-center text-rose-700 transition-all cursor-pointer"
                      >
                        Factory Hard Reset
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Footer Save & close alert */}
          <div className="p-4 bg-slate-50 dark:bg-slate-950 border-t border-slate-100 dark:border-slate-900 flex items-center justify-between text-[11px] font-bold uppercase tracking-wider text-slate-400 text-slate-400">
            <span className="flex items-center gap-1">
              <Database className="w-3.5 h-3.5 text-emerald-500 shrink-0" /> Local Sandbox Sync
            </span>
            <button
              onClick={onClose}
              className="flex items-center gap-1 px-4 py-1.5 bg-slate-900 hover:bg-indigo-700 text-white rounded-xl font-bold uppercase tracking-wider text-[10px] transition-all cursor-pointer shadow-sm select-none"
            >
              Close & Engage <ArrowRight className="w-3 h-3" />
            </button>
          </div>
        </div>
      </div>

      {backupPasswordPrompt && (
        <div className="fixed inset-0 z-[60] bg-slate-950/70 flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 w-full max-w-sm rounded-2xl shadow-2xl p-5 space-y-3">
            <h4 className="font-extrabold text-sm text-slate-900 dark:text-slate-100">Confirm your password</h4>
            <p className="text-[11px] text-slate-400 leading-normal">
              This file contains every household member's financial data. Re-enter your password to confirm the download.
            </p>
            <input
              type="password"
              autoFocus
              value={backupPassword}
              onChange={(e) => {
                setBackupPassword(e.target.value);
                setBackupError('');
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleBackupConfirm();
                if (e.key === 'Escape') setBackupPasswordPrompt(false);
              }}
              placeholder="Password"
              className="w-full px-3 py-2 border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 rounded-xl text-sm text-slate-900 dark:text-slate-100 outline-none focus:border-indigo-400"
            />
            {backupError && <p className="text-[11px] font-bold text-rose-600">{backupError}</p>}
            <div className="flex gap-2 pt-1">
              <button
                onClick={() => setBackupPasswordPrompt(false)}
                className="flex-1 py-2 border border-slate-200 dark:border-slate-700 rounded-xl text-xs font-bold text-slate-600 dark:text-slate-400 cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={handleBackupConfirm}
                disabled={!backupPassword || backupBusy}
                className="flex-1 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white rounded-xl text-xs font-bold cursor-pointer"
              >
                {backupBusy ? 'Checking…' : 'Download'}
              </button>
            </div>
          </div>
        </div>
      )}

      {resetPasswordPrompt && (
        <div className="fixed inset-0 z-[60] bg-slate-950/70 flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 w-full max-w-sm rounded-2xl shadow-2xl p-5 space-y-3">
            <h4 className="font-extrabold text-sm text-slate-900 dark:text-slate-100">Confirm your password</h4>
            <p className="text-[11px] text-slate-400 leading-normal">
              This permanently wipes all budget data. Re-enter your password to confirm the reset.
            </p>
            <input
              type="password"
              autoFocus
              value={resetPassword}
              onChange={(e) => {
                setResetPassword(e.target.value);
                setResetError('');
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleResetPasswordConfirm();
                if (e.key === 'Escape') setResetPasswordPrompt(false);
              }}
              placeholder="Password"
              className="w-full px-3 py-2 border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 rounded-xl text-sm text-slate-900 dark:text-slate-100 outline-none focus:border-indigo-400"
            />
            {resetError && <p className="text-[11px] font-bold text-rose-600">{resetError}</p>}
            <div className="flex gap-2 pt-1">
              <button
                onClick={() => setResetPasswordPrompt(false)}
                className="flex-1 py-2 border border-slate-200 dark:border-slate-700 rounded-xl text-xs font-bold text-slate-600 dark:text-slate-400 cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={handleResetPasswordConfirm}
                disabled={!resetPassword || resetBusy}
                className="flex-1 py-2 bg-rose-600 hover:bg-rose-700 disabled:opacity-50 text-white rounded-xl text-xs font-bold cursor-pointer"
              >
                {resetBusy ? 'Checking…' : 'Reset everything'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
