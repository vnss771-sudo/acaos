# `targetsAustralia` rollout report

**Status:** analysis only. **No workspace has been changed** and none will be changed automatically.

## What the flag does (as deployed)
`Workspace.targetsAustralia` defaults to **false**. When true: campaign/follow-up sends from that workspace are
denied `AU_SENDING_DISABLED` while `AU_COMMERCIAL_SENDING_ENABLED` is off (default), and once on require per-recipient
qualifying evidence (`AU_CONSENT_REQUIRED`). Workspaces with the flag **false behave exactly as before** (no AU gate).

## The key finding
Because the default is false, **every existing workspace — including ones that email Australian recipients today —
is outside the D2 gate.** D2 protects only workspaces that opt in. That was a deliberate trade-off (no country field
exists; defaulting everyone to AU would have halted all sending), but it means the Spam Act protection is currently
**opt-in, not enforced**. The pilot must therefore flag every pilot workspace explicitly.

## Production numbers
Not collected: I have no production database access. Run the read-only report yourself:

```
DATABASE_URL=<prod, read-only role> NODE_OPTIONS=--conditions=acaos-src node scripts/report-au-rollout.mjs --days=90
```
It prints aggregate counts and workspace **IDs only** (no addresses, names or content): total / flagged workspaces,
messages in the window, how many went to `.au` recipients, and which **unflagged** workspaces send to `.au` recipients
(the exposure list). `.au` is a heuristic; Spam Act s7 "Australian link" is broader.

## Options for existing workspaces
| Option | Effect | Risk |
|---|---|---|
| A. Leave as is (default) | No behaviour change | Unflagged AU senders stay un-gated; relies on customer attestation/AUP only |
| B. Flag the exposure-list workspaces | Those workspaces stop sending until AU sending is enabled **and** each recipient has evidence | Customers lose sending immediately; needs comms and support |
| C. Flag all workspaces | Blocks all sending platform-wide until legal approval | Highest disruption; only sensible if no customer is live |
| D. Add a recipient-based gate (future code): treat `.au` recipients as AU regardless of the flag | Closes the gap without per-workspace flipping | Heuristic false positives/negatives; behaviour change for existing senders — needs product decision + tests |

**Recommendation:** (1) run the report; (2) for the **pilot**, flag the pilot workspace(s) (Option B scoped to pilot) *before* any
real send, so the pilot proves the evidence workflow; (3) decide A vs B vs D for non-pilot workspaces after legal review of
`docs/legal/au-spam-act-review-package.md`. Never bulk-update without an explicit approval, a DB backup, and a notice to affected customers.

## If/when approved: backfill procedure (not run)
1. Export the exposure list from the report; owner approves the list in writing.
2. Notify affected customers (sending will pause until evidence is recorded).
3. Per workspace, a customer admin enables targeting in Settings → Compliance → Australia (audited as `compliance.updated`), **or**
   an operator runs a reviewed, transactional `UPDATE "Workspace" SET "targetsAustralia" = true WHERE id IN (...)` with the row count checked before COMMIT.
4. Rollback = set the column back to false for the same IDs; no data is lost.

## Not changed by this PR
`AU_COMMERCIAL_SENDING_ENABLED` (off), any production data, any flag.
