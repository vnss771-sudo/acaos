# Runbook: Stuck campaign send / stuck `SENDING` rows

**Severity:** SEV2.

`send-campaign` uses a **claim-first, fail-closed outbox** (in
`apps/worker/src/processors.ts::sendCampaignBatch`). For each lead, in one
advisory-locked transaction it reserves the daily-cap slot and inserts an
`OutreachSent` row with `status: 'SENDING'` (unique `(campaignId, leadId)`)
**before** generating copy or calling SMTP. On SMTP success it flips the row to
`SENT` (+ advances the lead, writes the contact-ledger event) in one transaction.
On a known SMTP rejection it flips to `FAILED`. **A crash AFTER the provider
accepted the message but BEFORE we recorded `SENT` leaves the row `SENDING`.**

### Core invariant: we NEVER auto-resend
A `SENDING` or `FAILED` row is treated as "already handled" and excluded from
future send selection. This is intentional: re-sending risks double-emailing a
prospect (worse than a missed send). The send job has `attempts:2`, but a retry
re-claims via the unique constraint and **skips** rows it already owns — it does
not re-deliver `SENDING`/`FAILED` leads.

## Symptoms
- `OutreachSent` rows in `status='SENDING'` older than a few minutes (a healthy
  send flips to `SENT`/`FAILED` within seconds).
- A `send-campaign` job that ran during a worker crash/OOM/redeploy (SIGTERM
  mid-batch); a `forced-exit-after-timeout` worker lifecycle event around then.
- Lead stuck at its pre-send stage despite an outbox row existing.

## Impact
- Ambiguous delivery for the stuck rows: the email **may or may not** have been
  delivered. The lead won't be re-selected (fail-closed), and a `SENDING` row
  counts toward the daily cap (`SENT`+`SENDING`), so it also consumes a slot.

## Immediate mitigation
1. Quantify: count `SENDING` rows older than ~15 min, grouped by workspace/
   campaign. A small handful from one crash is expected; a large/growing count
   means the worker is wedged or crash-looping — check worker `/ready`, logs, and
   `redis-outage.md` / `postgres-connection-exhaustion.md` first.
2. Stabilize the worker (it should restart cleanly via graceful shutdown; the
   10s watchdog force-exits a wedged close).
3. **Do not blindly resend.** Decide per row whether it was delivered (next step).

## Diagnosis steps
- For each stuck `SENDING` row, check `messageId` (only set on the `SENT`
  transaction — a `SENDING` row won't have one) and, where possible, the SMTP
  provider's logs / sent folder for that recipient + timestamp to determine if
  the message actually went out.
- Cross-check the contact ledger (`ContactEvent`) — a `SENT` event is written in
  the same transaction as the `SENT` flip, so its absence corroborates "not
  recorded as sent."
- Correlate the stuck rows' `createdAt` with a worker crash/deploy.

## Rollback / resolution steps
- **If you can confirm the email was delivered:** flip the row to `SENT`
  (set `sentAt`, ideally `messageId`) and advance the lead — do NOT resend.
- **If you can confirm it was NOT delivered and you want to retry:** delete the
  `SENDING` row (frees its cap slot and makes the lead eligible) and re-run the
  campaign. Equivalent handling for `FAILED` rows operators choose to retry.
- **If delivery is genuinely ambiguous:** prefer NOT resending (avoid
  double-contact); mark `FAILED` for the record and move on, or contact the
  prospect through a deliberate one-off if it matters.
- Roll back any deploy that changed the send transaction / outbox logic.

## Customer communication
- Internal/ops only in most cases. If a customer's campaign shows "in progress"
  rows that never completed, explain they were halted safely (no duplicates sent)
  and were resolved manually.

## Prevention follow-up
- Alert on `OutreachSent` rows in `SENDING` older than 15 minutes.
- Ensure graceful-shutdown drains in-flight `send-campaign` jobs before exit
  (worker `shutdown()` awaits `sendCampaignWorker.close()`); tune the platform's
  SIGTERM grace period above a single lead's send time.
- Consider a periodic janitor that reports (does not auto-resend) long-`SENDING`
  rows for operator review.
</content>
