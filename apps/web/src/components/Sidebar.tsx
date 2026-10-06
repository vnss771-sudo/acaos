import React from 'react'
import type { View, Workspace } from '../types.js'
import { PLAN_LABELS } from '../types.js'
import { colors } from '../styles.js'
import { HUBS, hubForView, defaultViewForHub } from '../lib/hubs.js'

type NavItem = { id: View; label: string; icon: string }
type NavGroup = { heading?: string; items: NavItem[] }

// The Work pages, each with its own entry; every other ops-* view is a Crew page.
const WORK_VIEWS: ReadonlySet<View> = new Set<View>(['ops-find-work', 'ops-delivery', 'ops-scorecard'])

// Flat nav (the rollback for the hub nav). The first group is the contractor's
// daily loop in order — what needs a decision, find work, the clients behind it,
// the jobs being delivered, the scorecard, the crew doing them. Email outreach and
// analysis sit under their own heading: there when wanted, out of the way otherwise.
const NAV_GROUPS: NavGroup[] = [
  {
    items: [
      { id: 'today', label: 'Today', icon: '☀' },
      { id: 'ops-find-work', label: 'Find work', icon: '⚒' },
      { id: 'prospects', label: 'Clients', icon: '◎' },
      { id: 'ops-delivery', label: 'Jobs & margins', icon: '$' },
      { id: 'ops-scorecard', label: 'Scorecard', icon: '★' },
      { id: 'ops-dashboard', label: 'Crew', icon: '⚡' },
    ],
  },
  {
    heading: 'Outreach',
    items: [
      { id: 'campaigns', label: 'Campaigns', icon: '▣' },
      { id: 'approvals', label: 'To review', icon: '✓' },
      { id: 'inbox', label: 'Inbox', icon: '✉' },
      { id: 'leads', label: 'Leads', icon: '▤' },
      { id: 'missions', label: 'Missions', icon: '◇' },
      { id: 'intelligence', label: 'Analytics', icon: '◈' },
      { id: 'ai', label: 'AI tools', icon: '✦' },
    ],
  },
  {
    heading: 'Account',
    items: [
      { id: 'dashboard', label: 'Overview', icon: '⬡' },
      { id: 'settings', label: 'Settings', icon: '◌' },
      { id: 'billing', label: 'Billing', icon: '◆' },
    ],
  },
]

type SidebarProps = {
  view: View
  setView: (v: View) => void
  email: string
  workspace: Workspace | null
  onLogout: () => void
  isAdmin?: boolean
  // When true, render the consolidated 5-hub nav (behind VITE_HUB_NAV);
  // otherwise the flat grouped nav. Defaults to the grouped nav.
  hubNav?: boolean
}

export function Sidebar({ view, setView, email, workspace, onLogout, isAdmin, hubNav }: SidebarProps) {
  const plan = workspace?.plan ?? 'free'
  const isPro = plan !== 'free'

  return (
    <aside style={{
      width: 224,
      background: colors.bgSurface,
      borderRight: `1px solid ${colors.border}`,
      display: 'flex',
      flexDirection: 'column',
      padding: '20px 0',
      flexShrink: 0
    }}>
      {/* Logo */}
      <div style={{ padding: '0 20px 20px' }}>
        <div style={{ color: colors.blue, fontWeight: 800, fontSize: 17, letterSpacing: 1.5 }}>ACAOS</div>
        {workspace && (
          <div style={{ color: colors.textFaint, fontSize: 12, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {workspace.name}
          </div>
        )}
      </div>

      {/* Nav */}
      <nav style={{ flex: 1 }}>
        {hubNav ? (
          // Consolidated hub nav: five hubs, the active one derived from which hub
          // owns the current view. Selecting a hub opens its first tab. Admin is a
          // tab inside Settings here, so there's no separate Admin button.
          HUBS.map(hub => {
            const active = hubForView(view).id === hub.id
            return (
              <button
                key={hub.id}
                onClick={() => setView(defaultViewForHub(hub, Boolean(isAdmin)))}
                aria-current={active ? 'page' : undefined}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '9px 20px', width: '100%',
                  background: active ? '#1e293b' : 'transparent',
                  border: 'none', cursor: 'pointer',
                  color: active ? '#f1f5f9' : colors.textFaint,
                  fontSize: 14, fontWeight: active ? 600 : 400,
                  borderLeft: `2px solid ${active ? colors.blue : 'transparent'}`,
                  textAlign: 'left', transition: 'all 0.1s'
                }}
              >
                <span aria-hidden="true" style={{ fontSize: 13, opacity: active ? 1 : 0.7 }}>{hub.icon}</span>
                {hub.label}
              </button>
            )
          })
        ) : (
          <>
        {NAV_GROUPS.map((group, gi) => (
          <div key={group.heading ?? 'primary'} style={{ marginTop: gi === 0 ? 0 : 14 }}>
            {group.heading && (
              <div style={{
                padding: '0 20px 6px', color: colors.textFaint, fontSize: 10,
                fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', opacity: 0.65
              }}>
                {group.heading}
              </div>
            )}
            {group.items.map(n => {
              // The single "Field Ops" entry stands in for 7 view ids (its own
              // always-visible sub-nav switches between them — see OpsSubNav) — so
              // it stays highlighted for any of them, not just the exact match.
              // "Crew" stands for every crew page; the Work pages have their own entries.
              const active = n.id === 'ops-dashboard' ? view.startsWith('ops-') && !WORK_VIEWS.has(view) : view === n.id
              return (
                <button
                  key={n.id}
                  onClick={() => setView(n.id)}
                  aria-current={active ? 'page' : undefined}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '9px 20px', width: '100%',
                    background: active ? '#1e293b' : 'transparent',
                    border: 'none', cursor: 'pointer',
                    color: active ? '#f1f5f9' : colors.textFaint,
                    fontSize: 14, fontWeight: active ? 600 : 400,
                    borderLeft: `2px solid ${active ? colors.blue : 'transparent'}`,
                    textAlign: 'left', transition: 'all 0.1s'
                  }}
                >
                  <span aria-hidden="true" style={{ fontSize: 13, opacity: active ? 1 : 0.7 }}>{n.icon}</span>
                  {n.label}
                </button>
              )
            })}
          </div>
        ))}
        {isAdmin && (
          <button
            onClick={() => setView('admin')}
            aria-current={view === 'admin' ? 'page' : undefined}
            style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '9px 20px', width: '100%',
              background: view === 'admin' ? '#1e293b' : 'transparent',
              border: 'none', cursor: 'pointer',
              color: view === 'admin' ? '#f1f5f9' : '#f59e0b',
              fontSize: 14, fontWeight: view === 'admin' ? 600 : 400,
              borderLeft: `2px solid ${view === 'admin' ? '#f59e0b' : 'transparent'}`,
              textAlign: 'left', transition: 'all 0.1s',
              borderTop: `1px solid ${colors.border}`, marginTop: 8
            }}
          >
            <span aria-hidden="true" style={{ fontSize: 13 }}>⚙</span>
            Admin
          </button>
        )}
          </>
        )}
      </nav>

      {/* Plan badge */}
      <div style={{ padding: '12px 20px', borderTop: `1px solid ${colors.border}` }}>
        <div style={{
          fontSize: 11, fontWeight: 700, letterSpacing: '0.06em',
          color: isPro ? colors.green : colors.textFaint,
          textTransform: 'uppercase',
          marginBottom: 8
        }}>
          {PLAN_LABELS[plan] ?? plan} plan
        </div>
        <div style={{ fontSize: 12, color: colors.textFaint, marginBottom: 10, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {email}
        </div>
        <button
          onClick={onLogout}
          style={{
            width: '100%', padding: '7px 12px', borderRadius: 6,
            border: `1px solid ${colors.border}`, background: 'transparent',
            color: colors.textMuted, cursor: 'pointer', fontSize: 12,
            textAlign: 'center'
          }}
        >
          Sign out
        </button>
      </div>
    </aside>
  )
}
