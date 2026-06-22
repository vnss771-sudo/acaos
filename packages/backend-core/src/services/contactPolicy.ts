import { prisma } from '../lib/prisma.js'
import { normalizeEmail } from '../lib/normalize.js'

// Central, conservative contact-frequency policy. Answers "may we contact this
// recipient right now?" by composing the suppression list, the ContactEvent
// ledger (recency / monthly cap / prior reply), and the lead's terminal state.
// One place so every send path — initial campaign send, follow-up worker, retry,
// manual send-now, and campaign preflight — applies the SAME rules.
//
// Pure-ish: only reads. The caller enforces the decision. Defaults are
// deliberately cautious (a wrong send is worse than a delayed one).

export type ContactPolicyReason =
  | 'SUPPRESSED'
  | 'ALREADY_REPLIED'
  | 'LEAD_TERMINAL'
  | 'RECENTLY_CONTACTED'
  | 'MONTHLY_CONTACT_LIMIT'

export type ContactPolicyDecision =
  | { allowed: true }
  | { allowed: false; reason: ContactPolicyReason }

export interface ContactPolicyInput {
  workspaceId: string
  email: string
  leadId?: string | null
  now?: Date
  // Tunables (conservative beta defaults). businessDaysGap: a recipient sent to
  // within this many business days is RECENTLY_CONTACTED. monthlyLimit: at most
  // this many sends in the trailing 30 days.
  businessDaysGap?: number
  monthlyLimit?: number
}

const TERMINAL_STAGES = new Set(['BOOKED', 'CLOSED', 'DEAD'])

/**
 * The date `n` business days (Mon–Fri) before `from`, at the same clock time.
 * Pure and exported for unit testing. n=0 returns `from`.
 */
export function businessDaysBefore(from: Date, n: number): Date {
  const d = new Date(from.getTime())
  let remaining = Math.max(0, Math.floor(n))
  while (remaining > 0) {
    d.setDate(d.getDate() - 1)
    const day = d.getDay() // 0 Sun … 6 Sat
    if (day !== 0 && day !== 6) remaining--
  }
  return d
}

export async function canContactRecipient(input: ContactPolicyInput): Promise<ContactPolicyDecision> {
  const now = input.now ?? new Date()
  const emailKey = normalizeEmail(input.email)
  const businessDaysGap = input.businessDaysGap ?? 5
  const monthlyLimit = input.monthlyLimit ?? 3
  const workspaceId = input.workspaceId

  // 1. Suppressed (unsubscribed / bounced / complaint) — hard block.
  const suppressed = await prisma.suppression.findUnique({
    where: { workspaceId_emailKey: { workspaceId, emailKey } },
    select: { id: true },
  })
  if (suppressed) return { allowed: false, reason: 'SUPPRESSED' }

  // 2. The recipient has already replied — never keep cold-contacting a live thread.
  const replied = await prisma.contactEvent.findFirst({
    where: { workspaceId, emailKey, type: 'REPLIED' },
    select: { id: true },
  })
  if (replied) return { allowed: false, reason: 'ALREADY_REPLIED' }

  // 3. Lead reached a terminal stage (booked/closed/dead) — stop contacting.
  if (input.leadId) {
    const lead = await prisma.lead.findUnique({ where: { id: input.leadId }, select: { stage: true } })
    if (lead && TERMINAL_STAGES.has(lead.stage)) return { allowed: false, reason: 'LEAD_TERMINAL' }
  }

  // 4. Recently contacted (a SENT event within the business-day gap).
  const recentSince = businessDaysBefore(now, businessDaysGap)
  const recent = await prisma.contactEvent.findFirst({
    where: { workspaceId, emailKey, type: 'SENT', occurredAt: { gte: recentSince } },
    select: { id: true },
  })
  if (recent) return { allowed: false, reason: 'RECENTLY_CONTACTED' }

  // 5. Monthly contact cap (>= monthlyLimit SENT events in the trailing 30 days).
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
  const monthCount = await prisma.contactEvent.count({
    where: { workspaceId, emailKey, type: 'SENT', occurredAt: { gte: thirtyDaysAgo } },
  })
  if (monthCount >= monthlyLimit) return { allowed: false, reason: 'MONTHLY_CONTACT_LIMIT' }

  return { allowed: true }
}
