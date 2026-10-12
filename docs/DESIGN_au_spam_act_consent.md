# D2 — Spam Act 2003 consent enforcement (design + status)

**Status: implemented, DISABLED, awaiting independent legal review. Not enabled anywhere.**

## Rules encoded (`lib/auConsent.ts`, pure)
- `legitimate_interest`, `express_consent`, `implied_consent` never satisfy the Australian gate.
- `express`: needs `evidenceAt` (not future) and documentation (`evidenceUrl` or ≥10-char `evidenceExcerpt`).
- `inferred_conspicuous_publication`: needs ALL of `evidenceUrl` (http/https), `evidenceAt`,
  `addressType` (role|personal), `optOutStatementAbsent === true`, `roleRelevant === true`.
  Publication alone is never enough. Missing/unknown ⇒ not qualifying (fail closed).

## Enforcement points
| Path | Behaviour |
|---|---|
| `authorizeOutboundSend` (campaign, follow-up) | `targetsAustralia` ∧ ¬`AU_COMMERCIAL_SENDING_ENABLED` ⇒ `AU_SENDING_DISABLED` (before the batch fast-path and independent of `COMPLIANCE_GATE_ENABLED`); flag on ⇒ per-recipient `hasAuConsent` else `AU_CONSENT_REQUIRED` |
| `sendCampaignBatch` | batch denied when disabled; per-lead `bulkCheckAuConsent` (fail-closed on empty page); audited `consent.enforcement.skipped` reason `targets_australia` |
| `sendFollowupTask` | via `authorizeOutboundSend`; task BLOCKED with the code; same audit |
| human replies (`inbox`) | unchanged (hard suppression only) |
| consent API | AU bases accepted only with valid evidence (400 otherwise, nothing stored); `evidenceHash` computed server-side |
| imports | cannot mint AU bases (`CONSENT_BASES` unchanged) |
| readiness | `auCommercialSending` check, not ready while disabled |
| erasure | evidence columns live on `ConsentRecord` (cascade-deleted with the workspace); covered by `tests-db/workspace-deletion.test.ts` |

## Jurisdiction
`Workspace.targetsAustralia` (default **false**, explicit opt-in) — there is no country field to
infer from, and defaulting existing workspaces to AU would change current behaviour. Decision for
rollout: who sets it and whether existing Australian-trading workspaces are backfilled (see PR).

## Migration
`20261012090000_au_consent_evidence`: one NOT NULL DEFAULT false column on Workspace and seven
nullable columns on ConsentRecord. Additive, no backfill, no locks beyond a brief ALTER.
Rollback: drop the columns (no data other than new evidence is lost).

## Needs legal review before enabling
Consent evidence rules and thresholds, role-address vs personal-address treatment, evidence
retention period, whether `express` evidence excerpts are sufficient, sender-identification
and unsubscribe copy for AU, and whether replies/transactional mail need separate treatment.
