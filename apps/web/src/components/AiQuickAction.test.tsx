import { describe, test, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AiQuickAction } from './AiQuickAction.js'
import type { Workspace } from '../types.js'

const workspace: Workspace = { id: 'ws1', name: 'Northwind', slug: 'northwind', plan: 'free' }
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn() } as never

function setup(kind: 'research' | 'outreach' | 'reply', apiImpl: (path: string, init?: unknown) => Promise<unknown>) {
  const api = vi.fn(apiImpl) as never
  render(<AiQuickAction kind={kind} api={api} workspace={workspace} toast={toast} />)
  return api as unknown as ReturnType<typeof vi.fn>
}

describe('AiQuickAction', () => {
  test('starts collapsed and expands to a form on click', async () => {
    setup('research', async () => ({ result: {} }))
    expect(screen.queryByLabelText(/Business name/i)).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /Qualify a business with AI/i }))
    expect(screen.getByLabelText(/Business name/i)).toBeInTheDocument()
  })

  test('run is disabled until the required field is filled', async () => {
    setup('research', async () => ({ result: {} }))
    await userEvent.click(screen.getByRole('button', { name: /Qualify a business with AI/i }))
    const run = screen.getByRole('button', { name: /Run qualify a business/i })
    expect(run).toBeDisabled()
    await userEvent.type(screen.getByLabelText(/Business name/i), 'Acme Plumbing')
    expect(run).toBeEnabled()
  })

  test('research: posts to the research endpoint and renders the AI read', async () => {
    const api = setup('research', async () => ({
      result: { aiSummary: 'A growing plumber.', outreachAngle: 'Coordinating crews', icpScore: 70, confidence: 'medium', recommendedAction: 'manual_review_then_draft' },
      scoreRationale: { score: 70 },
    }))
    await userEvent.click(screen.getByRole('button', { name: /Qualify a business with AI/i }))
    await userEvent.type(screen.getByLabelText(/Business name/i), 'Acme Plumbing')
    await userEvent.click(screen.getByRole('button', { name: /Run qualify a business/i }))

    await waitFor(() => expect(screen.getByText('A growing plumber.')).toBeInTheDocument())
    expect(screen.getByText(/ICP fit 70\/100/)).toBeInTheDocument()
    expect(screen.getByText('Coordinating crews')).toBeInTheDocument()
    // Called the research endpoint with the workspace + business name.
    const [path, init] = api.mock.calls[0]
    expect(path).toBe('/api/ai/research')
    expect(JSON.parse((init as { body: string }).body)).toMatchObject({ workspaceId: 'ws1', businessName: 'Acme Plumbing' })
  })

  test('reply: posts the reply body and renders intent + suggested action', async () => {
    const api = setup('reply', async () => ({
      result: { classification: 'NOT_INTERESTED', summary: 'They passed.', suggestedAction: 'Mark as not interested.' },
    }))
    await userEvent.click(screen.getByRole('button', { name: /Analyze a reply with AI/i }))
    await userEvent.type(screen.getByLabelText(/Paste the reply/i), 'No thanks')
    await userEvent.click(screen.getByRole('button', { name: /Run analyze a reply/i }))

    await waitFor(() => expect(screen.getByText('They passed.')).toBeInTheDocument())
    expect(screen.getByText('Not interested')).toBeInTheDocument()
    expect(screen.getByText(/Mark as not interested\./)).toBeInTheDocument()
    expect((api.mock.calls[0][0])).toBe('/api/ai/reply-analysis')
  })

  test('surfaces an API error via toast without crashing', async () => {
    setup('outreach', async () => { throw new Error('rate limited') })
    await userEvent.click(screen.getByRole('button', { name: /Draft a cold email with AI/i }))
    await userEvent.type(screen.getByLabelText(/Business name/i), 'Acme')
    await userEvent.click(screen.getByRole('button', { name: /Run draft a cold email/i }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('rate limited'))
  })
})
