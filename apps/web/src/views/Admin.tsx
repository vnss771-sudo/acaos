import React, { useEffect, useState } from 'react'
import { colors, s } from '../styles.js'
import { Spinner } from '../components/Spinner.js'
import { Table, type Column, type SortState } from '../components/ui/Table.js'
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
  const [workspaceSort, setWorkspaceSort] = useState<SortState | undefined>()
  const [queueSort, setQueueSort] = useState<SortState | undefined>()
  const [auditSort, setAuditSort] = useState<SortState | undefined>()

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

  const sortRows = <T,>(rows: T[], sort: SortState | undefined, val: (row: T, key: string) => string | number) => {
    if (!sort) return rows
    const dir = sort.dir === 'asc' ? 1 : -1
    return [...rows].sort((a, b) => {
      const av = val(a, sort.key), bv = val(b, sort.key)
      return av < bv ? -dir : av > bv ? dir : 0
    })
  }

  const sortedWorkspaces = sortRows(workspaces, workspaceSort, (w, key) => {
    switch (key) {
      case 'name': return w.name.toLowerCase()
      case 'plan': return w.plan
      case 'status': return w.subscriptionStatus ?? ''
      case 'memberCount': return w.memberCount
      case 'leadCount': return w.leadCount
      case 'campaignCount': return w.campaignCount
      case 'aiCallsThisMonth': return w.aiCallsThisMonth
      case 'createdAt': return w.createdAt
      default: return ''
    }
  })

  const sortedQueues = sortRows(queues, queueSort, (q, key) => {
    switch (key) {
      case 'name': return q.name
      case 'active': return q.active
      case 'waiting': return q.waiting
      case 'completed': return q.completed
      case 'failed': return q.failed
      default: return ''
    }
  })

  const sortedAudit = sortRows(audit, auditSort, (e, key) => {
    switch (key) {
      case 'createdAt': return e.createdAt
      case 'type': return e.type
      case 'entityType': return e.entityType ?? ''
      default: return ''
    }
  })

  const workspaceColumns: Column<WorkspaceSummary>[] = [
    {
      key: 'name', header: 'Workspace', sortable: true,
      render: ws => (
        <>
          <div style={{ color: colors.text, fontWeight: 500 }}>{ws.name}</div>
          <div style={{ color: colors.textFaint, fontSize: 11 }}>{ws.slug}</div>
        </>
      ),
    },
    {
      key: 'plan', header: 'Plan', sortable: true,
      render: ws => (
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.05em', color: planColor(ws.plan), textTransform: 'uppercase' }}>
          {PLAN_LABELS[ws.plan] ?? ws.plan}
        </span>
      ),
    },
    {
      key: 'status', header: 'Status', sortable: true,
      render: ws => <span style={{ color: statusColor(ws.subscriptionStatus), fontSize: 12 }}>{ws.subscriptionStatus ?? 'free'}</span>,
    },
    { key: 'memberCount', header: 'Members', sortable: true, align: 'right', render: ws => <span style={{ color: colors.textMuted }}>{ws.memberCount}</span> },
    { key: 'leadCount', header: 'Leads', sortable: true, align: 'right', render: ws => <span style={{ color: colors.textMuted }}>{ws.leadCount.toLocaleString()}</span> },
    { key: 'campaignCount', header: 'Campaigns', sortable: true, align: 'right', render: ws => <span style={{ color: colors.textMuted }}>{ws.campaignCount}</span> },
    {
      key: 'aiCallsThisMonth', header: 'AI / Mo', sortable: true, align: 'right',
      render: ws => <span style={{ color: ws.aiCallsThisMonth > 0 ? colors.blue : colors.textFaint }}>{ws.aiCallsThisMonth.toLocaleString()}</span>,
    },
    {
      key: 'createdAt', header: 'Created', sortable: true,
      render: ws => <span style={{ color: colors.textFaint, fontSize: 12 }}>{new Date(ws.createdAt).toLocaleDateString()}</span>,
    },
  ]

  const queueColumns: Column<QueueStat>[] = [
    { key: 'name', header: 'Queue', sortable: true, render: q => <span style={{ color: colors.text, fontFamily: 'monospace', fontSize: 12 }}>{q.name}</span> },
    { key: 'active', header: 'Active', sortable: true, render: q => <span style={{ color: q.active > 0 ? colors.amber : colors.textFaint, fontWeight: q.active > 0 ? 700 : 400 }}>{q.active}</span> },
    { key: 'waiting', header: 'Waiting', sortable: true, render: q => <span style={{ color: q.waiting > 0 ? colors.blue : colors.textFaint }}>{q.waiting}</span> },
    { key: 'completed', header: 'Completed', sortable: true, render: q => <span style={{ color: colors.green }}>{q.completed.toLocaleString()}</span> },
    { key: 'failed', header: 'Failed', sortable: true, render: q => <span style={{ color: q.failed > 0 ? colors.red : colors.textFaint, fontWeight: q.failed > 0 ? 700 : 400 }}>{q.failed}</span> },
  ]

  const auditColumns: Column<AuditEvent>[] = [
    { key: 'createdAt', header: 'When', sortable: true, render: e => <span style={{ color: colors.textFaint, whiteSpace: 'nowrap' }}>{new Date(e.createdAt).toLocaleString()}</span> },
    {
      key: 'type', header: 'Event', sortable: true,
      render: e => {
        const isFailure = /fail|bounce/i.test(e.type)
        return <span style={{ color: isFailure ? colors.red : colors.text, fontFamily: 'monospace', fontSize: 12, fontWeight: isFailure ? 700 : 400 }}>{e.type}</span>
      },
    },
    { key: 'entityType', header: 'Entity', sortable: true, render: e => <span style={{ color: colors.textMuted, fontSize: 12 }}>{e.entityType ?? '—'}</span> },
    {
      key: 'detail', header: 'Detail',
      render: e => (
        <span style={{ color: colors.textFaint, fontSize: 12, maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block' }}>
          {e.metadata ? JSON.stringify(e.metadata) : '—'}
        </span>
      ),
    },
  ]

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
        <Table<WorkspaceSummary>
          columns={workspaceColumns}
          rows={sortedWorkspaces}
          rowKey={ws => ws.id}
          sort={workspaceSort}
          onSortChange={setWorkspaceSort}
          empty="No workspaces yet."
        />
      </div>

      {/* Queue health panel */}
      {queues.length > 0 && (
        <div style={{ ...s.card, marginTop: 24 }}>
          <div style={{ ...s.sectionHeader, marginBottom: 16 }}>Worker Queue Health</div>
          <Table<QueueStat>
            columns={queueColumns}
            rows={sortedQueues}
            rowKey={q => q.name}
            sort={queueSort}
            onSortChange={setQueueSort}
          />
        </div>
      )}

      {audit.length > 0 && (
        <div style={{ ...s.card, marginTop: 24 }}>
          <div style={{ ...s.sectionHeader, marginBottom: 16 }}>Recent Activity (Audit Log)</div>
          <Table<AuditEvent>
            columns={auditColumns}
            rows={sortedAudit}
            rowKey={e => e.id}
            sort={auditSort}
            onSortChange={setAuditSort}
          />
        </div>
      )}

      <div style={{ marginTop: 16, color: colors.textFaint, fontSize: 12 }}>
        This view spans every workspace on the platform — separate from any single workspace's own admin or owner role.
        Workspace email credentials are encrypted before they're stored.
      </div>
    </div>
  )
}
