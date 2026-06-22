# Runbook: Stripe webhook failure

**Severity:** SEV2.

The webhook (`POST /api/billing/webhook`, handler in
`apps/api/src/routes/billing.ts`) is the source of truth for subscription state.
It: verifies the Stripe signature (`constructWebhookEvent`), then **claims the
event id** by inserting a `ProcessedStripeEvent` row (idempotency — Stripe is
at-least-once), then processes it, then 2xx. If processing throws, it **deletes
the claim** so Stripe's redelivery is reprocessed (not skipped as a duplicate).
The raw body is mounted as `express.raw` in `server.ts` before `express.json`.
Stripe-facing calls are wrapped by the `stripe` circuit breaker.

## Symptoms
- Stripe Dashboard → Developers → Webhooks shows failing deliveries / retries.
- `AuditEvent` rows: `billing.webhook.verification_failed` (signature) or
  `billing.webhook.processing_failed` (handler threw).
- `http_requests_total{route="/api/billing/webhook",status=~"4..|5.."}` elevated.
- Plan/subscription drift reports: customer paid but workspace not `active`, or
  vice versa.

## Impact
- Subscription state (`Workspace.subscriptionStatus`, `.plan`) lags reality:
  paid customers not upgraded, cancellations/past-due not reflected, dunning
  email on `invoice.payment_failed` not sent. Plan-limit enforcement is wrong
  until reconciled. No customer-facing outage.

## Immediate mitigation
- **Signature failures (`verification_failed`):** almost always a wrong
  `STRIPE_WEBHOOK_SECRET` (rotated, or wrong endpoint's secret), or a proxy
  mutating the raw body. Set the correct secret; confirm the raw-body mount
  precedes `express.json`. Do NOT log the signature/secret.
- **Processing failures (`processing_failed`):** the claim is auto-released, so
  Stripe will retry — first restore whatever the handler needs (usually Postgres;
  see `postgres-connection-exhaustion.md`). Once healthy, use Stripe Dashboard →
  "Resend" for failed events, or wait for automatic retries.
- **Backlog of missed events:** replay from the Stripe Dashboard. Idempotency
  makes replays safe (a duplicate event id returns `{received:true,duplicate:true}`).

## Diagnosis steps
- Read the `AuditEvent` `metadata.reason` (safe error text only) and the
  `eventType`.
- Confirm the running endpoint URL matches the Stripe webhook config and the
  secret matches that endpoint.
- For a specific customer, compare `Workspace.subscriptionStatus`/`plan`/
  `stripeSubscriptionId` against the Stripe subscription. Note: an **unrecognized
  price id never downgrades** a customer — the handler preserves the existing
  plan and logs a warning, so a missing `STRIPE_PRICE_*` env can leave a paying
  customer on the wrong tier without an error.

## Rollback steps
- If a deploy changed the webhook route, the raw-body middleware order, or the
  `STRIPE_PRICE_STARTER`/`STRIPE_PRICE_GROWTH` env mapping, roll it back.
- To reconcile a single drifted workspace, fix `subscriptionStatus`/`plan`
  directly from Stripe truth (admin path), then resend the relevant event to
  confirm the handler now applies it.

## Customer communication
- Affected customer only: "We had a brief delay syncing your subscription; it's
  corrected now." Apologize for any incorrect "past due" notice.

## Prevention follow-up
- Alert on any `billing.webhook.processing_failed` and on Stripe's delivery
  failure rate.
- Verify all `STRIPE_PRICE_*` envs are set in prod (a missing one silently keeps
  the old plan tier).
- Periodic reconciliation job comparing Stripe subscriptions to `Workspace` rows.
</content>
