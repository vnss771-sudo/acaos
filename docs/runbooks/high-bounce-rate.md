# Runbook: High bounce / complaint rate

**Severity:** SEV2 (sender reputation at risk → deliverability for all customers).

ACAOS detects bounces through `sync-mailbox`: NDR/bounce messages
(`mailer-daemon`/`postmaster`/"delivery status notification" senders/subjects)
are parsed, and — only for addresses that are actually present in `OutreachSent`
(so a stray address in a DSN body can never poison the list) — the recipient is
added to the `Suppression` list (`reason='BOUNCED'`) and the matching
`OutreachSent` row is flipped to `BOUNCED`, with an `email.bounced` audit event.
Suppressed addresses are excluded from future sends (`bulkCheckSuppression` →
`SUPPRESSED` skip in `send-campaign`).

## Symptoms
- Spike in `OutreachSent.status='BOUNCED'` and in `Suppression` rows with
  `reason='BOUNCED'`; many `email.bounced` audit events.
- `sync-mailbox` run logs showing high `bounced` counts.
- SMTP provider/postmaster tools reporting elevated bounce or spam-complaint rate.

## Impact
- Sender reputation degrades, hurting deliverability for **every** workspace on
  the shared sending infrastructure. Sustained high bounce/complaint rates can
  get the sending domain/IP blocklisted.

## Immediate mitigation
1. **Slow down / stop the bleed.** Engage `SAFE_LAUNCH_MODE=true` to clamp every
   workspace's daily send cap to the low ceiling
   (`SAFE_LAUNCH_DAILY_SEND_CAP`, default 20) and force human approval of all
   outbound copy. If the spike is acute, `FEATURE_SEND=false` halts sending
   entirely (both env-only, no restart). See `accidental-over-sending.md`.
2. Identify the source: one workspace blasting a bad/purchased list vs. a
   platform deliverability problem (SPF/DKIM/DMARC, IP warm-up). Per-workspace →
   pause that workspace's mission/campaign (mission `PAUSED`) and tighten its
   daily cap.
3. Confirm the bounce→suppression loop is actually running — if `sync-mailbox`
   is failing (`imap-auth-failure.md`), bounces aren't being suppressed and the
   same dead addresses keep getting hit, amplifying the problem. Fix sync first.

## Diagnosis steps
- Group `BOUNCED` rows by workspace/campaign and by hard vs. soft bounce reason.
- Check whether bounces concentrate on a recently imported/discovered list
  (low-quality source) — discovery import + email validation
  (`isDeliverableEmail`) should pre-filter, but a bad source still slips garbage.
- Verify SPF/DKIM/DMARC alignment and that List-Unsubscribe headers are present
  (the send footer + RFC 8058 headers are added per message).
- Check complaint feedback loops from the mailbox provider.

## Rollback steps
- No data rollback. If a deploy changed the bounce parser, suppression logic, or
  email validation, revert it (a regression there would let dead addresses keep
  receiving sends).

## Customer communication
- To a workspace whose list caused it: explain that sending was throttled/paused
  to protect deliverability and ask them to clean their list / verify consent.
- Platform-wide reputation event: notify all active senders that send rates are
  temporarily reduced while reputation recovers.

## Prevention follow-up
- Alert on `Suppression` `BOUNCED` growth rate and `OutreachSent` `BOUNCED` ratio
  per workspace.
- Enforce list quality at import (validation, consent attestation); keep
  `SAFE_LAUNCH_MODE` on for new/unproven workspaces.
- Per-workspace bounce-rate circuit: auto-pause a campaign past a bounce
  threshold (follow-up feature).
</content>
