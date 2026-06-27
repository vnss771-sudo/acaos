import type { View } from '../types.js'

// ── Consolidated 5-hub navigation (Phase 1, behind the VITE_HUB_NAV flag) ────────
// The product is one acquisition loop that had grown to 11 top-level pages. This
// collapses them into five hubs, each hosting the existing page views as sub-tabs:
//
//   Home      → Dashboard
//   Prospects → Prospects · Leads · Analytics (was Intelligence)
//   Outreach  → Campaigns · Missions · To Review (was Approvals) · AI Tools
//   Inbox     → Inbox (replies / response triage only — draft approval lives in Outreach)
//   Settings  → Settings (incl. Compliance, Team, Mailboxes) · Billing · Admin
//
// Phase 1 is a NAV-ONLY refactor: nothing is merged at the data layer, no route or
// view is deleted, and every existing `view` id stays valid — so the command palette
// and any deep links keep working. Later phases fold AI Tools into contextual actions
// inside the hubs and clean up the now-redundant standalone pages.

export type HubId = 'home' | 'prospects' | 'outreach' | 'inbox' | 'settings'

export type HubTab = { view: View; label: string; adminOnly?: boolean }
export type Hub = { id: HubId; label: string; icon: string; tabs: HubTab[] }

export const HUBS: Hub[] = [
  { id: 'home', label: 'Home', icon: '⬡', tabs: [
    { view: 'dashboard', label: 'Home' },
  ] },
  { id: 'prospects', label: 'Prospects', icon: '◎', tabs: [
    { view: 'prospects', label: 'Prospects' },
    { view: 'leads', label: 'Leads' },
    { view: 'intelligence', label: 'Analytics' },
  ] },
  { id: 'outreach', label: 'Outreach', icon: '▣', tabs: [
    { view: 'campaigns', label: 'Campaigns' },
    { view: 'missions', label: 'Missions' },
    { view: 'approvals', label: 'To Review' },
    { view: 'ai', label: 'AI Tools' },
  ] },
  { id: 'inbox', label: 'Inbox', icon: '✉', tabs: [
    { view: 'inbox', label: 'Inbox' },
  ] },
  { id: 'settings', label: 'Settings', icon: '◌', tabs: [
    { view: 'settings', label: 'Settings' },
    { view: 'billing', label: 'Billing' },
    { view: 'admin', label: 'Admin', adminOnly: true },
  ] },
]

// The hub that owns a given view. Falls back to Home for any unmapped view so the
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
// (so it can be dogfooded in a browser without a rebuild); otherwise the build-time
// VITE_HUB_NAV flag decides. Defaults OFF — the flat grouped nav stays the default
// until the hub nav is graduated.
export function isHubNavEnabled(): boolean {
  try {
    const override = localStorage.getItem('acaos_hub_nav')
    if (override === '1' || override === 'true') return true
    if (override === '0' || override === 'false') return false
  } catch { /* localStorage unavailable — fall through to the build-time flag */ }
  const flag = import.meta.env.VITE_HUB_NAV
  return flag === 'true' || flag === '1'
}
