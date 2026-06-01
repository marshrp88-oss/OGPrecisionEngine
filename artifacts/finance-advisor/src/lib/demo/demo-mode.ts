/**
 * Demo Mode — frontend-only interception layer.
 *
 * When active, we monkey-patch the global `window.fetch`. This is the single
 * choke point that catches BOTH request paths in the app:
 *   1. the generated orval hooks (which call customFetch → window.fetch), and
 *   2. the dashboard's raw fetch() calls (discretionary / cash-position /
 *      integrity-summary), which bypass customFetch entirely.
 *
 * Reads are served from an in-memory `DemoStore`. Writes mutate that store and
 * push the new state straight into the React Query cache (setQueryData) +
 * invalidate, so the UI recalculates and re-renders instantly. ZERO requests
 * reach the real API/DB while demo mode is on.
 *
 * The flag is persisted in localStorage only — nothing is written to the
 * assumptions table or any server resource.
 */
import type { QueryClient } from "@tanstack/react-query";
import { buildDemoStore, type DemoStore } from "./demo-dataset";

const FLAG_KEY = "demo_mode_enabled";

let originalFetch: typeof window.fetch | null = null;
let store: DemoStore | null = null;
let qc: QueryClient | null = null;

export function isDemoEnabled(): boolean {
  try {
    return localStorage.getItem(FLAG_KEY) === "true";
  } catch {
    return false;
  }
}

export function setDemoEnabled(on: boolean): void {
  try {
    localStorage.setItem(FLAG_KEY, on ? "true" : "false");
  } catch {
    /* localStorage unavailable — flag simply won't persist */
  }
}

/** True while the fetch interceptor is patched in. */
export function isDemoInstalled(): boolean {
  return originalFetch !== null;
}

export function installDemoFetch(queryClient: QueryClient): void {
  if (originalFetch) return; // idempotent
  qc = queryClient;
  store = buildDemoStore();
  originalFetch = window.fetch.bind(window);
  window.fetch = demoFetch as typeof window.fetch;
}

export function uninstallDemoFetch(): void {
  if (originalFetch) {
    window.fetch = originalFetch;
    originalFetch = null;
  }
  store = null;
  qc = null;
}

// ---------------------------------------------------------------------------
// Collections that support generic CRUD. path → { store array, query key }
// ---------------------------------------------------------------------------
const COLLECTIONS: Record<string, keyof DemoStore> = {
  "/api/bills": "bills",
  "/api/one-time-expenses": "oneTime",
  "/api/variable-spend": "variableSpend",
  "/api/commissions": "commissions",
  "/api/balances": "balances",
  "/api/debt": "debt",
  "/api/wealth/snapshots": "wealthSnapshots",
  "/api/wealth/credit-scores": "creditScores",
  "/api/scenarios": "scenarios",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function pathnameOf(url: string): string {
  try {
    // Resolve against a base so relative paths parse; we only keep pathname.
    return new URL(url, "http://demo.local").pathname.replace(/\/+$/, "") || "/";
  } catch {
    return url.split("?")[0].replace(/\/+$/, "");
  }
}

async function readBody(input: RequestInfo | URL, init?: RequestInit): Promise<any> {
  try {
    if (init?.body && typeof init.body === "string") return JSON.parse(init.body);
    if (input instanceof Request) {
      const text = await input.clone().text();
      return text ? JSON.parse(text) : undefined;
    }
  } catch {
    /* non-JSON body — ignore */
  }
  return undefined;
}

/** After any mutation: write the affected collection into cache + refresh. */
function syncCache(collectionPath: string) {
  if (!qc || !store) return;
  const arrKey = COLLECTIONS[collectionPath];
  if (arrKey) {
    qc.setQueryData([collectionPath], (store as any)[arrKey]);
    qc.invalidateQueries({ queryKey: [collectionPath] });
  }
  // Dashboard cards are static blobs but the lists they cross-reference moved,
  // so nudge every dashboard surface to re-pull from the store.
  for (const k of [
    "/api/dashboard/cycle",
    "/api/dashboard/discretionary",
    "/api/dashboard/cash-position",
    "/api/dashboard/integrity-summary",
    "/api/integrity/status",
    "/api/bills/summary",
    "/api/commissions/summary",
    "dashboard-discretionary",
    "dashboard-integrity",
    "dashboard-cash-position",
  ]) {
    qc.invalidateQueries({ queryKey: [k] });
  }
}

const demoFetch = async (
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> => {
  const rawUrl =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
  const path = pathnameOf(rawUrl);
  const method = (
    init?.method ?? (input instanceof Request ? input.method : "GET")
  ).toUpperCase();

  // Anything outside /api (vite assets, etc.) goes to the real fetch.
  if (!path.startsWith("/api")) {
    return originalFetch!(input as any, init);
  }
  if (!store) return jsonResponse(method === "GET" ? [] : {}, 200);

  const body = await readBody(input, init);
  const result = route(path, method, body);
  if (result === undefined) {
    // Unknown /api route — return a shape-safe empty so no page crashes and
    // nothing escapes to the network.
    return jsonResponse(method === "GET" ? [] : {}, 200);
  }
  return jsonResponse(result, 200);
};

/** Returns the response body, or `undefined` if the route is unhandled. */
function route(path: string, method: string, body: any): unknown {
  const s = store!;

  // --- health ---
  if (path === "/api/health" || path === "/api/healthz") return { status: "ok" };

  // --- static / derived reads (check BEFORE generic collections) ---
  if (method === "GET") {
    switch (path) {
      case "/api/dashboard/cycle": return s.cycle;
      case "/api/dashboard/discretionary": return s.discretionary;
      case "/api/dashboard/cash-position": return s.cashPosition;
      case "/api/dashboard/integrity-summary": return s.integritySummary;
      case "/api/integrity/status": return s.integrityStatus;
      case "/api/commissions/summary": return s.commissionSummary;
      case "/api/bills/summary": return s.billsSummary;
      case "/api/assumptions": return s.assumptions;
      case "/api/retirement": return s.retirement;
      case "/api/plaid/status": return { configured: false, env: "demo" };
      case "/api/plaid/items": return [];
    }
  }

  // --- assumptions are keyed by string key, not numeric id ---
  if (path.startsWith("/api/assumptions/") && (method === "PATCH" || method === "PUT")) {
    const key = decodeURIComponent(path.slice("/api/assumptions/".length));
    const row = s.assumptions.find((a) => a.key === key);
    if (row) {
      row.value = body?.value ?? row.value;
      row.updatedAt = new Date().toISOString();
    } else {
      s.assumptions.push({ key, value: body?.value ?? "", updatedAt: new Date().toISOString() });
    }
    syncCache("/api/assumptions");
    return s.assumptions.find((a) => a.key === key);
  }

  // --- retirement upsert (single resource) ---
  if (path === "/api/retirement" && (method === "PUT" || method === "POST")) {
    s.retirement = { ...s.retirement, ...body, updatedAt: new Date().toISOString() };
    qc?.setQueryData(["/api/retirement"], s.retirement);
    qc?.invalidateQueries({ queryKey: ["/api/retirement"] });
    return s.retirement;
  }

  // --- special bill actions ---
  if (/^\/api\/bills\/\d+\/mark-cleared$/.test(path) && method === "POST") {
    const id = Number(path.split("/")[3]);
    const b = s.bills.find((x) => x.id === id);
    if (b) {
      b.paymentState = "paid";
      b.clearedDate = new Date().toISOString().slice(0, 10);
    }
    syncCache("/api/bills");
    return b ?? {};
  }
  if (path === "/api/variable-spend/mark-quicksilver-paid" && method === "POST") {
    const owed = s.variableSpend.filter((v) => v.quicksilver);
    const settledAmount = owed.reduce((sum, v) => sum + (v.amount || 0), 0);
    owed.forEach((v) => (v.quicksilver = false));
    syncCache("/api/variable-spend");
    return { settledCount: owed.length, settledAmount };
  }
  if (path === "/api/balances/reconcile-suggestions" && method === "POST") {
    return { suggestions: [] };
  }

  // --- generic collection CRUD ---
  for (const base of Object.keys(COLLECTIONS)) {
    if (path !== base && !path.startsWith(base + "/")) continue;
    const arr = s[COLLECTIONS[base]] as any[];
    const idPart = path.startsWith(base + "/") ? path.slice(base.length + 1) : "";
    const id = Number(idPart);

    if (path === base && method === "GET") return arr;

    if (path === base && method === "POST") {
      const row = { id: s._nextId++, ...body };
      arr.push(row);
      syncCache(base);
      return row;
    }
    if (idPart && Number.isFinite(id) && (method === "PATCH" || method === "PUT")) {
      const row = arr.find((x) => x.id === id);
      if (row) Object.assign(row, body);
      syncCache(base);
      return row ?? {};
    }
    if (idPart && Number.isFinite(id) && method === "DELETE") {
      const idx = arr.findIndex((x) => x.id === id);
      const removed = idx >= 0 ? arr.splice(idx, 1)[0] : null;
      syncCache(base);
      return removed ?? {};
    }
    if (idPart && Number.isFinite(id) && method === "GET") {
      return arr.find((x) => x.id === id) ?? {};
    }
  }

  // Anthropic / Plaid writes etc. — swallow safely.
  if (path.startsWith("/api/anthropic")) {
    return method === "GET" ? [] : { id: store!._nextId++, messages: [] };
  }

  return undefined;
}
