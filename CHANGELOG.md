
## 2026-10-08 — UQ-06 security/send failure-path E2E
- Added real API/Postgres Playwright negative journeys for workspace and recipient suppression, reputation enforcement, safe-launch approval, tenant non-disclosure, refresh-session revocation, and SMTP SSRF/provider safety.
- E2E safety environment now explicitly enables SAFE_LAUNCH and reputation enforcement.
# ACAOS Changelog

## Unreleased

### Frontend error reporting
- The web app reports uncaught errors, unhandled promise rejections and React render errors to Sentry when `VITE_SENTRY_DSN` is set at build time. It uses no SDK, which matches the API and worker. It reports each distinct error once per page load, and at most 20 per page. Page URLs are sent without query strings or fragments.

### Release identity on Railway
- API and worker images built without build args (every Railway deploy) now report the root `package.json` version, e.g. `1.3.0+f803c36a0fa5`, instead of `0.0.0-dev`. The Dockerfiles defaulted `ACAOS_RELEASE_VERSION` to `0.0.0-dev`, which overrode the package version. It now defaults to the `unknown` placeholder that release metadata already ignores. An explicit `ACAOS_RELEASE_VERSION` still takes precedence.

### Verification record and dependency audit (10 Oct 2026)
- Recorded a full run of every test tier on Node 26 (unit, web, database, Redis and browser E2E with the tenant guard enforcing) in [`docs/VERIFICATION_2026-10-10.md`](docs/VERIFICATION_2026-10-10.md).
- Bumped dev-only `source-map-js` 1.2.1 → 1.2.2 (GHSA-68fv-2mgg-jv7q). `npm audit` now reports 0 vulnerabilities.
- Recorded the live deployment's integration status: Stripe's live key is rejected, Sentry is not configured, discovery works, and AI and mailbox have no production use yet. The record also lists the operator actions.

### Job variations (10 Oct 2026)
- Jobs & margins can record scope changes on a running job: what changed, the price change (negative for a reduction), and optional estimated cost and hours. Each variation goes draft → submitted → approved or rejected, and every step is audited.
- The accepted quote is never rewritten. Approved variations give an **adjusted contract** value. Revenue is compared against both the original quote and the adjusted contract.
- Estimated variation cost stays an estimate; actual margins still use the costs recorded at closeout.
- A closed job must be reopened before its variations change.

### Operator diagnostics per workspace (10 Oct 2026)
- Admin → Workspaces has a **Diagnose** action: a read-only view of one workspace's sending (last 24h by status, sends stuck in SENDING, reputation, automatic-sending posture), billing entitlement, mailbox posture (OAuth needing reconnection, reply sync, domain health), follow-ups, discovery source errors, the last week's failure events and the API release.
- `GET /api/admin/workspaces/:id/diagnostics` is platform-admin only and every view is audited. It never returns message content, recipients, credentials, tokens or audit metadata.

### Automatic outreach needs an explicit, earned go-ahead (10 Oct 2026)
- Turning off approval mode no longer, on its own, lets unreviewed drafts send. Outside safe-launch it used to; now automatic sending also needs `AUTONOMOUS_OUTREACH_MODE=active` (default off), sending on, the workspace not suppressed, a current versioned opt-in by an admin (step-up, audited), healthy sender reputation on its minimum sample, at least 20 human-reviewed drafts, a 90%+ approval rate and at most 5% of drafts held for policy review. If any one fails, drafts wait for approval.
- The worker and the campaign readiness/launch API share the same decision, so the UI never promises an automatic send the worker would hold.
- Settings → Deliverability shows the posture, the metrics and every blocker, with opt-in/opt-out for admins.
- The controlled-pilot preflight fails if `AUTONOMOUS_OUTREACH_MODE` is set to anything but `off`.

### Calibration proposals must beat the current weights on unseen outcomes (10 Oct 2026)
- Event-kind weight proposals are now tested before they can be accepted. The newest 30% of closed outcomes are held back, weights are fitted on the older ones only, and both the live and the candidate weights are scored on the held-back outcomes (Brier error and ranking AUC).
- Only an `IMPROVED` verdict can be approved; `NO_IMPROVEMENT`, `DEGRADED` and `INSUFFICIENT` (under 20 dated outcomes) return 409. Pending proposals made before this change are refused and regenerated with a verdict at the next learning run.
- The Learning Centre shows the verdict, the holdout size and both deltas, and disables Accept unless the proposal improved.

### Repeat jobs per site and phone-friendly Field Ops (9 Oct 2026)
- A site can now host more than one job. Each shift records the job its hours are costed to, so a second project at the same site keeps its own hours, margin, late-shift flags and closeout. Existing shifts were attributed to their site's one job by the migration.
- Shifts at a site with a single open job are attributed automatically. Where a site has several, clock-in and manual entry ask which job, and the API returns 409 until one is chosen.
- An accepted quote can start a new job at an existing site (`opsJobSiteId` on `POST /api/delivery/quotes/:id/job`). The pilot scorecard now follows opportunity → quote → job.
- On phones, Shifts, Sites and Crew show cards instead of sideways-scrolling tables; Clock In/Out is full width; closeout and reopen forms stack into one column with larger buttons.

### Billing grace and network benchmark privacy (9 Oct 2026)
- A single failed payment no longer drops a paying workspace to Free limits. `past_due` keeps the purchased plan for a 7-day grace window, set by the first failure and never extended by retries; after that, Free limits apply. `trialing` now counts as active.
- Stripe webhooks that arrive out of order are acknowledged but not applied when they are older than the newest event already applied, so a late failure can't undo a recovery.
- Checkout is refused for any live subscription (including `past_due`); the Billing page shows the grace deadline or the lapsed state and points to Manage Subscription.
- Cross-customer benchmarks now publish at 10+ contributing workspaces and 50+ closed outcomes (was 5 / 30), and the read API returns count bands and rates rounded to 5 points, with a rate withheld unless both sides have 5+ observations. Exact pooled counts stay server-side.

### AI provider compatibility and pilot preflight (8 Oct 2026)
- Fixed the default GPT-5 reasoning request so reasoning models no longer receive `temperature`; they keep `max_completion_tokens` and the supported reasoning setting, while standard chat models retain `temperature: 0.4` + `max_tokens`.
- Added a centralized model compatibility registry (`modelProfiles.ts`) so sampling/token/reasoning behaviour cannot drift across helpers.
- Added final-wire regression tests that capture the actual OpenAI SDK request for `gpt-5-mini`, `gpt-5-nano`, `o4-mini`, and `gpt-4o-mini`.
- Outreach provenance now records the parameters actually sent: reasoning models store `temperature = null` plus token-parameter/reasoning metadata, and the prompt hash changes with the effective request profile.
- Added `npm run smoke:ai-provider` for a real-provider release smoke covering research, outreach, and reply analysis, with model, latency, and provider token counts.
- Corrected AI-cost documentation: estimated per-action spend is used both for billing observability and the enforced monthly AI spend ceiling.

### Find work: AusTender sweep unstuck (7 Oct 2026)
- AusTender answers a day with no contract notices (a weekend, a public holiday) with a 400 "No
  Records found" instead of an empty list. The adapter treated it as a failure, so the run failed, the
  cursor never moved past Saturday 26 Sep, and every production sweep since Find work was turned on
  (4 Oct) found nothing. That response now reads as an empty day; any other 400 still fails the run.

### Contractor pilot scorecard (6 Oct 2026)
- New Scorecard tab in the Work hub answers "is ACAOS helping this business find and win worthwhile
  work?" against the pilot targets: work found (3+ a week), quotes from Find work (2+ a week), won
  jobs closed out with an invoice (80%), and a most profitable source. It shows this week, the
  weeks behind it, totals and conversions (found → quoted, quote → won), and each source's won
  value and gross margin, with a plain-language line once margins exist ("You made the most money
  from development applications…").
- Today opens with "This week in Find work" for admins: found, worth pursuing, quoted, won, margin
  and best source.
- `GET /api/delivery/scorecard` (workspace admins) serves it; `GET /api/admin/pilot-scorecards` lists
  every Find work workspace for the platform admin, shown under Admin → Contractor pilots beside the
  outreach activation funnel.
- Unknowns stay unknown: a win without an accepted quote has no amount, and jobs without costs
  entered don't count toward gross margin.

### Tenant guard enforcing (6 Oct 2026)
- The whole test suite ran with `TENANT_GUARD_MODE=enforce`, and five queries it blocked now filter by
  workspace: the onboarding import's top prospects, the pre-send relevance score update, the scoring
  model's outcome count, the scoring weight retune and the prompt quality report.
- Route tests now run inside the tenant context, as the API does, and the database tests call worker
  jobs through the same context wrapper as `worker.ts`. Before, the guard saw none of their queries.
- In enforce mode the guard logs each block before throwing, so a caller that swallows the error
  can't hide it.
- A tenant foreign key counts as scoping only when it pins specific rows (an id, `equals` or `in`).
  `leadId: null` and `{ not: null }` match rows in every workspace.
- CI runs the database, Redis and browser tiers through `scripts/with-tenant-guard.sh`, which
  enforces the guard and fails the job on any `[tenant-guard]` line.

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

## 2026-10-08 — Unicorn Quality UQ-04 tenant resource enforcement

- Added `tenantResourceScope` middleware for resource-ID-only API routes.
- Campaign, mission, lead, prospect, signal and inbox-reply ID routes now derive tenant context from the resource before business handlers execute.
- Foreign-tenant resource IDs return the same 404 as missing IDs at the resource boundary to reduce existence leakage.
- Added a tenant-resource route/lookup drift gate (`npm run check:tenant-resources`) to the main verification chain.
- Added an explicit tenant resource enforcement matrix and middleware regression tests.

## 2026-10-08 — UQ-05 send authorization auditability

- Added append-only allow/deny audit evidence to the centralized outbound acquisition send policy.
- Added `check:send-authorization` to pin reviewed mail call sites and prevent silent provider-send bypasses.
- Documented acquisition versus transactional mail authorization boundaries.

### UQ-07 — Billing, delivery, and recovery failure-path E2E
- Added signed Stripe webhook replay coverage proving first-delivery application plus duplicate acknowledgement without duplicate entitlement mutation.
- Added real delivery-API coverage for quote → acceptance → job creation and duplicate-job refusal.
- Added closeout safety coverage for open shifts, unknown-cost preservation, frozen economics, explicit reopen, and closeout versioning.
- Added real-Postgres stale-SENDING recovery coverage proving stale claims fail closed while recent in-flight sends remain untouched.

## 2026-10-08 — Release Gate A toolchain drift fix

- Fixed GitHub release, post-deploy smoke, uptime, and eval workflows still using Node 22 after the production toolchain moved to Node 26.
- Expanded `check:toolchain` so all workflow-level Node pins are verified, preventing future release/runtime drift.
- Re-ran source-level pilot hardening gates: tenant-resource, send-authorization, workflow pinning, monitoring assets, rollout contract, compose hardening, test-tier isolation, offline Prisma, architecture boundaries, and frontend mutation checks pass.
- Full dependency-backed verification remains pending in a Node 26 environment with installed dependencies and real pilot provider/deployment credentials.

## 2026-10-08 — UQ-09 Passkey/WebAuthn foundation
- Added additive passkey credential and ceremony-challenge persistence.
- Added RP ID/origin/HTTPS configuration validation and single-use challenge helpers.
- Added source/DB tests and `check:passkey-foundation`.
- Passkey ceremonies remain disabled until SimpleWebAuthn packages are installed and locked under the Node 26 toolchain; no hand-rolled verifier was introduced.

## UQ-10 — Worker processor domain split (2026-10-08)
- Split the 1,959-line worker processor catch-all into scoring, outreach, campaign send, follow-up, discovery and reply modules.
- Preserved `worker.ts` queue wiring through a compatibility barrel.
- Added a CI architecture gate to prevent processor-domain collapse and updated send-authorization drift checks for the new module paths.

## 2026-10-08 — UQ-08 strict frontend CSP
- Production `nginx.conf` CSP no longer allows `'unsafe-inline'`: `style-src 'self'`, `style-src-elem 'self'`, `style-src-attr 'none'`.
- No runtime changes were needed: React applies `style={{}}` props through the CSSOM, which CSP does not govern. The earlier CSP-aware JSX runtime approach was dropped (it broke the jsdom test tier, lost inline-style cascade precedence and leaked rules for dynamic values).
- Added `check:csp` to `npm run verify`: fails on a loosened policy, raw style-attribute/`<style>`/`innerHTML` writes in web code, or inline markup in `index.html`.
- Added `e2e/csp-strict.spec.ts`, which serves the production build with `nginx.conf`'s exact headers (`scripts/serve-web-csp.mjs`), proves enforcement with a negative control, visits every hub and tab, and fails on any CSP violation.
