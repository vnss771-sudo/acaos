# Runbook: Follow-ups are not sending

**Severity:** SEV3 (sequences delayed; one-off sends unaffected).

The automatic follow-up sender is **opt-in and dormant by default**. Alerts:
`FollowupBacklogGrowing`, `FollowupTasksStuck`.

## Symptoms
- `acaos_followup_due_unsent` growing; `send-followup` logs `skipped:
  FOLLOWUPS_ENABLED off` or `FEATURE_SEND disabled`.
- Tasks stuck `SCHEDULED` (never dispatched) or `PROCESSING` (claimed, not finishing).

## Diagnose
1. `GET /api/admin/status` → `followupsEnabled` + `send-followup` queue depth.
2. `acaos_followup_tasks{status}` breakdown.
3. Confirm the `followup-due-scan` scheduler is registered/running (worker logs).

## Remediate
- Enable: `FOLLOWUPS_ENABLED=true` **and** per-campaign `autoFollowupsEnabled`;
  `FEATURE_SEND` must be on. Tune cadence with `FOLLOWUP_SCAN_INTERVAL_MS`.
- Stuck `PROCESSING` after a deploy/crash: relate to stale-SENDING recovery
  (`STALE_SENDING_RECOVERY_MINUTES`); reset tasks to `SCHEDULED` if needed.
- Deferred tasks (parked back to `SCHEDULED` with reason DOMAIN_PACED / MONTHLY_CAP
  / OUTSIDE_SEND_WINDOW) are expected — they retry when capacity/window reopens.
