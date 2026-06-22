# Runbook: IMAP auth / mailbox-sync failure

**Severity:** SEV3 (single workspace) / SEV2 (all syncs failing).

`sync-mailbox` ingests replies and bounces. The worker schedules an auto-sync
**every 10 minutes** (`auto-imap-sync`), which scans every
`WorkspaceEmailConfig` with an `imapHost` set and calls `syncMailboxOnce` per
workspace; an auto-sync **catches per-workspace errors and continues** (one bad
mailbox doesn't fail the batch). A targeted (non-auto) sync for one workspace
surfaces its error. Config falls back to env (`IMAP_HOST`, `IMAP_PORT`,
`IMAP_USER`, `IMAP_PASS`, `IMAP_SECURE`, `IMAP_SOCKET_TIMEOUT_MS`). Gated by
`FEATURE_MAILBOX_SYNC`.

## Symptoms
- Logs: `Auto-sync failed for <workspaceId>: <error>` (auth, connection, TLS, or
  timeout) while other workspaces sync fine.
- `worker_jobs_total{queue="sync-mailbox",result="failed"}` up (or the job
  completes with low `synced/total`).
- Replies not appearing in the Inbox; bounces not suppressing addresses
  (downstream: bounce-driven suppression stops — see `high-bounce-rate.md`).

## Impact
- Reply tracking and bounce detection stop for the affected mailbox(es). Leads
  that replied won't advance to `REPLIED`; bounced addresses won't be added to
  the suppression list, risking continued sends to dead addresses.

## Immediate mitigation
1. Determine scope from logs: one `workspaceId` (SEV3) or all of them (SEV2 —
   platform IMAP/Redis/worker issue).
2. **Single workspace:** the credentials likely expired/changed (password
   rotated, app-password revoked, OAuth lapsed, or provider now requires an
   app-specific password). Ask the customer to re-enter mailbox credentials in
   settings (re-encrypts into `WorkspaceEmailConfig`). Their other flows are
   unaffected.
3. **All workspaces:** check the env IMAP creds, `EMAIL_ENCRYPTION_KEY`
   (a wrong/rotated key fails to decrypt every stored config — see
   `KEY_ROTATION.md`), worker health, and Redis (`redis-outage.md`).
4. If sync is erroring noisily platform-wide and you need quiet to investigate,
   set `FEATURE_MAILBOX_SYNC=false` (env, no restart); re-enable after the fix.

## Diagnosis steps
- Read the per-workspace error string: auth failure vs. connection/TLS vs.
  timeout (`IMAP_SOCKET_TIMEOUT_MS`).
- If decryption is failing for all configs, suspect `EMAIL_ENCRYPTION_KEY`
  rotation without re-encryption.
- Confirm the provider didn't disable basic-auth/IMAP or require an app password.

## Rollback steps
- Revert any change to `EMAIL_ENCRYPTION_KEY`, IMAP env defaults, or the mail
  service code.
- No data rollback — sync is read-only ingestion; a missed run is recovered by
  the next 10-minute auto-sync once creds are fixed.

## Customer communication
- Single workspace: "We couldn't connect to your mailbox — please re-enter your
  email credentials in Settings to resume reply tracking."
- Platform-wide: "Inbox sync was briefly delayed; replies are being ingested now."

## Prevention follow-up
- Alert on `sync-mailbox` failure ratio; surface a per-workspace "mailbox
  disconnected" indicator in the UI so customers self-heal.
- Document the provider-specific app-password requirements in onboarding.
- Tie `EMAIL_ENCRYPTION_KEY` rotation to a re-encryption step (see
  `KEY_ROTATION.md`).
</content>
