# Runbook: Accidental over-sending

**Severity:** SEV1 (active, runaway sending) / SEV2 (elevated but bounded).

"Over-sending" = emails going out faster, or in larger volume, than intended —
e.g. a misconfigured campaign, a daily cap set too high, an approval gate
bypassed, or a bug. ACAOS has layered controls; this runbook is the emergency
stop and the audit.

### The controls (all in `packages/backend-core/src/lib/launchControls.ts`)
- **`FEATURE_SEND`** — hard kill switch. `false` ⇒ the `send-campaign` worker
  skips every job (`{skipped:true, reason:'FEATURE_SEND disabled'}`) and the API
  send route 503s. This is the **big red button.**
- **`SAFE_LAUNCH_MODE`** — forces human approval of every outbound draft, disables
  auto-send, and **clamps every workspace's daily send cap** down to
  `SAFE_LAUNCH_DAILY_SEND_CAP` (default 20), overriding each workspace's own
  setting.
- **Per-workspace daily cap** (`WorkspaceICP.dailySendLimit`) enforced atomically
  per lead via `reserveDailySendSlot` inside the claim transaction, counting
  `OutreachSent` rows with status `SENT`+`SENDING` since local midnight. The
  effective cap is `effectiveDailySendLimit(workspaceLimit)` (min of the
  workspace cap and the safe ceiling when SAFE_LAUNCH_MODE is on).
- **Mission stop button** — a mission in `PAUSED`/`COMPLETE` halts its campaign's
  sends (re-checked before every lead, so a pause stops mid-batch across pages).

## Symptoms
- `OutreachSent` `SENT` rows for a workspace climbing far faster than expected.
- Customer/recipient complaints; bounce/complaint spike (`high-bounce-rate.md`).
- A campaign launched against far more leads than intended, or with auto-send on
  when it should have required approval.

## Immediate mitigation (in order of blast radius)
1. **Platform-wide emergency stop:** `FEATURE_SEND=false` (env, no restart). All
   sending stops on the next job. Use this first if sending is actively runaway
   and you don't yet know the scope.
2. **Clamp everyone without fully stopping:** `SAFE_LAUNCH_MODE=true` — forces
   approval + caps every workspace to the low ceiling. Good when you want to keep
   small, human-approved sends flowing while you investigate.
3. **Single workspace:** set/lower that workspace's `dailySendLimit`, and/or set
   its mission to `PAUSED` to stop its campaign mid-run.
4. Re-enable progressively once the cause is fixed: workspace cap → safe mode off
   → `FEATURE_SEND=true`.

## Diagnosis steps
- `launchControlsSnapshot()` (or the operator status endpoint) shows the live
  state of every flag/cap — confirm what was actually in effect.
- Count today's `OutreachSent` (`status IN ('SENT','SENDING')`,
  `sentAt >= midnight`) per workspace vs. the intended cap.
- Was approval expected? Check `WorkspaceICP.approvalMode` and whether
  `SAFE_LAUNCH_MODE` was off — if off and approvalMode false, drafts auto-send.
- Check `AuditEvent` / send logs for who launched and against how many leads
  (`sendCampaignJobId` dedups repeated launch clicks within a minute, so repeated
  clicks aren't the cause).

## Rollback steps
- Roll back any deploy or config change that raised a cap, disabled approval, or
  altered `reserveDailySendSlot` / `effectiveDailySendLimit`.
- Already-sent emails cannot be recalled. Stop further sends; for the recipients
  already contacted, add them to `Suppression` if they should not be re-contacted.

## Customer communication
- If a workspace over-sent to its own prospects: notify the workspace owner,
  explain the cause and the cap now in place.
- If recipients were contacted who shouldn't have been: prepare an apology and
  ensure they're suppressed; consider regulatory exposure
  (`suspected-data-breach.md` if any cross-tenant data leaked).

## Prevention follow-up
- Keep `SAFE_LAUNCH_MODE` on for new/unproven workspaces; default conservative
  caps.
- Alert on per-workspace send rate exceeding N× its cap or a sudden absolute
  spike.
- Require explicit confirmation in the UI when launching against large lead sets.
</content>
