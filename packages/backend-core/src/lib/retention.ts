// Automated data-retention enforcement.
//
// Implements the scheduled purge of the "Manual" rows in docs/DATA_RETENTION.md
// so the documented windows are actually enforced rather than aspirational. Each
// class is deleted by a single bounded `deleteMany` on an indexed time column;
// the function is workspace-agnostic (it sweeps the whole platform) and returns
// per-class counts for observability. It is pure DB work — no Redis, no queue —
// so it is callable from the worker's repeatable scheduler AND directly unit-
// testable against a real database.
//
// Every window is overridable by env (days) so operators can tighten/loosen a
// class without a code change; the defaults match the policy doc exactly.

import { prisma } from './prisma.js'

const DAY_MS = 24 * 60 * 60 * 1000

/** Read a positive integer day-count from env, falling back to `def`. */
function days(envVar: string, def: number): number {
  const raw = process.env[envVar]
  if (!raw) return def
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : def
}

export type RetentionWindows = {
  processedEmailDays: number
  outreachSentDays: number
  discoveryRunDays: number
  auditEventDays: number
  analyticsEventDays: number
  stripeEventDays: number
  /** Expired/used/revoked auth tokens are purged this long after creation. */
  authTokenDays: number
}

/** The default windows, mirroring docs/DATA_RETENTION.md, env-overridable. */
export function retentionWindows(): RetentionWindows {
  return {
    processedEmailDays: days('RETENTION_PROCESSED_EMAIL_DAYS', 90),
    outreachSentDays: days('RETENTION_OUTREACH_SENT_DAYS', 548), // 18 months
    discoveryRunDays: days('RETENTION_DISCOVERY_RUN_DAYS', 365), // 12 months
    auditEventDays: days('RETENTION_AUDIT_EVENT_DAYS', 730),     // 24 months
    analyticsEventDays: days('RETENTION_ANALYTICS_EVENT_DAYS', 365), // 12 months (cohort analysis)
    stripeEventDays: days('RETENTION_STRIPE_EVENT_DAYS', 365),   // 12 months
    authTokenDays: days('RETENTION_AUTH_TOKEN_DAYS', 30),
  }
}

export type PurgeCounts = {
  processedEmail: number
  outreachSent: number
  discoveryRun: number
  auditEvent: number
  analyticsEvent: number
  processedStripeEvent: number
  refreshToken: number
  emailVerificationToken: number
  passwordResetToken: number
}

/**
 * Delete every data class that is past its retention window. Idempotent and safe
 * to run repeatedly: rows already inside their window are untouched. Returns the
 * number of rows removed per class.
 *
 * `now` is injectable so tests can assert window boundaries deterministically.
 */
export async function purgeExpiredData(
  windows: RetentionWindows = retentionWindows(),
  now: Date = new Date(),
): Promise<PurgeCounts> {
  const before = (d: number) => new Date(now.getTime() - d * DAY_MS)

  // Auth tokens: only purge once they're spent (expired, used, or revoked) AND
  // older than the grace window — never delete a live, usable token.
  const authCutoff = before(windows.authTokenDays)

  const [
    processedEmail,
    outreachSent,
    discoveryRun,
    auditEvent,
    analyticsEvent,
    processedStripeEvent,
    refreshToken,
    emailVerificationToken,
    passwordResetToken,
  ] = await Promise.all([
    prisma.processedEmail.deleteMany({ where: { processedAt: { lt: before(windows.processedEmailDays) } } }),
    prisma.outreachSent.deleteMany({ where: { sentAt: { lt: before(windows.outreachSentDays) } } }),
    prisma.discoveryRun.deleteMany({ where: { startedAt: { lt: before(windows.discoveryRunDays) } } }),
    prisma.auditEvent.deleteMany({ where: { createdAt: { lt: before(windows.auditEventDays) } } }),
    prisma.analyticsEvent.deleteMany({ where: { occurredAt: { lt: before(windows.analyticsEventDays) } } }),
    prisma.processedStripeEvent.deleteMany({ where: { processedAt: { lt: before(windows.stripeEventDays) } } }),
    prisma.refreshToken.deleteMany({
      where: { createdAt: { lt: authCutoff }, OR: [{ expiresAt: { lt: now } }, { revokedAt: { not: null } }] },
    }),
    prisma.emailVerificationToken.deleteMany({
      where: { createdAt: { lt: authCutoff }, OR: [{ expiresAt: { lt: now } }, { usedAt: { not: null } }] },
    }),
    prisma.passwordResetToken.deleteMany({
      where: { createdAt: { lt: authCutoff }, OR: [{ expiresAt: { lt: now } }, { usedAt: { not: null } }] },
    }),
  ])

  return {
    processedEmail: processedEmail.count,
    outreachSent: outreachSent.count,
    discoveryRun: discoveryRun.count,
    auditEvent: auditEvent.count,
    analyticsEvent: analyticsEvent.count,
    processedStripeEvent: processedStripeEvent.count,
    refreshToken: refreshToken.count,
    emailVerificationToken: emailVerificationToken.count,
    passwordResetToken: passwordResetToken.count,
  }
}
