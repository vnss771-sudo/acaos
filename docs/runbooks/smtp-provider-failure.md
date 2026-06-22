# Runbook: SMTP provider failure

**Severity:** SEV2 (no outreach can be delivered).

Outbound email goes through `sendMail` (`packages/backend-core/src/services/
mail.js`), using per-workspace SMTP config (`WorkspaceEmailConfig`) and falling
back to env (`SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`,
`SMTP_FROM`). `send-campaign` uses a **claim-first outbox**: it inserts an
`OutreachSent` row as `SENDING` (atomic, unique `(campaignId, leadId)`, reserving
the daily-cap slot) **before** calling SMTP. On a known SMTP rejection it marks
the row `FAILED` (with `lastError`/`failedAt`) — **never auto-resent**. Dunning
mail and verification mail also use `sendMail`.

## Symptoms
- `send-campaign` jobs complete but `result.failed` is high;
  `[send-campaign] SMTP failed for lead ...` in logs.
- Many `OutreachSent` rows flipping to `FAILED` with a clustered `lastError`
  (auth, connection refused, timeout, 5xx from the relay).
- Leads stay at their pre-send stage (not advanced to `OUTREACH_SENT`).

## Impact
- Outreach not delivered. No duplicate or partial sends — the outbox is atomic
  and fail-closed. Verification/dunning emails may also fail.

## Immediate mitigation
1. Confirm SMTP health: from a worker shell, test connectivity to `SMTP_HOST:
   SMTP_PORT`; check the provider's status page and the account (suspended? over
   quota? IP blocked?).
2. If the provider is hard-down and retries would only pile up `FAILED` rows,
   **pause sending** with `FEATURE_SEND=false` (env, no restart). The send worker
   then skips cleanly instead of marking rows `FAILED`.
3. If it's a credential/config problem (auth failure, wrong host/port/secure),
   fix `SMTP_*` env or the workspace's `WorkspaceEmailConfig` and re-enable.
4. Mind the daily cap: `FAILED` rows do **not** consume a send slot for the day
   the way `SENT`/`SENDING` do? — they were inserted as `SENDING` then flipped to
   `FAILED`; only `SENT`/`SENDING` count toward `effectiveDailySendLimit`. Clear
   stale `FAILED` rows only when deliberately retrying (see below).

## Diagnosis steps
- Read `OutreachSent.lastError` for the clustered failure reason (auth vs.
  greylisting vs. reputation block vs. timeout).
- Check whether it's one workspace (its `WorkspaceEmailConfig`) or platform-wide
  (env SMTP). Per-workspace failures are SEV3.
- Confirm DNS/SPF/DKIM/DMARC weren't recently changed (a relay may reject on
  alignment failure — overlaps with `high-bounce-rate.md`).

## Rollback steps
- Revert any deploy or config change to SMTP credentials, host/port, or the
  mailer.
- **Retrying failed sends is deliberate, not automatic.** To re-send leads that
  hit a now-fixed transient SMTP error, delete their `FAILED` `OutreachSent` rows
  (operators may clear `FAILED` rows to deliberately retry) and re-run the
  campaign — the lead becomes eligible again. Do NOT delete `SENT` rows.

## Customer communication
- "Email delivery was paused due to a mail-provider issue; queued outreach will
  send once restored. No duplicate emails were sent." Notify affected workspace
  owners if delivery was paused for hours.

## Prevention follow-up
- Alert on `send-campaign` `failed` ratio and on `OutreachSent` `FAILED` growth.
- Add SMTP connection health to monitoring; consider a backup relay.
- Verify SPF/DKIM/DMARC and warm-up posture before raising send volume.
</content>
