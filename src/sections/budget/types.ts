export type TransactionCategory = string;

export interface Transaction {
  id: string;
  date: string; // ISO date or localized string
  description: string;
  merchantName: string;
  amount: number;
  category: TransactionCategory;
  bankName: string;
  status: 'pending' | 'cleared';
  scope?: 'personal' | 'joint';
  // Present on both legs of an internal transfer between two linked accounts --
  // shared value ties the debit/credit pair together (see App.tsx handleAddTransfer).
  transferId?: string;
  // The real BankConnection.id this leg is attributed to, used to precisely
  // reverse balances on delete instead of matching by bankName string.
  accountId?: string;
}

export interface Budget {
  category: TransactionCategory;
  // The default monthly limit -- used for any month without its own entry in
  // `monthlyLimits`, and for every month when rollover/monthlyLimits are unset
  // (Phase 5's backward-compatibility requirement: a legacy row with only
  // `limit` behaves exactly as it did before this phase).
  limit: number;
  // 'YYYY-MM' -> a one-off limit for that month only, set via "Set for {Month}
  // only…" or the inline-edit toast's "Only for {Month}" action. Absent months
  // fall back to `limit` (see budgetMath's limitFor).
  monthlyLimits?: Record<string, number>;
  // Carries this category's unspent (or overspent) money from one month into
  // the next -- see budgetMath's carryInto for the month-by-month math. Income
  // categories ignore this flag even when set.
  rollover?: boolean;
  // 'YYYY-MM' the rollover chain starts counting from -- set when rollover is
  // first turned on and left in place when it's turned off, so re-enabling it
  // later doesn't need re-explaining and turning it off keeps the history of
  // when it was on.
  rolloverSince?: string;
  // Legacy stored field -- used to be recalculated onto every row on every
  // transaction change (a whole-table PUT storm for nothing the UI read back).
  // Display now always derives spent per scope/month from transactions instead
  // (see Budget.tsx's displayBudgets), so this is optional and, where still
  // written, only a placeholder for rows that predate that change.
  spent?: number;
  scope?: 'personal' | 'joint' | 'all';
}

// What every component that renders a budget actually receives: Budget.tsx's
// displayBudgets always fills in a numeric `spent` before handing rows down,
// so component props can rely on it being present without re-deriving it.
// `baseLimit` is this month's limit before rollover (limitFor's result);
// `carriedIn` is the rollover amount folded in on top of it (0 when rollover
// is off, or for an income category, or for the 'all' pseudo-month); `limit`
// itself becomes the AVAILABLE amount (baseLimit + carriedIn) so every
// existing consumer that reads `limit` -- Overview, needsAttention,
// budgetLevel, safeToSpend, BillsTracker -- automatically accounts for
// rollover without having to know it exists.
// `unbudgeted` marks a synthetic $0-limit row for a category that has spending
// but no budget entry (see buildDisplayBudgets) -- there is no stored row behind it.
export type DisplayBudget = Budget & { spent: number; baseLimit: number; carriedIn: number; unbudgeted?: boolean };

export interface BankConnection {
  id: string;
  bankName: string;
  accountName: string;
  lastFour: string;
  balance: number;
  status: 'connected' | 'disconnected';
  isPlaid?: boolean;
  // Set by the server: whether it holds a Plaid access token for this account. The token itself
  // never reaches the browser (the project notes 10.7); a save ignores this field.
  hasAccessToken?: boolean;
  plaidAccountId?: string;
  itemId?: string;
  scope?: 'personal' | 'joint';
  // 'loan' accounts (auto loans, student loans, mortgages linked as a standalone
  // item) carry a balance you OWE, not cash you have. 'savings' is real money but
  // deliberately set aside, not meant to be casually spent. Both are excluded from
  // "Available Cash" -- only 'depository' (checking) counts as spendable cash.
  accountType?: 'depository' | 'savings' | 'loan';
}

export interface BudgetAlert {
  id: string;
  type: 'warning' | 'critical' | 'info';
  category: TransactionCategory;
  message: string;
  date: string;
  isRead: boolean;
  amount?: number;
}

export interface SecurityEvent {
  id: string;
  timestamp: string;
  event: string;
  type: 'success' | 'warning' | 'critical' | 'info';
}

export interface CreditCard {
  id: string;
  cardName: string;
  issuer: string;
  cardType: 'visa' | 'mastercard' | 'amex' | 'discover' | 'other';
  creditLimit: number;
  balance: number;
  apr: number;
  dueDate: string; // Day of month, e.g., "15" or "25th"
  minPayment: number;
  scope?: 'personal' | 'joint';
  status: 'active' | 'closed';
}

// Phase 6: a recurring bill with a due date and expected amount, replacing the
// old category-based "N of M bills paid" tracker (BillsTracker's old
// billCategories model, still kept around for the one-time migration banner --
// see useBudgetStore's billCategories).
export interface Bill {
  id: string;
  name: string; // "Xfinity Internet"
  amount: number; // expected, positive
  dueDay: number; // 1-31; clamped to the month's real length (Feb 31 -> 28/29)
  frequency: 'monthly' | 'quarterly' | 'yearly';
  startMonth: string; // 'YYYY-MM' -- anchors quarterly/yearly and rules out "due" before this
  category: string; // budget category it counts against
  matchText?: string; // merchant/description substring that identifies the payment
  autopay?: boolean;
  scope?: 'personal' | 'joint';
  // 'YYYY-MM' -> a manual link/mark for that month. `null` explicitly means
  // "not paid" and blocks auto-matching for that month (see budgetMath's
  // billStatus) -- otherwise a since-deleted matched transaction would just
  // silently auto-match a different one next render.
  payments?: Record<string, { transactionId?: string; markedAt: string } | null>;
  active: boolean;
}

export interface SavingsGoal {
  id: string;
  name: string;
  targetAmount: number;
  scope?: 'personal' | 'joint';
  targetDate?: string;
  // Two ways to track progress: link the goal to one of the household's real
  // savings accounts (progress = that account's live Plaid balance), or track
  // it manually for a goal that doesn't map to a specific account.
  linkedBankConnectionId?: string;
  manualAmount?: number;
  // Milestone percentages (25/50/75/100) already alerted on, so we don't
  // re-fire the same "you hit 50%!" alert every time the balance is re-checked.
  alertedMilestones?: number[];
}

