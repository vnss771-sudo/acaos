import { describe, test, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { OpsTechnician, newSubmissionId } from './OpsTechnician.js'
import type { Workspace } from '../../types.js'

const workspace: Workspace = { id: 'ws1', name: 'Northwind', slug: 'northwind', plan: 'free' }
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }
const job = { id: 'job1', status: 'ACTIVE', siteName: 'Harbour Plaza', jobCode: 'HP-1', assignedAt: '2026-10-01T00:00:00.000Z' }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

type Init = { method?: string; body?: string } | undefined
type Handler = (path: string, init?: Init) => unknown

function mockApi(handler: Handler) {
  return vi.fn(async (path: string, init?: Init) => handler(path, init)) as unknown as Parameters<typeof OpsTechnician>[0]['api'] & ReturnType<typeof vi.fn>
}

const assignedOk = (jobs = [job], linked = true) => ({ linked, jobs })
const evidencePage = (evidence: unknown[] = [], nextCursor: string | null = null) => ({ evidence, nextCursor })

function standard(post?: Handler, pages?: Record<string, unknown>): Handler {
  return (path, init) => {
    if (path.startsWith('/api/ops/technician/assigned')) return assignedOk()
    if (init?.method === 'POST') return post ? post(path, init) : { evidence: {} }
    if (path.includes('/evidence')) return (pages && Object.entries(pages).find(([k]) => path.includes(k))?.[1]) ?? evidencePage()
    throw new Error(`unexpected ${path}`)
  }
}

afterEach(() => { cleanup(); vi.clearAllMocks() })

async function openJob(api: ReturnType<typeof mockApi>) {
  render(<OpsTechnician api={api} workspace={workspace} toast={toast} />)
  await userEvent.click(await screen.findByRole('button', { name: /Harbour Plaza/ }))
}

const posts = (api: ReturnType<typeof vi.fn>) =>
  api.mock.calls.filter((c: unknown[]) => (c[1] as Init)?.method === 'POST').map((c: unknown[]) => JSON.parse((c[1] as { body: string }).body))

describe('job list', () => {
  test('lists only what the endpoint returns, scoped to the workspace', async () => {
    const api = mockApi(standard())
    render(<OpsTechnician api={api} workspace={workspace} toast={toast} />)
    expect(await screen.findByText('Harbour Plaza')).toBeTruthy()
    expect(api).toHaveBeenCalledWith('/api/ops/technician/assigned?workspaceId=ws1')
  })

  test('explains an account with no crew link', async () => {
    const api = mockApi(() => assignedOk([], false))
    render(<OpsTechnician api={api} workspace={workspace} toast={toast} />)
    expect(await screen.findByText(/isn't linked to a crew profile/i)).toBeTruthy()
  })

  test('explains an empty assignment list and offers retry on a load failure', async () => {
    const empty = mockApi(() => assignedOk([]))
    render(<OpsTechnician api={empty} workspace={workspace} toast={toast} />)
    expect(await screen.findByText('No jobs assigned')).toBeTruthy()
    cleanup()
    let fail = true
    const flaky = mockApi(() => { if (fail) { fail = false; throw new Error('offline') } return assignedOk() })
    render(<OpsTechnician api={flaky} workspace={workspace} toast={toast} />)
    expect((await screen.findByRole('alert')).textContent).toContain('offline')
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Harbour Plaza')).toBeTruthy()
  })
})

describe('notes', () => {
  test('submits a note with a UUID submission id and clears the form', async () => {
    const api = mockApi(standard())
    await openJob(api)
    await userEvent.type(await screen.findByLabelText(/What did you do/), 'Fitted isolator')
    await userEvent.click(screen.getByRole('button', { name: 'Save note' }))
    await waitFor(() => expect(posts(api)).toHaveLength(1))
    const [body] = posts(api)
    expect(body).toMatchObject({ workspaceId: 'ws1', kind: 'NOTE', note: 'Fitted isolator' })
    expect(body.submissionId).toMatch(UUID)
    expect(api.mock.calls.some((c: unknown[]) => String(c[0]).startsWith('/api/ops/technician/job1/evidence'))).toBe(true)
    await waitFor(() => expect((screen.getByLabelText(/What did you do/) as HTMLTextAreaElement).value).toBe(''))
    expect(toast.success).toHaveBeenCalled()
  })

  test('a failed save keeps the text and retries with the SAME submission id', async () => {
    let attempts = 0
    const api = mockApi(standard(() => { attempts++; if (attempts === 1) throw new Error('Network down'); return { evidence: {} } }))
    await openJob(api)
    await userEvent.type(await screen.findByLabelText(/What did you do/), 'Replaced fuse')
    await userEvent.click(screen.getByRole('button', { name: 'Save note' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Network down')
    expect((screen.getByLabelText(/What did you do/) as HTMLTextAreaElement).value).toBe('Replaced fuse')
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(posts(api)).toHaveLength(2))
    const [first, second] = posts(api)
    expect(second.submissionId).toBe(first.submissionId)
    expect(second.note).toBe(first.note)
  })

  test('editing after a failure uses a NEW submission id (changed content must not reuse the old one)', async () => {
    let attempts = 0
    const api = mockApi(standard(() => { attempts++; if (attempts === 1) throw new Error('Network down'); return { evidence: {} } }))
    await openJob(api)
    const box = await screen.findByLabelText(/What did you do/)
    await userEvent.type(box, 'First')
    await userEvent.click(screen.getByRole('button', { name: 'Save note' }))
    await screen.findByRole('alert')
    await userEvent.type(box, ' edit')
    await userEvent.click(screen.getByRole('button', { name: /Retry|Save note/ }))
    await waitFor(() => expect(posts(api)).toHaveLength(2))
    const [first, second] = posts(api)
    expect(second.submissionId).not.toBe(first.submissionId)
    expect(second.note).toBe('First edit')
  })

  test('blank notes cannot be submitted', async () => {
    const api = mockApi(standard())
    await openJob(api)
    const btn = await screen.findByRole('button', { name: 'Save note' })
    expect((btn as HTMLButtonElement).disabled).toBe(true)
    await userEvent.type(screen.getByLabelText(/What did you do/), '   ')
    expect((btn as HTMLButtonElement).disabled).toBe(true)
  })

  test('a revoked or closed job returns the worker to the list', async () => {
    const api = mockApi(standard(() => { throw new Error('Job is not active') }))
    await openJob(api)
    await userEvent.type(await screen.findByLabelText(/What did you do/), 'Late note')
    await userEvent.click(screen.getByRole('button', { name: 'Save note' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Job is not active')
    expect(await screen.findByRole('heading', { name: 'My jobs' }, { timeout: 4000 })).toBeTruthy()
  })
})

describe('checklist', () => {
  test('builds a checklist, ticks items and submits it as CHECKLIST evidence', async () => {
    const api = mockApi(standard())
    await openJob(api)
    await userEvent.click(await screen.findByRole('tab', { name: 'Checklist' }))
    const input = screen.getByLabelText('New checklist item')
    await userEvent.type(input, 'Isolated supply{Enter}')
    await userEvent.type(input, 'Tested RCD')
    await userEvent.click(screen.getByRole('button', { name: 'Add' }))
    await userEvent.click(screen.getByRole('checkbox', { name: 'Isolated supply' }))
    await userEvent.click(screen.getByRole('button', { name: 'Save checklist' }))
    await waitFor(() => expect(posts(api)).toHaveLength(1))
    const [body] = posts(api)
    expect(body).toMatchObject({
      workspaceId: 'ws1', kind: 'CHECKLIST',
      checklist: [{ label: 'Isolated supply', checked: true }, { label: 'Tested RCD', checked: false }],
    })
    expect(body.submissionId).toMatch(UUID)
  })

  test('cannot submit an empty checklist', async () => {
    const api = mockApi(standard())
    await openJob(api)
    await userEvent.click(await screen.findByRole('tab', { name: 'Checklist' }))
    expect((screen.getByRole('button', { name: 'Save checklist' }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('history', () => {
  test('shows evidence and pages with the server cursor', async () => {
    const row = (id: string, note: string) => ({ id, kind: 'NOTE', createdAt: '2026-10-02T00:00:00.000Z', content: { note } })
    const api = mockApi(standard(undefined, {
      'cursor=c1': evidencePage([row('e2', 'older note')]),
      '/evidence': evidencePage([row('e1', 'newest note')], 'c1'),
    }))
    await openJob(api)
    await userEvent.click(await screen.findByRole('tab', { name: 'History' }))
    expect(await screen.findByText('newest note')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }))
    expect(await screen.findByText('older note')).toBeTruthy()
    expect(screen.getByText('newest note')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull()
  })
})

describe('newSubmissionId', () => {
  test('falls back to a valid v4 uuid without crypto.randomUUID', () => {
    const real = globalThis.crypto
    Object.defineProperty(globalThis, 'crypto', { value: { getRandomValues: real.getRandomValues.bind(real) }, configurable: true })
    try {
      const a = newSubmissionId()
      expect(a).toMatch(UUID)
      expect(newSubmissionId()).not.toBe(a)
    } finally {
      Object.defineProperty(globalThis, 'crypto', { value: real, configurable: true })
    }
  })
})
