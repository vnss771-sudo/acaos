import React from 'react'
import type { View, Workspace } from '../types.js'
import { PLAN_LABELS, STAGE_COLOR } from '../types.js'
import { colors } from '../styles.js'

type NavItem = { id: View; label: string; icon: string }

const NAV: NavItem[] = [
  { id: 'intelligence', label: 'Intelligence', icon: '◈' },
  { id: 'prospects', label: 'Prospects', icon: '◎' },
  { id: 'dashboard', label: 'Dashboard', icon: '⬡' },
  { id: 'missions', label: 'Missions', icon: '◇' },
  { id: 'campaigns', label: 'Campaigns', icon: '▣' },
  { id: 'leads', label: 'Leads', icon: '▤' },
  { id: 'ai', label: 'AI Tools', icon: '✦' },
  { id: 'billing', label: 'Billing', icon: '◆' },
  { id: 'settings', label: 'Settings', icon: '◌' }
]

type SidebarProps = {
  view: View
  setView: (v: View) => void
  email: string
  workspace: Workspace | null
  onLogout: () => void
  isAdmin?: boolean
}

export function Sidebar({ view, setView, email, workspace, onLogout, isAdmin }: SidebarProps) {
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
        {NAV.map(n => {
          const active = view === n.id
          return (
            <button
              key={n.id}
              onClick={() => setView(n.id)}
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
              <span style={{ fontSize: 13, opacity: active ? 1 : 0.7 }}>{n.icon}</span>
              {n.label}
            </button>
          )
        })}
        {isAdmin && (
          <button
            onClick={() => setView('admin')}
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
            <span style={{ fontSize: 13 }}>⚙</span>
            Admin
          </button>
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
