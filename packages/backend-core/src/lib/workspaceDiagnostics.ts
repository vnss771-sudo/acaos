// Read-only per-workspace diagnostics for platform operators (UQ-31): enough to
// support a pilot customer without raw database access or impersonation.
//
// Privacy: this never selects message bodies or subjects, recipient addresses,
// SMTP/IMAP passwords, OAuth tokens or mailbox content. Recent failures expose
// only event type, entity identity and time — never audit metadata. Callers run
// it inside the workspace's tenant context; every query is workspace-scoped.
import { prisma } from './prisma.js'
import { billingEntitlement } from './billingEntitlements.js'
import { staleSendRecoveryMinutes } from './staleSends.js'
import { assessAutonomy } from './autonomyReadiness.js'
import { evaluateSenderReputation } from './senderReputation.js'

const DAY_MS = 86_400_000
/** Audit-event type fragments that indicate something went wrong. */
const FAILURE_MARKERS = ['fail', 'error', 'block', 'deny', 'denied', 'reject', 'suppress']
const clip = (s: string | null | undefined, n = 200) => (s ? s.replace(/\s+/g, ' ').trim().slice(0, n) : null)

type MailPosture = {
  smtpHost: string | null; smtpFrom: string | null; imapHost: string | null; authMethod: string
  oauthConnectedAt: Date | null; oauthError: string | null; lastSyncedUid: number
  domainHealth: unknown; domainHealthCheckedAt: Date | null
}

type Counts = Record<string, number>
const tally = (rows: Array<{ status: string; _count: { _all: number } }>): Counts =>
  Object.fromEntries(rows.map(r => [r.status, r._count._all]))

export async function loadWorkspaceDiagnostics(workspaceId: string, now: Date = new Date()) {
  const ws = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: {
      id: true, name: true, createdAt: true, onboardingCompleted: true, plan: true,
      subscriptionStatus: true, stripeSubscriptionId: true, billingGraceUntil: true,
      sendSuppressed: true, sendSuppressedReason: true,
    },
  }) as null | {
    id: string; name: string; createdAt: Date; onboardingCompleted: boolean; plan: string
    subscriptionStatus: string | null; stripeSubscriptionId: string | null; billingGraceUntil: Date | null
    sendSuppressed: boolean; sendSuppressedReason: string | null
  }
  if (!ws) return null

  const since24h = new Date(now.getTime() - DAY_MS)
  const staleBefore = new Date(now.getTime() - staleSendRecoveryMinutes() * 60_000)
  const [mail, sends24h, staleSending, followups, sources, runs, audit, reputation, autonomy] = await Promise.all([
    prisma.workspaceEmailConfig.findUnique({
      where: { workspaceId },
      select: {
        smtpHost: true, smtpFrom: true, imapHost: true, authMethod: true, oauthConnectedAt: true, oauthError: true,
        lastSyncedUid: true, domainHealth: true, domainHealthCheckedAt: true,
      },
    }) as Promise<MailPosture | null>,
    prisma.outreachSent.groupBy({ by: ['status'], where: { workspaceId, claimedAt: { gte: since24h } }, _count: { _all: true } }),
    prisma.outreachSent.count({ where: { workspaceId, status: 'SENDING', claimedAt: { lt: staleBefore } } }),
    prisma.followupTask.groupBy({ by: ['status'], where: { workspaceId }, _count: { _all: true } }),
    prisma.discoverySourceState.findMany({
      where: { workspaceId },
      select: { source: true, lastRunAt: true, lastSuccessAt: true, lastError: true, lastWarning: true, runCount: true, failureCount: true },
      orderBy: { source: 'asc' },
    }),
    prisma.discoveryRun.groupBy({ by: ['status'], where: { workspaceId, startedAt: { gte: new Date(now.getTime() - 7 * DAY_MS) } }, _count: { _all: true } }),
    prisma.auditEvent.findMany({
      where: { workspaceId, createdAt: { gte: new Date(now.getTime() - 7 * DAY_MS) }, OR: FAILURE_MARKERS.map(m => ({ type: { contains: m } })) },
      select: { type: true, entityType: true, entityId: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 20,
    }),
    evaluateSenderReputation(workspaceId, now),
    assessAutonomy(workspaceId, now),
  ]) as [
    MailPosture | null,
    Array<{ status: string; _count: { _all: number } }>,
    number,
    Array<{ status: string; _count: { _all: number } }>,
    Array<{ source: string; lastRunAt: Date | null; lastSuccessAt: Date | null; lastError: string | null; lastWarning: string | null; runCount: number; failureCount: number }>,
    Array<{ status: string; _count: { _all: number } }>,
    Array<{ type: string; entityType: string | null; entityId: string | null; createdAt: Date }>,
    Awaited<ReturnType<typeof evaluateSenderReputation>>,
    Awaited<ReturnType<typeof assessAutonomy>>,
  ]

  const entitlement = billingEntitlement(ws, now)
  const health = (mail?.domainHealth ?? null) as { status?: string } | null
  return {
    workspace: { id: ws.id, name: ws.name, createdAt: ws.createdAt.toISOString(), onboardingCompleted: ws.onboardingCompleted },
    sending: {
      suppressed: ws.sendSuppressed,
      suppressedReason: clip(ws.sendSuppressedReason),
      last24h: tally(sends24h),
      staleSending,
      staleAfterMinutes: staleSendRecoveryMinutes(),
      reputation: { healthy: reputation.healthy, sends: reputation.totalSends, bounceRate: reputation.bounceRate, complaintRate: reputation.complaintRate, reason: reputation.reason },
      autonomy: { ready: autonomy.ready, optedIn: autonomy.optedIn, blockers: autonomy.blockers },
    },
    billing: {
      plan: ws.plan,
      providerStatus: ws.subscriptionStatus,
      hasSubscription: Boolean(ws.stripeSubscriptionId),
      entitlement: entitlement.status,
      effectivePlan: entitlement.effectivePlan,
      graceUntil: entitlement.graceUntil?.toISOString() ?? null,
    },
    mailbox: mail ? {
      smtpConfigured: Boolean(mail.smtpHost && mail.smtpFrom),
      imapConfigured: Boolean(mail.imapHost),
      authMethod: mail.authMethod,
      oauthConnected: mail.oauthConnectedAt != null,
      oauthActionRequired: Boolean(mail.oauthError),
      replySyncStarted: mail.lastSyncedUid > 0,
      domainHealth: health?.status ?? null,
      domainHealthCheckedAt: mail.domainHealthCheckedAt?.toISOString() ?? null,
    } : null,
    followups: tally(followups),
    discovery: {
      runsLast7d: tally(runs),
      sources: sources.map(s => ({
        source: s.source, runs: s.runCount, failures: s.failureCount,
        lastRunAt: s.lastRunAt?.toISOString() ?? null, lastSuccessAt: s.lastSuccessAt?.toISOString() ?? null,
        lastError: clip(s.lastError), lastWarning: clip(s.lastWarning),
      })),
    },
    recentFailures: audit.map(a => ({ type: a.type, entityType: a.entityType, entityId: a.entityId, at: a.createdAt.toISOString() })),
    generatedAt: now.toISOString(),
  }
}

export type WorkspaceDiagnostics = NonNullable<Awaited<ReturnType<typeof loadWorkspaceDiagnostics>>>
