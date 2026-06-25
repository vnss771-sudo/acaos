# Sub-processor disclosure

> Version: **2026-06-24** · Keep in sync with `SUBPROCESSORS_VERSION` in
> `packages/backend-core/src/lib/subprocessors.ts` and `GET /api/legal/subprocessors`.
> Factual inventory derived from the codebase; legal approves the customer-facing wording.

ACAOS engages the following sub-processors to provide the service. Each is engaged only
when the corresponding capability is configured/enabled. ACAOS acts as a processor on
behalf of the customer (controller); these are sub-processors under GDPR Art. 28.

| Sub-processor | Purpose | Personal data processed | Engaged when |
|---|---|---|---|
| **OpenAI** | Lead research, outreach generation, reply classification | Business name, contact first name, truncated lead notes, inbound reply bodies | AI features enabled (`FEATURE_AI`) |
| **Stripe** | Subscription billing | Billing email, workspace identifier | Billing configured (`STRIPE_SECRET_KEY`) |
| **Customer's SMTP / IMAP provider** | Sending outreach and reading replies | Recipient email address and message content | Per-workspace email configured |
| **Apollo, Hunter, Google Places** | Prospect discovery and enrichment | Prospect company and contact data | Discovery enabled (`FEATURE_DISCOVERY`) |
| **Sentry** | Error monitoring | Error context (HTTP method, route, identifiers) — never request/email bodies | `SENTRY_DSN` configured |

> The "customer's SMTP/IMAP provider" is chosen and contracted by the customer, not by
> ACAOS; we transmit through the credentials the customer supplies.

**Data minimisation notes (engineering):**
- `lead.notes` is truncated to 500 chars before it reaches OpenAI (`services/openai.ts`).
- Reply bodies sent for classification are capped at 3000 chars.
- Sentry receives method/route/identifiers only — verified no request or email bodies
  (ASVS V8).
- The OpenAI model is allow-listed and tokens are clamped (cost/PII-surface control).

**Change process:** adding/removing/materially changing an entry requires bumping
`SUBPROCESSORS_VERSION`; the product then prompts each workspace to re-acknowledge.
