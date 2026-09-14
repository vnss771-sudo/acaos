import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiHook } from '../../hooks/useApi.js'
import type { ToastHook } from '../../hooks/useToast.js'
import type { View, Workspace, OpsOverview } from '../../types.js'
import { colors, s } from '../../styles.js'
import { Card } from '../../components/ui/Card.js'
import { KpiCard } from '../../components/ui/KpiCard.js'
import { Skeleton } from '../../components/ui/Skeleton.js'
import { EmptyState } from '../../components/ui/EmptyState.js'
import { Badge } from '../../components/ui/Badge.js'
import { Grid } from '../../components/ui/Grid.js'
import { OpsSubNav } from '../../components/ops/OpsSubNav.js'

type Props = { api: ApiHook; workspace: Workspace | null; toast: ToastHook; setView: (v: View) => void }

const SEVERITY_COLOR: Record<string, string> = { LOW: colors.textFaint, MEDIUM: colors.amber, HIGH: colors.red, CRITICAL: colors.purple }

function formatDuration(startTime: string): string {
  const ms = Date.now() - new Date(startTime).getTime()
  const hours = Math.floor(ms / 3_600_000)
  const mins = Math.floor((ms % 3_600_000) / 60_000)
  return hours > 0 ? `${hours}h ${mins}m` : `${mins}m`
}

export function OpsDashboard({ api, workspace, toast, setView }: Props) {
  const [overview, setOverview] = useState<OpsOverview | null>(null)
  const [loading, setLoading] = useState(false)
  const reqRef = useRef(0)

  const fetchOverview = useCallback(() => {
    if (!workspace) return
    const reqId = ++reqRef.current
    setLoading(true)
    api<{ overview: OpsOverview }>(`/api/ops/admin/overview?workspaceId=${workspace.id}`)
      .then(d => { if (reqId === reqRef.current) setOverview(d.overview) })
      .catch(e => { if (reqId === reqRef.current) toast.error(e instanceof Error ? e.message : 'Failed to load Field Ops overview') })
      .finally(() => { if (reqId === reqRef.current) setLoading(false) })
  }, [workspace?.id])

  useEffect(() => { fetchOverview() }, [fetchOverview])

  return (
    <div>
      <OpsSubNav view="ops-dashboard" setView={setView} />

      <div style={{ color: colors.textFaint, fontSize: 12, marginBottom: 16 }}>
        Field Ops is the operational side of the product — crew, job sites, and shift scheduling. It's separate from Leads/Campaigns, which cover sales and outreach.
      </div>

      {loading && !overview ? (
        <Grid cols={4}>
          {[0, 1, 2, 3].map(i => <Card key={i}><Skeleton height={70} /></Card>)}
        </Grid>
      ) : !overview ? (
        <EmptyState title="No Field Ops data yet" description="Add crew members and job sites to get started." />
      ) : (
        <div style={s.stack}>
          <Grid cols={4}>
            <KpiCard label="Active Crew" value={overview.activeCrewCount} />
            <KpiCard label="Job Sites" value={overview.jobSiteCount} />
            <KpiCard label="Open Alerts" value={overview.openAlertCount} color={overview.openAlertCount > 0 ? colors.amber : colors.text} />
            <KpiCard label="Hours This Week" value={overview.thisWeekShiftHours} />
          </Grid>

          {(overview.flaggedShiftsCount > 0 || overview.missingHeatChecksCount > 0 || overview.fatigueAlertsCount > 0) && (
            <Card style={{ borderColor: colors.amber }}>
              <div style={s.sectionHeader}>This week's compliance flags</div>
              <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', fontSize: 13, color: colors.textMuted }}>
                {overview.flaggedShiftsCount > 0 && <span>{overview.flaggedShiftsCount} flagged shift{overview.flaggedShiftsCount === 1 ? '' : 's'}</span>}
                {overview.missingHeatChecksCount > 0 && <span>{overview.missingHeatChecksCount} missing heat check{overview.missingHeatChecksCount === 1 ? '' : 's'}</span>}
                {overview.fatigueAlertsCount > 0 && <span>{overview.fatigueAlertsCount} fatigue alert{overview.fatigueAlertsCount === 1 ? '' : 's'}</span>}
              </div>
            </Card>
          )}

          <Grid cols={2}>
            <Card>
              <div style={s.flexBetween}>
                <div style={s.sectionHeader}>Clocked in now ({overview.clockedInCrew.length})</div>
                <button style={s.btnGhost} onClick={() => setView('ops-shifts')}>View shifts</button>
              </div>
              {overview.clockedInCrew.length === 0 ? (
                <EmptyState title="Nobody is clocked in" />
              ) : (
                <div style={{ display: 'grid', gap: 8 }}>
                  {overview.clockedInCrew.map(shift => (
                    <div key={shift.id} style={{ ...s.flexBetween, padding: '8px 0', borderBottom: `1px solid ${colors.borderLight}` }}>
                      <div>
                        <div style={{ color: colors.text, fontSize: 13, fontWeight: 600 }}>{shift.crewMember.fullName}</div>
                        <div style={{ color: colors.textFaint, fontSize: 12 }}>{shift.jobSite.siteName}</div>
                      </div>
                      <Badge color={colors.green}>{formatDuration(shift.startTime)}</Badge>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <Card>
              <div style={s.flexBetween}>
                <div style={s.sectionHeader}>Open alerts ({overview.openAlertCount})</div>
                <button style={s.btnGhost} onClick={() => setView('ops-alerts')}>View all</button>
              </div>
              {overview.openAlerts.length === 0 ? (
                <EmptyState title="No open alerts" description="Compliance and fatigue alerts will show up here." />
              ) : (
                <div style={{ display: 'grid', gap: 8 }}>
                  {overview.openAlerts.map(alert => (
                    <div key={alert.id} style={{ ...s.flexBetween, padding: '8px 0', borderBottom: `1px solid ${colors.borderLight}` }}>
                      <div style={{ color: colors.text, fontSize: 13 }}>{alert.title}</div>
                      <Badge color={SEVERITY_COLOR[alert.severity] ?? colors.textFaint}>{alert.severity}</Badge>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </Grid>

          <Grid cols={2}>
            <Card>
              <div style={s.flexBetween}>
                <div style={s.sectionHeader}>Recent shifts</div>
                <button style={s.btnGhost} onClick={() => setView('ops-shifts')}>View all</button>
              </div>
              {overview.recentShifts.length === 0 ? (
                <EmptyState title="No shifts recorded yet" />
              ) : (
                <div style={{ display: 'grid', gap: 8 }}>
                  {overview.recentShifts.map(shift => (
                    <div key={shift.id} style={{ padding: '8px 0', borderBottom: `1px solid ${colors.borderLight}` }}>
                      <div style={s.flexBetween}>
                        <span style={{ color: colors.text, fontSize: 13 }}>{shift.crewMember?.fullName ?? '—'}</span>
                        <span style={{ color: colors.textMuted, fontSize: 12 }}>{shift.totalHours}h</span>
                      </div>
                      <div style={{ color: colors.textFaint, fontSize: 12 }}>{shift.jobSite?.siteName ?? '—'} · {new Date(shift.shiftDate).toLocaleDateString()}</div>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <Card>
              <div style={s.flexBetween}>
                <div style={s.sectionHeader}>Upcoming roster</div>
                <button style={s.btnGhost} onClick={() => setView('ops-roster')}>View roster</button>
              </div>
              {overview.upcomingRoster.length === 0 ? (
                <EmptyState title="Nothing published yet" description="Published roster entries for the coming days will appear here." />
              ) : (
                <div style={{ display: 'grid', gap: 8 }}>
                  {overview.upcomingRoster.map(entry => (
                    <div key={entry.id} style={{ padding: '8px 0', borderBottom: `1px solid ${colors.borderLight}` }}>
                      <div style={s.flexBetween}>
                        <span style={{ color: colors.text, fontSize: 13 }}>{entry.crewMember?.fullName ?? '—'}</span>
                        <span style={{ color: colors.textMuted, fontSize: 12 }}>{new Date(entry.rosterDate).toLocaleDateString()}</span>
                      </div>
                      <div style={{ color: colors.textFaint, fontSize: 12 }}>{entry.jobSite?.siteName ?? '—'}</div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </Grid>
        </div>
      )}
    </div>
  )
}
