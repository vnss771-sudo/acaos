import { describe, test, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AiTools } from './AiTools.js'
import type { Workspace, Lead } from '../types.js'

const workspace: Workspace = { id: 'ws1', name: 'Northwind', slug: 'northwind', plan: 'free' }
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }
const lead = { id: 'l1', businessName: 'Acme Plumbing', stage: 'NEW', score: 50, category: 'Plumbing' } as Lead

afterEach(() => vi.restoreAllMocks())

describe('AiTools', () => {
  test('fetches leads on mount and shows the three tools with the research description', async () => {
    const api = vi.fn().mockResolvedValue({ leads: [lead] })
    render(<AiTools api={api as never} workspace={workspace} toast={toast as never} />)

    expect(api).toHaveBeenCalledWith('/api/leads?workspaceId=ws1&limit=100')
    // Research is the default tab → its run button + the other two tab buttons.
    expect(await screen.findByRole('button', { name: /Run Lead Research/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Outreach Copy/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Reply Analysis/i })).toBeInTheDocument()
    expect(screen.getByText(/Generate AI business intelligence/i)).toBeInTheDocument()
  })

  test('switching tabs updates the description', async () => {
    const api = vi.fn().mockResolvedValue({ leads: [] })
    render(<AiTools api={api as never} workspace={workspace} toast={toast as never} />)

    await userEvent.click(screen.getByRole('button', { name: /Outreach Copy/i }))
    expect(screen.getByText(/Write personalised cold email sequences/i)).toBeInTheDocument()
  })

  test('sync Run includes workspaceId in the AI request body (regression)', async () => {
    // Backend /api/ai/* rejects with 400 "workspaceId required" if the body
    // omits workspaceId. The default (sync) mode must always include it.
    const api = vi.fn()
      .mockResolvedValueOnce({ leads: [lead] }) // mount fetch
      .mockResolvedValue({ result: 'done' })
    render(<AiTools api={api as never} workspace={workspace} toast={toast as never} />)

    await userEvent.click(await screen.findByRole('button', { name: /Run Lead Research/ }))

    const call = api.mock.calls.find(c => c[0] === '/api/ai/research')
    expect(call).toBeTruthy()
    expect(JSON.parse((call![1] as { body: string }).body)).toMatchObject({ workspaceId: 'ws1' })
  })

  test('outreach reuses the prospect research — passes aiSummary + outreachAngle', async () => {
    // Run research → switch to outreach (business name persists) → the outreach
    // request must carry the research so the email uses the real angle, not
    // generic workspace defaults.
    const researchJson = JSON.stringify({
      aiSummary: 'Acme is a growing plumbing business.',
      outreachAngle: 'Scheduling across crews',
    })
    const api = vi.fn()
      .mockResolvedValueOnce({ leads: [] })            // mount fetch
      .mockResolvedValueOnce({ result: researchJson }) // research run
      .mockResolvedValueOnce({ result: '{"subject":"s","email":"e","followup":"f"}' }) // outreach run
    render(<AiTools api={api as never} workspace={workspace} toast={toast as never} />)

    await userEvent.type(await screen.findByPlaceholderText('Acme Plumbing Brisbane'), 'Acme Plumbing')
    await userEvent.click(screen.getByRole('button', { name: /Run Lead Research/ }))

    await userEvent.click(screen.getByRole('button', { name: /Outreach Copy/i }))
    expect(await screen.findByText(/Using your research for Acme Plumbing/i)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /Run Outreach Copy/ }))

    const call = api.mock.calls.find(c => c[0] === '/api/ai/outreach')
    expect(call).toBeTruthy()
    expect(JSON.parse((call![1] as { body: string }).body)).toMatchObject({
      workspaceId: 'ws1',
      businessName: 'Acme Plumbing',
      aiSummary: 'Acme is a growing plumbing business.',
      outreachAngle: 'Scheduling across crews',
    })
  })

  test('async (Queue) mode reveals the lead selector', async () => {
    const api = vi.fn().mockResolvedValue({ leads: [lead] })
    render(<AiTools api={api as never} workspace={workspace} toast={toast as never} />)

    // The lead selector is hidden in instant mode.
    expect(screen.queryByText('— choose a lead —')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Queue (async)' }))
    expect(await screen.findByText('— choose a lead —')).toBeInTheDocument()
  })
})
