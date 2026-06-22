# Runbook: Reputation guard is blocking sends

**Severity:** SEV2 platform-wide (multiple workspaces) / SEV3 single workspace.

The sender-reputation circuit breaker (`lib/senderReputation.ts`) reads the
ContactEvent ledger and, when `REPUTATION_GUARD_MODE=enforce`, halts a workspace's
sends if its trailing bounce/complaint rate is over threshold. In `observe` (the
default) it only logs. Alert: `ReputationEnforceBlocking`.

## Symptoms
- `send-campaign` / `send-followup` logs: `reputation BOUNCE_RATE_HIGH … mode=enforce`.
- `acaos_reputation_enforce_blocks_total` rising; campaigns report
  `skippedByReason.REPUTATION_BLOCKED`.
- A customer reports their sends suddenly stopped.

## Diagnose
1. `GET /api/stats/reputation?workspaceId=<id>` → `guardMode`, `healthy`,
   `bounceRate`, `complaintRate`, `totalSends`, `reason`, `thresholds`.
2. `GET /api/admin/status` → confirm the global `reputationGuardMode`.

## Remediate
- If the block is **correct** (real high bounces): fix deliverability first —
  see [`high-bounce-rate.md`](high-bounce-rate.md). Don't just disable the guard.
- To stop blocking while investigating: set `REPUTATION_GUARD_MODE=observe` (still
  logs, doesn't block). Takes effect on the next job (no deploy).
- Tune thresholds if mis-calibrated: `REPUTATION_MAX_BOUNCE_RATE`,
  `REPUTATION_MAX_COMPLAINT_RATE`, `REPUTATION_WINDOW_DAYS`, `REPUTATION_MIN_SENDS`.

## Escalate
SEV2 if blocking is platform-wide or a paying customer is hard-down; otherwise SEV3.
