import React from 'react'
import type { View } from '../../types.js'
import { colors } from '../../styles.js'
import { isHubNavEnabled } from '../../lib/hubs.js'

// Sub-navigation for the Work and Crew pages, used only by the flat sidebar nav
// (the rollback mode). With the hub nav on (the default), HubTabs already shows
// exactly these tabs for the active hub, so this renders nothing rather than a
// second, duplicate strip.
const GROUPS: { label: string; tabs: { view: View; label: string }[] }[] = [
  { label: 'Work', tabs: [
    { view: 'ops-find-work', label: 'Find work' },
    { view: 'ops-delivery', label: 'Jobs & margins' },
  ] },
  { label: 'Crew', tabs: [
    { view: 'ops-dashboard', label: 'Overview' },
    { view: 'ops-crew', label: 'Crew' },
    { view: 'ops-shifts', label: 'Shifts' },
    { view: 'ops-roster', label: 'Roster' },
    { view: 'ops-jobs', label: 'Sites' },
    { view: 'ops-fatigue', label: 'Fatigue' },
    { view: 'ops-alerts', label: 'Alerts' },
  ] },
]

export function OpsSubNav({ view, setView, force }: { view: View; setView: (v: View) => void; force?: boolean }) {
  if (!force && isHubNavEnabled()) return null
  const group = GROUPS.find(g => g.tabs.some(t => t.view === view)) ?? GROUPS[1]
  return (
    <div role="tablist" aria-label={`${group.label} sections`} style={{
      display: 'flex', gap: 2, marginBottom: 22, overflowX: 'auto',
      borderBottom: `1px solid ${colors.border}`,
    }}>
      {group.tabs.map(t => {
        const active = t.view === view
        return (
          <button
            key={t.view}
            role="tab"
            aria-selected={active}
            onClick={() => setView(t.view)}
            style={{
              background: 'transparent', border: 'none', cursor: 'pointer',
              padding: '8px 14px', fontSize: 13, fontWeight: active ? 600 : 400,
              color: active ? colors.text : colors.textFaint,
              borderBottom: `2px solid ${active ? colors.blue : 'transparent'}`,
              marginBottom: -1, transition: 'color 0.1s', whiteSpace: 'nowrap',
            }}
          >
            {t.label}
          </button>
        )
      })}
    </div>
  )
}
