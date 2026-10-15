import { describe, test, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { OpsTechnician } from './OpsTechnician.js'
import { Harness, Backend } from '../../components/photos/testHarness.js'
import type { Workspace } from '../../types.js'

const workspace: Workspace = { id: 'ws-1', name: 'Northwind', slug: 'northwind', plan: 'free' }
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }
const job = { id: 'job1', status: 'ACTIVE', siteName: 'Harbour Plaza', jobCode: 'HP-1', assignedAt: '2026-10-01T00:00:00.000Z' }

type Api = Parameters<typeof OpsTechnician>[0]['api']
const api = (photos: boolean | undefined): Api => vi.fn(async (path: string) => {
  if (path.startsWith('/api/ops/technician/assigned')) return { linked: true, ...(photos === undefined ? {} : { photos }), jobs: [job] }
  if (path.includes('/evidence')) return { evidence: [], nextCursor: null }
  throw new Error(`unexpected ${path}`)
}) as unknown as Api

afterEach(() => { cleanup(); vi.clearAllMocks() })

async function open(photos: boolean | undefined, withProvider = true, backend = new Backend()) {
  const ui = <OpsTechnician api={api(photos)} workspace={workspace} toast={toast} />
  render(withProvider ? <Harness backend={backend} workspaceId="ws-1">{ui}</Harness> : ui)
  await userEvent.click(await screen.findByRole('button', { name: /Harbour Plaza/ }))
  return backend
}

describe('Photos tab availability', () => {
  test('is offered only when the server says photo uploads are enabled', async () => {
    await open(true)
    expect(screen.getByRole('tab', { name: 'Photos' })).toBeInTheDocument()
  })

  test.each([[false], [undefined]])('is hidden when the server says photos are %s (production default)', async (flag) => {
    await open(flag)
    expect(screen.queryByRole('tab', { name: /Photos/ })).not.toBeInTheDocument()
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Note', 'Checklist', 'History'])
  })

  test('is hidden outside the app shell that owns the upload engine', async () => {
    await open(true, false)
    expect(screen.queryByRole('tab', { name: /Photos/ })).not.toBeInTheDocument()
  })

  test('opens the photo screen for this job and never starts uploading by itself', async () => {
    const backend = await open(true)
    await userEvent.click(screen.getByRole('tab', { name: 'Photos' }))
    expect(screen.getByRole('button', { name: 'Take photo' })).toBeInTheDocument()
    expect(backend.calls).toHaveLength(0)
  })

  test('shows how many photos are waiting on the tab itself, even from other tabs', async () => {
    const backend = await open(true)
    backend.online = false
    await userEvent.click(screen.getByRole('tab', { name: 'Photos' }))
    fireEvent.change(screen.getByTestId('photo-camera-input'), { target: { files: [new File([new Uint8Array([1])], 'a.jpg', { type: 'image/jpeg' })] } })
    await userEvent.click(screen.getByRole('tab', { name: /Note/ }))
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Photos (1)' })).toBeInTheDocument())
  })

  test('photos are uploaded against the job that was opened', async () => {
    const backend = await open(true)
    await userEvent.click(screen.getByRole('tab', { name: 'Photos' }))
    fireEvent.change(screen.getByTestId('photo-gallery-input'), { target: { files: [new File([new Uint8Array([1])], 'a.jpg', { type: 'image/jpeg' })] } })
    await waitFor(() => expect(backend.calls.find((c) => c.op === 'init')?.jobId).toBe('job1'))
    expect((backend.calls.find((c) => c.op === 'init')?.body as { workspaceId: string }).workspaceId).toBe('ws-1')
  })
})
