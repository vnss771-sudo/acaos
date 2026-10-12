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

## E2 — ABN verification of the sender (implemented)
`POST /api/workspaces/:id/compliance/abn` (admin) checks the ABN checksum locally, then calls the ABR
JSON service (`lib/abnLookup.ts`, GET, breaker `abr-lookup`). Only an **Active** ABN is stored on
`Workspace.senderAbn*` and printed as an `ABN xx xxx xxx xxx` footer line (`verifiedAbn`); a cancelled
ABN clears any stored one. The `ABR_GUID` secret travels as `guid=` and is scrubbed from all errors,
logs and diagnostics. Not yet done: verifying *prospect* entities, and a Settings UI field.
**Unverified assumption:** the ABR JSON field names (`Abn`, `AbnStatus`, `EntityName`,
`EntityTypeName`, `Message`) and JSONP wrapper are coded from ABR's published service and fixtures;
confirm against the live service with a real GUID (use ABR's documented test ABNs) before enabling.

## E5 — weekly discovery smoke check (implemented)
`.github/workflows/discovery-smoke.yml`: Sundays 21:17 UTC + manual dispatch; AusTender only (no key,
no secrets); on failure opens/comments a single tracking issue (`issues: write` on that job only).
