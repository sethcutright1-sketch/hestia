import React, { useState, useMemo } from 'react';
import { 
  CreditCard as CardIcon, 
  Plus, 
  Trash2, 
  Edit, 
  X, 
  DollarSign, 
  Percent, 
  Calendar, 
  ArrowUpRight, 
  ArrowDownLeft, 
  AlertTriangle, 
  CheckCircle,
  TrendingDown,
  Info
} from 'lucide-react';
import { CreditCard, BankConnection, Transaction, TransactionCategory } from '../types';

interface CreditCardTrackerProps {
  creditCards: CreditCard[];
  setCreditCards: React.Dispatch<React.SetStateAction<CreditCard[]>>;
  bankConnections: BankConnection[];
  setBankConnections: React.Dispatch<React.SetStateAction<BankConnection[]>>;
  onAddCardTransaction: (description: string, amount: number, category: string, bankName: string, scope?: 'personal' | 'joint') => void;
  ledgerScope: 'all' | 'personal' | 'joint';
  currency: string;
  categories: string[];
  showToast: (message: string, type: 'success' | 'critical' | 'info') => void;
}

export default function CreditCardTracker({
  creditCards,
  setCreditCards,
  bankConnections,
  setBankConnections,
  onAddCardTransaction,
  ledgerScope,
  currency,
  categories,
  showToast
}: CreditCardTrackerProps) {
  // Modal visibility states
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [isPayModalOpen, setIsPayModalOpen] = useState(false);
  const [isLogChargeModalOpen, setIsLogChargeModalOpen] = useState(false);
  const [editingCard, setEditingCard] = useState<CreditCard | null>(null);
  const [cardToDelete, setCardToDelete] = useState<CreditCard | null>(null);

  // Selected card for Pay off or Spend
  const [selectedCardId, setSelectedCardId] = useState<string>('');

  // Payment Form States
  const [payAmount, setPayAmount] = useState<string>('');
  const [paySourceBankId, setPaySourceBankId] = useState<string>('');
  const [payDate, setPayDate] = useState<string>(new Date().toISOString().split('T')[0]);

  // Log Charge Form States
  const [chargeDescription, setChargeDescription] = useState<string>('');
  const [chargeAmount, setChargeAmount] = useState<string>('');
  const [chargeCategory, setChargeCategory] = useState<string>('Shopping');
  const [chargeDate, setChargeDate] = useState<string>(new Date().toISOString().split('T')[0]);

  // Add/Edit Card Form States
  const [cardName, setCardName] = useState('');
  const [issuer, setIssuer] = useState('');
  const [cardType, setCardType] = useState<'visa' | 'mastercard' | 'amex' | 'discover' | 'other'>('visa');
  const [creditLimit, setCreditLimit] = useState('');
  const [cardBalance, setCardBalance] = useState('');
  const [apr, setApr] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [minPayment, setMinPayment] = useState('');
  const [cardScope, setCardScope] = useState<'personal' | 'joint'>('personal');

  // Filter cards by standard ledgerScope context
  const filteredCards = useMemo(() => {
    return creditCards.filter(c => ledgerScope === 'all' || c.scope === ledgerScope);
  }, [creditCards, ledgerScope]);

  // Score-aware aggregate metrics
  const stats = useMemo(() => {
    const totalBalance = filteredCards.reduce((sum, c) => sum + c.balance, 0);
    const totalLimit = filteredCards.reduce((sum, c) => sum + c.creditLimit, 0);
    const utilization = totalLimit > 0 ? (totalBalance / totalLimit) * 100 : 0;
    const totalMinPay = filteredCards.reduce((sum, c) => sum + c.minPayment, 0);
    
    // Simple estimated monthly interest: (Balance * (APR/100)) / 12
    const estMonthlyInterest = filteredCards.reduce((sum, c) => {
      if (c.balance <= 0) return sum;
      return sum + (c.balance * (c.apr / 100)) / 12;
    }, 0);

    return {
      totalBalance,
      totalLimit,
      utilization,
      totalMinPay,
      estMonthlyInterest
    };
  }, [filteredCards]);

  // Open modals with defaults
  const handleOpenAddModal = () => {
    setCardName('');
    setIssuer('');
    setCardType('visa');
    setCreditLimit('');
    setCardBalance('0');
    setApr('19.99');
    setDueDate('15');
    setMinPayment('35');
    setCardScope(ledgerScope === 'all' ? 'personal' : ledgerScope);
    setEditingCard(null);
    setIsAddModalOpen(true);
  };

  const handleOpenEditModal = (card: CreditCard) => {
    setEditingCard(card);
    setCardName(card.cardName);
    setIssuer(card.issuer);
    setCardType(card.cardType);
    setCreditLimit(card.creditLimit.toString());
    setCardBalance(card.balance.toString());
    setApr(card.apr.toString());
    setDueDate(card.dueDate);
    setMinPayment(card.minPayment.toString());
    setCardScope(card.scope || 'personal');
    setIsAddModalOpen(true);
  };

  // Create or Update Credit Card
  const handleSaveCard = (e: React.FormEvent) => {
    e.preventDefault();

    const limitNum = parseFloat(creditLimit) || 0;
    const balNum = parseFloat(cardBalance) || 0;
    const aprNum = parseFloat(apr) || 0;
    const minPayNum = parseFloat(minPayment) || 0;

    if (!cardName.trim() || !issuer.trim() || limitNum <= 0) {
      showToast('Please verify all credit card inputs. Card Name and Limit are required.', 'critical');
      return;
    }

    if (editingCard) {
      // Update Card
      setCreditCards(prev => prev.map(c => c.id === editingCard.id ? {
        ...c,
        cardName,
        issuer,
        cardType,
        creditLimit: limitNum,
        balance: balNum,
        apr: aprNum,
        dueDate,
        minPayment: minPayNum,
        scope: cardScope
      } : c));
      showToast(`Updated card ${cardName}.`, 'success');
    } else {
      // Add Card
      const newCard: CreditCard = {
        id: `card-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
        cardName,
        issuer,
        cardType,
        creditLimit: limitNum,
        balance: balNum,
        apr: aprNum,
        dueDate,
        minPayment: minPayNum,
        scope: cardScope,
        status: 'active'
      };
      setCreditCards(prev => [...prev, newCard]);
      showToast(`Added card ${cardName}.`, 'success');
    }

    setIsAddModalOpen(false);
  };

  // Close Card
  const handleDeleteCard = (id: string, name: string) => {
    setCreditCards(prev => prev.filter(c => c.id !== id));
    showToast(`Removed card ${name}.`, 'info');
  };

  // Log Card Payment Submission
  const handlePaySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const amountNum = parseFloat(payAmount);
    if (!selectedCardId || isNaN(amountNum) || amountNum <= 0) {
      showToast('Enter a valid positive payment amount.', 'critical');
      return;
    }

    const card = creditCards.find(c => c.id === selectedCardId);
    if (!card) return;

    // Process payment from selected bank account
    if (paySourceBankId) {
      const sourceBank = bankConnections.find(b => b.id === paySourceBankId);
      if (!sourceBank) return;

      // Deduct from bank account
      setBankConnections(prev => prev.map(ba => ba.id === sourceBank.id ? {
        ...ba,
        balance: ba.balance - amountNum
      } : ba));
    }

    // Reduce outstanding credit card balance
    setCreditCards(prev => prev.map(c => c.id === selectedCardId ? {
      ...c,
      balance: Math.max(0, c.balance - amountNum)
    } : c));

    // Register a beautiful clearing transaction in General Ledger feed
    const sourceName = paySourceBankId 
      ? (bankConnections.find(b => b.id === paySourceBankId)?.bankName || 'Checking Account')
      : 'Capital Reserve';

    // Log the transaction in standard transaction manager as a negative outward payment
    onAddCardTransaction(
      `Credit Card Payment: ${card.issuer} ${card.cardName}`,
      -amountNum,
      'Credit Cards & Debt',
      sourceName,
      card.scope || 'personal'
    );

    showToast(`Logged credit card payment! Paid -${currency}${amountNum.toFixed(2)} to ${card.cardName}.`, 'success');
    setIsPayModalOpen(false);
    setPayAmount('');
    setSelectedCardId('');
  };

  // Log Spend on Card Submission
  const handleLogChargeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const amountNum = parseFloat(chargeAmount);
    if (!selectedCardId || !chargeDescription.trim() || isNaN(amountNum) || amountNum <= 0) {
      showToast('Verify transaction description and amount are valid and positive.', 'critical');
      return;
    }

    const card = creditCards.find(c => c.id === selectedCardId);
    if (!card) return;

    const newOutstanding = card.balance + amountNum;
    if (newOutstanding > card.creditLimit) {
      showToast(`Transaction rejected. Card credit limit is ${currency}${card.creditLimit.toLocaleString()}. Exceeding limit is not permitted.`, 'critical');
      return;
    }

    // Add to outstanding credit card balance
    setCreditCards(prev => prev.map(c => c.id === selectedCardId ? {
      ...c,
      balance: c.balance + amountNum
    } : c));

    // Dispatch raw action to feed into general ledger
    // Since charging is spending, it must go into transactions ledger as a negative outflow
    onAddCardTransaction(
      `${chargeDescription} (on ${card.cardName})`,
      -amountNum, // negative is expense
      chargeCategory,
      `${card.issuer} ${card.cardName}`,
      card.scope || 'personal'
    );

    // Dynamic categorization notice
    showToast(`Logged charge: ${currency}${amountNum.toFixed(2)} spent on ${card.cardName} in ${chargeCategory}.`, 'success');
    setIsLogChargeModalOpen(false);
    setChargeDescription('');
    setChargeAmount('');
  };

  // Days left to due date calculation helper
  const getDueStatus = (dueDayStr: string) => {
    const dueDay = parseInt(dueDayStr, 10);
    if (isNaN(dueDay)) return { text: `Due day: ${dueDayStr}`, variant: 'none' };
    
    const today = new Date();
    const currentDay = today.getDate();
    
    if (dueDay === currentDay) {
      return { text: 'Statement due TODAY ⚠️', variant: 'critical' };
    }
    
    let daysDiff = dueDay - currentDay;
    if (daysDiff < 0) {
      // Due next month
      const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
      daysDiff = daysInMonth - currentDay + dueDay;
    }

    if (daysDiff === 1) {
      return { text: 'Due tomorrow! 🔥', variant: 'critical' };
    }
    if (daysDiff <= 5) {
      return { text: `Due in ${daysDiff} days ⚡`, variant: 'warning' };
    }
    return { text: `Due in ${daysDiff} days`, variant: 'info' };
  };

  // Theme based Card Visual Stylings with stable pseudo-random background colors and high-contrast black text for excellent readability
  const getCardDesign = (id: string, index: number) => {
    const styles = [
      { bg: 'bg-emerald-300 text-black', border: 'border-emerald-400/80' },
      { bg: 'bg-amber-300 text-black', border: 'border-amber-400/80' },
      { bg: 'bg-sky-300 text-black', border: 'border-sky-400/80' },
      { bg: 'bg-rose-300 text-black', border: 'border-rose-400/80' },
      { bg: 'bg-purple-300 text-black', border: 'border-purple-400/80' },
      { bg: 'bg-orange-300 text-black', border: 'border-orange-400/80' },
      { bg: 'bg-yellow-300 text-black', border: 'border-yellow-400/80' },
      { bg: 'bg-teal-300 text-black', border: 'border-teal-400/80' },
      { bg: 'bg-lime-300 text-black', border: 'border-lime-400/80' },
      { bg: 'bg-fuchsia-300 text-black', border: 'border-fuchsia-400/80' },
      { bg: 'bg-cyan-300 text-black', border: 'border-cyan-400/80' },
      { bg: 'bg-pink-300 text-black', border: 'border-pink-400/80' },
    ];
    
    let hash = 0;
    const str = id || '';
    for (let i = 0; i < str.length; i++) {
      hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    const pick = Math.abs(hash + index) % styles.length;
    return styles[pick];
  };

  return (
    <div className="space-y-6">
      
      {/* Scope and action summary metrics header */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 shadow-sm">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6">
          <div>
            <h1 className="text-xl font-bold text-slate-800 dark:text-slate-100">Credit cards</h1>
            <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">
              Balances, limits and payments.
            </p>
          </div>

          <div className="flex flex-wrap gap-2.5">
            <button
              onClick={handleOpenAddModal}
              className="flex items-center gap-1.5 px-4 py-2 text-xs font-bold bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 hover:bg-slate-800 dark:hover:bg-slate-300 rounded-xl transition-all cursor-pointer"
            >
              <Plus className="w-4 h-4" /> Add Credit Card
            </button>
            <button
              onClick={() => {
                if (filteredCards.length === 0) {
                  showToast('Add a credit card first before recording payments.', 'info');
                  return;
                }
                setSelectedCardId(filteredCards[0].id);
                setPayAmount('');
                setPaySourceBankId(bankConnections[0]?.id || '');
                setIsPayModalOpen(true);
              }}
              className="flex items-center gap-1.5 px-4 py-2 text-xs font-bold border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-800 hover:bg-slate-50 dark:hover:bg-slate-700 rounded-xl transition-all cursor-pointer"
            >
              <ArrowDownLeft className="w-4 h-4 text-emerald-600 dark:text-emerald-400" /> Log Payment
            </button>
            <button
              onClick={() => {
                if (filteredCards.length === 0) {
                  showToast('Add a credit card first before spending on it.', 'info');
                  return;
                }
                setSelectedCardId(filteredCards[0].id);
                setChargeDescription('');
                setChargeAmount('');
                setIsLogChargeModalOpen(true);
              }}
              className="flex items-center gap-1.5 px-4 py-2 text-xs font-bold border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-800 hover:bg-slate-50 dark:hover:bg-slate-700 rounded-xl transition-all cursor-pointer"
            >
              <ArrowUpRight className="w-4 h-4 text-rose-500 dark:text-rose-400" /> Card Charge
            </button>
          </div>
        </div>

        {/* Aggregate metrics grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-6 pt-6 border-t border-slate-100 dark:border-slate-800">
          <div className="space-y-1">
            <span className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider">Total Outstanding</span>
            <div className="text-lg font-black text-slate-900 dark:text-slate-100 font-mono">
              {currency}{stats.totalBalance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </div>
            <p className="text-[10px] text-slate-400 dark:text-slate-500 font-medium">Sum of balances across cards</p>
          </div>

          <div className="space-y-1">
            <span className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider">Total Available Credit</span>
            <div className="text-lg font-black text-slate-950 dark:text-slate-100 font-mono">
              {currency}{(stats.totalLimit - stats.totalBalance).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </div>
            <p className="text-[10px] text-slate-500 dark:text-slate-400 font-medium">Limit: {currency}{stats.totalLimit.toLocaleString(undefined, { maximumFractionDigits: 0 })}</p>
          </div>

          <div className="space-y-1">
            <span className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider">Overall Utilization</span>
            <div className="flex items-center gap-2 mt-1">
              <span className={`text-lg font-black font-mono ${
                stats.utilization > 80 ? 'text-rose-600 dark:text-rose-400' : stats.utilization > 30 ? 'text-amber-500 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400'
              }`}>
                {stats.utilization.toFixed(1)}%
              </span>
            </div>
            {/* Visual utilization bar */}
            <div className="w-full bg-slate-100 dark:bg-slate-800 rounded-full h-1.5 overflow-hidden">
              <div
                className={`h-full ${
                  stats.utilization > 80 ? 'bg-rose-500' : stats.utilization > 30 ? 'bg-amber-500' : 'bg-emerald-500'
                }`}
                style={{ width: `${Math.min(100, stats.utilization)}%` }}
              ></div>
            </div>
          </div>

          <div className="space-y-1">
            <span className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider">Estimated Monthly APR Costs</span>
            <div className="text-lg font-black text-rose-500 dark:text-rose-400 font-mono">
              {currency}{stats.estMonthlyInterest.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </div>
            <p className="text-[10px] text-slate-400 dark:text-slate-500 font-medium font-sans">Accumulated on carryover</p>
          </div>
        </div>
      </div>

      {/* Primary visual body: Cards & Tools */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        
        {/* Visual Cards Carousel Grid */}
        <div className="lg:col-span-8 space-y-4">
          <h2 className="text-sm font-bold text-slate-800 dark:text-slate-100 flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-indigo-500"></span>
            Linked Active Credit Ledgers ({filteredCards.length})
          </h2>

          {filteredCards.length === 0 ? (
            <div className="bg-white dark:bg-slate-900 border border-dashed border-slate-200 dark:border-slate-700 rounded-2xl p-12 text-center space-y-3">
              <CardIcon className="w-10 h-10 text-slate-300 dark:text-slate-600 mx-auto" />
              <h3 className="text-sm font-bold text-slate-700 dark:text-slate-300">No active credit cards tracked (for target scope)</h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 max-w-sm mx-auto">
                No credit cards linked to this ledger profile. Click the link button to configure metallic card telemetry and keep track of limits, payment cycles, and credit score optimization guidelines.
              </p>
              <button
                onClick={handleOpenAddModal}
                className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-bold bg-slate-200 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-800 dark:text-slate-200 rounded-lg transition-all cursor-pointer"
              >
                <Plus className="w-4 h-4" /> Set up card
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {filteredCards.map((card, idx) => {
                const design = getCardDesign(card.id, idx);
                const utilization = (card.balance / card.creditLimit) * 100;
                const dueStatus = getDueStatus(card.dueDate);

                return (
                  <div 
                    key={card.id} 
                    className={`relative rounded-3xl p-5 shadow-sm border ${design.bg} ${design.border} flex flex-col justify-between h-[210px] overflow-hidden transition-all hover:shadow-md hover:scale-[1.01]`}
                  >
                    {/* Subtle metallic glow effect suitable for light background */}
                    <div className="absolute top-0 right-0 w-32 h-32 bg-black/5 rounded-full blur-2xl pointer-events-none"></div>
                    <div className="absolute -bottom-8 -left-8 w-24 h-24 bg-black/5 rounded-full blur-xl pointer-events-none"></div>

                    {/* Top segment: Issuer, Type and Scope Badge */}
                    <div className="flex items-start justify-between">
                      <div>
                        <div className="text-[10px] uppercase font-bold tracking-widest text-slate-800 opacity-70">{card.issuer}</div>
                        <div className="text-base font-black tracking-tight text-black">{card.cardName}</div>
                      </div>

                      <div className="flex items-center gap-2">
                        {/* Scope indicator (high contrast dark pill) */}
                        <span className="px-2 py-0.5 rounded-full text-[9px] font-bold uppercase bg-black/10 text-black backdrop-blur-md">
                          {card.scope === 'joint' ? 'Joint' : 'Mine'}
                        </span>
                        
                        {/* Network symbol */}
                        <span className="text-xs font-extrabold italic opacity-90 uppercase text-black">
                          {card.cardType === 'visa' && 'Visa'}
                          {card.cardType === 'mastercard' && 'Mastercard'}
                          {card.cardType === 'amex' && 'Amex'}
                          {card.cardType === 'discover' && 'Discover'}
                          {card.cardType === 'other' && 'Card'}
                        </span>
                      </div>
                    </div>

                    {/* Middle segment: Chip and Balance */}
                    <div className="flex items-center justify-between my-2">
                      <div className="w-8 h-6 bg-slate-900/15 border border-slate-900/25 rounded-sm relative">
                        {/* Micro chip bands styling */}
                        <div className="absolute inset-y-0 left-1/3 w-0.5 bg-slate-900/20"></div>
                        <div className="absolute inset-y-0 right-1/3 w-0.5 bg-slate-900/20"></div>
                        <div className="absolute inset-x-0 top-1/2 h-0.5 bg-slate-900/20"></div>
                      </div>

                      <div className="text-right">
                        <span className="text-[9px] font-bold uppercase tracking-wider text-slate-800 opacity-75">Outstanding Balance</span>
                        <div className="text-2xl font-black font-mono text-black">
                          {currency}{card.balance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </div>
                      </div>
                    </div>

                    {/* Bottom segment: Limits, APR and Quick Actions */}
                    <div className="space-y-2 border-t border-black/10 pt-2.5">
                      <div className="flex justify-between items-end">
                        <div className="space-y-0.5">
                          <div className="text-[9px] uppercase font-bold text-slate-800 opacity-75 flex items-center gap-1.5">
                            Credit Limit: {currency}{card.creditLimit.toLocaleString()}
                            <span className="opacity-40">•</span>
                            APR {card.apr}%
                          </div>
                          <div className="w-[110px] md:w-[130px] bg-black/10 h-1 rounded-full overflow-hidden">
                            <div 
                              className={`h-full ${
                                utilization > 80 ? 'bg-rose-600' : utilization > 30 ? 'bg-amber-500' : 'bg-emerald-600'
                              }`}
                              style={{ width: `${Math.min(100, utilization)}%` }}
                            ></div>
                          </div>
                        </div>

                        {/* Actions */}
                        <div className="flex gap-1.5">
                          <button
                            onClick={() => handleOpenEditModal(card)}
                            title="Edit card"
                            aria-label={`Edit ${card.cardName}`}
                            className="flex items-center justify-center min-h-10 min-w-10 rounded-lg bg-black/5 hover:bg-black/10 transition-all text-slate-800 cursor-pointer border border-black/10"
                          >
                            <Edit className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => setCardToDelete(card)}
                            title="Remove card"
                            aria-label={`Remove ${card.cardName}`}
                            className="flex items-center justify-center min-h-10 min-w-10 rounded-lg bg-red-500/10 hover:bg-red-500/20 transition-all text-red-700 border border-red-500/10 cursor-pointer"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    </div>

                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Right sidebar: Payment cycles, Utilization optimization advice */}
        <div className="lg:col-span-4 space-y-6">
          
          {/* Card statement reminders component */}
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 shadow-sm space-y-4">
            <h3 className="text-xs font-bold text-slate-800 dark:text-slate-100 uppercase tracking-widest flex items-center gap-1.5">
              <Calendar className="w-4 h-4 text-slate-500 dark:text-slate-400" /> Payment Calendars
            </h3>

            {filteredCards.length === 0 ? (
              <p className="text-xs text-slate-400 dark:text-slate-500">Configure cards to schedule payment reminders automatically.</p>
            ) : (
              <div className="space-y-3">
                {filteredCards.map((card) => {
                  const status = getDueStatus(card.dueDate);
                  const isOverdue = card.balance > 0 && status.variant === 'critical';

                  return (
                    <div
                      key={`schedule-${card.id}`}
                      className="p-3 bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 rounded-xl flex items-center justify-between"
                    >
                      <div className="space-y-0.5">
                        <div className="text-xs font-bold text-slate-800 dark:text-slate-100">{card.issuer} {card.cardName}</div>
                        <div className="text-[10px] text-slate-400 dark:text-slate-500 font-medium">
                          Statement Day: {card.dueDate}th • Min due: {currency}{card.minPayment}
                        </div>
                      </div>
                      <div className="text-right">
                        <span className={`inline-flex px-2 py-0.5 rounded-full text-[9px] font-bold ${
                          status.variant === 'critical' ? 'bg-rose-50 dark:bg-rose-950/30 text-rose-700 dark:text-rose-400' :
                          status.variant === 'warning' ? 'bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-400' :
                          'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300'
                        }`}>
                          {card.balance === 0 ? 'No balance' : status.text}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Credit score optimization engine tip box */}
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 shadow-sm space-y-4">
            <h3 className="text-xs font-bold text-slate-800 dark:text-slate-100 uppercase tracking-widest flex items-center gap-1.5">
              <TrendingDown className="w-4 h-4 text-indigo-500 dark:text-indigo-400" /> Score Optimizer advice
            </h3>

            <div className="space-y-3.5">
              <div className="flex gap-2.5 p-3 rounded-xl bg-indigo-50/50 dark:bg-indigo-950/20 border border-indigo-100 dark:border-indigo-900/60 text-xs">
                <Info className="w-4 h-4 text-indigo-700 dark:text-indigo-400 shrink-0 mt-0.5" />
                <div className="text-indigo-950 dark:text-indigo-300 font-medium leading-relaxed">
                  Keeping individual and overall credit card utilization <strong>below 30%</strong> is optimal. Your current composite utilization is
                  <strong className="text-indigo-800 dark:text-indigo-400"> {stats.utilization.toFixed(1)}% </strong>.
                </div>
              </div>

              {stats.utilization > 30 ? (
                <div className="flex items-start gap-2 text-xs text-amber-800 dark:text-amber-400 p-3 bg-amber-50 dark:bg-amber-950/20 rounded-xl border border-amber-100 dark:border-amber-900/60">
                  <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                  <div>
                    <span className="font-bold block">Action Required</span>
                    Your credit utilization is high. We recommend logging standard payments using cash balances to avoid carrying a high debt-to-limit ratio. This minimizes interest loss!
                  </div>
                </div>
              ) : (
                <div className="flex items-start gap-2 text-xs text-emerald-800 dark:text-emerald-400 p-3 bg-emerald-50 dark:bg-emerald-950/20 rounded-xl border border-emerald-100 dark:border-emerald-900/60">
                  <CheckCircle className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
                  <div>
                    <span className="font-bold block">Excellent Standing</span>
                    Your credit utilization is safe! Carrying under 30% signals low credit risk and drives maximum scoring health. Keep up the disciplined budget matching.
                  </div>
                </div>
              )}
            </div>
          </div>

        </div>
      </div>

      {/* ========================================== */}
      {/* MODAL 1: ADD OR EDIT CARD MODAL */}
      {/* ========================================== */}
      {isAddModalOpen && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in duration-205">
          <div className="bg-white dark:bg-slate-900 rounded-3xl border border-slate-200 dark:border-slate-800 shadow-xl max-w-md w-full overflow-hidden">
            <div className="bg-slate-900 dark:bg-slate-950 text-white p-5 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold">{editingCard ? 'Edit card' : 'Add Credit Card'}</h3>
                <p className="text-[10px] text-slate-400 font-medium">Track a credit card's balance, limit and due date.</p>
              </div>
              <button
                onClick={() => setIsAddModalOpen(false)}
                aria-label="Close"
                className="p-1 rounded-lg bg-white/10 hover:bg-white/20 text-white cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSaveCard} className="p-6 space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-[10px] uppercase font-bold text-slate-500 dark:text-slate-400">Card Name</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. CSR, Cash Rewards"
                    value={cardName}
                    onChange={(e) => setCardName(e.target.value)}
                    className="w-full text-xs p-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-xl focus:outline-hidden focus:border-indigo-500"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] uppercase font-bold text-slate-500 dark:text-slate-400">Issuer Bank</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Chase, Amex, Citi"
                    value={issuer}
                    onChange={(e) => setIssuer(e.target.value)}
                    className="w-full text-xs p-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-xl focus:outline-hidden focus:border-indigo-500"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-[10px] uppercase font-bold text-slate-500 dark:text-slate-400">Card Network</label>
                  <select
                    value={cardType}
                    onChange={(e: any) => setCardType(e.target.value)}
                    className="w-full text-xs p-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-xl focus:outline-hidden"
                  >
                    <option value="visa">Visa</option>
                    <option value="mastercard">Mastercard</option>
                    <option value="amex">American Express</option>
                    <option value="discover">Discover</option>
                    <option value="other">Other Network</option>
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="text-[10px] uppercase font-bold text-slate-500 dark:text-slate-400">Ledger Profile Scope</label>
                  <select
                    value={cardScope}
                    onChange={(e: any) => setCardScope(e.target.value)}
                    className="w-full text-xs p-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-xl focus:outline-hidden"
                  >
                    <option value="personal">Mine</option>
                    <option value="joint">Joint</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-[10px] uppercase font-bold text-slate-500 dark:text-slate-400">Credit Limit ({currency})</label>
                  <input
                    type="number"
                    required
                    min="1"
                    placeholder="e.g. 10000"
                    value={creditLimit}
                    onChange={(e) => setCreditLimit(e.target.value)}
                    className="w-full text-xs p-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-xl focus:outline-hidden focus:border-indigo-500 font-mono"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] uppercase font-bold text-slate-500 dark:text-slate-400">Current Outstanding Balance ({currency})</label>
                  <input
                    type="number"
                    min="0"
                    required
                    placeholder="0"
                    value={cardBalance}
                    onChange={(e) => setCardBalance(e.target.value)}
                    className="w-full text-xs p-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-xl focus:outline-hidden focus:border-indigo-500 font-mono"
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div className="space-y-1">
                  <label className="text-[10px] uppercase font-bold text-slate-500 dark:text-slate-400">APR %</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    required
                    placeholder="21.99"
                    value={apr}
                    onChange={(e) => setApr(e.target.value)}
                    className="w-full text-xs p-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-xl focus:outline-hidden focus:border-indigo-500 font-mono"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] uppercase font-bold text-slate-500 dark:text-slate-400">Due Day (1-31)</label>
                  <input
                    type="number"
                    min="1"
                    max="31"
                    required
                    placeholder="15"
                    value={dueDate}
                    onChange={(e) => setDueDate(e.target.value)}
                    className="w-full text-xs p-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-xl focus:outline-hidden focus:border-indigo-500 font-mono"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] uppercase font-bold text-slate-500 dark:text-slate-400">Min Payment ({currency})</label>
                  <input
                    type="number"
                    min="0"
                    required
                    placeholder="35"
                    value={minPayment}
                    onChange={(e) => setMinPayment(e.target.value)}
                    className="w-full text-xs p-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-xl focus:outline-hidden focus:border-indigo-500 font-mono"
                  />
                </div>
              </div>

              <div className="flex gap-2 pt-2.5">
                <button
                  type="submit"
                  className="flex-1 py-2.5 text-xs font-bold bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 rounded-xl hover:bg-slate-800 dark:hover:bg-slate-300 transition-all cursor-pointer text-center"
                >
                  {editingCard ? 'Save changes' : 'Add card'}
                </button>
                {editingCard && (
                  <button
                    type="button"
                    onClick={() => {
                      setCardToDelete(editingCard);
                      setIsAddModalOpen(false);
                    }}
                    className="py-2.5 px-4 text-xs font-bold bg-rose-50 dark:bg-rose-950/30 hover:bg-rose-100 dark:hover:bg-rose-950/50 text-rose-700 dark:text-rose-400 rounded-xl transition-all border border-rose-200 dark:border-rose-900 cursor-pointer flex items-center gap-1.5"
                    title="Remove this card"
                  >
                    <Trash2 className="w-4 h-4 shrink-0" />
                    <span>Delete Card</span>
                  </button>
                )}
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ========================================== */}
      {/* MODAL 2: LOG CREDIT CARD PAYMENT */}
      {/* ========================================== */}
      {isPayModalOpen && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in duration-205">
          <div className="bg-white dark:bg-slate-900 rounded-3xl border border-slate-200 dark:border-slate-800 shadow-xl max-w-md w-full overflow-hidden">
            <div className="bg-slate-900 dark:bg-slate-950 text-white p-5 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold">Log Credit Card Payment</h3>
                <p className="text-[10px] text-slate-400 font-medium">Record a transfer of funds to reduce carrying balances.</p>
              </div>
              <button
                onClick={() => setIsPayModalOpen(false)}
                aria-label="Close"
                className="p-1 rounded-lg bg-white/10 hover:bg-white/20 text-white cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handlePaySubmit} className="p-6 space-y-4">

              <div className="space-y-1">
                <label className="text-[10px] uppercase font-bold text-slate-500 dark:text-slate-400">Target Credit Card</label>
                <select
                  required
                  value={selectedCardId}
                  onChange={(e) => setSelectedCardId(e.target.value)}
                  className="w-full text-xs p-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-xl focus:outline-hidden"
                >
                  <option value="">-- Choose Credit Card --</option>
                  {filteredCards.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.issuer} {c.cardName} (Bal: {currency}{c.balance.toFixed(2)})
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1">
                <label className="text-[10px] uppercase font-bold text-slate-500 dark:text-slate-400">Source Bank Account / Cash Account</label>
                <select
                  value={paySourceBankId}
                  onChange={(e) => setPaySourceBankId(e.target.value)}
                  className="w-full text-xs p-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-xl focus:outline-hidden"
                >
                  <option value="">No Bank Account (Log as reserve/cash reserve)</option>
                  {bankConnections
                    .filter((b) => b.status === "connected")
                    .map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.bankName} - {b.accountName} (Bal: {currency}{b.balance.toFixed(2)})
                      </option>
                    ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-[10px] uppercase font-bold text-slate-500 dark:text-slate-400">Payment Amount ({currency})</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0.01"
                    required
                    placeholder="0.00"
                    value={payAmount}
                    onChange={(e) => setPayAmount(e.target.value)}
                    className="w-full text-xs p-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-xl focus:outline-hidden focus:border-indigo-500 font-mono"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] uppercase font-bold text-slate-500 dark:text-slate-400">Payment Date</label>
                  <input
                    type="date"
                    required
                    value={payDate}
                    onChange={(e) => setPayDate(e.target.value)}
                    className="w-full text-xs p-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-xl focus:outline-hidden focus:border-indigo-500"
                  />
                </div>
              </div>

              {/* Dynamic Warning Block instead of Blocking Confirm dialogs */}
              {(() => {
                const amountNum = parseFloat(payAmount) || 0;
                const card = creditCards.find(c => c.id === selectedCardId);
                const sourceBank = bankConnections.find(b => b.id === paySourceBankId);
                const warnings: string[] = [];

                if (card && amountNum > card.balance) {
                  warnings.push(`The payment amount of ${currency}${amountNum.toFixed(2)} exceeds the card's outstanding balance of ${currency}${card.balance.toFixed(2)}.`);
                }
                if (sourceBank && sourceBank.balance < amountNum) {
                  warnings.push(`Selected account "${sourceBank.bankName}" has insufficient funds (${currency}${sourceBank.balance.toFixed(2)}) for payment.`);
                }

                if (warnings.length > 0) {
                  return (
                    <div className="p-3 bg-amber-50/70 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-900/60 text-amber-900 dark:text-amber-400 rounded-xl space-y-1 text-[11px] font-medium leading-relaxed">
                      {warnings.map((w, idx) => (
                        <div key={idx} className="flex items-start gap-1">
                          <AlertTriangle className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                          <span>{w}</span>
                        </div>
                      ))}
                    </div>
                  );
                }
                return null;
              })()}

              <button
                type="submit"
                className="w-full py-2.5 text-xs font-bold bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 rounded-xl hover:bg-slate-800 dark:hover:bg-slate-300 transition-all cursor-pointer flex items-center justify-center gap-1.5"
              >
                <ArrowDownLeft className="w-4 h-4 text-emerald-400" /> Log and Clear Payment
              </button>
            </form>
          </div>
        </div>
      )}

      {/* ========================================== */}
      {/* MODAL 3: CARD CHARGE / LOG SPENT */}
      {/* ========================================== */}
      {isLogChargeModalOpen && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in duration-205">
          <div className="bg-white dark:bg-slate-900 rounded-3xl border border-slate-200 dark:border-slate-800 shadow-xl max-w-md w-full overflow-hidden">
            <div className="bg-slate-900 dark:bg-slate-950 text-white p-5 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold">Log Card Charge (Purchase)</h3>
                <p className="text-[10px] text-slate-400 font-medium">Record a purchase that increases card balance and syncs to ledger.</p>
              </div>
              <button
                onClick={() => setIsLogChargeModalOpen(false)}
                aria-label="Close"
                className="p-1 rounded-lg bg-white/10 hover:bg-white/20 text-white cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleLogChargeSubmit} className="p-6 space-y-4">

              <div className="space-y-1">
                <label className="text-[10px] uppercase font-bold text-slate-500 dark:text-slate-400">Charge Target Credit Card</label>
                <select
                  required
                  value={selectedCardId}
                  onChange={(e) => setSelectedCardId(e.target.value)}
                  className="w-full text-xs p-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-xl focus:outline-hidden"
                >
                  <option value="">-- Choose Credit Card --</option>
                  {filteredCards.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.issuer} {c.cardName} (Available limit: {currency}{(c.creditLimit - c.balance).toLocaleString()})
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1">
                <label className="text-[10px] uppercase font-bold text-slate-500 dark:text-slate-400">Transaction Description</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Grocery Shop, Netflix Subscription"
                  value={chargeDescription}
                  onChange={(e) => setChargeDescription(e.target.value)}
                  className="w-full text-xs p-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-xl focus:outline-hidden focus:border-indigo-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-[10px] uppercase font-bold text-slate-500 dark:text-slate-400">Purchase Amount ({currency})</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0.01"
                    required
                    placeholder="0.00"
                    value={chargeAmount}
                    onChange={(e) => setChargeAmount(e.target.value)}
                    className="w-full text-xs p-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-xl focus:outline-hidden focus:border-indigo-500 font-mono"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] uppercase font-bold text-slate-500 dark:text-slate-400">Payment Date</label>
                  <input
                    type="date"
                    required
                    value={chargeDate}
                    onChange={(e) => setChargeDate(e.target.value)}
                    className="w-full text-xs p-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-xl focus:outline-hidden focus:border-indigo-500"
                  />
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-[10px] uppercase font-bold text-slate-500 dark:text-slate-400">Budget Allocation Category</label>
                <select
                  value={chargeCategory}
                  onChange={(e) => setChargeCategory(e.target.value)}
                  className="w-full text-xs p-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-slate-100 rounded-xl focus:outline-hidden"
                >
                  {categories.filter(c => c !== 'Income').map((cat) => (
                    <option key={cat} value={cat}>
                      {cat}
                    </option>
                  ))}
                </select>
              </div>

              <button
                type="submit"
                className="w-full py-2.5 text-xs font-bold bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 rounded-xl hover:bg-slate-800 dark:hover:bg-slate-300 transition-all cursor-pointer flex items-center justify-center gap-1.5"
              >
                <ArrowUpRight className="w-4 h-4 text-rose-400" /> Log Transaction Charge
              </button>
            </form>
          </div>
        </div>
      )}

      {/* ========================================== */}
      {/* MODAL 4: DELETE CONFIRMATION MODAL */}
      {/* ========================================== */}
      {cardToDelete && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in duration-200">
          <div className="bg-white dark:bg-slate-900 rounded-3xl border border-slate-200 dark:border-slate-800 shadow-xl max-w-sm w-full overflow-hidden p-6 space-y-4">
            <div className="flex items-start gap-3">
              <div className="p-3 bg-red-50 dark:bg-red-950/30 text-red-600 dark:text-red-400 rounded-2xl border border-red-100 dark:border-red-900/60 shrink-0">
                <Trash2 className="w-6 h-6" />
              </div>
              <div className="space-y-1">
                <h4 className="text-sm font-bold text-slate-900 dark:text-slate-100">Remove Credit Card?</h4>
                <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                  Are you sure you want to disconnect & remove the <strong className="text-slate-800 dark:text-slate-200">"{cardToDelete.cardName}"</strong> tracker dashboard?
                </p>
                <p className="text-[10px] text-slate-400 dark:text-slate-500 font-medium">This will stop tracking the account's utilization, APR optimization advice, and statement dates. This action is irreversible.</p>
              </div>
            </div>

            <div className="flex gap-2 pt-2">
              <button
                type="button"
                onClick={() => setCardToDelete(null)}
                className="flex-1 py-2 text-xs font-bold bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 rounded-xl transition-all border border-slate-200 dark:border-slate-700 cursor-pointer text-center"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  handleDeleteCard(cardToDelete.id, cardToDelete.cardName);
                  setCardToDelete(null);
                }}
                className="flex-1 py-2 text-xs font-bold bg-red-700 hover:bg-red-700 text-white rounded-xl transition-all cursor-pointer text-center"
              >
                Yes, Disconnect
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
