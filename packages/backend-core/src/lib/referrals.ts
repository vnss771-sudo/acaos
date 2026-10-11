// Referral-partner attribution and commission estimates.
//
// Partners are platform-level records (not tenant-owned). A workspace is attributed
// once, at signup, from the code the owner entered. Commission is an estimate for
// the operator to pay out manually — the app never moves money.

// Monthly list prices in cents (AUD, ex-GST). Mirror the live Stripe prices; the
// plan -> price map lives here only because commission is a reporting estimate.
export const PLAN_MONTHLY_CENTS: Readonly<Record<string, number>> = {
  free: 0,
  starter: 14900,
  growth: 24900,
}

const CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{2,31}$/

export function normalizeReferralCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const code = raw.trim().toUpperCase()
  return CODE_PATTERN.test(code) ? code : null
}

// Resolves an entered code to an active partner id. Unknown, malformed or paused
// codes return null so a typo never blocks signup.
export async function resolveReferralPartnerId(
  db: { referralPartner: { findUnique(args: { where: { code: string }; select: { id: true; status: true } }): Promise<{ id: string; status: string } | null> } },
  raw: unknown,
): Promise<string | null> {
  const code = normalizeReferralCode(raw)
  if (!code) return null
  const partner = await db.referralPartner.findUnique({ where: { code }, select: { id: true, status: true } })
  return partner && partner.status === 'active' ? partner.id : null
}

export type ReferredWorkspace = { plan: string; subscriptionStatus: string | null }

export function isPayingWorkspace(w: ReferredWorkspace): boolean {
  return (PLAN_MONTHLY_CENTS[w.plan] ?? 0) > 0 && (w.subscriptionStatus === 'active' || w.subscriptionStatus === 'trialing')
}

export function summariseReferrals(workspaces: ReferredWorkspace[], commissionPercent: number) {
  const paying = workspaces.filter(isPayingWorkspace)
  const monthlyRecurringCents = paying.reduce((sum, w) => sum + (PLAN_MONTHLY_CENTS[w.plan] ?? 0), 0)
  return {
    referred: workspaces.length,
    paying: paying.length,
    monthlyRecurringCents,
    estimatedMonthlyCommissionCents: Math.round((monthlyRecurringCents * commissionPercent) / 100),
  }
}
