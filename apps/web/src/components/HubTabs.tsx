import React from 'react'
import type { View } from '../types.js'
import { hubForView, visibleTabs } from '../lib/hubs.js'
import { colors } from '../styles.js'

// The sub-tab strip for the active hub, shown under the header when the hub nav is
// on. Renders nothing for single-view hubs (Home, Inbox) — there's nothing to switch
// between, so no chrome. Selecting a tab routes via the existing `setView`, so the
// underlying page rendering is unchanged.
export function HubTabs({ view, setView, isAdmin }: {
  view: View
  setView: (v: View) => void
  isAdmin: boolean
}) {
  const hub = hubForView(view)
  const tabs = visibleTabs(hub, isAdmin)
  if (tabs.length <= 1) return null

  return (
    <div role="tablist" aria-label={`${hub.label} sections`} style={{
      display: 'flex', gap: 2, marginBottom: 22,
      borderBottom: `1px solid ${colors.border}`,
    }}>
      {tabs.map(t => {
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
              marginBottom: -1, transition: 'color 0.1s',
            }}
          >
            {t.label}
          </button>
        )
      })}
    </div>
  )
}
