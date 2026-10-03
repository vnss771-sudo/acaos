# ACAOS Changelog

## Unreleased

### Mailbox sign-in
- Workspaces can connect Gmail / Google Workspace or Outlook / Microsoft 365 by signing in, with no
  app password needed. IMAP sync and SMTP sending are unchanged, apart from authenticating with
  OAuth2 (XOAUTH2). The refresh token is stored encrypted and included in key rotation. A revoked grant
  shows a Reconnect prompt in Settings. Setup guide: `docs/MAILBOX_SIGN_IN.md`

### Inbound enquiries and risk escalation
- Emails that ask for work from someone who isn't a lead and isn't replying to an outreach email
  (previously recorded as "unmatched" and dropped) now appear in Find work as **Emailed you** cards,
  with the sender, a short redacted excerpt and the reasons they were picked up. They follow the same
  Pursue → Quote → Won → Job → Margin loop, and Jobs & margins reports them as "Direct enquiries".
  Automated, bulk and transactional mail is filtered out by its headers, sender and wording.
  Kill switch: `FEATURE_INBOUND_ENQUIRIES`
- Deterministic risk escalation (`lib/riskEscalation.ts`): replies or enquiries that mention legal
  action, a refund or payment dispute, a formal complaint, damage the business caused, or a data breach
  are flagged when the mailbox syncs, before any AI runs. A flagged reply is never marked dead or used
  for scoring, and gets no AI draft (the Inbox shows "Needs you"). A flagged enquiry goes to the top
  of Find work

### Contractor-first
- Positioning, README, pricing and terminology rewritten for trade contractors (`POSITIONING.md`);
  plans shown as Free / Contractor / Contractor Pro (plan keys and Stripe mapping unchanged)
- Navigation follows the loop: Today · Work (Find work, Clients, Jobs & margins) · Crew · Outreach · Settings;
  Today is the landing screen (`/`), the old dashboard is Overview (`/overview`)
- Onboarding asks first: trade contractor (trades + area → Find work) or email outreach
- One flow from found work to margin: accepting a quote keeps the card in view and offers
  "Start the job"; won work waiting to start shows on Today; jobs link to crew rates and shifts
- Demo script (`docs/DEMO_SCRIPT.md`) and a runnable demo seed (`scripts/demo/seed-contractor.mts`)

### Fixes from running the app
- Reloading a page could log the user out: app boot fired a second, concurrent token refresh, which the
  server's refresh-reuse (theft) detection treats as a replay and revokes every session. Boot now shares
  the single-flight refresh, and refreshes are serialised across tabs with the Web Locks API
- Find work's "Active" tab now shows only new + pursued work, matching its count (it also listed won and lost)
- Jobs & margins: a running job shows "% of estimate used" instead of a misleading negative variance;
  the origin line says where the work came from instead of repeating the title; closeout placeholders fit

### Hardening
- Links built from external data (tender feeds, evidence, AI research) only render for http(s) URLs
- Jobs flag shifts logged after closeout instead of silently leaving them out
- End-to-end test of the whole find → quote → job → closeout → report loop, and of the tenant boundary

### Operator console (phase 14)
- New *Today* screen: what needs a decision with its evidence and contact, new work this week,
  work worth watching, and pipeline / won revenue / quote-to-win / delivered margin
- Propose outreach (nothing sends), quote company-level opportunities, and opt in to
  cross-customer benchmarks from the console

### Delivery economics (phase 15A)
- Quotes on Work-discovery and commercial opportunities; accepting one marks the opportunity won
- Delivery jobs linked to Field Ops job sites, with live and frozen (closeout) economics:
  hours vs estimate, labour and gross margin, unknowns reported instead of zeroed
- `/api/delivery/*` (admin only); see `docs/ACQUISITION_OS_DELIVERY.md`

### Delivery economics (phase 15B)
- Record and decide quotes from Find work; new *Jobs & margins* screen with closeout and reopen
- Report of what closed work earns by origin (medians with sample sizes)
- Outcome graph attributes wins and revenue to the exact quoted opportunity

## v1.3.0 — Full Build Pass

### API — New routes
- `GET/POST /api/campaigns` — list and create campaigns per workspace
- `GET/PATCH/DELETE /api/campaigns/:id` — read, update, delete campaigns
- `GET /api/leads` — paginated lead list with workspace/campaign/stage filters
- `POST /api/leads` — create single lead
- `POST /api/leads/import` — bulk import up to 500 leads
- `GET/PATCH/DELETE /api/leads/:id` — read, update stage/AI fields, delete
- `POST /api/billing/webhook` — Stripe webhook with signature verification

### API — Fixes
- Fixed OpenAI model name: `gpt-5.4-mini` → `gpt-4o-mini`
- Fixed OpenAI service: `responses.create` → `chat.completions.create` with `json_object` response format
- Added `userBelongsToWorkspace` helper to workspaces lib

### Worker — Now functional
- `research-lead`: fetches AI summary + outreach angle, writes back to Lead row, advances to RESEARCHED
- `generate-outreach`: generates subject/email/followup copy for a lead
- `analyze-reply`: classifies reply, advances INTERESTED leads to REPLIED stage
- `sync-mailbox`: invokes IMAP sync, logs results per workspace

### Frontend — Full rebuild
- Dashboard with workspace/campaign/lead stat cards
- Campaigns page: list, create, delete
- Leads page: filterable table by stage, paginated, add single lead, detail panel, stage transitions
- AI Tools page: Research / Outreach / Reply tabs with live API calls
- Billing page: Stripe checkout trigger
- Sidebar navigation, JWT auth with logout-on-401
