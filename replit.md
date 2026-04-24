# Reserve — Personal Finance Advisor

## Overview

pnpm workspace monorepo. "Reserve" is a precision personal finance advisor for Marshall Roberts-Payne, an Odoo AE with variable commission income. Reproduces the OG Financial Engine Excel workbook v7.2 methodology to the penny, plus a Claude-powered AI advisor with the Financial Playbook v7.3 as permanent context.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **Frontend**: React + Vite + shadcn/ui + Tailwind CSS + recharts
- **Routing**: wouter
- **API framework**: Express 5 (api-server artifact)
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)
- **AI**: Anthropic Claude (via Replit AI Integration proxy, no user API key needed)

## Artifacts

- `finance-advisor` — React frontend at `/` (9 pages)
- `api-server` — Express API backend
- `mockup-sandbox` — Component preview server

## Frontend Pages

- `/` — Cycle Dashboard (Safe to Spend, status, stale data warning, math accordion)
- `/bills` — Bills Engine (CRUD, Column H AND-gate, include toggles)
- `/commissions` — Commissions (Odoo tiered calculator, drought flag)
- `/sandbox` — Decision Sandbox (4 scenario tabs: vehicle/drought/income floor/income change)
- `/wealth` — Wealth Management (snapshots, net worth chart, credit scores)
- `/debt` — Debt Strategy (payoff analysis, invest-vs-pay verdict)
- `/retirement` — Retirement Planning (FV projections, $1M calculator, match gap flag)
- `/advisor` — AI Advisor (streaming chat, session history, integrity check on session start)
- `/settings` — Settings (12 financial assumptions)

## Key Backend Files

- `artifacts/api-server/src/routes/` — All 15 route files
- `artifacts/api-server/src/lib/financeEngine.ts` — Core computation: Safe to Spend, Forward Reserve, Commission tiers
- `artifacts/api-server/src/lib/seed.ts` — Seeds default data (run once via `tsx`)
- `lib/db/src/schema/` — All Drizzle table schemas
- `lib/api-spec/openapi.yaml` — Full API contract (codegen source)
- `lib/api-client-react/src/generated/api.ts` — Generated React Query hooks
- `lib/api-zod/src/generated/api.ts` — Generated Zod schemas

## Finance Engine Methodology (Non-Negotiable Rules)

1. **Paycheck Boundary** — All cycle calcs use next payday boundary, never calendar month-end
2. **Commission-as-Zero** — Baseline assumes $0 commission unless status="confirmed"
3. **Column H AND-Gate** — Bill counts if: include=TRUE, amount>0, due >= today, due < next payday
4. **Forward Reserve Exclusion (§2.1)** — Forward reserve is in monthly savings AND in Discretionary This Month, but NOT in Safe to Spend. Three engine functions answer three different questions: `safeToSpend()` (current cycle, no reserve, paycheck-bounded), `discretionaryThisMonth()` (end-of-month deployable surplus from checking, subtracts reserve), `monthlySavingsEstimate()` (full-month income/outflow ledger, paycheck boundary, subtracts reserve).
5. **One-Time Cost Gating** — Reserved only when amount + due date between today and next payday
6. **Stale Data Failure** — >3 days since balance update blocks reliable cycle analysis
7. **Variable Spend Proration** — cap ÷ 30.4 × days remaining
8. **QuickSilver Accrual** — Credit card variable spend tracked separately
9. **Commission Tax Rate** — 43.5% effective rate
10. **YELLOW Threshold** — Safe to Spend < $400

## Commission Tiers (Odoo)

MRR: $0-100: 10%, $101-300: 25%, $301-500: 40%, $501-700: 55%, >$700: 65%
NRR: $0-1K: 0.5%, $1K-2K: 1.0%, $2K-4K: 2.0%, $4K-6K: 3.0%, >$6K: 4.2%

## Seed Data (Part B from Brief)

- Checking: $2,140 (intentionally old to show stale data UX)
- HYSA: $12,600 (target: $15,000)
- Brokerage: $36,000
- 401(k): $1,550
- Student loans: $30,000 (not in repayment, rate unknown)
- Jan 2026 commission: $890 MRR → $208.20 take-home
- Feb 2026 commission: $245 MRR → $26.13 take-home
- Credit scores: Experian 756, Equifax 754, TransUnion 736
- 11 bills seeded (Rent $1,125, Car Insurance $182, etc.)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `cd lib/db && pnpm drizzle-kit push` — push DB schema changes
- `node_modules/.bin/tsx artifacts/api-server/src/lib/seed.ts` — reseed default data

## Environment Variables

- `DATABASE_URL` — PostgreSQL connection string (auto-provisioned)
- `SESSION_SECRET` — Session secret (available)
- `AI_INTEGRATIONS_ANTHROPIC_BASE_URL` — Anthropic proxy URL (via Replit integration)
- `AI_INTEGRATIONS_ANTHROPIC_API_KEY` — Anthropic API key (via Replit integration)
