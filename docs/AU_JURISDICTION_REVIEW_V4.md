# Phase 1 v4 — Australian jurisdiction review (design and safe inventory)

## Status
The repository currently has `Workspace.targetsAustralia` (Boolean, default `false`). That value is **not** a complete country or Spam Act applicability classification. No legal conclusion can be inferred from it being false. `AU_JURISDICTION_REVIEW_REQUIRED=true` from Phase 1 v3 stops non-flagged campaign/follow-up sending, but would also stop legitimately non-Australian tenants. **Do not enable it globally without a workspace impact review.**

## Operator inventory (read only)
Run against an approved, least-privilege database connection:

```sh
DATABASE_URL='[database connection from approved secret store]' node scripts/report-au-rollout.mjs --days=90 --json
```

The report scans records in 500-row keyset pages rather than loading all email addresses at once. It stores only workspace-level counts in memory and prints workspace identifiers and aggregates. It is read-only. Treat even workspace IDs and volume counts as internal operational data. It still queries recipient email addresses and must be run under the organization's normal privacy/security controls. `--days` must be 1–365.

**Limits:** `.au` recipient domains are a heuristic, not a legal definition of an Australian link. Australian recipients can have .com addresses; non-Australian recipients can use .au. This inventory does not establish where the sender is located, where the recipient is ordinarily resident, sender authorization, or exemption eligibility. It is a review queue, not an allowlist or a legal determination. Results are a database snapshot-in-motion and may omit transactions added during scanning.

## Intended state machine (design only; migration NOT included)

- `UNREVIEWED`: no operator-approved determination; new workspaces should begin here.
- `AU_IN_SCOPE`: reviewed as potentially covered by Australian commercial-message rules; enforce applicable reviewed AU controls.
- `OUT_OF_SCOPE`: reviewed and documented as not in scope for the AU-specific gate; other suppression and jurisdiction rules still apply.
- `REVIEW_EXPIRED`: must be reviewed again after material changes in sender/recipient geography or business operation.

Store review evidence separately from self-service profile fields: reviewer identity, basis/rationale, review time, policy version, expiration or reassessment trigger, and append-only audit event. A workspace admin may submit evidence or request review, but must **not** self-certify `OUT_OF_SCOPE` to bypass sending restrictions. A privileged operator workflow, separate from ordinary workspace administrator privileges, should own transition decisions. A legal reviewer must approve applicability criteria and retention rules before this state machine is implemented or the rollout activated.

## Safe rollout sequence
1. Obtain legal review of applicability factors and definitions. Document who may make operator decisions.
2. Run the read-only inventory and map existing workspaces to reviewed states without altering records. Include workspaces with no sends in the inventory.
3. Estimate impact of fail-closed mode on non-Australian workspaces; create a remediation plan for each affected tenant.
4. Implement the new persisted state and operator-only transition API in a separate migration/PR after policy approval. Preserve existing `targetsAustralia=true` as AU-restricted, regardless of any disagreement in newer fields, pending review.
5. Stage migrations and manual review with outbound sending disabled. Test API, batch, follow-up, queued/retry dispatch, background workers, tenancy boundaries, and race conditions.
6. Verify an approved correction process for mistakes; record all changes and never silently downgrade an AU-restricted workspace.
7. Roll out behind a separately reviewed feature flag with staged checks and instant rollback/kill switch. Do not automatically enable `AU_COMMERCIAL_SENDING_ENABLED`.

## Other production gates
- Independent Spam Act legal review remains outstanding.
- D1 secret incident runbook requires authorized production investigation/rotation decision.
- Verify production flags, ABR live integration and actual SMTP behavior separately.
- Neither this report nor this design authorizes live outbound sending or modifies customer data.
