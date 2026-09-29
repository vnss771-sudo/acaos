import { describe, test, expect, vi } from 'vitest'
import { render, act } from '@testing-library/react'
import type { ComponentType } from 'react'
import { makeDemoApi, DEMO_USER, DEMO_WORKSPACES } from '../lib/demoApi.js'
import { Dashboard } from './Dashboard.js'
import { InboxView } from './Inbox.js'
import { Leads } from './Leads.js'
import { ProspectsView } from './Prospects.js'
import { Settings } from './Settings.js'
import { Billing } from './Billing.js'
import { MissionsView } from './Missions.js'
import { Campaigns } from './Campaigns.js'
import { ApprovalsView } from './Approvals.js'
import { Intelligence } from './Intelligence.js'
import { AiTools } from './AiTools.js'

// Investor/demo mode must never crash a core page: render every main view against
// the demo API and let its fetches settle. A render error fails the test.
const views: Record<string, ComponentType<Record<string, unknown>>> = {
  Dashboard, InboxView, Leads, ProspectsView, Settings, Billing, MissionsView,
  Campaigns, ApprovalsView, Intelligence, AiTools,
} as never

const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }

describe('demo mode smoke', () => {
  for (const [name, View] of Object.entries(views)) {
    test(`${name} renders with demo data`, async () => {
      const { container } = render(
        <View
          api={makeDemoApi()} workspace={DEMO_WORKSPACES[0]} user={DEMO_USER} toast={toast}
          setView={vi.fn()} onUserUpdate={vi.fn()} onWorkspaceUpdate={vi.fn()} canManage
        />,
      )
      await act(async () => { await new Promise(r => setTimeout(r, 50)) })
      expect(container.textContent?.trim().length).toBeGreaterThan(0)
    })
  }
})
