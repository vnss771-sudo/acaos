import React, { useEffect, useState } from 'react'
import type { Workspace } from '../types.js'
import { PLAN_LABELS } from '../types.js'
import { s, colors } from '../styles.js'
import { Spinner } from '../components/Spinner.js'
import type { ApiHook } from '../hooks/useApi.js'
import type { ToastHook } from '../hooks/useToast.js'

type Props = { api: ApiHook; workspace: Workspace | null; toast: ToastHook }

type UsageStats = {
  month: string
  totals: Record<string, number>
  total: number
  limit: number
  plan: string
  discovery?: {
    used: number
    limit: number
    estimatedCostCents?: number
    byProvider?: Record<string, { runs: number; costCents: number }>
  }
  leads?: { used: number; limit: number }
}

type BillingStatus = {
  plan: string
  status: string
  hasSubscription: boolean
  usage?: UsageStats
}

const PLAN_FEATURES: Record<string, string[]> = {
  free: [
    '1 workspace',
    'Up to 50 leads',
    '5 AI requests per month',
    'Basic pipeline management'
  ],
  starter: [
    'Unlimited leads',
    '500 AI requests per month',
    'Async AI research & outreach',
    'CSV bulk import',
    'BullMQ job queue',
    'Email & IMAP integration',
    'Priority support'
  ],
  growth: [
    'Everything in Starter',
    'Unlimited AI requests',
    'Multiple workspaces',
    'Team members',
    'Advanced analytics',
    'Dedicated onboarding',
    'SLA support'
  ]
}

const STATUS_COLOR: Record<string, string> = {
  active: colors.green,
  trialing: colors.blue,
  past_due: colors.amber,
  canceled: colors.red,
  none: colors.textFaint
}

export function Billing({ api, workspace, toast }: Props) {
  const [billingStatus, setBillingStatus] = useState<BillingStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [checkoutLoading, setCheckoutLoading] = useState('')
  const [portalLoading, setPortalLoading] = useState(false)

  useEffect(() => {
    if (!workspace) return
    setLoading(true)
    api<BillingStatus>(`/api/billing/status?workspaceId=${workspace.id}`)
      .then(setBillingStatus)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [workspace?.id])

  async function startCheckout(priceKey: string) {
    if (!workspace) return
    setCheckoutLoading(priceKey)
    try {
      // Send the plan name, not a price id. The server resolves the Stripe price
      // from the plan so a client can't point checkout at an arbitrary price.
      const plan = priceKey === 'growth' ? 'growth' : 'starter'
      const d = await api<{ url: string }>('/api/billing/checkout', {
        method: 'POST',
        body: JSON.stringify({ workspaceId: workspace.id, plan })
      })
      window.location.href = d.url
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Checkout failed') }
    finally { setCheckoutLoading('') }
  }

  async function openPortal() {
    if (!workspace) return
    setPortalLoading(true)
    try {
      const d = await api<{ url: string }>('/api/billing/portal', {
        method: 'POST',
        body: JSON.stringify({ workspaceId: workspace.id })
      })
      window.location.href = d.url
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Could not open billing portal') }
    finally { setPortalLoading(false) }
  }

  const currentPlan = billingStatus?.plan ?? workspace?.plan ?? 'free'
  const isActive = billingStatus?.status === 'active' || billingStatus?.status === 'trialing'

  return (
    <div style={s.stack}>
      {/* Current status card */}
      <div style={s.card}>
        <div style={s.sectionHeader}>Current Plan</div>
        {loading ? (
          <div style={{ padding: 20, textAlign: 'center' }}><Spinner /></div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap' }}>
            <div>
              <div style={{ color: colors.text, fontSize: 24, fontWeight: 700 }}>
                {PLAN_LABELS[currentPlan] ?? currentPlan}
              </div>
              {billingStatus && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: STATUS_COLOR[billingStatus.status] || colors.textFaint, display: 'inline-block' }} />
                  <span style={{ color: STATUS_COLOR[billingStatus.status] || colors.textFaint, fontSize: 13, textTransform: 'capitalize' }}>
                    {billingStatus.status === 'none' ? 'No subscription' : billingStatus.status.replace(/_/g, ' ')}
                  </span>
                </div>
              )}
            </div>

            <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
              {!isActive && currentPlan === 'free' && (
                <button
                  style={{ ...s.btn, background: colors.blue }}
                  disabled={!!checkoutLoading}
                  onClick={() => startCheckout('starter')}
                >
                  {checkoutLoading === 'starter' ? <><Spinner size={14} color="#fff" /> Loading…</> : 'Upgrade Plan →'}
                </button>
              )}
              {billingStatus?.hasSubscription && (
                <button
                  style={s.btnGhost}
                  onClick={openPortal}
                  disabled={portalLoading}
                >
                  {portalLoading ? <><Spinner size={14} /> Loading…</> : 'Manage Subscription →'}
                </button>
              )}
            </div>
          </div>
        )}

        {billingStatus?.usage && (
          <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
            {[
              { label: 'AI calls used this month', used: billingStatus.usage.total, limit: billingStatus.usage.limit },
              ...(billingStatus.usage.discovery ? [{ label: 'Discovery runs this month', used: billingStatus.usage.discovery.used, limit: billingStatus.usage.discovery.limit }] : []),
              ...(billingStatus.usage.leads ? [{ label: 'Leads', used: billingStatus.usage.leads.used, limit: billingStatus.usage.leads.limit }] : []),
            ].map(m => (
              <div key={m.label}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                  <span style={{ color: colors.textMuted, fontSize: 13 }}>{m.label}</span>
                  <span style={{ color: colors.text, fontSize: 13, fontWeight: 600 }}>
                    {m.used}{m.limit > 0 ? ` / ${m.limit}` : ' / ∞'}
                  </span>
                </div>
                {m.limit > 0 && (
                  <div style={{ background: '#1e2d40', borderRadius: 4, height: 6, overflow: 'hidden' }}>
                    <div style={{
                      width: `${Math.min(100, (m.used / m.limit) * 100)}%`,
                      height: '100%',
                      background: m.used / m.limit > 0.85 ? colors.red : colors.blue,
                      borderRadius: 4,
                      transition: 'width 0.4s'
                    }} />
                  </div>
                )}
              </div>
            ))}

            {billingStatus.usage.discovery?.estimatedCostCents != null && (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>
                <span style={{ color: colors.textMuted, fontSize: 13 }}>
                  Estimated discovery cost this month
                  {(() => {
                    const by = billingStatus.usage.discovery.byProvider
                    const parts = by
                      ? Object.entries(by)
                          .filter(([, v]) => v.costCents > 0)
                          .map(([name, v]) => `${name} $${(v.costCents / 100).toFixed(2)}`)
                      : []
                    return parts.length > 0
                      ? <span style={{ color: colors.textMuted, fontSize: 11, marginLeft: 6 }}>({parts.join(', ')})</span>
                      : null
                  })()}
                </span>
                <span style={{ color: colors.text, fontSize: 13, fontWeight: 600 }}>
                  ${(billingStatus.usage.discovery.estimatedCostCents / 100).toFixed(2)}
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Pricing cards */}
      {!isActive && (
        <>
          <div style={{ color: colors.text, fontSize: 16, fontWeight: 600 }}>Upgrade your plan</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
            {(['starter', 'growth'] as const).map(plan => (
              <div
                key={plan}
                style={{
                  ...s.card,
                  borderColor: plan === 'growth' ? colors.purple + '80' : colors.border,
                  position: 'relative'
                }}
              >
                {plan === 'growth' && (
                  <div style={{
                    position: 'absolute', top: -10, right: 16,
                    background: colors.purple, color: '#fff',
                    fontSize: 11, fontWeight: 700, padding: '2px 10px', borderRadius: 99,
                    letterSpacing: '0.06em'
                  }}>
                    MOST POPULAR
                  </div>
                )}

                <div style={{ marginBottom: 16 }}>
                  <div style={{ color: colors.text, fontSize: 18, fontWeight: 700 }}>
                    {PLAN_LABELS[plan]}
                  </div>
                  <div style={{ color: colors.textFaint, fontSize: 13, marginTop: 4 }}>
                    {plan === 'starter' ? 'Perfect for solo founders' : 'For growing teams'}
                  </div>
                </div>

                <ul style={{ color: colors.textMuted, fontSize: 13, lineHeight: 1.8, paddingLeft: 18, marginBottom: 20 }}>
                  {PLAN_FEATURES[plan].map(f => <li key={f}>{f}</li>)}
                </ul>

                <button
                  style={{
                    ...s.btn,
                    width: '100%',
                    background: plan === 'growth' ? colors.purple : colors.blue,
                    opacity: checkoutLoading === plan ? 0.7 : 1
                  }}
                  disabled={!!checkoutLoading}
                  onClick={() => startCheckout(plan)}
                >
                  {checkoutLoading === plan ? <><Spinner size={14} color="#fff" /> Loading…</> : `Upgrade to ${PLAN_LABELS[plan]} →`}
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      {/* What's included on free */}
      <div style={s.card}>
        <div style={s.sectionHeader}>Free Plan includes</div>
        <ul style={{ color: colors.textMuted, fontSize: 13, lineHeight: 1.9, paddingLeft: 18, margin: 0 }}>
          {PLAN_FEATURES.free.map(f => <li key={f}>{f}</li>)}
        </ul>
      </div>
    </div>
  )
}
