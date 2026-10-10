// Test support for UQ-40. Send-pipeline tests that exercise freshly generated
// (unreviewed) drafts must run as an autonomy-ready workspace, exactly as
// production would require: operator switch on, a current opt-in, and the
// quality/reputation bars met (relaxed to zero-history here).
import { AUTONOMY_CONSENT_VERSION } from '../../packages/backend-core/src/lib/autonomyReadiness.ts'

export function enableAutonomyEnv(): void {
  process.env.AUTONOMOUS_OUTREACH_MODE = 'active'
  process.env.AUTONOMY_MIN_REVIEWED_DRAFTS = '0'
  process.env.AUTONOMY_MIN_SENDS = '0'
}

export const autonomyOptIn = () => ({ autonomyOptInAt: new Date(), autonomyConsentVersion: AUTONOMY_CONSENT_VERSION })

/** Fake-Prisma reads assessAutonomy makes, for a clean, history-free workspace. */
export const autonomyReads = {
  outreachDraftGroupBy: async () => [],
  contactEventCount: async () => 0,
  unsubscribeEventCount: async () => 0,
}
