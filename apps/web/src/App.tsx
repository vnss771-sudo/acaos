import React, { useEffect, useState, useCallback } from 'react'
import type { User, Workspace, View } from './types.js'
import { canManageWorkspace } from './types.js'
import { useApi } from './hooks/useApi.js'
import { useToast } from './hooks/useToast.js'
import { ToastContainer } from './components/Toast.js'
import { Sidebar } from './components/Sidebar.js'
import { AuthScreen } from './components/AuthScreen.js'
import { ReauthModal } from './components/ReauthModal.js'
import { Dashboard } from './views/Dashboard.js'
import { Campaigns } from './views/Campaigns.js'
import { MissionsView } from './views/Missions.js'
import { ApprovalsView } from './views/Approvals.js'
import { Leads } from './views/Leads.js'
import { AiTools } from './views/AiTools.js'
import { Billing } from './views/Billing.js'
import { Settings } from './views/Settings.js'
import { Intelligence } from './views/Intelligence.js'
import { ProspectsView } from './views/Prospects.js'
import { AdminView } from './views/Admin.js'
import { OnboardingWizard } from './components/OnboardingWizard.js'
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
  // Access token is held in memory only. On load it is re-derived from the
  // HttpOnly refresh cookie via /api/auth/refresh (see the boot effect below).
  const [token, setToken] = useState<string | null>(null)
  const [resetToken] = useState<string | null>(() => getUrlParam('reset'))
  const [inviteToken] = useState<string | null>(() => getUrlParam('invite'))
  const [verifyToken] = useState<string | null>(() => getUrlParam('verify'))
  const [user, setUser] = useState<User | null>(null)
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [activeWsId, setActiveWsId] = useState<string | null>(null)
  const [view, setView] = useState<View>('dashboard')
  const [booting, setBooting] = useState(true)
  // Step-up: set when any authed API call returns 403 {code:"REAUTH_REQUIRED"}.
  // While true the ReauthModal is shown; on success the user can retry the action.
  const [reauthRequired, setReauthRequired] = useState(false)

  const { toasts, toast, removeToast } = useToast()

  // Memoized so its identity is stable: `api` depends on it (useApi), and several
  // views deliberately key data-loading effects on `api`. A fresh logout every
  // render would churn `api` and defeat that.
  const logout = useCallback(() => {
    // The refresh cookie is HttpOnly; the server clears it. A custom header
    // satisfies the CSRF guard.
    fetch(`${API}/api/auth/logout`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'X-CSRF-Protection': '1' }
    }).catch(() => {})
    setToken(null)
    setUser(null)
    setWorkspaces([])
    setActiveWsId(null)
  }, [])

  const onReauthRequired = useCallback(() => setReauthRequired(true), [])
  const api = useApi(token, logout, setToken, onReauthRequired)

  // Exchange the HttpOnly refresh cookie for a fresh access token. Returns true
  // when a session was (re)established.
  const refreshAccessToken = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'X-CSRF-Protection': '1' }
      })
      if (!res.ok) return false
      const data = await res.json()
      setToken(data.token)
      return true
    } catch { return false }
  }, [])

  // Boot: try to re-establish a session from the refresh cookie. If it fails,
  // there is no session — show the auth screen.
  useEffect(() => {
    let cancelled = false
    refreshAccessToken().then(ok => {
      if (!cancelled && !ok) setBooting(false)
    })
    return () => { cancelled = true }
  }, [refreshAccessToken])

  // Once we have an access token, load the user + workspaces.
  useEffect(() => {
    if (!token) return
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
      .catch(() => logout())
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

  // Verify email address when ?verify=TOKEN is present (runs once on mount)
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
          onToken={(t) => setToken(t)}
          resetToken={resetToken}
          inviteToken={inviteToken}
        />
        <ToastContainer toasts={toasts} onRemove={removeToast} />
      </>
    )
  }

  // Gate the admin UI on the backend's authoritative claim (from /api/auth/me),
  // not a build-time env var — the API enforces /api/admin server-side regardless.
  const isAdmin = Boolean(user.isPlatformAdmin)

  const VIEW_TITLE: Record<View, string> = {
    dashboard: 'Acquisition Radar',
    intelligence: 'Acquisition Intelligence',
    prospects: 'Prospects',
    missions: 'Missions',
    campaigns: 'Campaigns',
    approvals: 'Review Queue',
    leads: 'Leads',
    ai: 'AI Tools',
    billing: 'Billing',
    settings: 'Settings',
    admin: 'Admin Panel'
  }

  const commonProps = { api, workspace: activeWorkspace, toast }
  // Role-aware UI: members get a read-mostly view; admin-only controls are hidden
  // (the backend enforces the same gate, so this is UX, not the security boundary).
  const canManage = canManageWorkspace(activeWorkspace)

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
        isAdmin={isAdmin}
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

        {/* Past-due payment warning banner */}
        {activeWorkspace?.subscriptionStatus === 'past_due' && (
          <div role="alert" style={{
            background: '#7c2d12', borderBottom: '1px solid #b45309',
            padding: '10px 28px', display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0
          }}>
            <span aria-hidden="true" style={{ fontSize: 16 }}>⚠</span>
            <span style={{ fontSize: 13, color: '#fde68a', flex: 1 }}>
              Your last payment failed. AI features are limited until billing is updated.
            </span>
            <button
              onClick={() => setView('billing')}
              style={{
                background: '#b45309', color: '#fff', border: 'none', borderRadius: 6,
                padding: '5px 14px', fontSize: 12, fontWeight: 700, cursor: 'pointer'
              }}
            >
              Update billing
            </button>
          </div>
        )}

        {/* Main content */}
        <main style={{ flex: 1, padding: '24px 28px', maxWidth: 1200, width: '100%' }}>
          <ErrorBoundary>
            {view === 'dashboard' && <Dashboard {...commonProps} setView={setView} />}
            {view === 'intelligence' && <Intelligence {...commonProps} setView={setView} />}
            {view === 'prospects' && <ProspectsView {...commonProps} canManage={canManage} />}
            {view === 'missions' && <MissionsView {...commonProps} canManage={canManage} />}
            {view === 'campaigns' && <Campaigns {...commonProps} canManage={canManage} />}
            {view === 'approvals' && <ApprovalsView {...commonProps} canManage={canManage} />}
            {view === 'leads' && <Leads {...commonProps} canManage={canManage} />}
            {view === 'ai' && <AiTools {...commonProps} />}
            {view === 'billing' && <Billing {...commonProps} />}
            {view === 'settings' && (
              <Settings
                {...commonProps}
                canManage={canManage}
                user={user}
                onUserUpdate={setUser}
                onWorkspaceUpdate={handleWorkspaceUpdate}
              />
            )}
            {view === 'admin' && isAdmin && <AdminView api={api} toast={toast} />}
          </ErrorBoundary>
        </main>
      </div>

      {/* Onboarding wizard — shown once per workspace until dismissed. Hidden for
          members: it performs workspace seed/ICP writes that require admin. */}
      {activeWorkspace && !activeWorkspace.onboardingCompleted && canManage && (
        <OnboardingWizard
          workspace={activeWorkspace}
          api={api}
          toast={toast}
          onComplete={() => handleWorkspaceUpdate({ ...activeWorkspace, onboardingCompleted: true })}
        />
      )}

      {/* Step-up re-authentication — shown when an authed call needs a fresh
          credential proof. After a successful reauth the user retries the action. */}
      {reauthRequired && (
        <ReauthModal
          api={api}
          mfaEnabled={!!user.totpEnabled}
          onSuccess={() => {
            setReauthRequired(false)
            toast.success('Identity confirmed — please retry your action')
          }}
          onCancel={() => setReauthRequired(false)}
        />
      )}

      <ToastContainer toasts={toasts} onRemove={removeToast} />
    </div>
  )
}
