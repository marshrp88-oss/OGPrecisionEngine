# PROJECT BRIEF — PERSONAL FINANCE ADVISOR APP

**Owner:** Marshall Roberts-Payne
**Build target:** Replit Agent 4 (Plan mode → Max mode)
**Attachments to upload with this brief:** `OG_Financial_Engine__7_2_.xlsx`, `Claude_Financial_Playbook_v7_3.docx`

---

## 1. WHAT YOU ARE BUILDING

A single-user, AI-powered personal finance application that replaces a mature Excel workbook with a live, methodology-enforced web app. The application is a Progressive Web App (PWA) — installable on phone and desktop, works offline for read-only views, and is hosted on Replit with a Replit-native Postgres database.

The application is not a generic budget tracker. It is a **methodology-enforced cash flow and decision engine for an Account Executive with variable commission income**, with a persistent AI advisor layer that uses the uploaded playbook as permanent context. The advisor is expected to refuse to perform calculations that violate the playbook's rules (e.g., savings calculated at calendar-month boundary instead of paycheck boundary) and to cite the specific rule when it does.

The application must faithfully replicate the Excel workbook's logic cell-for-cell, then extend it with capabilities Excel cannot deliver: real-time bank data sync, push alerts, mobile access, historical trend analysis, predictive forecasting, and a persistent advisor that remembers prior sessions.

---

## 2. USER CONTEXT

- **Role:** Account Executive at Odoo Inc. (SaaS sales)
- **Income:** $54,000 base salary + variable commission (MRR tiered up to 0.65×; NRR tiered up to 0.042×)
- **Pay schedule:** Semi-monthly, 7th and 22nd
- **Commission payout:** 22nd of the month following the sales month
- **Location:** Buffalo, NY (commutes via NFTA — mobile access critical)
- **Tech comfort:** High; fact-checks outputs rigorously; prefers directness over hedging
- **Existing tooling:** 8-sheet Excel workbook (uploaded) with 2 years of iterative refinement; accompanying methodology playbook (uploaded)

---

## 3. CORE METHODOLOGY — NON-NEGOTIABLE BUSINESS RULES

These rules must be encoded as enforced application logic, not optional user preferences. The AI advisor must refuse or reframe requests that violate them.

**3.1 Paycheck-boundary rule.** All savings calculations use the paycheck boundary, never the calendar month-end. Bills due 1st–7th of a month must be reserved from the prior 22nd paycheck because they land before the next income arrives.

**3.2 Commission-as-zero rule.** Baseline savings calculations assume $0 commission income unless there is a confirmed payout with a verified date in the commission table. Projections never pre-count expected commission.

**3.3 Column H AND-gate.** A bill counts against the current cycle's required reserve only if: Include=TRUE, Amount>0, Due Date ≥ today, AND Due Date < next payday. Bills due ON payday are excluded from the prior cycle because the incoming check covers them.

**3.4 Forward reserve exclusion from current cycle.** The forward reserve (bills due 1st–7th of next month plus 7 days of prorated variable spend) is subtracted from the monthly savings calculation but NOT from current-cycle Safe to Spend. These are different questions and must be shown separately.

**3.5 One-time cost gating.** A one-time expense is reserved against the current cycle only when it has both an amount AND a due date between today and next payday. Missing due date = invisible to cycle reserve but still visible to monthly savings estimate.

**3.6 Stale data failure mode.** If the last balance update is more than 3 days old, or the next payday date has already passed, all Dashboard cycle outputs must display a blocking warning. The advisor must refuse cycle analysis until the user updates balance and payday date.

**3.7 Variable spend proration.** Monthly variable cap ÷ 30.4 days = per-day variable budget. For partial periods, multiply by days remaining. This formula is used in both Safe to Spend and Monthly Savings calculations.

**3.8 QuickSilver accrual surfacing.** Credit card variable spending is tracked separately and subtracted from monthly savings estimates, because the cash has been spent even though it has not yet left the checking account.

**3.9 Commission tax rate.** Commission take-home is calculated at 43.5% effective tax rate (not marginal — this reflects FICA + federal + state withholding on supplemental income in NY).

**3.10 YELLOW status threshold.** Safe to Spend below $400 triggers YELLOW status. This threshold is user-configurable and should be recalibrated whenever the largest known irregular expense changes.

---

## 4. TECH STACK

| Layer | Choice | Rationale |
|---|---|---|
| Frontend | Next.js 15 (App Router) + React 19 + TypeScript | Replit-native, PWA support built-in, strongly typed |
| Styling | Tailwind CSS + shadcn/ui | Fast, clean, professional default aesthetic |
| State | Zustand or React Query | Server state caching, avoids prop drilling |
| Backend | Next.js API routes (Node.js) | Same repo, same deploy target |
| Database | PostgreSQL (Replit Postgres) | Native integration, no external hosting |
| ORM | Drizzle ORM | Type-safe, fast, Postgres-native |
| Auth | Replit Auth or NextAuth with email/password | Single user but scaffolded for multi-tenant |
| AI | Anthropic Claude API (claude-opus-4-7 for advisor, claude-haiku-4-5 for background tasks) | Matches the advisor paradigm the user already has |
| Bank sync | Plaid (Phase 2 only) | Standard for US bank integration |
| Charts | Recharts | Works well in React, good default styling |
| Notifications | Web Push API + email (Resend) | PWA-native push, email fallback |
| PWA | next-pwa or Workbox | Installable, offline-capable read views |

**Environment secrets to configure in Replit:**
`ANTHROPIC_API_KEY`, `DATABASE_URL` (auto-provisioned), `PLAID_CLIENT_ID` + `PLAID_SECRET` (Phase 2), `NEXTAUTH_SECRET`, `RESEND_API_KEY` (optional).

---

## 5. DATA MODEL

```
users
  id, email, name, created_at
  // single user to start; foreign keys ready for multi-tenant

assumptions
  user_id, key, value, updated_at
  // key-value store for the 14 parameters from workbook Assumptions sheet
  // e.g., ('base_net_income', 3220), ('variable_spend_cap', 600)

balances
  id, user_id, account_type (enum: checking, hysa, brokerage, 401k, other),
  amount, as_of_date, source (enum: manual, plaid, csv), notes
  // time-series; every balance update is a new row, not an overwrite

bills
  id, user_id, name, amount, due_day, frequency,
  include_in_cycle (boolean), category (enum: essential, discretionary, debt, variable),
  autopay (boolean), last_paid, notes, active_from, active_until
  // active_until supports "prepaid through Jan 2027" scenario (gym membership)

one_time_expenses
  id, user_id, description, amount, due_date, paid (boolean), notes

variable_spend_log
  id, user_id, week_of, amount, category, quicksilver (boolean), notes

commissions
  id, user_id, sales_month, mrr_achieved, nrr_achieved,
  mrr_payout (calculated), nrr_payout (calculated),
  gross_total (calculated), take_home (calculated),
  payout_date (calculated), status (enum: pending, paid, confirmed)

credit_scores
  id, user_id, as_of_date, experian, equifax, transunion, notes

debt
  id, user_id, name, balance, interest_rate, loan_type,
  minimum_payment, status, notes
  // student loans, car loan history, etc.

decision_scenarios
  id, user_id, name, type (enum: vehicle, housing, investment, other),
  inputs_json, outputs_json, created_at, saved (boolean)

chat_sessions
  id, user_id, created_at, last_message_at, title (auto-generated)

chat_messages
  id, session_id, role (user/assistant), content,
  tool_calls_json, tool_results_json, created_at

session_integrity_log
  id, user_id, run_at, checks_json (10 checks), status (pass/fail), notes

playbook_versions
  id, version, content (markdown), effective_from, notes
  // the methodology playbook lives in the DB; editable by user; versioned
```

---

## 6. MODULES

### 6.1 Cycle Dashboard (home screen)

**Purpose:** Primary decision interface. Answers "how much can I spend right now without breaking future obligations?"

**Inputs:**
- Checking balance (manual or Plaid)
- Last balance update timestamp
- Next payday date (auto-advances after payday, user can override)
- Bills with due dates within cycle window
- One-time expenses with due dates within cycle window

**Computed outputs (must match workbook Dashboard exactly):**
- Bills Due Before Next Payday (sum of qualifying bills)
- Total Required Hold (bills + buffers + one-time due this cycle)
- Safe to Spend (checking − total required hold, clamped ≥ 0)
- Daily Rate (Safe to Spend ÷ days until payday)
- Days of Coverage Remaining
- Variable Spend Until Payday (user input)
- Remaining Discretionary (Safe to Spend − variable spend estimate)
- Status (RED if ≤ $0, YELLOW if < threshold, GREEN otherwise)
- Payday Risk flag (if payday falls on weekend)
- Forward Reserve (advisory, shown separately — not subtracted from Safe to Spend)

**UI requirements:**
- Single screen, mobile-first
- Status badge visible at the top (color-coded)
- Stale data banner at top if balance > 3 days old
- Tap-to-expand sections for underlying math
- One-tap "update balance" shortcut prominent
- Widget for variable spend logging (replaces B44:B48)

### 6.2 Bills Engine

**Purpose:** Autopay tracking, cycle gating, optimization suggestions.

**Features:**
- CRUD on bills table
- Include toggle (primary on/off switch — Column F logic)
- Auto-calculated Next Due Date (EDATE rollover)
- Column H AND-gate displayed clearly for each bill
- Visual timeline of upcoming bills (next 30 days)
- Autopay vs manual distinction with "manual payment risk" flag
- Category breakdown (essential vs discretionary vs debt)
- Subscription audit (all Discretionary-category bills, annualized)
- Bills-to-income ratio health score
- Prepaid bill support (e.g., gym through Jan 2027) — bills have active_from/active_until dates and are automatically excluded during prepaid periods without requiring user to toggle

### 6.3 Commissions

**Purpose:** Odoo-specific commission calculator with historical tracking and drought detection.

**Features:**
- Monthly commission entry (MRR, NRR)
- Tiered payout calculation (encoded from workbook formulas)
- Take-home after 43.5% tax
- Payout date auto-calculated (22nd of following month)
- Last 3 months average take-home
- Commission drought flag (< $50 threshold across recent history)
- YTD commission take-home
- Pipeline layer (Phase 2): opportunities with probability-weighted expected commission
- Feeds confirmed payouts to Dashboard on the payout date

### 6.4 Decision Sandbox

**Purpose:** Scenario modeling for significant purchases or life events.

**Pre-built scenario templates:**
- Vehicle purchase (PMT, total cost, HYSA impact, new savings floor)
- Large purchase (generic, with loan/no-loan toggle)
- Income change scenario (raise, new job offer)
- Commission drought survival (liquid runway at $0 commission)
- Income replacement floor (minimum base salary to maintain savings)

**For each scenario:**
- Inputs with sensible defaults pulled from current data
- Outputs: monthly cost, new Safe to Spend, new daily rate, runway, affordability verdict
- Save/load named scenarios
- Compare up to 4 options side-by-side

### 6.5 Wealth Management

**Purpose:** Monthly net worth tracking, HYSA gap, credit scores, brokerage policy.

**Features:**
- Monthly snapshot table (HYSA, brokerage, 401k, other, liabilities)
- Net worth trend chart (last 12 months + projection)
- HYSA gap tracker (target from assumptions, current from most recent snapshot, months-to-close)
- Savings rate tracker (monthly savings / monthly gross)
- Credit score tracking (3 bureaus, spread, lowest bureau, review cadence)
- Brokerage policy statement (read-only; self-managed per user)
- FV projection to age 35, 40, 45, 65

**Critical:** Brokerage is self-managed. App does not recommend allocations. Advisor is instructed to decline portfolio advice and redirect to the user's own strategy.

### 6.6 Debt Strategy

**Purpose:** Loan analysis and invest-vs-pay verdict.

**Features:**
- Per-loan entry (balance, rate, term, status)
- Standard repayment calculation
- Accelerated scenarios (3yr, 5yr, 7yr payoff)
- Interest savings comparison
- Break-even verdict: FV of investing the difference vs interest saved from aggressive paydown
- Flag when actual rate crosses break-even threshold

### 6.7 Retirement Planning

**Purpose:** 401(k) optimization with match gap detection.

**Features:**
- Contribution rate vs match cap comparison
- Match gap dollar amount (uncaptured employer match)
- Cost to close gap (take-home impact)
- FV projection at current contribution, match cap, and 10% contribution
- $1M target calculator (required contribution rate)
- Roth vs traditional decision helper (basic — tax bracket + age inputs)

### 6.8 AI Advisor (core differentiator)

**Purpose:** The methodology-enforced conversational advisor that uses the playbook as permanent context and live user data as tool-accessible context.

**System prompt construction:**
- Full playbook (Sections 1-6, permanent) loaded at session start
- Current snapshot of user's assumptions, balances, active bills, recent commissions, upcoming one-time expenses
- Role instruction: "Act as a dedicated financial engineer and senior advisor. Apply Section 2 methodology to every calculation without exception."
- Refusal instructions: list of behaviors the advisor must not do (Section 6.3 of playbook)

**Tool layer (functions the advisor can call):**
- `get_current_cycle_state()` — returns Safe to Spend, Status, days to payday, required hold
- `get_bills(filters)` — returns bill list with cycle-counting status
- `get_balance_history(account, range)` — time series
- `get_commission_history(months)` — recent commissions
- `run_scenario(type, inputs)` — executes a Decision Sandbox scenario
- `get_assumptions()` — returns all parameter values
- `update_assumption(key, value)` — with user confirmation
- `log_variable_spend(week, amount, category, quicksilver)` — adds to variable spend log
- `flag_stale_data()` — returns last balance update age and payday freshness
- `run_session_integrity_check()` — returns status of all 10 checks

**UI:**
- Persistent chat interface, accessible from every screen
- Streaming responses
- Tool call visualization (user sees when advisor is pulling data)
- Session history sidebar
- New session starts with session integrity check run automatically
- Advisor refuses to proceed if session integrity fails, and says so

**Model choice:**
- Default: Claude Opus 4.7 for advisor conversations
- Fallback to Claude Haiku 4.5 for background tasks (e.g., auto-titling chat sessions, summarizing long histories)

### 6.9 Session Integrity

**Purpose:** Automated version of the workbook's Assumptions D20:D29 checks.

**Features:**
- 10 checks run automatically at session start
- Each check has a pass/fail status and detail message
- Any failure blocks cycle analysis and prompts user to investigate
- Overall status displayed on Dashboard header
- Log of check runs stored for debugging

### 6.10 Data Ingestion

**Phase 1:**
- Manual entry for all data
- CSV import for bills, commissions, historical balances
- Excel workbook import (one-time migration from `OG_Financial_Engine__7_2_.xlsx`)

**Phase 2:**
- Plaid Link integration for checking + HYSA auto-sync
- Daily scheduled balance refresh
- Transaction categorization (auto-categorizes into variable spend buckets)
- Still allows manual override on any synced value

---

## 7. AI ADVISOR DESIGN DETAIL

The advisor is the spine of the application's differentiation. These specifics matter:

**Context loading sequence on every new conversation:**
1. Playbook markdown (permanent reference)
2. User profile (name, role, income structure)
3. Current financial snapshot (balances, assumptions, active bills)
4. Recent activity (last 30 days of variable spend, last 3 commission entries, last 5 one-time expenses)
5. Session integrity check results

**Persistence across sessions:** Chat history is stored and searchable. The advisor can reference prior conversations when relevant, but treats each session as a fresh analytical context (the methodology is permanent; the numbers are live; the conversation is historical).

**Refusal behaviors (must be enforced in system prompt):**
- Refuses to calculate savings at calendar month-end; reframes to paycheck boundary
- Refuses to include expected commission in baseline calculations; uses base-pay floor
- Refuses to run cycle analysis on stale data (> 3 days); prompts for balance update first
- Refuses to give portfolio allocation advice; redirects to user's brokerage policy
- Refuses to recommend aggressive debt paydown without confirmed loan interest rate

**Proactive behaviors:**
- Flags when the YELLOW threshold is likely stale (e.g., after a known irregular expense is paid)
- Flags when bills haven't been reviewed in > 90 days
- Flags when commission has been $0 for 2+ consecutive months
- Flags when HYSA has been above or below target by >15% for > 30 days
- Flags approaching deadlines on one-time expenses

---

## 8. PHASED ROLLOUT

**Phase 1 — Core Application (target: 1–2 weeks to functional)**

- Auth (single user)
- Database schema
- Assumptions management UI
- Bills CRUD + Column H logic
- Cycle Dashboard with all computed outputs
- Manual balance entry
- One-time expense tracker
- Variable spend logger
- AI Advisor with playbook context and 4 core tools (get_current_cycle_state, get_bills, get_balance_history, get_assumptions)
- Session Integrity module
- Stale data warnings
- PWA manifest + service worker
- Import from existing Excel workbook (one-time migration)

**Phase 2 — Full Workbook Parity + Plaid (target: 2–3 weeks after Phase 1)**

- Commissions module (calculator + history + drought flag)
- Decision Sandbox (all scenario templates)
- Wealth Management (monthly snapshots, HYSA gap, credit scores, projections)
- Debt Strategy module
- Retirement Planning module
- Extended AI Advisor tools (scenarios, history, pipeline)
- Plaid integration for checking + HYSA
- Email notifications

**Phase 3 — Intelligence Layer (target: ongoing)**

- Commission pipeline with probability-weighted forecasting
- Cash flow projection (3-cycle rolling forecast)
- Automated anomaly detection (unusual spend patterns)
- Calendar integration (bill due dates → Google Calendar)
- Push notifications for threshold breaches
- Monthly auto-generated financial review document (PDF)
- Historical analytics (year-over-year comparisons, spending trends)
- Tax planning module (quarterly estimate tracking)

---

## 9. SUCCESS CRITERIA

The application is considered successful when:

1. **Fidelity.** Safe to Spend, Status, Forward Reserve, and Monthly Savings match the Excel workbook to the penny for identical inputs.
2. **Advisor discipline.** The advisor refuses methodology violations in at least 95% of cases when prompted to break the rules. Test this explicitly.
3. **Stale data protection.** Cycle outputs are never shown as authoritative when balance data is > 3 days old.
4. **Mobile usability.** A full cycle analysis can be performed on a phone during a 20-minute commute without opening the desktop.
5. **Session start time.** From app open to current Safe to Spend displayed: under 2 seconds on LTE.
6. **Methodology citation.** The advisor cites specific playbook sections when explaining decisions (e.g., "per Section 2.1 Forward-Reserve Rule").
7. **Migration completeness.** All historical data from the Excel workbook (balances, commissions, credit scores, bills) is importable in one session without data loss.

---

## 10. OPEN DECISIONS FOR AGENT TO CONFIRM BEFORE BUILDING

These are items where Replit Agent should pause and confirm with the user before proceeding:

1. **Project name.** Default suggestion: "Ledger" or "Reserve" or user-provided.
2. **Auth flow.** Email/password, magic link, or Replit Auth. Single user for now.
3. **Playbook storage.** Store the playbook content inline in the DB (editable via UI) or as a flat markdown file in the repo. Recommendation: DB-stored with version history.
4. **Claude model routing.** Confirm budget expectations; default to Opus 4.7 for advisor, Haiku 4.5 for background tasks.
5. **Deployment target.** Replit Autoscale Deployment (recommended for PWA) vs Reserved VM (overkill for single user).

---

## 11. HOW TO RUN THIS IN REPLIT AGENT 4

1. Open Replit and create a new project with Agent.
2. Upload `OG_Financial_Engine__7_2_.xlsx` and `Claude_Financial_Playbook_v7_3.docx` as attachments to the initial message.
3. Paste this entire brief as the initial prompt.
4. Enable **Plan mode**. Agent will generate a task breakdown. Review it, revise anything that looks wrong, accept the plan.
5. Switch to **Max mode** (Pro plan required for Max) or **Autonomous Power** mode if Max is unavailable. Enable App testing and Code optimizations.
6. Run Phase 1 first. Test the cycle dashboard with current numbers before moving to Phase 2.
7. Iterate. For targeted changes (visual tweaks, small bugs), use **Lite mode** — it's faster and cheaper.

**Critical first test after Phase 1 build completes:** Reproduce the current workbook's Dashboard outputs. Enter the same balance ($1,947 if not yet updated, or current balance), same next payday, same bills, same assumptions. Safe to Spend should equal what Excel shows. If it doesn't match, do not proceed to Phase 2 until the discrepancy is found and fixed.
