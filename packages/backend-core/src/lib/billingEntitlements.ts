// Billing entitlement policy (UQ-26): what a workspace may use, derived from
// what Stripe says and when, so a single failed payment or a late webhook can't
// flip a paying customer to Free-plan limits mid-month.
//
//   active / trialing         → the purchased plan
//   past_due, within grace    → the purchased plan (a bounded 7-day grace)
//   past_due, grace expired   → free (fails closed)
//   canceled / unpaid / other → free
//   no subscription status    → the stored plan (free by default; comped plans keep working)
//
// The grace deadline is set by the first past_due transition and never moved by
// repeated past_due events, so retries can't extend it indefinitely.

export const BILLING_GRACE_DAYS = 7
const DAY_MS = 86_400_000

export type BillingFacts = {
  plan: string | null
  subscriptionStatus: string | null
  billingGraceUntil: Date | null
}

export type EntitlementStatus = 'none' | 'active' | 'grace' | 'lapsed'

export type Entitlement = {
  status: EntitlementStatus
  /** The plan whose limits apply right now. */
  effectivePlan: 'free' | 'starter' | 'growth'
  graceUntil: Date | null
}

function paidPlan(plan: BillingFacts['plan']): 'free' | 'starter' | 'growth' {
  return plan === 'starter' || plan === 'growth' ? plan : 'free'
}

export function billingEntitlement(facts: BillingFacts, now: Date = new Date()): Entitlement {
  const plan = paidPlan(facts.plan)
  const status = facts.subscriptionStatus
  if (!status) return { status: 'none', effectivePlan: plan, graceUntil: null }
  if (status === 'active' || status === 'trialing') return { status: 'active', effectivePlan: plan, graceUntil: null }
  if (status === 'past_due' && facts.billingGraceUntil && now < facts.billingGraceUntil) {
    return { status: 'grace', effectivePlan: plan, graceUntil: facts.billingGraceUntil }
  }
  return { status: 'lapsed', effectivePlan: 'free', graceUntil: facts.billingGraceUntil }
}

/** Grace deadline after a past_due transition: an existing deadline is kept, never extended. */
export function graceUntilAfterPastDue(existing: Date | null, now: Date = new Date()): Date {
  return existing ?? new Date(now.getTime() + BILLING_GRACE_DAYS * DAY_MS)
}

/**
 * Stripe delivers at least once and not in order. An event created before the
 * newest one already applied to this workspace must not overwrite its state.
 */
export function isStaleStripeEvent(eventCreatedSeconds: number | undefined, lastAppliedAt: Date | null): boolean {
  if (eventCreatedSeconds == null || !lastAppliedAt) return false
  return eventCreatedSeconds * 1000 < lastAppliedAt.getTime()
}
