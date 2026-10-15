import { describe, it, expect, vi } from 'vitest'
import { makeEvidenceApi } from './evidenceApi'

describe('makeEvidenceApi', () => {
  it('maps every operation onto the typed route contracts and the status read', async () => {
    const route = vi.fn(async (..._a: unknown[]) => ({ file: { id: 'f', status: 'PENDING', kind: 'PHOTO' } }))
    const api = vi.fn(async (..._a: unknown[]) => ({ file: { status: 'AVAILABLE' } }))
    const ev = makeEvidenceApi(route as never, api as never)
    const body = { workspaceId: 'w', submissionId: 's', contentType: 'image/jpeg' as const, sizeBytes: 5 }
    await ev.init('job 1', body)
    await ev.complete('job 1', 'f/1', 'w')
    await ev.cancel('job 1', 'f/1', 'w')
    expect(route.mock.calls).toEqual([
      ['POST /api/ops/technician/:jobId/files/init', { params: { jobId: 'job 1' }, body }],
      ['POST /api/ops/technician/:jobId/files/:fileId/complete', { params: { jobId: 'job 1', fileId: 'f/1' }, body: { workspaceId: 'w' } }],
      ['DELETE /api/ops/technician/:jobId/files/:fileId', { params: { jobId: 'job 1', fileId: 'f/1' }, body: { workspaceId: 'w' } }],
    ])
    expect((await ev.status('job 1', 'f/1', 'w')).file.status).toBe('AVAILABLE')
    expect(api.mock.calls[0][0]).toBe('/api/ops/technician/job%201/files/f%2F1?workspaceId=w')
  })
})
