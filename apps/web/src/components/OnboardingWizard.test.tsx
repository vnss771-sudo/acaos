import React from 'react'
import { describe, test, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { OnboardingWizard } from './OnboardingWizard.js'
import type { Workspace } from '../types.js'

const workspace: Workspace = { id: 'ws1', name: 'Northwind', slug: 'northwind', plan: 'free' }
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }
afterEach(() => vi.restoreAllMocks())

function makeApi() {
  return vi.fn((_path: string, _init?: { body?: string }) => Promise.resolve({}))
}
type Api = ReturnType<typeof makeApi>

function seedBody(api: Api) {
  const call = api.mock.calls.find(([path]) => path === '/api/workspaces/ws1/seed')
  return call?.[1]?.body ? JSON.parse(call[1].body) : null
}

async function walkToStep3(api: Api, props: Partial<React.ComponentProps<typeof OnboardingWizard>> = {}) {
  render(<OnboardingWizard workspace={workspace} api={api as never} toast={toast as never} onComplete={vi.fn()} {...props} />)
  await userEvent.click(screen.getByRole('button', { name: /Set up email outreach/ }))
  await userEvent.click(screen.getByRole('button', { name: 'Select Industrial Services' }))
  await userEvent.click(screen.getByRole('button', { name: /Continue/ }))
  await screen.findByText('Want some example data to explore?')
}

// Step 3 now leads to the "Your first clients" step before the final screen.
async function skipFirstProspects() {
  await screen.findByText('Your first clients')
  await userEvent.click(screen.getByRole('button', { name: /Skip for now/ }))
}

describe('OnboardingWizard', () => {
  test('starts by asking which job ACAOS does first, with skip available', () => {
    render(<OnboardingWizard workspace={workspace} api={makeApi() as never} toast={toast as never} onComplete={vi.fn()} />)
    expect(screen.getByText('Welcome to ACAOS')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /I'm a trade contractor/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Set up email outreach/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Skip setup/ })).toBeInTheDocument()
  })

  test('the email path explains how outreach works before asking anything', async () => {
    render(<OnboardingWizard workspace={workspace} api={makeApi() as never} toast={toast as never} onComplete={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: /Set up email outreach/ }))
    expect(screen.getByText(/nothing sends without you/)).toBeInTheDocument()
    expect(screen.getByText('Step 1 of 3 · Pick your business type')).toBeInTheDocument()
  })

  test('the contractor path saves trades and regions to Find work, then lands on Find work', async () => {
    const api = vi.fn((path: string, _init?: { method?: string; body?: string }) => path.startsWith('/api/opportunities/profile?')
      ? Promise.resolve({ trades: [{ id: 'electrical', label: 'Electrical' }, { id: 'plumbing', label: 'Plumbing' }], regions: ['QLD', 'NSW'], sources: [{ name: 'austender', label: 'AusTender', configured: true }, { name: 'planningalerts', label: 'DAs', configured: false }] })
      : Promise.resolve({}))
    const onComplete = vi.fn()
    const onNavigate = vi.fn()
    render(<OnboardingWizard workspace={workspace} api={api as never} toast={toast as never} onComplete={onComplete} onNavigate={onNavigate} />)
    await userEvent.click(screen.getByRole('button', { name: /I'm a trade contractor/ }))
    await userEvent.click(await screen.findByLabelText('Electrical'))
    await userEvent.click(screen.getByLabelText('QLD'))
    await userEvent.click(screen.getByRole('button', { name: /Start finding work/ }))
    expect(await screen.findByText('You’re set up')).toBeInTheDocument()
    const put = api.mock.calls.find(([p, i]) => p === '/api/opportunities/profile' && i?.method === 'PUT')
    expect(JSON.parse(put![1]!.body!)).toEqual({ workspaceId: 'ws1', enabled: true, trades: ['electrical'], keywords: [], regions: ['QLD'], sources: ['austender', 'planningalerts'] })
    expect(seedBody(api as never)).toEqual({ playbookId: null, includeExamples: false })
    await userEvent.click(screen.getByRole('button', { name: /Go to Find work/ }))
    expect(onComplete).toHaveBeenCalled()
    expect(onNavigate).toHaveBeenCalledWith('ops-find-work')
  })

  test('the contractor path needs at least one trade', async () => {
    const api = vi.fn((path: string) => path.startsWith('/api/opportunities/profile?')
      ? Promise.resolve({ trades: [{ id: 'electrical', label: 'Electrical' }], regions: ['QLD'], sources: [] })
      : Promise.resolve({}))
    render(<OnboardingWizard workspace={workspace} api={api as never} toast={toast as never} onComplete={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: /I'm a trade contractor/ }))
    await screen.findByLabelText('Electrical')
    await userEvent.click(screen.getByRole('button', { name: /Start finding work/ }))
    expect(toast.error).toHaveBeenCalledWith('Pick at least one trade')
  })

  test('adding examples seeds them and the final screen says so', async () => {
    const api = makeApi()
    await walkToStep3(api)
    await userEvent.click(screen.getByRole('button', { name: /Looks good/ }))
    await skipFirstProspects()

    expect(await screen.findByText("You're set up.")).toBeInTheDocument()
    expect(seedBody(api)).toEqual({ playbookId: 'industrial', includeExamples: true })
    expect(screen.getByText('Example companies added')).toBeInTheDocument()
    expect(screen.getByText('Connect your email account')).toBeInTheDocument()
  })

  test('skipping examples does not claim they were added', async () => {
    const api = makeApi()
    await walkToStep3(api)
    await userEvent.click(screen.getByRole('button', { name: /start empty/ }))
    await skipFirstProspects()

    await screen.findByText("You're set up.")
    expect(seedBody(api)).toEqual({ playbookId: 'industrial', includeExamples: false })
    expect(screen.queryByText('Example companies added')).not.toBeInTheDocument()
  })

  test('"Connect my email now" hands off to email setup', async () => {
    const onConnectEmail = vi.fn()
    await walkToStep3(makeApi(), { onConnectEmail })
    await userEvent.click(screen.getByRole('button', { name: /Looks good/ }))
    await skipFirstProspects()
    await userEvent.click(await screen.findByRole('button', { name: /Connect my email now/ }))
    await waitFor(() => expect(onConnectEmail).toHaveBeenCalledTimes(1))
  })

  test('first prospects are sent to the onboarding import, then the final screen shows', async () => {
    const api = vi.fn((path: string, _init?: { body?: string }) =>
      Promise.resolve(path === '/api/prospects/onboarding-import'
        ? { imported: 1, skipped: 0, failed: 0, errors: [], intents: [{ id: 'i1', prospectId: 'p1', companyName: 'Acme' }] }
        : {}))
    await walkToStep3(api)
    await userEvent.click(screen.getByRole('button', { name: /Looks good/ }))
    await screen.findByText('Your first clients')

    const submit = screen.getByRole('button', { name: /Prepare my first emails/ })
    expect(submit).toBeDisabled()
    await userEvent.type(screen.getByLabelText('Company 1'), 'Acme Plumbing')
    await userEvent.type(screen.getByLabelText('Contact email 1'), 'not-an-email')
    expect(submit).toBeDisabled()
    await userEvent.clear(screen.getByLabelText('Contact email 1'))
    await userEvent.type(screen.getByLabelText('Contact email 1'), 'mark@acme.test')
    await userEvent.click(submit)

    expect(await screen.findByText("You're set up.")).toBeInTheDocument()
    const call = api.mock.calls.find(([path]) => path === '/api/prospects/onboarding-import')
    expect(JSON.parse(call![1]!.body!)).toEqual({
      workspaceId: 'ws1',
      rows: [{ companyName: 'Acme Plumbing', contactEmail: 'mark@acme.test', sourceTag: 'onboarding' }],
    })
  })
})
