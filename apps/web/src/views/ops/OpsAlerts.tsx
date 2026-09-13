import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ApiHook } from '../../hooks/useApi.js'
import type { ToastHook } from '../../hooks/useToast.js'
import type { View, Workspace, OpsAlert } from '../../types.js'
import { colors, s } from '../../styles.js'
import { Card } from '../../components/ui/Card.js'
import { KpiCard } from '../../components/ui/KpiCard.js'
import { Skeleton } from '../../components/ui/Skeleton.js'
import { EmptyState } from '../../components/ui/EmptyState.js'
import { Badge } from '../../components/ui/Badge.js'
import { Grid } from '../../components/ui/Grid.js'
import { Table } from '../../components/ui/Table.js'
import type { Column } from '../../components/ui/Table.js'
import { OpsSubNav } from '../../components/ops/OpsSubNav.js'
import { makeRouteApi } from '../../lib/routeApi.js'

type Props = { api: ApiHook; workspace: Workspace | null; toast: ToastHook; canManage?: boolean; setView: (v: View) => void }

type AlertCounts = { open: number; reviewed: number; openHigh: number }

const SEVERITY_COLOR: Record<string, string> = { LOW: colors.textFaint, MEDIUM: colors.amber, HIGH: colors.red, CRITICAL: colors.purple }
const STATUS_COLOR: Record<string, string> = { OPEN: colors.amber, REVIEWED: colors.green }

const LIMIT = 25

// "MISSING_HEAT_CHECK" -> "Missing heat check". A light humanization, not a
// full label registry — good enough for a worklist column.
function humanizeAlertType(type: string): string {
  const lower = type.toLowerCase().replace(/_/g, ' ')
  return lower.charAt(0).toUpperCase() + lower.slice(1)
}

export function OpsAlerts({ api, workspace, toast, canManage = false, setView }: Props) {
  const route = useMemo(() => makeRouteApi(api), [api])

  const [counts, setCounts] = useState<AlertCounts | null>(null)
  const [alerts, setAlerts] = useState<OpsAlert[]>([])
  const [total, setTotal] = useState(0)
  const [pages, setPages] = useState(1)
  const [page, setPage] = useState(1)
  const [statusFilter, setStatusFilter] = useState('')
  const [severityFilter, setSeverityFilter] = useState('')
  const [loading, setLoading] = useState(false)
  const [reviewingIds, setReviewingIds] = useState<Set<string>>(new Set())

  const countsReqRef = useRef(0)
  const fetchCounts = useCallback(() => {
    if (!workspace) return
    const reqId = ++countsReqRef.current
    api<AlertCounts>(`/api/ops/alerts/counts?workspaceId=${workspace.id}`)
      .then(d => { if (reqId === countsReqRef.current) setCounts(d) })
      .catch(e => { if (reqId === countsReqRef.current) toast.error(e instanceof Error ? e.message : 'Failed to load alert counts') })
  }, [workspace?.id])

  useEffect(() => { fetchCounts() }, [fetchCounts])

  const listReqRef = useRef(0)
  const fetchAlerts = useCallback(() => {
    if (!workspace) return
    const reqId = ++listReqRef.current
    setLoading(true)
    const params = new URLSearchParams({ workspaceId: workspace.id, page: String(page), limit: String(LIMIT) })
    if (statusFilter) params.set('status', statusFilter)
    if (severityFilter) params.set('severity', severityFilter)
    api<{ alerts: OpsAlert[]; total: number; page: number; limit: number; pages: number }>(`/api/ops/alerts?${params}`)
      .then(d => {
        if (reqId !== listReqRef.current) return
        setAlerts(d.alerts || [])
        setTotal(d.total || 0)
        setPages(d.pages || 1)
      })
      .catch(e => { if (reqId === listReqRef.current) toast.error(e instanceof Error ? e.message : 'Failed to load alerts') })
      .finally(() => { if (reqId === listReqRef.current) setLoading(false) })
  }, [workspace?.id, page, statusFilter, severityFilter])

  useEffect(() => { fetchAlerts() }, [fetchAlerts])

  async function markReviewed(id: string) {
    if (!workspace) return
    setReviewingIds(prev => new Set(prev).add(id))
    try {
      await route('POST /api/ops/alerts/:id/review', { params: { id }, body: { workspaceId: workspace.id } })
      toast.success('Alert marked reviewed')
      fetchAlerts()
      fetchCounts()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to mark alert reviewed')
    } finally {
      setReviewingIds(prev => { const next = new Set(prev); next.delete(id); return next })
    }
  }

  const columns: Column<OpsAlert>[] = [
    { key: 'title', header: 'Title', render: a => a.title },
    { key: 'alertType', header: 'Type', render: a => humanizeAlertType(a.alertType) },
    { key: 'severity', header: 'Severity', render: a => <Badge color={SEVERITY_COLOR[a.severity] ?? colors.textFaint}>{a.severity}</Badge> },
    { key: 'status', header: 'Status', render: a => <Badge color={STATUS_COLOR[a.status] ?? colors.textFaint}>{a.status}</Badge> },
    { key: 'createdAt', header: 'Created', render: a => new Date(a.createdAt).toLocaleDateString() },
    ...(canManage
      ? [{
          key: 'actions',
          header: '',
          render: (a: OpsAlert) => a.status === 'OPEN' ? (
            <button style={s.btnSm} disabled={reviewingIds.has(a.id)} onClick={() => markReviewed(a.id)}>
              {reviewingIds.has(a.id) ? 'Reviewing…' : 'Mark Reviewed'}
            </button>
          ) : null,
        } as Column<OpsAlert>]
      : []),
  ]

  return (
    <div>
      <OpsSubNav view="ops-alerts" setView={setView} />

      <div style={s.stack}>
        {loading && !counts ? (
          <Grid cols={3}>
            {[0, 1, 2].map(i => <Card key={i}><Skeleton height={70} /></Card>)}
          </Grid>
        ) : counts && (
          <Grid cols={3}>
            <KpiCard label="Open Alerts" value={counts.open} />
            <KpiCard label="Reviewed" value={counts.reviewed} />
            <KpiCard label="Urgent (High/Critical)" value={counts.openHigh} color={counts.openHigh > 0 ? colors.red : colors.text} />
          </Grid>
        )}

        <Card>
          <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div>
              <label style={s.label} htmlFor="ops-alerts-status">Status</label>
              <select
                id="ops-alerts-status"
                style={{ ...s.input, width: 160 }}
                value={statusFilter}
                onChange={e => { setStatusFilter(e.target.value); setPage(1) }}
              >
                <option value="">All</option>
                <option value="OPEN">Open</option>
                <option value="REVIEWED">Reviewed</option>
              </select>
            </div>
            <div>
              <label style={s.label} htmlFor="ops-alerts-severity">Severity</label>
              <select
                id="ops-alerts-severity"
                style={{ ...s.input, width: 160 }}
                value={severityFilter}
                onChange={e => { setSeverityFilter(e.target.value); setPage(1) }}
              >
                <option value="">All</option>
                <option value="LOW">Low</option>
                <option value="MEDIUM">Medium</option>
                <option value="HIGH">High</option>
                <option value="CRITICAL">Critical</option>
              </select>
            </div>
          </div>

          {loading && alerts.length === 0 ? (
            <Skeleton height={200} />
          ) : (
            <Table
              columns={columns}
              rows={alerts}
              rowKey={a => a.id}
              empty={<EmptyState title="No alerts" description="No compliance or fatigue alerts right now." />}
            />
          )}

          {total > LIMIT && (
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 16 }}>
              <button style={s.btnSm} disabled={page === 1} onClick={() => setPage(p => p - 1)}>← Prev</button>
              <span style={{ color: colors.textFaint, fontSize: 13 }}>Page {page} of {pages}</span>
              <button style={s.btnSm} disabled={page >= pages} onClick={() => setPage(p => p + 1)}>Next →</button>
            </div>
          )}
        </Card>
      </div>
    </div>
  )
}
