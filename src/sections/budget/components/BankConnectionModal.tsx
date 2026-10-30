import React, { useState, useEffect } from 'react';
import { Landmark, ShieldCheck, X, Link as LinkIcon, RefreshCw, AlertTriangle } from 'lucide-react';
import { BankConnection, CreditCard, Transaction, TransactionCategory } from '../types';

interface BankConnectionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConnect: (connection: BankConnection | BankConnection[], initialTransactions?: Transaction[], newCreditCards?: CreditCard[]) => void;
  showToast: (message: string, type: 'success' | 'warn' | 'critical' | 'info') => void;
  // POST /api/budget/plaid/configure is requireAdmin server-side
  // (the project notes 10.20) -- a non-admin session sees an explanation
  // instead of a form that would only 403.
  isAdmin: boolean;
}

export interface AccountToConnect {
  id: string;
  name: string;
  mask: string;
  balance: number;
  type: string;
  selected: boolean;
  scope: 'personal' | 'joint';
  isCreditCard?: boolean;
  isLoan?: boolean;
  isSavings?: boolean;
  creditLimit?: number;
  apr?: number;
  minPayment?: number;
  dueDate?: string;
}

export default function BankConnectionModal({ isOpen, onClose, onConnect, showToast, isAdmin }: BankConnectionModalProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [accountScope, setAccountScope] = useState<'personal' | 'joint'>('personal');

  // Unified multi-account state
  const [accountsToConnect, setAccountsToConnect] = useState<AccountToConnect[]>([]);
  const [selectionStep, setSelectionStep] = useState<'none' | 'real_plaid'>('none');
  const [tempPlaidData, setTempPlaidData] = useState<{
    itemId?: string;
    institutionName: string;
    fetchedTxs: Transaction[];
  } | null>(null);

  // Plaid configurations
  const [plaidStatus, setPlaidStatus] = useState<{ configured: boolean; environment: string } | null>(null);
  const [isCheckingStatus, setIsCheckingStatus] = useState(true);

  // Plaid keys editing state
  const [showKeyForm, setShowKeyForm] = useState(false);
  const [tempClientId, setTempClientId] = useState('');
  const [tempSecret, setTempSecret] = useState('');
  const [tempEnv, setTempEnv] = useState<'sandbox' | 'development' | 'production'>('sandbox');
  const [tempPassword, setTempPassword] = useState('');
  const [isSavingKeys, setIsSavingKeys] = useState(false);

  // Load Plaid status from server
  useEffect(() => {
    if (!isOpen) return;
    setIsCheckingStatus(true);
    fetch('/api/budget/plaid/status')
      .then(res => res.json())
      .then(data => {
        setPlaidStatus(data);
        setIsCheckingStatus(false);
      })
      .catch(err => {
        console.error("Failed to check Plaid API configuration status:", err);
        setIsCheckingStatus(false);
      });
  }, [isOpen]);

  if (!isOpen) return null;

  // Real Plaid Dynamic Link Activation
  const handleLaunchRealPlaid = async () => {
    setIsLoading(true);
    try {
      const tokenRes = await fetch('/api/budget/plaid/create_link_token', { method: 'POST' });
      if (!tokenRes.ok) {
        const errObj = await tokenRes.json();
        throw new Error(errObj.error || "Failed to create Plaid link_token");
      }
      const tokenData = await tokenRes.json();
      const linkToken = tokenData.link_token;

      // Ensure Plaid script is loaded in DOM
      if (!(window as any).Plaid) {
        const script = document.createElement('script');
        script.src = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";
        script.async = true;
        document.body.appendChild(script);
        await new Promise((resolve) => {
          script.onload = resolve;
        });
      }

      setIsLoading(false);

      const handler = (window as any).Plaid.create({
        token: linkToken,
        onSuccess: async (publicToken: string, metadata: any) => {
          setIsLoading(true);
          try {
            // Exchange public token on backend
            const exchangeRes = await fetch('/api/budget/plaid/exchange_public_token', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ public_token: publicToken })
            });

            if (!exchangeRes.ok) {
              throw new Error("Plaid Token Exchange API failed");
            }

            const exchangeData = await exchangeRes.json();
            const accounts = exchangeData.accounts || [];
            const creditLiabilities: Record<string, any> = exchangeData.creditLiabilities || {};

            // Fetch initial transactions for linked account
            let fetchedTxs: Transaction[] = [];
            try {
              const txsRes = await fetch('/api/budget/plaid/fetch_transactions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ itemId: exchangeData.item_id })
              });
              if (txsRes.ok) {
                const txsData = await txsRes.json();
                fetchedTxs = txsData.transactions || [];
              }
            } catch (txErr) {
              console.warn("Could not sync initial Plaid transactions during exchange:", txErr);
            }

            // Map ALL Plaid accounts so user can choose which to link. Credit-type
            // accounts are flagged so they route into the Credit Cards tracker
            // (with real APR/limit/due-date/min-payment when Plaid provides them)
            // instead of being treated as a plain bank connection.
            const mappedAccounts: AccountToConnect[] = accounts.map((acc: any) => {
              const isCreditCard = acc.type === 'credit';
              const isLoan = acc.type === 'loan';
              // Plaid's `subtype` distinguishes checking from savings within the
              // 'depository' type -- savings (and SoFi-style "vault" sub-accounts,
              // which also report subtype "savings") are real money but deliberately
              // set aside, so they're excluded from "Available Cash" like loans are.
              const isSavings = acc.type === 'depository' && acc.subtype === 'savings';
              const liability = creditLiabilities[acc.account_id];
              return {
                id: acc.account_id || `plaid-${exchangeData.item_id || Date.now()}-${Math.random()}`,
                name: acc.name || (isCreditCard ? 'Credit Card' : 'Checking Account'),
                mask: acc.mask || '1234',
                balance: acc.balances?.current || 0.0,
                type: acc.subtype || acc.type || 'depository',
                selected: true,
                scope: accountScope,
                isCreditCard,
                isLoan,
                isSavings,
                creditLimit: acc.balances?.limit ?? undefined,
                apr: liability?.aprPercentage ?? undefined,
                minPayment: liability?.minimumPaymentAmount ?? undefined,
                dueDate: liability?.nextPaymentDueDate ? new Date(liability.nextPaymentDueDate).getDate().toString() : undefined,
              };
            });

            setAccountsToConnect(mappedAccounts);
            setTempPlaidData({
              itemId: exchangeData.item_id,
              institutionName: metadata.institution?.name || 'Plaid Bank',
              fetchedTxs: fetchedTxs
            });
            setSelectionStep('real_plaid');
          } catch (exchangeErr: any) {
            console.error("Plaid token exchange error:", exchangeErr);
            showToast(`Couldn't link the bank: ${exchangeErr.message}`, 'critical');
          } finally {
            setIsLoading(false);
          }
        },
        onExit: (err: any) => {
          if (err != null) {
            console.warn("Plaid Link exit with error", err);
            showToast(`Bank linking stopped: ${err.message}`, 'warn');
          }
        }
      });

      handler.open();
    } catch (err: any) {
      console.error(err);
      setIsLoading(false);
      showToast(err.message || "Couldn't open Plaid", "critical");
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs">
      <div className="w-full max-w-md overflow-hidden bg-white dark:bg-slate-900 rounded-2xl shadow-xl flex flex-col relative" id="bank-modal">

        {/* Real Plaid Account Selector Overlay */}
        {selectionStep === 'real_plaid' && (
          <div className="absolute inset-0 z-[60] bg-white dark:bg-slate-900 flex flex-col p-6 rounded-2xl">
            <div className="flex items-center justify-between pb-4 border-b border-slate-100 dark:border-slate-800 mb-4 shrink-0">
              <div className="flex items-center gap-2">
                <div className="p-2 bg-emerald-50 dark:bg-emerald-950/30 text-[#00C08B] rounded-xl">
                  <ShieldCheck className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="font-extrabold text-slate-900 dark:text-slate-100 text-sm tracking-tight">Choose accounts to add</h3>
                  <p className="text-[10px] text-slate-400 dark:text-slate-500 font-bold uppercase tracking-wider">{tempPlaidData?.institutionName || 'Your bank'}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setSelectionStep('none');
                  setAccountsToConnect([]);
                  setTempPlaidData(null);
                }}
                aria-label="Close"
                className="p-1.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 rounded-lg"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto space-y-4 pr-1">
              <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                Connected to <strong>{tempPlaidData?.institutionName}</strong>. Pick the accounts you want in the budget:
              </p>

              <div className="space-y-2.5">
                {accountsToConnect.map((acc) => (
                  <div key={acc.id} className="flex items-center justify-between p-3.5 border border-slate-200 dark:border-slate-700 rounded-2xl hover:border-indigo-200 dark:hover:border-indigo-800 bg-slate-50/20 dark:bg-slate-800/20 hover:bg-slate-50/50 dark:hover:bg-slate-800/50 transition-all">
                    <label className="flex items-center gap-3 cursor-pointer flex-1 min-w-0">
                      <input
                        type="checkbox"
                        checked={acc.selected}
                        onChange={(e) => {
                          const checked = e.target.checked;
                          setAccountsToConnect(prev => prev.map(a => a.id === acc.id ? { ...a, selected: checked } : a));
                        }}
                        className="rounded text-[#00C08B] focus:ring-[#00a87a] w-4 h-4"
                      />
                      <div className="min-w-0">
                        <p className="text-xs font-bold text-slate-800 dark:text-slate-200 truncate flex items-center gap-1.5">
                          {acc.name}
                          {acc.isCreditCard && (
                            <span className="px-1.5 py-0.5 bg-violet-50 dark:bg-violet-950/30 text-violet-700 dark:text-violet-400 border border-violet-200/60 dark:border-violet-800/60 rounded-md text-[9px] font-black uppercase tracking-wide shrink-0">Credit Card</span>
                          )}
                          {acc.isLoan && (
                            <span className="px-1.5 py-0.5 bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-400 border border-amber-200/60 dark:border-amber-800/60 rounded-md text-[9px] font-black uppercase tracking-wide shrink-0">Loan (debt, not cash)</span>
                          )}
                          {acc.isSavings && (
                            <span className="px-1.5 py-0.5 bg-sky-50 dark:bg-sky-950/30 text-sky-700 dark:text-sky-400 border border-sky-200/60 dark:border-sky-800/60 rounded-md text-[9px] font-black uppercase tracking-wide shrink-0">Savings (excluded from cash)</span>
                          )}
                        </p>
                        <p className="text-[10px] text-slate-400 dark:text-slate-500 font-mono">••••{acc.mask} · {acc.type}</p>
                      </div>
                    </label>
                    <div className="text-right shrink-0">
                      <p className="text-xs font-black text-slate-900 dark:text-slate-100 font-mono">
                        ${acc.balance.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="pt-4 border-t border-slate-100 dark:border-slate-800 shrink-0 flex gap-3">
              <button
                type="button"
                onClick={() => {
                  setSelectionStep('none');
                  setAccountsToConnect([]);
                  setTempPlaidData(null);
                }}
                className="flex-1 py-2.5 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 rounded-xl text-xs font-bold transition-all text-slate-700 dark:text-slate-300 cursor-pointer text-center"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  const selectedCount = accountsToConnect.filter(a => a.selected).length;
                  if (selectedCount === 0) {
                    showToast('Pick at least one account', 'warn');
                    return;
                  }
                  
                  if (!tempPlaidData) return;

                  const selectedAccounts = accountsToConnect.filter(a => a.selected);

                  // Credit-type accounts become Credit Cards, everything else (checking,
                  // savings, etc.) becomes a regular bank connection.
                  const connections: BankConnection[] = selectedAccounts
                    .filter(acc => !acc.isCreditCard)
                    .map(acc => ({
                      id: acc.id,
                      bankName: tempPlaidData.institutionName,
                      accountName: acc.name,
                      lastFour: acc.mask || '4321',
                      balance: acc.balance,
                      status: 'connected',
                      isPlaid: true,
                      // The server attaches the token from the link it just made (by itemId) when
                      // this row is saved; true here so Sync works before the next reload.
                      hasAccessToken: true,
                      plaidAccountId: acc.id,
                      itemId: tempPlaidData.itemId,
                      scope: accountScope,
                      accountType: acc.isLoan ? 'loan' : acc.isSavings ? 'savings' : 'depository'
                    }));

                  const newCreditCards: CreditCard[] = selectedAccounts
                    .filter(acc => acc.isCreditCard)
                    .map(acc => ({
                      id: acc.id,
                      cardName: acc.name,
                      issuer: tempPlaidData.institutionName,
                      cardType: 'other',
                      creditLimit: acc.creditLimit || Math.max(acc.balance * 2, 1000),
                      balance: acc.balance,
                      apr: acc.apr ?? 24.99,
                      dueDate: acc.dueDate || '15',
                      minPayment: acc.minPayment || Math.max(25, acc.balance * 0.02),
                      scope: accountScope,
                      status: 'active'
                    }));

                  onConnect(connections, tempPlaidData.fetchedTxs.map((t: any) => ({ ...t, scope: accountScope })), newCreditCards);

                  const summary = [
                    connections.length > 0 ? `${connections.length} account(s)` : null,
                    newCreditCards.length > 0 ? `${newCreditCards.length} credit card(s)` : null,
                  ].filter(Boolean).join(' and ');
                  showToast(`Added ${summary} from ${tempPlaidData.institutionName}`, 'success');
                  setSelectionStep('none');
                  setAccountsToConnect([]);
                  setTempPlaidData(null);
                  onClose();
                }}
                className="flex-1 py-2.5 bg-[#00C08B] hover:bg-[#00a87a] text-white font-bold rounded-xl text-xs transition-all cursor-pointer text-center"
              >
                Add {accountsToConnect.filter(a => a.selected).length} {accountsToConnect.filter(a => a.selected).length === 1 ? 'account' : 'accounts'}
              </button>
            </div>
          </div>
        )}

        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-slate-100 dark:border-slate-800">
          <div className="flex items-center gap-2">
            <div className="p-2.5 bg-indigo-50 dark:bg-indigo-950/30 text-indigo-600 dark:text-indigo-400 rounded-xl">
              <Landmark className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-extrabold text-slate-900 dark:text-slate-100 text-base tracking-tight">Link a bank</h3>
              <p className="text-[10px] text-slate-400 dark:text-slate-500 font-bold uppercase tracking-wider">Secure connection through Plaid</p>
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="p-1.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Mine / Joint: who the linked accounts belong to */}
        <div className="bg-slate-50 dark:bg-slate-950 p-4 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <span className="text-[11px] font-bold text-slate-700 dark:text-slate-300 block">Whose accounts?</span>
            <span className="text-[10px] text-slate-400 dark:text-slate-500 block leading-normal">Joint accounts are shared with the household.</span>
          </div>
          <div className="flex gap-1 bg-slate-200/50 dark:bg-slate-800/60 p-1 rounded-lg shrink-0">
            <button
              type="button"
              onClick={() => setAccountScope('personal')}
              className={`px-3 py-1.5 text-[10px] font-bold rounded-md flex items-center gap-1 transition-all cursor-pointer ${
                accountScope === 'personal'
                  ? 'bg-indigo-600 text-white shadow-xs'
                  : 'bg-transparent text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'
              }`}
            >
              Mine
            </button>
            <button
              type="button"
              onClick={() => setAccountScope('joint')}
              className={`px-3 py-1.5 text-[10px] font-bold rounded-md flex items-center gap-1 transition-all cursor-pointer ${
                accountScope === 'joint'
                  ? 'bg-sky-600 text-white shadow-xs'
                  : 'bg-transparent text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'
              }`}
            >
              Joint
            </button>
          </div>
        </div>

        {/* Body Content */}
        <div className="p-6">
          <div className="space-y-4">
              <div className="flex items-start gap-3 bg-indigo-50/80 dark:bg-indigo-950/20 border border-indigo-100 dark:border-indigo-900/60 p-4 rounded-xl shadow-2xs">
                <LinkIcon className="w-5 h-5 text-indigo-600 dark:text-indigo-400 shrink-0 mt-0.5" />
                <div className="space-y-1.5">
                  <p className="text-xs font-bold text-indigo-900 dark:text-indigo-300">How linking works</p>
                  <p className="text-[11px] text-indigo-800 dark:text-indigo-400 leading-relaxed">
                    You sign in to your bank in Plaid's window; this app never sees your bank password. Balances and transactions then sync automatically. Works with Chase, Capital One, Wells Fargo, Bank of America and thousands more.
                  </p>
                </div>
              </div>

              {isCheckingStatus ? (
                <div className="py-8 text-center text-slate-400 dark:text-slate-500 text-xs font-semibold flex flex-col items-center gap-2">
                  <RefreshCw className="w-5 h-5 animate-spin text-indigo-600 dark:text-indigo-400" />
                  <span>Checking Plaid setup…</span>
                </div>
              ) : plaidStatus?.configured ? (
                // Real Plaid configuration is found!
                <div className="space-y-3.5 py-2">
                  <div className="bg-emerald-50 dark:bg-emerald-950/25 border border-emerald-100 dark:border-emerald-900/60 p-3 rounded-lg text-[11px] text-emerald-800 dark:text-emerald-400 font-medium">
                    <span className="font-extrabold text-emerald-900 dark:text-emerald-300">✓ Plaid is set up</span> ({plaidStatus.environment === "sandbox" ? "test mode: use Plaid test logins, not real accounts" : "real bank accounts"}).
                  </div>

                  <button
                    onClick={handleLaunchRealPlaid}
                    disabled={isLoading}
                    className="w-full py-3 bg-[#00C08B] hover:bg-[#00a87a] disabled:bg-emerald-300 dark:disabled:bg-emerald-900/50 text-white font-extrabold text-xs uppercase tracking-wider rounded-xl transition-all shadow-md flex items-center justify-center gap-2 cursor-pointer"
                  >
                    {isLoading ? (
                      <>
                        <RefreshCw className="w-4 h-4 animate-spin" />
                        <span>Opening Plaid…</span>
                      </>
                    ) : (
                      <>
                        <Landmark className="w-4 h-4" />
                        <span>Connect a bank</span>
                      </>
                    )}
                  </button>
                </div>
              ) : (
                // Plaid is unconfigured on the server. There used to be a "sandbox
                // simulator" here that faked the whole Plaid Link flow and then wrote
                // invented connections and transactions into the household's REAL
                // ledger -- removed 2026-09-24 (same reasoning as the "Legacy
                // Connection" flow removed 2026-09-06). Plaid's own sandbox, chosen in
                // the keys form below, is the way to try linking without real accounts.
                <div className="border border-amber-300 dark:border-amber-800/60 bg-amber-50/60 dark:bg-amber-950/20 p-3.5 rounded-xl space-y-1.5">
                  <div className="flex items-center gap-1.5 font-bold text-amber-900 dark:text-amber-400 text-xs">
                    <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-500 shrink-0" />
                    Plaid isn't set up yet
                  </div>
                  <p className="text-[11px] text-slate-700 dark:text-slate-300 leading-normal">
                    Add your Plaid keys below to link real bank accounts. To try linking without real accounts, choose Plaid's Sandbox environment there.
                  </p>
                </div>
              )}

              {/* Plaid Keys Form Toggle / Accordion button -- admin-only
                  (POST /api/budget/plaid/configure is requireAdmin server-side,
                  the project notes 10.20), so a non-admin sees why instead
                  of a form that would only 403. */}
              {!isAdmin ? (
                <div className="border-t border-slate-100 dark:border-slate-800 pt-4 mt-2">
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-normal">
                    Ask an admin to set up Plaid.
                  </p>
                </div>
              ) : (
              <div className="border-t border-slate-100 dark:border-slate-800 pt-4 mt-2">
                <button
                  type="button"
                  onClick={() => setShowKeyForm(!showKeyForm)}
                  className="w-full text-left text-xs font-bold text-indigo-600 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-300 flex items-center justify-between py-1 px-1 rounded-sm focus:outline-hidden transition-colors cursor-pointer"
                >
                  <span className="flex items-center gap-1.5 font-bold">
                    <span className="text-sm">🛠️</span> Plaid keys
                  </span>
                  <span className="text-[10px] text-slate-500 dark:text-slate-400 font-bold uppercase tracking-wider">{showKeyForm ? "Hide" : "Edit"}</span>
                </button>

                {showKeyForm && (
                  <div className="mt-3 bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-800 p-4 rounded-xl space-y-3.5 animate-in fade-in duration-200">
                    <div>
                      <p className="text-[10px] text-slate-500 dark:text-slate-400 leading-normal">
                        From your Plaid dashboard. They're saved in this app's settings on the server and replace any keys already there.
                      </p>
                    </div>

                    <div className="space-y-3">
                      <div>
                        <label className="block text-[10px] font-black text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1">Plaid Client ID</label>
                        <input
                          type="text"
                          required
                          placeholder="Plaid Client ID"
                          value={tempClientId}
                          onChange={(e) => setTempClientId(e.target.value)}
                          className="w-full px-3 py-2 text-xs border border-slate-200 dark:border-slate-700 rounded-lg focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 outline-hidden bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 font-mono"
                        />
                      </div>

                      <div>
                        <label className="block text-[10px] font-black text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1">Plaid Secret</label>
                        <input
                          type="password"
                          required
                          placeholder="••••••••••••••••••••••••"
                          value={tempSecret}
                          onChange={(e) => setTempSecret(e.target.value)}
                          className="w-full px-3 py-2 text-xs border border-slate-200 dark:border-slate-700 rounded-lg focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 outline-hidden bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 font-mono"
                        />
                      </div>

                      <div>
                        <label className="block text-[10px] font-black text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1">Environment</label>
                        <select
                          value={tempEnv}
                          onChange={(e: any) => setTempEnv(e.target.value)}
                          className="w-full px-3 py-2 text-xs border border-slate-200 dark:border-slate-700 rounded-lg focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 outline-hidden bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 font-semibold cursor-pointer"
                        >
                          <option value="sandbox">Sandbox (test logins only)</option>
                          <option value="development">Development (real banks, limited)</option>
                          <option value="production">Production (real banks)</option>
                        </select>
                      </div>

                      <div>
                        <label className="block text-[10px] font-black text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1">Your account password</label>
                        <input
                          type="password"
                          required
                          placeholder="Confirm it's you"
                          value={tempPassword}
                          onChange={(e) => setTempPassword(e.target.value)}
                          className="w-full px-3 py-2 text-xs border border-slate-200 dark:border-slate-700 rounded-lg focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 outline-hidden bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 font-mono"
                        />
                      </div>
                    </div>

                    <div className="flex gap-2 pt-1">
                      <button
                        type="button"
                        onClick={() => {
                          setTempClientId('');
                          setTempSecret('');
                          setTempPassword('');
                          setShowKeyForm(false);
                        }}
                        className="flex-1 py-2 text-slate-600 dark:text-slate-400 border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-xl text-xs font-bold transition-all cursor-pointer"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        disabled={isSavingKeys}
                        onClick={async () => {
                          if (!tempClientId || !tempSecret) {
                            showToast("Plaid Client ID and Secret are required", "warn");
                            return;
                          }
                          if (!tempPassword) {
                            showToast("Your account password is required", "warn");
                            return;
                          }
                          setIsSavingKeys(true);
                          try {
                            const res = await fetch("/api/budget/plaid/configure", {
                              method: "POST",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({
                                clientId: tempClientId,
                                secret: tempSecret,
                                environment: tempEnv,
                                password: tempPassword
                              })
                            });
                            if (!res.ok) {
                              const errData = await res.json();
                              throw new Error(errData.error || "Failed to configure keys");
                            }
                            const data = await res.json();
                            setPlaidStatus({ configured: data.configured, environment: data.environment });
                            setShowKeyForm(false);
                            setTempPassword('');
                            showToast("Plaid keys saved", "success");
                          } catch (err: any) {
                            showToast(err.message || "Couldn't save the Plaid keys", "critical");
                          } finally {
                            setIsSavingKeys(false);
                          }
                        }}
                        className="flex-1 py-2 bg-indigo-700 hover:bg-indigo-700 text-white font-bold rounded-xl text-xs transition-all cursor-pointer flex items-center justify-center gap-1.5"
                      >
                        {isSavingKeys ? (
                          <>
                            <RefreshCw className="w-3 h-3 animate-spin" />
                            <span>Saving…</span>
                          </>
                        ) : (
                          <span>Save keys</span>
                        )}
                      </button>
                    </div>
                  </div>
                )}
              </div>
              )}

          </div>
        </div>
      </div>
    </div>
  );
}
