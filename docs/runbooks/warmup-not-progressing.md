# Runbook: Warmup is not progressing

**Severity:** SEV3 (a workspace is throttled lower than expected).

Opt-in domain warmup (`lib/warmup.ts`) ramps the daily cap over `WARMUP_SCHEDULE`
when `WorkspaceICP.warmupStartedAt` is set. Alert: `WarmupStuck`.

## Symptoms
- `acaos_warmup_day` flat / `acaos_warmup_cap` not rising; sends capped low.

## Diagnose
1. Confirm `warmupStartedAt` is set and in the past for the workspace.
2. Compute expected day = floor((now − warmupStartedAt)/24h)+1 vs `WARMUP_SCHEDULE`.
3. The effective cap is `min(effectiveDailySendLimit, warmupDailyCap)` — a low
   `dailySendLimit` or `SAFE_LAUNCH_DAILY_SEND_CAP` may be the binding constraint,
   not warmup.

## Remediate
- Adjust `WARMUP_SCHEDULE`, or clear `warmupStartedAt` to end warmup (full cap),
  or advance it. Changes take effect on the next batch (no deploy).
