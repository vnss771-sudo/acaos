# ACAOS Changelog

## Unreleased

### Uptime check and quieter startup (6 Oct 2026)
- New `.github/workflows/uptime.yml` runs the deploy smoke check against the live API and web every
  15 minutes and fails, emailing the repo owner, when either is down after one retry.
- The API's startup migrations no longer print npm's "new version available" notice, which the
  platform logged as an error on every start.

### Live test follow-ups (6 Oct 2026)
- The API answers CORS preflights with a 10-minute max age, so browsers stop repeating the OPTIONS
  request before each call to the same address. They were 98 of 201 requests in the live test.
- Today reads the network opt-in from new `GET /api/commercial-opportunities/network-participation`
  instead of probing the benchmarks, which answered 403 to every workspace that hadn't opted in.
- Find work with automatic searching off disables Search now, and the empty list no longer says
  "We search on a schedule".
- Billing describes the plans as `POSITIONING.md` does: Contractor is "For most trade businesses",
  not "AI-powered email research for agencies".
- The verification and password-reset emails carry a plain-text part.
- The monitoring uptime probes target the live Railway hosts and require HTTPS.
- `Dockerfile.web` drops `--ignore-optional`, an unknown npm flag that never omitted anything, and
  `.env.example` drops the unused `VITE_STRIPE_PRICE_*`.

### Fixes from the live test (4 Oct 2026)
- Today counts Find work. Accepted Find work quotes add to Won through ACAOS ("from Find work"), all
  quotes count toward Quote → win, and quotes awaiting a decision show beside the pipeline. Before,
  a contractor who quoted and won through Find work saw $0 and "0 quoted".
- Page reloads no longer use up login attempts. `/api/auth/refresh` has its own per-IP limit
  (120 per 15 minutes, 30 while Redis is degraded) instead of sharing login's 10.
- Upgrade and the billing portal answer a Stripe failure with a 503 "Billing is temporarily
  unavailable" instead of "Internal server error".
- No email goes out with a localhost unsubscribe link. In production, a worker without `API_URL`
  refuses the campaign batch and blocks follow-ups (`API_URL_NOT_CONFIGURED`).
- The worker refuses to start in production when `DATABASE_URL` isn't a `postgresql://` URL, and its
  `/ready` also checks the database. Job failures log at warn (will retry) or error (retries spent)
  instead of info.
- The page base styles moved from an inline `<style>` in `index.html` to `src/base.css`. The production
  CSP blocked the inline block, leaving a white 8px frame and browser-default fonts.
- Docker-built services report their real commit: the Dockerfiles' `unknown` placeholder no longer
  hides `RAILWAY_GIT_COMMIT_SHA`.

### Microsoft 365 sending through Graph
- Microsoft 365 mailboxes connected by sign-in now send through Microsoft Graph instead of SMTP, so
  they can send even where the tenant has SMTP AUTH turned off (the default under security defaults).
- The full MIME message is sent, keeping List-Unsubscribe, threading headers and the Message-ID used for
  reply matching.
- Sign-in now also asks for Graph `Mail.Send`. Mailboxes connected earlier keep sending over SMTP until
  they are reconnected.
- SMTP is tried only when Graph certainly didn't send (no consent yet, 401, 403 or 429). A `5.7.139` SMTP failure tells the user to
  reconnect.
- Kill switch: `MICROSOFT_SEND_VIA_GRAPH`

### Reply classification corrections that count
- The Inbox 👎 now asks which label the reply should have had. Previously the verdict was only written
  to the audit log, and nothing read it back.
- A correction is applied:
  - The automation's stage change is undone in favour of the person's label, so a reply wrongly sorted
    as "not interested" revives its lead. This only happens if nothing else has moved the lead since.
  - The scoring outcome is corrected, so the learning loop stops training on the wrong label.
  - Marking it right afterwards restores the AI label.
- Verdicts are stored on the reply (`replyFeedback`, `replyIntentCorrected`; additive migration), and
  the Inbox shows the corrected label.
- New `GET /api/inbox/classification-accuracy` and an Inbox panel (`lib/classificationAccuracy.ts`):
  - Accuracy from reviewed replies, withheld below 5 with the reason.
  - The labels it gets wrong most often.
  - When confident "not interested" calls keep being overturned, a suggested
    `REPLY_CLASSIFICATION_MIN_CONFIDENCE`, together with how many correct ones would then also wait
    for a person.

### Sensitive-data guard on outbound email
- A deterministic scan (`lib/sensitiveData.ts`) stops ACAOS from sending payment card numbers (valid
  issuer prefix plus Luhn check), secret API or private keys (fixed provider prefixes, PEM headers),
  passwords, or tax file numbers (TFN checksum next to "TFN"). It is tuned so invoice and job numbers,
  phone numbers, ABNs and BSB/account details for payment are left alone.
- Where it applies:
  - AI drafts that pick one up go to POLICY_REVIEW instead of DRAFTED.
  - Approving such a draft is refused (422).
  - A campaign never sends one, even if already approved or edited: it is skipped as `SENSITIVE_DATA`
    and the draft is held for review.
  - A follow-up step carrying one is BLOCKED.
  - An Inbox reply carrying one is refused (422) before anything is sent or recorded.
- Stored inbound enquiry excerpts use the same redaction, now covering keys, passwords and TFNs as well
  as card numbers

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
