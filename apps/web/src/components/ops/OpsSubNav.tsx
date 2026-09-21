import React from 'react'
import type { View } from '../../types.js'
import { colors } from '../../styles.js'

// Field Ops's own sub-navigation. The sidebar (and, in hub-nav mode, HubTabs)
// only surface ONE entry point ('ops-dashboard') for all 7 Ops view ids — this
// strip is what actually switches between them, and unlike HubTabs it is always
// rendered regardless of hub-nav mode, since the flat/default nav has no other
// way to move between Ops sub-pages once inside one.
const TABS: { view: View; label: string }[] = [
  { view: 'ops-dashboard', label: 'Dashboard' },
  { view: 'ops-crew', label: 'Crew' },
  { view: 'ops-jobs', label: 'Job Sites' },
  { view: 'ops-shifts', label: 'Shifts' },
  { view: 'ops-roster', label: 'Roster' },
  { view: 'ops-fatigue', label: 'Fatigue' },
  { view: 'ops-alerts', label: 'Alerts' },
]

export function OpsSubNav({ view, setView }: { view: View; setView: (v: View) => void }) {
  return (
    <div role="tablist" aria-label="Field Ops sections" style={{
      display: 'flex', gap: 2, marginBottom: 22, overflowX: 'auto',
      borderBottom: `1px solid ${colors.border}`,
    }}>
      {TABS.map(t => {
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
