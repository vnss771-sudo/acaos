import type { View } from '../types.js'

// ── Contractor-first hub navigation (on by default) ─────────────────────
// The product is one loop for a trade business — find work, win it, run it,
// learn what pays — so the hubs follow that loop in order:
//
//   Today    → Today (what needs a decision) · Overview (the old Home dashboard)
//   Work     → Find work · Clients · Jobs & margins
//   Crew     → Overview · Crew · Shifts · Roster · Sites · Fatigue · Alerts
//   Outreach → Campaigns · To review · Inbox · Leads · Missions · Analytics · AI tools
//   Settings → Settings · Billing · Admin
//
// NAV-ONLY grouping: no view or route is deleted and every `view` id stays valid,
// so the command palette and deep links keep working.

export type HubId = 'today' | 'work' | 'crew' | 'outreach' | 'settings'

export type HubTab = { view: View; label: string; adminOnly?: boolean }
export type Hub = { id: HubId; label: string; icon: string; tabs: HubTab[] }

export const HUBS: Hub[] = [
  { id: 'today', label: 'Today', icon: '☀', tabs: [
    { view: 'today', label: 'Today' },
    { view: 'dashboard', label: 'Overview' },
  ] },
  { id: 'work', label: 'Work', icon: '⚒', tabs: [
    { view: 'ops-find-work', label: 'Find work' },
    { view: 'prospects', label: 'Clients' },
    { view: 'ops-delivery', label: 'Jobs & margins' },
  ] },
  { id: 'crew', label: 'Crew', icon: '⚡', tabs: [
    { view: 'ops-dashboard', label: 'Overview' },
    { view: 'ops-crew', label: 'Crew' },
    { view: 'ops-shifts', label: 'Shifts' },
    { view: 'ops-roster', label: 'Roster' },
    { view: 'ops-jobs', label: 'Sites' },
    { view: 'ops-fatigue', label: 'Fatigue' },
    { view: 'ops-alerts', label: 'Alerts' },
  ] },
  { id: 'outreach', label: 'Outreach', icon: '▣', tabs: [
    { view: 'campaigns', label: 'Campaigns' },
    { view: 'approvals', label: 'To review' },
    { view: 'inbox', label: 'Inbox' },
    { view: 'leads', label: 'Leads' },
    { view: 'missions', label: 'Missions' },
    { view: 'intelligence', label: 'Analytics' },
    { view: 'ai', label: 'AI tools' },
  ] },
  { id: 'settings', label: 'Settings', icon: '◌', tabs: [
    { view: 'settings', label: 'Settings' },
    { view: 'billing', label: 'Billing' },
    { view: 'admin', label: 'Admin', adminOnly: true },
  ] },
]

// The hub that owns a given view. Falls back to Today for any unmapped view so the
// nav can never end up with no hub highlighted.
export function hubForView(view: View): Hub {
  return HUBS.find(h => h.tabs.some(t => t.view === view)) ?? HUBS[0]
}

// Tabs visible to this user — drops admin-only tabs (e.g. Admin) for non-admins so
// the Settings hub doesn't advertise a tab they can't open.
export function visibleTabs(hub: Hub, isAdmin: boolean): HubTab[] {
  return hub.tabs.filter(t => !t.adminOnly || isAdmin)
}

// The view a hub opens to (its first visible tab).
export function defaultViewForHub(hub: Hub, isAdmin: boolean): View {
  const tabs = visibleTabs(hub, isAdmin)
  return (tabs[0] ?? hub.tabs[0]).view
}

// Whether the consolidated hub nav is active. A runtime localStorage override wins
// (so it can be dogfooded — or rolled back — in a browser without a rebuild);
// otherwise the build-time VITE_HUB_NAV flag decides. Defaults ON; VITE_HUB_NAV=false
// (or localStorage acaos_hub_nav=0) is a rollback switch to the flat sidebar nav.
export function isHubNavEnabled(): boolean {
  try {
    const override = localStorage.getItem('acaos_hub_nav')
    if (override === '1' || override === 'true') return true
    if (override === '0' || override === 'false') return false
  } catch { /* localStorage unavailable — fall through to the build-time flag */ }
  const flag = import.meta.env.VITE_HUB_NAV
  return flag !== 'false' && flag !== '0'
}
