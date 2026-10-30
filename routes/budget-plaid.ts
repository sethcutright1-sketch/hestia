import express from "express";
import {
  getConfig,
  setConfig,
  encryptSecret,
  decryptSecret,
  PLAID_CONFIG_KEY,
  plaidItemKey,
  getPlaidCursor,
  setPlaidCursor,
  clearPlaidCursor,
  matchMerchantRule,
  getScopedItems,
  getBankConnectionAccessToken,
} from "../db.ts";
import { currentUserId, requireAdmin, verifyPassword } from "../auth.ts";
import { rememberFreshLink, freshLinkToken } from "../plaidFreshLinks.ts";

// Ported from the standalone Budget Sync app. Unlike the source, this never
// rewrites a .env file on disk -- this app's dotenv loads .env then .env.local
// with override:true, so a UI-set key written to .env would be silently
// shadowed by any .env.local value on the next restart. Persisted to app_config
// instead; env vars still win if set, so an operator can still configure Plaid
// the old way. The stored `secret` is encrypted with DB_ENCRYPTION_KEY (db.ts) -- the database
// is copied into every backup, and the client secret is what makes a leaked access token usable
// (the project notes 10.6). A value saved before that is encrypted once at boot
// (encryptStoredPlaidSecret); decryptSecret passes it through until then.
interface PlaidConfig {
  clientId: string;
  secret: string;
  environment: string;
}

function getPlaidConfig(): PlaidConfig {
  const stored = getConfig(PLAID_CONFIG_KEY, null) as PlaidConfig | null;
  return {
    clientId: process.env.PLAID_CLIENT_ID || stored?.clientId || "",
    secret: process.env.PLAID_SECRET || (stored?.secret ? decryptSecret(stored.secret) : ""),
    environment: process.env.PLAID_ENV || stored?.environment || "sandbox",
  };
}

function getPlaidHostEnv(token: string, configuredEnv: string): string {
  if (typeof token === "string") {
    if (token.startsWith("access-sandbox-") || token.startsWith("public-sandbox-")) return "sandbox";
    if (token.startsWith("access-production-") || token.startsWith("public-production-")) return "production";
    if (token.startsWith("access-development-") || token.startsWith("public-development-")) return "production";
  }
  return configuredEnv === "development" || configuredEnv === "production" ? "production" : "sandbox";
}

// Always Plaid's real host unless PLAID_API_BASE is explicitly set in the
// environment, which exists so the sync loop can be exercised against a local
// mock. Operator-set only -- never derived from request data.
function plaidUrl(hostEnv: string, endpointPath: string): string {
  const base = process.env.PLAID_API_BASE || `https://${hostEnv}.plaid.com`;
  return `${base.replace(/\/$/, "")}${endpointPath}`;
}

export const budgetPlaidRoutes = express.Router();

// Doesn't decrypt anything: whether a secret is saved is all this needs, and a status poll
// shouldn't start failing over a key problem that the next real Plaid call will report anyway.
budgetPlaidRoutes.get("/status", (_req, res) => {
  const stored = getConfig(PLAID_CONFIG_KEY, null) as PlaidConfig | null;
  const clientId = process.env.PLAID_CLIENT_ID || stored?.clientId || "";
  const hasSecret = !!(process.env.PLAID_SECRET || stored?.secret);
  res.json({ configured: !!(clientId && hasSecret), environment: process.env.PLAID_ENV || stored?.environment || "sandbox" });
});

// Same "prove this isn't just a left-open session" pattern as PUT
// /api/auth/kiosk and /api/backup/download -- this replaces the credentials
// every joint bank connection runs on, so a stolen/unlocked kiosk session (or
// a parent account) shouldn't be able to swap them on its own. requireAdmin
// first: a kiosk session's own password is the shared device credential, not
// a real member's, so checking a password alone here would mean anyone who
// knows the kiosk's password (effectively anyone standing at the fridge)
// could pass this check.
budgetPlaidRoutes.post("/configure", requireAdmin, async (req, res) => {
  const { clientId, secret, environment, password } = req.body || {};
  if (clientId === undefined || secret === undefined) {
    return res.status(400).json({ error: "Missing Plaid clientId or secret parameters" });
  }
  if (!(await verifyPassword(currentUserId(req), password))) {
    return res.status(401).json({ error: "Incorrect password." });
  }

  let sanitizedEnv = environment || "sandbox";
  if (sanitizedEnv !== "sandbox" && sanitizedEnv !== "development" && sanitizedEnv !== "production") {
    sanitizedEnv = "sandbox";
  }

  let storedSecret: string;
  try {
    storedSecret = secret ? encryptSecret(String(secret)) : "";
  } catch (err: any) {
    // Only reachable when DB_ENCRYPTION_KEY is missing or malformed. Refused rather than
    // saved in the clear.
    return res.status(500).json({ error: `Can't save the Plaid secret: ${err.message}` });
  }
  setConfig(PLAID_CONFIG_KEY, { clientId, secret: storedSecret, environment: sanitizedEnv });
  res.json({ success: true, message: "Plaid credentials updated successfully", configured: !!(clientId && secret), environment: sanitizedEnv });
});

budgetPlaidRoutes.post("/create_link_token", async (_req, res) => {
  try {
    const { clientId, secret, environment } = getPlaidConfig();
    const hostEnv = environment === "development" ? "production" : environment;

    if (!clientId || !secret) {
      return res.status(400).json({ error: "Plaid credentials not configured. Add them in Budget settings." });
    }

    const response = await fetch(plaidUrl(hostEnv, "/link/token/create"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: clientId,
        secret,
        client_name: "Household Budget",
        country_codes: ["US"],
        language: "en",
        user: { client_user_id: "household_budget_user_" + Date.now() },
        products: ["transactions"],
        // "liabilities" gives us APR / minimum payment / next due date for credit
        // card accounts, but must stay optional -- as a required product it blocks
        // linking ANY account at institutions whose connected accounts don't
        // include a qualifying liability (credit/loan) account.
        optional_products: ["liabilities"],
      }),
    });

    const data = await response.json();
    if (!response.ok) throw new Error((data as any).error_message || JSON.stringify(data));
    res.json(data);
  } catch (err: any) {
    console.error("Error creating Plaid link token:", err);
    res.status(500).json({ error: err.message });
  }
});

budgetPlaidRoutes.post("/exchange_public_token", async (req, res) => {
  try {
    const { clientId, secret, environment } = getPlaidConfig();
    const { public_token } = req.body;
    if (!clientId || !secret) return res.status(400).json({ error: "Plaid credentials not configured." });
    if (!public_token) return res.status(400).json({ error: "public_token is required." });

    const hostEnv = getPlaidHostEnv(public_token, environment);

    const exchangeResponse = await fetch(plaidUrl(hostEnv, "/item/public_token/exchange"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: clientId, secret, public_token }),
    });
    const exchangeData: any = await exchangeResponse.json();
    if (!exchangeResponse.ok) throw new Error(exchangeData.error_message || JSON.stringify(exchangeData));

    const accessToken = exchangeData.access_token;

    const accountsResponse = await fetch(plaidUrl(hostEnv, "/accounts/balance/get"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: clientId, secret, access_token: accessToken }),
    });
    const accountsData: any = await accountsResponse.json();
    if (!accountsResponse.ok) throw new Error(accountsData.error_message || JSON.stringify(accountsData));

    // Best-effort: pull credit card liability details (APR, minimum payment, next
    // due date). Not every institution supports this, so a failure here shouldn't
    // block the bank connection itself.
    let creditLiabilities: Record<string, any> = {};
    try {
      const liabilitiesResponse = await fetch(plaidUrl(hostEnv, "/liabilities/get"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: clientId, secret, access_token: accessToken }),
      });
      const liabilitiesData: any = await liabilitiesResponse.json();
      if (liabilitiesResponse.ok) {
        const cards = liabilitiesData.liabilities?.credit || [];
        for (const card of cards) {
          const aprPercentage = card.aprs?.find((a: any) => a.apr_type === "purchase_apr")?.apr_percentage
            ?? card.aprs?.[0]?.apr_percentage
            ?? null;
          creditLiabilities[card.account_id] = {
            aprPercentage,
            minimumPaymentAmount: card.minimum_payment_amount ?? null,
            nextPaymentDueDate: card.next_payment_due_date ?? null,
            lastStatementBalance: card.last_statement_balance ?? null,
          };
        }
      }
    } catch (liabErr: any) {
      console.warn("Liabilities fetch skipped (not supported for this institution):", liabErr.message);
    }

    // The token stays on the server (10.7): remembered here for the first sync and for the save of
    // the accounts the person picks (db.ts attaches it to each bank_connections row). The browser
    // gets only the item id and the account list.
    rememberFreshLink(currentUserId(req), exchangeData.item_id, accessToken);
    res.json({ accounts: accountsData.accounts, item_id: exchangeData.item_id, creditLiabilities });
  } catch (err: any) {
    console.error("Error exchanging Plaid public token:", err);
    res.status(500).json({ error: err.message });
  }
});

/** The access token for a request body naming `bankConnectionId` (a row this user may see) or
 *  `itemId` (an item this user exchanged moments ago; plaidFreshLinks.ts). Never reads a token from the body. */
export function resolveAccessToken(userId: string, body: any): string | null {
  if (typeof body?.bankConnectionId === "string") return getBankConnectionAccessToken(userId, body.bankConnectionId);
  if (typeof body?.itemId === "string") return freshLinkToken(userId, body.itemId);
  return null;
}

budgetPlaidRoutes.post("/fetch_transactions", async (req, res) => {
  try {
    const userId = currentUserId(req);
    const { clientId, secret, environment } = getPlaidConfig();
    if (!clientId || !secret) return res.status(400).json({ error: "Plaid credentials not configured." });
    // 10.7: the browser names a connection (or the just-linked item) and the server finds the token.
    // A token in the body is ignored, so a caller can't point the server at an item it doesn't own.
    const access_token = resolveAccessToken(userId, req.body);
    if (!access_token) return res.status(400).json({ error: "bankConnectionId is required, and must be one of your own connections." });

    const hostEnv = getPlaidHostEnv(access_token, environment);
    const itemKey = plaidItemKey(access_token);

    // `reset` replays the item's whole history from scratch. Needed once after a
    // sync that was previously capped mid-history, to backfill what it skipped.
    if (req.body.reset) clearPlaidCursor(userId, itemKey);

    // A synced transaction has no scope of its own -- it inherits whichever
    // ledger (personal/joint) the household assigned to the bank account it
    // came from, via that account's plaidAccountId. Without this, every
    // Plaid-synced transaction fell back to "personal" downstream regardless
    // of the connection's actual scope, so the Joint Wallet filter never
    // showed bank-synced activity even from accounts marked joint.
    const scopeByPlaidAccountId = new Map<string, "personal" | "joint">(
      getScopedItems("bank_connections", userId)
        .filter((b: any) => b.plaidAccountId)
        .map((b: any) => [b.plaidAccountId, b.scope === "joint" ? "joint" : "personal"])
    );

    const accountNames: Record<string, string> = {};
    // the project notes #5: "available cash" was a client-side running total
    // that only ever moved by locally-added transaction amounts, never
    // reconciled against the bank's real balance -- so interest, holds, and
    // anything not captured as a synced transaction let it drift indefinitely.
    // A sync is the natural point to refresh it, since it's already the
    // "talk to Plaid" moment; balances keyed by account_id so the client can
    // match them to the right bankConnections row.
    const balances: { accountId: string; balance: number }[] = [];
    try {
      const acctRes = await fetch(plaidUrl(hostEnv, "/accounts/balance/get"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: clientId, secret, access_token }),
      });
      const acctData: any = await acctRes.json();
      if (acctRes.ok) {
        const instName = acctData.item?.institution_name;
        for (const a of acctData.accounts || []) {
          const label = a.official_name || a.name || a.subtype || "Account";
          accountNames[a.account_id] = instName ? `${instName} · ${label}` : label;
          if (typeof a.balances?.current === "number") {
            balances.push({ accountId: a.account_id, balance: a.balances.current });
          }
        }
      }
    } catch {
      // Non-fatal: fall back to a generic label below, and the client keeps its
      // last-known balance rather than failing the whole sync over this.
    }

    // Page through the cursor feed until Plaid says there's nothing more.
    const added: any[] = [];
    const modifiedRaw: any[] = [];
    const removedIds: string[] = [];
    let cursor = getPlaidCursor(userId, itemKey);
    const startingCursor = cursor;
    let hasMore = true;
    let pages = 0;
    let restarts = 0;
    const MAX_PAGES = 60;
    const MAX_RESTARTS = 3;

    while (hasMore && pages < MAX_PAGES) {
      const body: Record<string, unknown> = { client_id: clientId, secret, access_token, count: 500 };
      if (cursor) body.cursor = cursor;

      const syncResponse = await fetch(plaidUrl(hostEnv, "/transactions/sync"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const syncData: any = await syncResponse.json();

      if (!syncResponse.ok) {
        // Plaid invalidates a cursor if the item's data changed mid-pagination.
        // Restart cleanly from the cursor we began this request with.
        if (syncData?.error_code === "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION" && restarts < MAX_RESTARTS) {
          restarts++;
          added.length = 0;
          modifiedRaw.length = 0;
          removedIds.length = 0;
          cursor = startingCursor;
          hasMore = true;
          pages = 0;
          continue;
        }
        throw new Error(syncData?.error_message || JSON.stringify(syncData));
      }

      added.push(...(syncData.added || []));
      modifiedRaw.push(...(syncData.modified || []));
      removedIds.push(...(syncData.removed || []).map((r: any) => r.transaction_id).filter(Boolean));

      cursor = syncData.next_cursor;
      hasMore = Boolean(syncData.has_more);
      pages++;
    }

    const mapTransaction = (tx: any) => {
      const rawAmt = Number(tx.amount);
      const isExpense = rawAmt > 0;
      const finalAmount = isExpense ? -rawAmt : Math.abs(rawAmt);

      let category = "Shopping";
      if (tx.personal_finance_category?.primary) {
        const prim = tx.personal_finance_category.primary.toLowerCase();
        const detailed = (tx.personal_finance_category?.detailed || "").toLowerCase();
        if (detailed.includes("groceries") || detailed.includes("supermarket")) category = "Groceries";
        else if (prim === "food_and_drink") category = "Eating Out";
        else if (detailed.includes("rent_and_utilities_rent") || detailed.includes("rent_and_utilities_mortgage")) category = "Mortgage/Rent";
        else if (detailed.includes("subscription")) category = "Subscriptions";
        else if (prim === "rent_and_utilities") category = "Utilities & Bills";
        else if (prim === "travel" || prim === "transportation") category = "Gas & Transport";
        else if (prim === "entertainment") category = "Family Activities";
        else if (prim === "medical") category = "Medical & Health";
        else if (prim === "loan_payments" || detailed.includes("credit_card")) category = "Credit Cards & Debt";
        else if (detailed.includes("savings") || detailed.includes("vault")) category = "Savings";
        else if (prim === "income") category = "Income";
        else if (prim === "transfer_in" || prim === "transfer_out") category = "Transfer";
      }

      // A remembered merchant rule is the household's own "always categorize
      // this merchant this way" -- it beats Plaid's guess outright. It used to
      // only be offered as a dismissable banner suggestion held in React state,
      // which never appeared for a sync that ran on another device or after a
      // reload, so e.g. "Children's Hospital" (a cafeteria, saved as Eating
      // Out) kept landing as Plaid's "medical" -> Medical & Health.
      const remembered = matchMerchantRule(userId, tx.merchant_name || tx.name || "");

      return {
        id: tx.transaction_id,
        date: tx.date,
        description: tx.name,
        merchantName: tx.merchant_name || tx.name,
        amount: finalAmount,
        category: remembered ? remembered.category : category,
        bankName: accountNames[tx.account_id] || "Plaid Connected",
        accountId: tx.account_id,
        scope: scopeByPlaidAccountId.get(tx.account_id) || "personal",
        status: tx.pending ? "pending" : "cleared",
      };
    };

    // Plaid can issue two distinct, both-"cleared" transaction_ids for what is
    // really one real-world event; collapse same-account/date/amount/merchant
    // matches within this batch down to one row before they're ever stored.
    const contentKey = (t: { accountId?: string; date: string; amount: number; merchantName: string }) =>
      `${t.accountId || ""}|${t.date}|${t.amount}|${t.merchantName.trim().toLowerCase()}`;
    const dedupeByContent = <T extends { accountId?: string; date: string; amount: number; merchantName: string }>(list: T[]): T[] => {
      const seen = new Set<string>();
      return list.filter((t) => {
        const k = contentKey(t);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    };

    const processed = dedupeByContent(added.map(mapTransaction));
    const processedModified = dedupeByContent(modifiedRaw.map(mapTransaction));

    // Only persist the cursor once the whole page walk succeeded.
    if (cursor) setPlaidCursor(userId, itemKey, cursor);

    res.json({
      transactions: processed,
      modified: processedModified,
      removed: removedIds,
      pages,
      backfilled: !startingCursor,
      cursor,
      balances,
    });
  } catch (err: any) {
    console.error("Error fetching Plaid transactions:", err);
    res.status(500).json({ error: err.message });
  }
});
