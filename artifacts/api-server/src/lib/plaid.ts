import {
  Configuration,
  PlaidApi,
  PlaidEnvironments,
  Products,
  CountryCode,
  type AccountBase,
} from "plaid";
import { db, plaidItems, balances, type PlaidAccountMeta } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";
import { scheduleIntegrityRevalidation } from "./integrity";

/**
 * Safe serializer for Plaid (axios) errors. The raw error object includes
 * `config` with headers + request body, which can contain `PLAID-SECRET`
 * and bank `access_token` values. Never log the raw error — always go
 * through this helper.
 */
export function safePlaidError(err: unknown): {
  message: string;
  errorCode?: string;
  errorType?: string;
  status?: number;
  requestId?: string;
} {
  if (typeof err !== "object" || err === null) {
    return { message: String(err) };
  }
  const anyErr = err as {
    message?: string;
    response?: {
      status?: number;
      data?: {
        error_code?: string;
        error_type?: string;
        error_message?: string;
        request_id?: string;
      };
    };
  };
  const data = anyErr.response?.data;
  return {
    message: data?.error_message ?? anyErr.message ?? "Plaid error",
    ...(data?.error_code ? { errorCode: data.error_code } : {}),
    ...(data?.error_type ? { errorType: data.error_type } : {}),
    ...(anyErr.response?.status ? { status: anyErr.response.status } : {}),
    ...(data?.request_id ? { requestId: data.request_id } : {}),
  };
}

const SUPPORTED_ENVS = new Set(["sandbox", "development", "production"]);

export function isPlaidConfigured(): boolean {
  return Boolean(process.env["PLAID_CLIENT_ID"] && process.env["PLAID_SECRET"]);
}

export function getPlaidClient(): PlaidApi {
  const clientId = process.env["PLAID_CLIENT_ID"];
  const secret = process.env["PLAID_SECRET"];
  const envName = (process.env["PLAID_ENV"] ?? "sandbox").toLowerCase();

  if (!clientId || !secret) {
    throw new Error(
      "Plaid is not configured. Set PLAID_CLIENT_ID and PLAID_SECRET secrets.",
    );
  }
  if (!SUPPORTED_ENVS.has(envName)) {
    throw new Error(`Invalid PLAID_ENV: ${envName}`);
  }

  const config = new Configuration({
    basePath: PlaidEnvironments[envName as keyof typeof PlaidEnvironments],
    baseOptions: {
      headers: {
        "PLAID-CLIENT-ID": clientId,
        "PLAID-SECRET": secret,
      },
    },
  });
  return new PlaidApi(config);
}

export const PLAID_PRODUCTS: Products[] = [Products.Auth, Products.Transactions];
export const PLAID_COUNTRY_CODES: CountryCode[] = [CountryCode.Us];

/** Map a Plaid account subtype → our internal balances.accountType vocab. */
export function mapAccountType(
  type: string,
  subtype: string | null | undefined,
): string | null {
  const t = type.toLowerCase();
  const s = (subtype ?? "").toLowerCase();
  if (t === "depository") {
    if (s === "checking") return "checking";
    if (s === "savings" || s === "money market" || s === "cd") return "hysa";
    return "checking";
  }
  if (t === "investment") {
    if (s === "401k") return "401k";
    if (s === "roth" || s === "ira" || s === "roth ira") return "roth_ira";
    return "brokerage";
  }
  return null;
}

export function buildAccountsMeta(accounts: AccountBase[]): PlaidAccountMeta[] {
  return accounts.map((a) => ({
    accountId: a.account_id,
    name: a.name,
    officialName: a.official_name ?? null,
    mask: a.mask ?? null,
    type: a.type,
    subtype: a.subtype ?? null,
    mappedAccountType: mapAccountType(a.type, a.subtype),
  }));
}

/**
 * Pull fresh balances for a single Plaid item — updates the item's metadata
 * + sync state, but does NOT write `balances` rows. Returns sums per mapped
 * accountType so an outer aggregator can sum across all linked institutions
 * (avoids latest-row-per-account-type clobbering when multiple banks are
 * linked).
 */
async function fetchItemSums(itemRowId: number): Promise<Map<string, number>> {
  const [item] = await db.select().from(plaidItems).where(eq(plaidItems.id, itemRowId));
  if (!item) throw new Error(`Plaid item ${itemRowId} not found`);

  const client = getPlaidClient();
  try {
    const resp = await client.accountsBalanceGet({ access_token: item.accessToken });
    const accounts = resp.data.accounts;
    const meta = buildAccountsMeta(accounts);
    const now = new Date();

    const sums = new Map<string, number>();
    for (const a of accounts) {
      const mapped = mapAccountType(a.type, a.subtype);
      if (!mapped) continue;
      const bal = a.balances.available ?? a.balances.current;
      if (bal == null) continue;
      sums.set(mapped, (sums.get(mapped) ?? 0) + bal);
    }

    await db
      .update(plaidItems)
      .set({ accountsMeta: meta, lastSyncedAt: now, lastSyncError: null })
      .where(eq(plaidItems.id, itemRowId));

    return sums;
  } catch (err) {
    const safe = safePlaidError(err);
    await db
      .update(plaidItems)
      .set({ lastSyncError: safe.message })
      .where(eq(plaidItems.id, itemRowId));
    throw err;
  }
}

/**
 * Sync every linked Plaid item and write a single aggregated `balances` row
 * per mapped accountType (sum across institutions). Also triggers an
 * integrity revalidation so check #1 (stale-balance freshness) clears
 * without waiting for an unrelated HTTP write.
 */
export async function refreshAllItems(): Promise<{ ok: number; failed: number }> {
  const items = await db.select().from(plaidItems);
  let ok = 0;
  let failed = 0;
  const totals = new Map<string, number>();
  const sources: string[] = [];

  for (const item of items) {
    try {
      const sums = await fetchItemSums(item.id);
      for (const [k, v] of sums.entries()) {
        totals.set(k, (totals.get(k) ?? 0) + v);
      }
      if (item.institutionName) sources.push(item.institutionName);
      ok++;
    } catch (err) {
      logger.error(
        { plaidError: safePlaidError(err), itemId: item.id },
        "Plaid refresh failed",
      );
      failed++;
    }
  }

  if (totals.size > 0) {
    const now = new Date();
    const note = sources.length > 0 ? sources.join(" + ") : null;
    for (const [accountType, amount] of totals.entries()) {
      await db.insert(balances).values({
        accountType,
        amount: amount.toFixed(2),
        asOfDate: now,
        source: "plaid",
        notes: note,
      } as never);
    }
    scheduleIntegrityRevalidation("plaid refresh");
  }

  return { ok, failed };
}

/** Start a nightly (24h) interval that refreshes all linked items. */
let schedulerStarted = false;
export function startPlaidNightlyScheduler(): void {
  if (schedulerStarted) return;
  schedulerStarted = true;
  const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
  setInterval(() => {
    if (!isPlaidConfigured()) return;
    refreshAllItems()
      .then(({ ok, failed }) =>
        logger.info({ ok, failed }, "Plaid nightly refresh complete"),
      )
      .catch((err) =>
        logger.error(
          { plaidError: safePlaidError(err) },
          "Plaid nightly refresh threw",
        ),
      );
  }, TWENTY_FOUR_HOURS).unref();
}
