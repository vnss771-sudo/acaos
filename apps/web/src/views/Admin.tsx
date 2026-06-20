import React, { useEffect, useState } from 'react'
import { colors, s } from '../styles.js'
import { Spinner } from '../components/Spinner.js'
import type { ApiHook } from '../hooks/useApi.js'
import type { ToastHook } from '../hooks/useToast.js'
import { PLAN_LABELS } from '../types.js'
import type { AuditEvent, BillingPlan } from '../types.js'

type WorkspaceSummary = {
  id: string
  name: string
  slug: string
  plan: BillingPlan
  subscriptionStatus: string | null
  createdAt: string
  memberCount: number
  leadCount: number
  campaignCount: number
  aiCallsThisMonth: number
}

type AdminOverview = {
  workspaces: WorkspaceSummary[]
  totals: {
    workspaceCount: number
    totalLeads: number
    totalCampaigns: number
    totalAiCalls: number
    paidWorkspaces: number
  }
}

type QueueStat = { name: string; active: number; waiting: number; completed: number; failed: number }

type Props = { api: ApiHook; toast: ToastHook }

function planColor(plan: BillingPlan) {
  if (plan === 'growth') return colors.green
  if (plan === 'starter') return colors.blue
  return colors.textFaint
}

function statusColor(status: string | null) {
  if (status === 'active') return colors.green
  if (status === 'past_due') return '#f59e0b'
  if (status === 'canceled') return colors.red
  return colors.textFaint
}

function KpiTile({ label, value, color = colors.text }: { label: string; value: string | number; color?: string }) {
  return (
    <div style={{ ...s.card, flex: 1, minWidth: 140 }}>
      <div style={{ color: colors.textFaint, fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 8 }}>
        {label}
      </div>
      <div style={{ color, fontSize: 28, fontWeight: 700 }}>{value}</div>
    </div>
  )
}

export function AdminView({ api, toast }: Props) {
  const [data, setData] = useState<AdminOverview | null>(null)
  const [loading, setLoading] = useState(true)
  const [queues, setQueues] = useState<QueueStat[]>([])
  const [audit, setAudit] = useState<AuditEvent[]>([])

  useEffect(() => {
    let cancelled = false
    api<AdminOverview>('/api/admin/overview')
      .then(d => { if (!cancelled) setData(d) })
      .catch(() => { if (!cancelled) toast.error('Failed to load admin overview') })
      .finally(() => { if (!cancelled) setLoading(false) })
    api<{ queues: QueueStat[] }>('/api/admin/queue-stats')
      .then(d => { if (!cancelled) setQueues(d.queues) })
      .catch(() => {})
    api<{ events: AuditEvent[] }>('/api/admin/audit?limit=50')
      .then(d => { if (!cancelled) setAudit(d.events) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  if (loading) return <Spinner />
  if (!data) return null

  const { workspaces, totals } = data

  return (
    <div style={{ maxWidth: 1100 }}>
      <div style={{ marginBottom: 24 }}>
        <div style={{ color: colors.textFaint, fontSize: 13, marginBottom: 4 }}>
          Founder control panel — visible only to the admin account.
        </div>
      </div>

      {/* KPI row */}
      <div style={{ display: 'flex', gap: 16, marginBottom: 28, flexWrap: 'wrap' }}>
        <KpiTile label="Workspaces" value={totals.workspaceCount} />
        <KpiTile label="Paid" value={totals.paidWorkspaces} color={colors.green} />
        <KpiTile label="Total Leads" value={totals.totalLeads.toLocaleString()} />
        <KpiTile label="Campaigns" value={totals.totalCampaigns} />
        <KpiTile label="AI Calls (month)" value={totals.totalAiCalls.toLocaleString()} color={colors.blue} />
      </div>

      {/* Workspace table */}
      <div style={s.card}>
        <div style={{ ...s.sectionHeader, marginBottom: 16 }}>All Workspaces</div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${colors.border}` }}>
                {['Workspace', 'Plan', 'Status', 'Members', 'Leads', 'Campaigns', 'AI / Mo', 'Created'].map(h => (
                  <th key={h} style={{ textAlign: 'left', padding: '8px 12px', color: colors.textFaint, fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {workspaces.map((ws, i) => (
                <tr
                  key={ws.id}
                  style={{ borderBottom: `1px solid ${colors.border}`, background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)' }}
                >
                  <td style={{ padding: '10px 12px' }}>
                    <div style={{ color: colors.text, fontWeight: 500 }}>{ws.name}</div>
                    <div style={{ color: colors.textFaint, fontSize: 11 }}>{ws.slug}</div>
                  </td>
                  <td style={{ padding: '10px 12px' }}>
                    <span style={{
                      fontSize: 11, fontWeight: 700, letterSpacing: '0.05em',
                      color: planColor(ws.plan), textTransform: 'uppercase'
                    }}>
                      {PLAN_LABELS[ws.plan] ?? ws.plan}
                    </span>
                  </td>
                  <td style={{ padding: '10px 12px' }}>
                    <span style={{ color: statusColor(ws.subscriptionStatus), fontSize: 12 }}>
                      {ws.subscriptionStatus ?? 'free'}
                    </span>
                  </td>
                  <td style={{ padding: '10px 12px', color: colors.textMuted, textAlign: 'right' }}>{ws.memberCount}</td>
                  <td style={{ padding: '10px 12px', color: colors.textMuted, textAlign: 'right' }}>{ws.leadCount.toLocaleString()}</td>
                  <td style={{ padding: '10px 12px', color: colors.textMuted, textAlign: 'right' }}>{ws.campaignCount}</td>
                  <td style={{ padding: '10px 12px', textAlign: 'right' }}>
                    <span style={{ color: ws.aiCallsThisMonth > 0 ? colors.blue : colors.textFaint }}>
                      {ws.aiCallsThisMonth.toLocaleString()}
                    </span>
                  </td>
                  <td style={{ padding: '10px 12px', color: colors.textFaint, fontSize: 12 }}>
                    {new Date(ws.createdAt).toLocaleDateString()}
                  </td>
                </tr>
              ))}
              {workspaces.length === 0 && (
                <tr>
                  <td colSpan={8} style={{ padding: 24, textAlign: 'center', color: colors.textFaint }}>
                    No workspaces yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Queue health panel */}
      {queues.length > 0 && (
        <div style={{ ...s.card, marginTop: 24 }}>
          <div style={{ ...s.sectionHeader, marginBottom: 16 }}>Worker Queue Health</div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${colors.border}` }}>
                  {['Queue', 'Active', 'Waiting', 'Completed', 'Failed'].map(h => (
                    <th key={h} style={{ textAlign: 'left', padding: '8px 12px', color: colors.textFaint, fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {queues.map((q, i) => (
                  <tr key={q.name} style={{ borderBottom: `1px solid ${colors.border}`, background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)' }}>
                    <td style={{ padding: '8px 12px', color: colors.text, fontFamily: 'monospace', fontSize: 12 }}>{q.name}</td>
                    <td style={{ padding: '8px 12px', color: q.active > 0 ? colors.amber : colors.textFaint, fontWeight: q.active > 0 ? 700 : 400 }}>{q.active}</td>
                    <td style={{ padding: '8px 12px', color: q.waiting > 0 ? colors.blue : colors.textFaint }}>{q.waiting}</td>
                    <td style={{ padding: '8px 12px', color: colors.green }}>{q.completed.toLocaleString()}</td>
                    <td style={{ padding: '8px 12px', color: q.failed > 0 ? colors.red : colors.textFaint, fontWeight: q.failed > 0 ? 700 : 400 }}>{q.failed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {audit.length > 0 && (
        <div style={{ ...s.card, marginTop: 24 }}>
          <div style={{ ...s.sectionHeader, marginBottom: 16 }}>Recent Activity (Audit Log)</div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${colors.border}` }}>
                  {['When', 'Event', 'Entity', 'Detail'].map(h => (
                    <th key={h} style={{ textAlign: 'left', padding: '8px 12px', color: colors.textFaint, fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {audit.map((e, i) => {
                  const isFailure = /fail|bounce/i.test(e.type)
                  return (
                    <tr key={e.id} style={{ borderBottom: `1px solid ${colors.border}`, background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)' }}>
                      <td style={{ padding: '8px 12px', color: colors.textFaint, whiteSpace: 'nowrap' }}>{new Date(e.createdAt).toLocaleString()}</td>
                      <td style={{ padding: '8px 12px', color: isFailure ? colors.red : colors.text, fontFamily: 'monospace', fontSize: 12, fontWeight: isFailure ? 700 : 400 }}>{e.type}</td>
                      <td style={{ padding: '8px 12px', color: colors.textMuted, fontSize: 12 }}>{e.entityType ?? '—'}</td>
                      <td style={{ padding: '8px 12px', color: colors.textFaint, fontSize: 12, maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {e.metadata ? JSON.stringify(e.metadata) : '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div style={{ marginTop: 16, color: colors.textFaint, fontSize: 12 }}>
        Admin access is granted by the <code style={{ color: colors.amber }}>isPlatformAdmin</code> user flag (bootstrapped once via the <code style={{ color: colors.amber }}>ADMIN_EMAIL</code> env var on first admin request).
        Use <code style={{ color: colors.amber }}>EMAIL_ENCRYPTION_KEY</code> (64 hex chars) in production for credential encryption.
      </div>
    </div>
  )
}
