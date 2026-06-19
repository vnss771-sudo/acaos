import { describe, test, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MissionsView } from './Missions.js'
import type { Mission, MissionDetail, Workspace } from '../types.js'

const workspace: Workspace = { id: 'ws1', name: 'Northwind', slug: 'northwind', plan: 'free' }
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }

const mission: Mission = {
  id: 'm1', name: 'Q3 Roofers', goalType: 'BOOK_CALL', status: 'ACTIVE',
  campaignId: 'c1', createdAt: new Date().toISOString(),
  stats: { sent: 0, replied: 0, failed: 0, bounced: 0, pendingDrafts: 0 },
  discovery: { runs: 1, discovered: 3 },
}

const detail: MissionDetail = {
  mission,
  playbook: null,
  discoveryRuns: [],
  prospects: [{ id: 'pb', companyName: 'High Co', opportunityScore: 95, buyingStage: 'PURCHASING' }],
  intents: [
    { id: 'i1', status: 'PROPOSED', prospect: { id: 'pa', companyName: 'Low Co', opportunityScore: 40, buyingStage: 'RESEARCHING' }, recommendation: { reasoning: 'Hiring spike detected' } },
    { id: 'i2', status: 'DRAFTED', draftSubject: 'Quick question', draftBody: 'Hello there', prospect: { id: 'pb', companyName: 'High Co', opportunityScore: 95, buyingStage: 'PURCHASING' } },
  ],
  funnel: { discovered: 3, recommended: 2, drafted: 1, approved: 0, rejected: 0, sent: 0 },
  sendReadiness: { ready: false, checks: [{ name: 'smtpConfigured', label: 'Email sending configured', ok: false, hint: 'Add SMTP in Settings.' }] },
  engagement: { sent: 4, replied: 1, bounced: 0, failed: 0, replyRate: 0.25 },
  recentSends: [
    { id: 's1', toEmail: 'cfo@high.co', subject: 'Quick question', status: 'REPLIED', replyIntent: 'INTERESTED', sentAt: new Date().toISOString(), repliedAt: new Date().toISOString() },
    { id: 's2', toEmail: 'ops@low.co', subject: 'Intro', status: 'SENT', replyIntent: null, sentAt: new Date().toISOString(), repliedAt: null },
  ],
  learning: { updateCount: 2, lastWeightUpdate: new Date().toISOString(), totalOutcomes: 14 },
}

function makeApi() {
  return vi.fn((path: string) => {
    if (path === '/api/missions?workspaceId=ws1') return Promise.resolve({ missions: [mission] })
    if (path === '/api/missions/m1') return Promise.resolve(detail)
    return Promise.resolve({}) // POST actions
  })
}

afterEach(() => vi.restoreAllMocks())

async function expandDetails(api: ReturnType<typeof makeApi>) {
  render(<MissionsView api={api as never} workspace={workspace} toast={toast as never} canManage />)
  await screen.findByText('Q3 Roofers')
  await userEvent.click(screen.getByRole('button', { name: 'Details' }))
  await screen.findByText('Send readiness')
}

describe('MissionsView control plane', () => {
  test('expanding a mission shows the funnel strip, readiness, and recommendation evidence', async () => {
    const api = makeApi()
    await expandDetails(api)

    // Funnel strip stages
    expect(screen.getByText('Discovered')).toBeInTheDocument()
    expect(screen.getByText('Recommended')).toBeInTheDocument()
    // Recommendation reasoning (the "why") is surfaced inline
    expect(screen.getByText('Hiring spike detected')).toBeInTheDocument()
    // Drafted copy is previewed
    expect(screen.getByText('Quick question')).toBeInTheDocument()
    // A failing send-readiness check is shown
    expect(screen.getByText(/Email sending configured/)).toBeInTheDocument()
  })

  test('shows engagement (reply rate + recent replies) and learning progress', async () => {
    const api = makeApi()
    await expandDetails(api)

    expect(screen.getByText('Engagement')).toBeInTheDocument()
    // Reply rate from the engagement payload (0.25 → 25%)
    expect(screen.getByText('25%')).toBeInTheDocument()
    // A recent reply with its classified intent
    expect(screen.getByText(/replied · INTERESTED/)).toBeInTheDocument()
    // Learning summary reflects the scoring-model progress
    expect(screen.getByText(/Scoring model updated 2× from 14 outcomes/)).toBeInTheDocument()
  })

  test('the guided stepper points to the next incomplete step', async () => {
    const api = makeApi()
    await expandDetails(api)
    // discovered + recommended are done but approved is 0 → "Review & approve" is next.
    expect(screen.getByText(/then approve the keepers/)).toBeInTheDocument()
  })

  test('the guided stepper reports completion when the whole loop is done', async () => {
    const doneDetail: MissionDetail = {
      ...detail,
      funnel: { discovered: 5, recommended: 5, drafted: 3, approved: 3, rejected: 0, sent: 3 },
      sendReadiness: { ready: true, checks: [] },
      engagement: { sent: 3, replied: 2, bounced: 0, failed: 0, replyRate: 0.66 },
    }
    const api = vi.fn((path: string) => {
      if (path === '/api/missions?workspaceId=ws1') return Promise.resolve({ missions: [mission] })
      if (path === '/api/missions/m1') return Promise.resolve(doneDetail)
      return Promise.resolve({})
    })
    render(<MissionsView api={api as never} workspace={workspace} toast={toast as never} canManage />)
    await screen.findByText('Q3 Roofers')
    await userEvent.click(screen.getByRole('button', { name: 'Details' }))
    await screen.findByText('Send readiness')
    expect(screen.getByText(/Full loop complete/)).toBeInTheDocument()
  })

  test('Score & recommend posts to the mission score endpoint', async () => {
    const api = makeApi()
    await expandDetails(api)
    await userEvent.click(screen.getByRole('button', { name: 'Score & recommend' }))
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith('/api/missions/m1/score', expect.objectContaining({ method: 'POST' })))
  })

  test('Generate draft and Approve call the intent action endpoints', async () => {
    const api = makeApi()
    await expandDetails(api)

    await userEvent.click(screen.getByRole('button', { name: 'Generate draft' }))
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith('/api/prospects/pa/intents/i1/draft', expect.objectContaining({ method: 'POST' })))

    await userEvent.click(screen.getByRole('button', { name: 'Approve' }))
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith('/api/prospects/pb/intents/i2/approve', expect.objectContaining({ method: 'POST' })))
  })

  test('a non-manager sees the funnel but no action buttons', async () => {
    const api = makeApi()
    render(<MissionsView api={api as never} workspace={workspace} toast={toast as never} canManage={false} />)
    await screen.findByText('Q3 Roofers')
    await userEvent.click(screen.getByRole('button', { name: 'Details' }))
    await screen.findByText('Send readiness')
    expect(screen.queryByRole('button', { name: 'Score & recommend' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Generate draft' })).not.toBeInTheDocument()
  })
})
