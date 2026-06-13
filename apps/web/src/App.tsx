import React, { useEffect, useState, useCallback } from 'react'
import type { User, Workspace, View } from './types.js'
import { useApi } from './hooks/useApi.js'
import { useToast } from './hooks/useToast.js'
import { ToastContainer } from './components/Toast.js'
import { Sidebar } from './components/Sidebar.js'
import { AuthScreen } from './components/AuthScreen.js'
import { Dashboard } from './views/Dashboard.js'
import { Campaigns } from './views/Campaigns.js'
import { Leads } from './views/Leads.js'
import { AiTools } from './views/AiTools.js'
import { Billing } from './views/Billing.js'
import { Settings } from './views/Settings.js'
import { Intelligence } from './views/Intelligence.js'
import { ProspectsView } from './views/Prospects.js'
import { colors } from './styles.js'

const API = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '')

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { hasError: boolean; error?: Error }> {
  constructor(props: { children: React.ReactNode }) {
    super(props)
    this.state = { hasError: false }
  }
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error }
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: '40px', textAlign: 'center', color: '#ef4444' }}>
          <div style={{ fontSize: 32, marginBottom: 16 }}>⚠</div>
          <div style={{ fontSize: 18, marginBottom: 8 }}>Something went wrong</div>
          <div style={{ fontSize: 13, color: '#64748b', marginBottom: 24 }}>{this.state.error?.message}</div>
          <button onClick={() => window.location.reload()} style={{ padding: '8px 20px', borderRadius: 6, background: '#2563eb', color: '#fff', border: 'none', cursor: 'pointer' }}>
            Reload
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

function getUrlParam(key: string) {
  return new URLSearchParams(window.location.search).get(key)
}

export function App() {
  const [token, setToken] = useState<string | null>(localStorage.getItem('acaos_token'))
  const [resetToken] = useState<string | null>(() => getUrlParam('reset'))
  const [inviteToken] = useState<string | null>(() => getUrlParam('invite'))
  const [verifyToken] = useState<string | null>(() => getUrlParam('verify'))
  const [user, setUser] = useState<User | null>(null)
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [activeWsId, setActiveWsId] = useState<string | null>(null)
  const [view, setView] = useState<View>('dashboard')
  const [booting, setBooting] = useState(true)

  const { toasts, toast, removeToast } = useToast()

  function logout() {
    const refreshToken = localStorage.getItem('acaos_refresh')
    if (refreshToken) {
      fetch(`${API}/api/auth/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken })
      }).catch(() => {})
    }
    localStorage.removeItem('acaos_token')
    localStorage.removeItem('acaos_refresh')
    setToken(null)
    setUser(null)
    setWorkspaces([])
    setActiveWsId(null)
  }

  const api = useApi(token, logout)

  // Transparent access token refresh
  const refreshAccessToken = useCallback(async () => {
    const refreshToken = localStorage.getItem('acaos_refresh')
    if (!refreshToken) return false
    try {
      const res = await fetch(`${API}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken })
      })
      const data = await res.json()
      if (!res.ok) return false
      localStorage.setItem('acaos_token', data.token)
      if (data.refreshToken) localStorage.setItem('acaos_refresh', data.refreshToken)
      setToken(data.token)
      return true
    } catch { return false }
  }, [])

  useEffect(() => {
    if (!token) { setBooting(false); return }
    api<{ user: User; workspaces: Workspace[] }>('/api/auth/me')
      .then(d => {
        setUser(d.user)
        const wsList = Array.isArray(d.workspaces) ? d.workspaces : []
        setWorkspaces(wsList)
        if (wsList.length > 0) {
          const savedId = localStorage.getItem('acaos_workspace')
          const found = savedId ? wsList.find(w => w.id === savedId) : null
          setActiveWsId(found ? found.id : wsList[0].id)
        }
      })
      .catch(async () => {
        const refreshed = await refreshAccessToken()
        if (!refreshed) logout()
      })
      .finally(() => setBooting(false))
  }, [token])

  const activeWorkspace = workspaces.find(w => w.id === activeWsId) ?? null

  function handleWorkspaceUpdate(updated: Workspace) {
    setWorkspaces(prev => prev.map(w => w.id === updated.id ? { ...w, ...updated } : w))
  }

  function handleSetActiveWs(id: string) {
    setActiveWsId(id)
    localStorage.setItem('acaos_workspace', id)
  }

  if (booting) {
    return (
      <div style={{ minHeight: '100vh', background: colors.bg, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ color: colors.textFaint, fontSize: 14 }}>Loading…</div>
      </div>
    )
  }

  if (!token || !user) {
    return (
      <>
        <AuthScreen
          onToken={(t, rt) => { setToken(t); if (rt) localStorage.setItem('acaos_refresh', rt) }}
          resetToken={resetToken}
          inviteToken={inviteToken}
        />
        <ToastContainer toasts={toasts} onRemove={removeToast} />
      </>
    )
  }

  // Verify email address when ?verify=TOKEN is present
  useEffect(() => {
    if (!verifyToken) return
    fetch(`${API}/api/auth/verify-email/${verifyToken}`)
      .then(() => window.history.replaceState({}, '', window.location.pathname))
      .catch(() => {})
  }, [verifyToken])

  // Accept a pending invite once we know who the user is
  useEffect(() => {
    if (!inviteToken || !token || !user) return
    fetch(`${API}/api/auth/invite/${inviteToken}/accept`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    }).then(r => r.json()).then(d => {
      if (d.workspaceId) {
        window.history.replaceState({}, '', window.location.pathname)
        window.location.reload()
      }
    }).catch(() => {})
  }, [inviteToken, token, user?.id])

  const VIEW_TITLE: Record<View, string> = {
    dashboard: 'Dashboard',
    intelligence: 'Acquisition Intelligence',
    prospects: 'Prospects',
    campaigns: 'Campaigns',
    leads: 'Leads',
    ai: 'AI Tools',
    billing: 'Billing',
    settings: 'Settings'
  }

  const commonProps = { api, workspace: activeWorkspace, toast }

  return (
    <div style={{
      display: 'flex', minHeight: '100vh',
      background: colors.bg, color: colors.text,
      fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif'
    }}>
      <Sidebar
        view={view}
        setView={setView}
        email={user.email}
        workspace={activeWorkspace}
        onLogout={logout}
      />

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, overflowY: 'auto' }}>
        {/* Top bar */}
        <header style={{
          padding: '16px 28px', borderBottom: `1px solid ${colors.border}`,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          flexShrink: 0, background: colors.bgSurface
        }}>
          <h1 style={{ color: colors.textMuted, fontSize: 12, letterSpacing: '0.1em', fontWeight: 700, margin: 0, textTransform: 'uppercase' }}>
            {VIEW_TITLE[view]}
          </h1>

          {/* Workspace switcher */}
          {workspaces.length > 1 && (
            <select
              value={activeWsId ?? ''}
              onChange={e => handleSetActiveWs(e.target.value)}
              style={{
                padding: '6px 12px', borderRadius: 6, border: `1px solid ${colors.border}`,
                background: '#0b1220', color: colors.text, fontSize: 13, cursor: 'pointer'
              }}
            >
              {workspaces.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          )}
        </header>

        {/* Main content */}
        <main style={{ flex: 1, padding: '24px 28px', maxWidth: 1200, width: '100%' }}>
          <ErrorBoundary>
            {view === 'dashboard' && <Dashboard {...commonProps} setView={setView} />}
            {view === 'intelligence' && <Intelligence {...commonProps} setView={setView} />}
            {view === 'prospects' && <ProspectsView {...commonProps} />}
            {view === 'campaigns' && <Campaigns {...commonProps} />}
            {view === 'leads' && <Leads {...commonProps} />}
            {view === 'ai' && <AiTools {...commonProps} />}
            {view === 'billing' && <Billing {...commonProps} />}
            {view === 'settings' && (
              <Settings
                {...commonProps}
                user={user}
                onUserUpdate={setUser}
                onWorkspaceUpdate={handleWorkspaceUpdate}
              />
            )}
          </ErrorBoundary>
        </main>
      </div>

      <ToastContainer toasts={toasts} onRemove={removeToast} />
    </div>
  )
}
