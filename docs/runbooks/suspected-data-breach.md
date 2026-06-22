# Runbook: Suspected data breach

**Severity:** SEV1. Always. Until proven otherwise.

Treat any suspected unauthorized access, exfiltration, or exposure of customer or
personal data as a SEV1. ACAOS is multi-tenant, so a tenant-isolation failure
(one workspace reading another's data) is in scope, as is exposure of secrets
(`JWT_SECRET`, `EMAIL_ENCRYPTION_KEY`, `STRIPE_*`, provider API keys,
`METRICS_TOKEN`) or stored personal data (lead/prospect contacts, mailbox
credentials in `WorkspaceEmailConfig`, email content).

> **Preserve evidence before you change anything.** Snapshot logs, audit events,
> and DB state first — remediation can destroy the forensic trail.

## Symptoms / triggers
- Anomalous access patterns: a workspace's data appearing under another tenant,
  unexpected admin (`isPlatformAdmin`) actions, mass data reads/exports.
- Leaked credentials (key in a public repo/log, `METRICS_TOKEN` exposed and
  `/metrics` scraped externally).
- A third-party / researcher report, or an alert from a provider (GitHub secret
  scanning, Stripe, OpenAI).
- Auth anomalies: token reuse, unexpected refresh-token activity.

## Impact
- Potential exposure of PII and customer outreach data; legal/regulatory
  notification obligations (GDPR/CCPA) with statutory clocks. Reputation and
  contractual exposure.

## Immediate mitigation
1. **Declare SEV1; engage the incident commander and Founder/DPO immediately** —
   the regulatory notification clock may have started.
2. **Contain.**
   - If a kill switch reduces blast radius (e.g. suspected abuse via the send
     path), use `FEATURE_SEND=false` / `SAFE_LAUNCH_MODE=true`.
   - Revoke/rotate exposed secrets right away: `JWT_SECRET` (invalidates access
     tokens), provider API keys (`OPENAI_API_KEY`, `APOLLO/HUNTER/GOOGLE`,
     `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET`), `METRICS_TOKEN`,
     `EMAIL_ENCRYPTION_KEY` (see `KEY_ROTATION.md` — note this requires
     re-encrypting stored mailbox creds; coordinate carefully).
   - Invalidate sessions / revoke refresh tokens for affected users; force
     re-auth.
   - If a specific account/IP is the actor, block it at the edge.
3. **Preserve evidence:** export relevant `AuditEvent` rows, application logs
   (request-id correlated), Sentry events, and a DB snapshot. Do not delete.

## Diagnosis steps
- Reconstruct the access path from `AuditEvent` and request logs (every request
  carries a request id via `requestContext`). Identify what data, whose, and how
  much.
- Determine the vector: tenant-isolation bug (a query missing `workspaceId`
  scoping — most processors scope by `workspaceId` deliberately), leaked secret,
  compromised account, or dependency vuln.
- Confirm whether `/metrics` was exposed (it requires `METRICS_TOKEN`; in prod a
  missing token returns 404, not data).
- Establish a timeline and the full set of affected workspaces/users/records.

## Rollback / remediation steps
- Patch the vulnerability (e.g. add the missing tenant scope) and deploy; verify
  with a regression test before reopening anything you closed.
- Complete secret rotation and confirm old credentials are dead.
- Do NOT silently purge data to "clean up" — that destroys evidence and may
  itself be a violation. Retention purge (`retention-purge`) is automated and
  bounded; don't run ad-hoc deletes during an active investigation.

## Customer communication
- **Founder/DPO/legal own external comms and timing.** Do not notify customers ad
  hoc.
- Prepare facts: what data, whose, when, for how long, what was done. Meet
  statutory notification deadlines (e.g. GDPR 72h to the supervisory authority
  where applicable).

## Prevention follow-up
- Full written post-mortem; track remediation to closure.
- Add a regression test for the exact vector (tenant-scoping test if isolation
  failed).
- Review secret handling, access logging/alerting, and least-privilege; rotate on
  a schedule (`KEY_ROTATION.md`). Enable provider secret scanning.
</content>
