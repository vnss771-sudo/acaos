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
  await userEvent.click(screen.getByRole('button', { name: 'Select Industrial Services' }))
  await userEvent.click(screen.getByRole('button', { name: /Continue/ }))
  await screen.findByText('Want some example data to explore?')
}

describe('OnboardingWizard', () => {
  test('explains how the product works before asking anything', () => {
    render(<OnboardingWizard workspace={workspace} api={makeApi() as never} toast={toast as never} onComplete={vi.fn()} />)
    expect(screen.getByText('Welcome to ACAOS')).toBeInTheDocument()
    expect(screen.getByText(/nothing sends without you/)).toBeInTheDocument()
    expect(screen.getByText('Step 1 of 3 · Pick your business type')).toBeInTheDocument()
  })

  test('adding examples seeds them and the final screen says so', async () => {
    const api = makeApi()
    await walkToStep3(api)
    await userEvent.click(screen.getByRole('button', { name: /Looks good/ }))

    expect(await screen.findByText("You're set up.")).toBeInTheDocument()
    expect(seedBody(api)).toEqual({ playbookId: 'industrial', includeExamples: true })
    expect(screen.getByText('Example companies added')).toBeInTheDocument()
    expect(screen.getByText('Connect your email account')).toBeInTheDocument()
  })

  test('skipping examples does not claim they were added', async () => {
    const api = makeApi()
    await walkToStep3(api)
    await userEvent.click(screen.getByRole('button', { name: /start empty/ }))

    await screen.findByText("You're set up.")
    expect(seedBody(api)).toEqual({ playbookId: 'industrial', includeExamples: false })
    expect(screen.queryByText('Example companies added')).not.toBeInTheDocument()
  })

  test('"Connect my email now" hands off to email setup', async () => {
    const onConnectEmail = vi.fn()
    await walkToStep3(makeApi(), { onConnectEmail })
    await userEvent.click(screen.getByRole('button', { name: /Looks good/ }))
    await userEvent.click(await screen.findByRole('button', { name: /Connect my email now/ }))
    await waitFor(() => expect(onConnectEmail).toHaveBeenCalledTimes(1))
  })
})
