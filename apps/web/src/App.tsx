import React, { useEffect, useState, useCallback, useMemo, lazy, Suspense } from 'react'
import type { User, Workspace, View } from './types.js'
import { canManageWorkspace } from './types.js'
import { useApi } from './hooks/useApi.js'
import { useToast } from './hooks/useToast.js'
import { ToastContainer } from './components/Toast.js'
import { Sidebar } from './components/Sidebar.js'
import { Drawer } from './components/ui/Drawer.js'
import { AuthScreen } from './components/AuthScreen.js'
import { ReauthModal } from './components/ReauthModal.js'
import { OnboardingWizard } from './components/OnboardingWizard.js'
import { CommandPalette } from './components/CommandPalette.js'
import { HubTabs } from './components/HubTabs.js'
import { SkipLink } from './components/SkipLink.js'
import { isHubNavEnabled, hubForView } from './lib/hubs.js'
import { isInvestorDemoRequested, clearInvestorDemo, removeDemoUrlFlag } from './lib/demoMode.js'
import { makeDemoApi, DEMO_USER, DEMO_WORKSPACES } from './lib/demoApi.js'
import { Spinner } from './components/Spinner.js'
import { useIsTablet } from './hooks/useMediaQuery.js'
import { colors } from './styles.js'

// Code-split the route views: each becomes its own chunk fetched on first
// navigation, instead of shipping the entire app (admin/billing/settings
// included) in the initial bundle. React.lazy needs a default export, so adapt
// each named export.
const Dashboard = lazy(() => import('./views/Dashboard.js').then(m => ({ default: m.Dashboard })))
const Campaigns = lazy(() => import('./views/Campaigns.js').then(m => ({ default: m.Campaigns })))
const MissionsView = lazy(() => import('./views/Missions.js').then(m => ({ default: m.MissionsView })))
const ApprovalsView = lazy(() => import('./views/Approvals.js').then(m => ({ default: m.ApprovalsView })))
const Leads = lazy(() => import('./views/Leads.js').then(m => ({ default: m.Leads })))
const AiTools = lazy(() => import('./views/AiTools.js').then(m => ({ default: m.AiTools })))
const Billing = lazy(() => import('./views/Billing.js').then(m => ({ default: m.Billing })))
const Settings = lazy(() => import('./views/Settings.js').then(m => ({ default: m.Settings })))
const Intelligence = lazy(() => import('./views/Intelligence.js').then(m => ({ default: m.Intelligence })))
const ProspectsView = lazy(() => import('./views/Prospects.js').then(m => ({ default: m.ProspectsView })))
const AdminView = lazy(() => import('./views/Admin.js').then(m => ({ default: m.AdminView })))
const InboxView = lazy(() => import('./views/Inbox.js').then(m => ({ default: m.InboxView })))

function ViewFallback() {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', padding: '64px 0' }}>
      <Spinner size={20} color={colors.blue} />
    </div>
  )
}

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

// Security: reset/verify/invite tokens are delivered in the URL fragment (after
// '#'), not the query string. Fragments are never sent to the server (no Referer
// leak, no proxy/access-log exposure) — the SPA reads them client-side.
function getHashParam(key: string) {
  const hash = window.location.hash.replace(/^#/, '')
  return new URLSearchParams(hash).get(key)
}

// Drop the fragment (which carries a sensitive token) from the URL without a
// reload, leaving any query string intact.
function clearUrlHash() {
  window.history.replaceState({}, '', window.location.pathname + window.location.search)
}

export function App() {
  // Access token is held in memory only. On load it is re-derived from the
  // HttpOnly refresh cookie via /api/auth/refresh (see the boot effect below).
  // Investor/demo mode: render the real shell + views against seeded data with
  // no backend. Decided once at mount; the real auth/api paths are inert while on.
  const [demo] = useState(() => isInvestorDemoRequested())
  const [token, setToken] = useState<string | null>(null)
  const [resetToken] = useState<string | null>(() => getHashParam('reset'))
  const [inviteToken] = useState<string | null>(() => getHashParam('invite'))
  const [verifyToken] = useState<string | null>(() => getHashParam('verify'))
  const [user, setUser] = useState<User | null>(null)
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [activeWsId, setActiveWsId] = useState<string | null>(null)
  const [view, setView] = useState<View>('dashboard')
  // Resolved once per session — the hub-nav flag is static (env / localStorage).
  const [hubNav] = useState(isHubNavEnabled)
  const [booting, setBooting] = useState(true)
  // At tablet/mobile widths the sidebar collapses into a hamburger-triggered
  // drawer; `navOpen` controls it. Desktop renders the sidebar inline.
  const isTablet = useIsTablet()
  const [navOpen, setNavOpen] = useState(false)
  // Step-up: set when any authed API call returns 403 {code:"REAUTH_REQUIRED"}.
  // While true the ReauthModal is shown; on success the user can retry the action.
  const [reauthRequired, setReauthRequired] = useState(false)

  const { toasts, toast, removeToast } = useToast()

  // Memoized so its identity is stable: `api` depends on it (useApi), and several
  // views deliberately key data-loading effects on `api`. A fresh logout every
  // render would churn `api` and defeat that.
  const logout = useCallback(() => {
    // In demo mode "Sign out" exits the demo back to the real app.
    if (isInvestorDemoRequested()) {
      clearInvestorDemo()
      removeDemoUrlFlag()
      window.location.reload()
      return
    }
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
  const realApi = useApi(token, logout, setToken, onReauthRequired)
  // Stable demo api identity (views key data-loading effects on `api`).
  const demoApi = useMemo(() => makeDemoApi(), [])
  const api = demo ? demoApi : realApi

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

  // Demo mode: seed a session from fixtures and skip all auth round-trips.
  useEffect(() => {
    if (!demo) return
    setUser(DEMO_USER)
    setWorkspaces(DEMO_WORKSPACES)
    setActiveWsId(DEMO_WORKSPACES[0].id)
    setBooting(false)
  }, [demo])

  // Boot: try to re-establish a session from the refresh cookie. If it fails,
  // there is no session — show the auth screen.
  useEffect(() => {
    if (demo) return
    let cancelled = false
    refreshAccessToken().then(ok => {
      if (!cancelled && !ok) setBooting(false)
    })
    return () => { cancelled = true }
  }, [refreshAccessToken, demo])

  // Once we have an access token, load the user + workspaces.
  useEffect(() => {
    if (demo || !token) return
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
    // Token travels in the POST body, never the URL path, so it can't leak via
    // API access / proxy logs. Clear the fragment after firing regardless.
    fetch(`${API}/api/auth/verify-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: verifyToken }),
    })
      .then(() => clearUrlHash())
      .catch(() => {})
  }, [verifyToken])

  // Accept a pending invite once we know who the user is
  useEffect(() => {
    if (!inviteToken || !token || !user) return
    fetch(`${API}/api/auth/invite/accept`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: inviteToken }),
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
    dashboard: 'Home',
    intelligence: 'Analytics',
    prospects: 'Prospects',
    missions: 'Missions',
    campaigns: 'Campaigns',
    approvals: 'To Review',
    inbox: 'Inbox',
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
      <SkipLink />
      {isTablet ? (
        <Drawer open={navOpen} onClose={() => setNavOpen(false)}>
          <Sidebar
            view={view}
            setView={v => { setView(v); setNavOpen(false) }}
            email={user.email}
            workspace={activeWorkspace}
            onLogout={logout}
            isAdmin={isAdmin}
            hubNav={hubNav}
          />
        </Drawer>
      ) : (
        <Sidebar
          view={view}
          setView={setView}
          email={user.email}
          workspace={activeWorkspace}
          onLogout={logout}
          isAdmin={isAdmin}
          hubNav={hubNav}
        />
      )}

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, overflowY: 'auto' }}>
        {/* Investor/demo banner — sample data, no live backend. */}
        {demo && (
          <div style={{
            background: '#1e3a8a', borderBottom: '1px solid #3b82f6',
            padding: '8px 28px', display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0
          }}>
            <span aria-hidden="true">★</span>
            <span style={{ fontSize: 13, color: '#dbeafe', flex: 1 }}>
              <strong>Investor demo</strong> — sample data, no live backend.
            </span>
            <button
              onClick={logout}
              style={{
                background: '#3b82f6', color: '#fff', border: 'none', borderRadius: 6,
                padding: '5px 14px', fontSize: 12, fontWeight: 700, cursor: 'pointer'
              }}
            >
              Exit demo
            </button>
          </div>
        )}

        {/* Top bar */}
        <header style={{
          padding: '16px 28px', borderBottom: `1px solid ${colors.border}`,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          flexShrink: 0, background: colors.bgSurface
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
            {isTablet && (
              <button
                aria-label="Open navigation"
                onClick={() => setNavOpen(true)}
                style={{
                  background: 'transparent', border: `1px solid ${colors.border}`, borderRadius: 6,
                  color: colors.textMuted, cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: '4px 9px'
                }}
              >
                ☰
              </button>
            )}
            <h1 style={{ color: colors.textMuted, fontSize: 12, letterSpacing: '0.1em', fontWeight: 700, margin: 0, textTransform: 'uppercase' }}>
              {hubNav ? hubForView(view).label : VIEW_TITLE[view]}
            </h1>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {/* Command palette hint — also opens it on click. */}
          <button
            type="button"
            aria-label="Open command palette"
            title="Command palette"
            onClick={() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }))}
            style={{
              display: 'flex', alignItems: 'center', gap: 6, background: '#0b1220',
              border: `1px solid ${colors.border}`, borderRadius: 6, color: colors.textFaint,
              cursor: 'pointer', fontSize: 12, padding: '5px 10px',
            }}
          >
            <span aria-hidden="true">⌘K</span>
            <span style={{ color: colors.textMuted }}>Search</span>
          </button>

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
          </div>
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
        <main id="main-content" tabIndex={-1} style={{ flex: 1, padding: '24px 28px', maxWidth: 1200, width: '100%' }}>
          {/* Hub sub-tabs: switch between the pages within the active hub. Renders
              nothing for single-page hubs or when the hub nav is off. */}
          {hubNav && <HubTabs view={view} setView={setView} isAdmin={isAdmin} />}
          <ErrorBoundary>
            <Suspense fallback={<ViewFallback />}>
            {view === 'dashboard' && <Dashboard {...commonProps} setView={setView} />}
            {view === 'intelligence' && <Intelligence {...commonProps} setView={setView} />}
            {view === 'prospects' && <ProspectsView {...commonProps} canManage={canManage} />}
            {view === 'missions' && <MissionsView {...commonProps} canManage={canManage} />}
            {view === 'campaigns' && <Campaigns {...commonProps} canManage={canManage} />}
            {view === 'approvals' && <ApprovalsView {...commonProps} canManage={canManage} />}
            {view === 'inbox' && <InboxView {...commonProps} />}
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
            </Suspense>
          </ErrorBoundary>
        </main>
      </div>

      {/* Global ⌘K / Ctrl+K / "/" command palette — jump to any screen. */}
      <CommandPalette setView={setView} isAdmin={isAdmin} />

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
