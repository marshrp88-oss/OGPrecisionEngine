import { Router, type IRouter } from "express";
import { db, plaidItems } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import {
  CreatePlaidLinkTokenResponse,
  ExchangePlaidPublicTokenBody,
  GetPlaidStatusResponse,
  GetPlaidItemsResponse,
  RefreshPlaidBalancesResponse,
} from "@workspace/api-zod";
import {
  getPlaidClient,
  isPlaidConfigured,
  refreshAllItems,
  buildAccountsMeta,
  safePlaidError,
  PLAID_PRODUCTS,
  PLAID_COUNTRY_CODES,
} from "../lib/plaid";

const router: IRouter = Router();

function serializeItem(row: typeof plaidItems.$inferSelect) {
  return {
    id: row.id,
    institutionId: row.institutionId,
    institutionName: row.institutionName,
    accounts: row.accountsMeta,
    lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
    lastSyncError: row.lastSyncError,
    createdAt: row.createdAt.toISOString(),
  };
}

router.get("/plaid/status", async (_req, res): Promise<void> => {
  const configured = isPlaidConfigured();
  const env = (process.env["PLAID_ENV"] ?? "sandbox").toLowerCase();
  res.json(GetPlaidStatusResponse.parse({ configured, env }));
});

router.post("/plaid/link-token", async (req, res): Promise<void> => {
  if (!isPlaidConfigured()) {
    res.status(503).json({
      error: "Plaid is not configured. Add PLAID_CLIENT_ID and PLAID_SECRET secrets.",
    });
    return;
  }
  try {
    const client = getPlaidClient();
    const resp = await client.linkTokenCreate({
      user: { client_user_id: "reserve-user" },
      client_name: "Reserve",
      products: PLAID_PRODUCTS,
      country_codes: PLAID_COUNTRY_CODES,
      language: "en",
    });
    res.json(CreatePlaidLinkTokenResponse.parse({ linkToken: resp.data.link_token }));
  } catch (err) {
    const safe = safePlaidError(err);
    req.log.error({ plaidError: safe }, "Plaid link-token failed");
    res.status(500).json({ error: safe.message });
  }
});

router.post("/plaid/exchange-public-token", async (req, res): Promise<void> => {
  const parsed = ExchangePlaidPublicTokenBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (!isPlaidConfigured()) {
    res.status(503).json({ error: "Plaid is not configured." });
    return;
  }
  try {
    const client = getPlaidClient();
    const exchange = await client.itemPublicTokenExchange({
      public_token: parsed.data.publicToken,
    });
    const accessToken = exchange.data.access_token;
    const itemId = exchange.data.item_id;

    // Pull initial institution + accounts metadata.
    const itemResp = await client.itemGet({ access_token: accessToken });
    const institutionId = itemResp.data.item.institution_id ?? null;
    let institutionName: string | null = null;
    if (institutionId) {
      try {
        const inst = await client.institutionsGetById({
          institution_id: institutionId,
          country_codes: PLAID_COUNTRY_CODES,
        });
        institutionName = inst.data.institution.name;
      } catch (err) {
        req.log.warn({ plaidError: safePlaidError(err) }, "institutionsGetById failed");
      }
    }
    const accountsResp = await client.accountsGet({ access_token: accessToken });
    const accountsMeta = buildAccountsMeta(accountsResp.data.accounts);

    const [row] = await db
      .insert(plaidItems)
      .values({
        itemId,
        accessToken,
        institutionId,
        institutionName,
        accountsMeta,
      } as never)
      .onConflictDoUpdate({
        target: plaidItems.itemId,
        set: { accessToken, institutionId, institutionName, accountsMeta },
      })
      .returning();

    if (!row) {
      res.status(500).json({ error: "Failed to save Plaid item" });
      return;
    }

    // Immediately pull balances across all linked items so the dashboard
    // updates on first link (aggregates across institutions).
    try {
      await refreshAllItems();
    } catch (err) {
      req.log.error({ plaidError: safePlaidError(err) }, "Initial balance refresh failed");
    }

    res.status(201).json(serializeItem(row));
  } catch (err) {
    const safe = safePlaidError(err);
    req.log.error({ plaidError: safe }, "Plaid exchange failed");
    res.status(500).json({ error: safe.message });
  }
});

router.get("/plaid/items", async (_req, res): Promise<void> => {
  const rows = await db.select().from(plaidItems).orderBy(desc(plaidItems.createdAt));
  res.json(GetPlaidItemsResponse.parse(rows.map(serializeItem)));
});

router.post("/plaid/refresh", async (req, res): Promise<void> => {
  if (!isPlaidConfigured()) {
    res.status(503).json({ error: "Plaid is not configured." });
    return;
  }
  try {
    const result = await refreshAllItems();
    res.json(RefreshPlaidBalancesResponse.parse(result));
  } catch (err) {
    const safe = safePlaidError(err);
    req.log.error({ plaidError: safe }, "Plaid refresh failed");
    res.status(500).json({ error: safe.message });
  }
});

router.delete("/plaid/items/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params["id"] ?? "", 10);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [item] = await db.select().from(plaidItems).where(eq(plaidItems.id, id));
  if (!item) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (isPlaidConfigured()) {
    try {
      await getPlaidClient().itemRemove({ access_token: item.accessToken });
    } catch (err) {
      req.log.warn(
        { plaidError: safePlaidError(err) },
        "Plaid itemRemove failed; deleting locally anyway",
      );
    }
  }
  await db.delete(plaidItems).where(eq(plaidItems.id, id));
  res.sendStatus(204);
});

export default router;
