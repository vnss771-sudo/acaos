import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiHook } from '../../hooks/useApi.js'
import type { ToastHook } from '../../hooks/useToast.js'
import type { View, Workspace, OpsFatigueRisk, OpsCrewMember } from '../../types.js'
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

type Props = { api: ApiHook; workspace: Workspace | null; toast: ToastHook; setView: (v: View) => void }

type FatigueSummary = { critical: number; high: number; medium: number; low: number }

const RISK_COLOR: Record<string, string> = { LOW: colors.textFaint, MEDIUM: colors.amber, HIGH: colors.red, CRITICAL: colors.purple }

// Read-only report: this view never mutates anything, so there's no Modal and no
// canManage gating — every signed-in workspace member can see it.
export function OpsFatigue({ api, workspace, toast, setView }: Props) {
  const [summary, setSummary] = useState<FatigueSummary | null>(null)
  const [reports, setReports] = useState<OpsFatigueRisk[]>([])
  const [loading, setLoading] = useState(false)
  const [crewNames, setCrewNames] = useState<Record<string, string>>({})

  const fatigueReqRef = useRef(0)
  const fetchFatigue = useCallback(() => {
    if (!workspace) return
    const reqId = ++fatigueReqRef.current
    setLoading(true)
    api<{ summary: FatigueSummary; reports: OpsFatigueRisk[] }>(`/api/ops/fatigue?workspaceId=${workspace.id}`)
      .then(d => {
        if (reqId !== fatigueReqRef.current) return
        setSummary(d.summary)
        setReports(d.reports || [])
      })
      .catch(e => { if (reqId === fatigueReqRef.current) toast.error(e instanceof Error ? e.message : 'Failed to load fatigue report') })
      .finally(() => { if (reqId === fatigueReqRef.current) setLoading(false) })
  }, [workspace?.id])

  useEffect(() => { fetchFatigue() }, [fetchFatigue])

  // Fetched once per workspace so the fatigue rows (which only carry
  // crewMemberId) can show a name — best-effort, so a failure just leaves ids
  // unresolved rather than breaking the report.
  const crewReqRef = useRef(0)
  useEffect(() => {
    if (!workspace) return
    const reqId = ++crewReqRef.current
    api<{ crew: OpsCrewMember[] }>(`/api/ops/crew?workspaceId=${workspace.id}&limit=200`)
      .then(d => {
        if (reqId !== crewReqRef.current) return
        const map: Record<string, string> = {}
        for (const c of d.crew || []) map[c.id] = c.fullName
        setCrewNames(map)
      })
      .catch(() => {})
  }, [workspace?.id])

  const columns: Column<OpsFatigueRisk>[] = [
    { key: 'crewMember', header: 'Crew Member', render: r => crewNames[r.crewMemberId] ?? r.crewMemberId },
    { key: 'riskLevel', header: 'Risk Level', render: r => <Badge color={RISK_COLOR[r.riskLevel] ?? colors.textFaint}>{r.riskLevel}</Badge> },
    { key: 'riskScore', header: 'Score', align: 'right', render: r => r.riskScore },
    { key: 'totalHours7d', header: 'Hours (7d)', align: 'right', render: r => r.totalHours7d },
    { key: 'consecutiveDays', header: 'Consecutive Days', align: 'right', render: r => `${r.consecutiveDays}${r.consecutiveDaysCapped ? '+' : ''}` },
    {
      key: 'recommendation',
      header: 'Recommendation',
      render: r => <span style={{ color: colors.textMuted, fontSize: 12, display: 'block', maxWidth: 320 }}>{r.recommendation}</span>,
    },
  ]

  return (
    <div>
      <OpsSubNav view="ops-fatigue" setView={setView} />

      <div style={s.stack}>
        {loading && !summary ? (
          <Grid cols={4}>
            {[0, 1, 2, 3].map(i => <Card key={i}><Skeleton height={70} /></Card>)}
          </Grid>
        ) : summary && (
          <Grid cols={4}>
            <KpiCard label="Critical" value={summary.critical} color={colors.purple} />
            <KpiCard label="High" value={summary.high} color={colors.red} />
            <KpiCard label="Medium" value={summary.medium} color={colors.amber} />
            <KpiCard label="Low" value={summary.low} color={colors.text} />
          </Grid>
        )}

        <Card>
          <div style={{ ...s.flexBetween, marginBottom: 16 }}>
            <div style={{ ...s.sectionHeader, marginBottom: 0 }}>Crew fatigue report (last 7 days)</div>
            <button style={s.btnGhost} onClick={fetchFatigue} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh'}</button>
          </div>

          {loading && reports.length === 0 ? (
            <Skeleton height={200} />
          ) : (
            <Table
              columns={columns}
              rows={reports}
              rowKey={r => r.crewMemberId}
              empty={<EmptyState title="No active crew members" description="Fatigue risk reports will appear here once active crew members have logged shifts." />}
            />
          )}
        </Card>
      </div>
    </div>
  )
}
