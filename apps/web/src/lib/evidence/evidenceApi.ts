// Adapter from the app's authenticated API client to the engine's EvidenceApi. Every mutation goes
// through the typed route client (contracts live in packages/shared); the status poll is a read.
import type { RouteApi } from '../routeApi'
import type { EvidenceApi } from './uploadEngine'

type RawApi = <T = unknown>(path: string, init?: Record<string, unknown>) => Promise<T>

export function makeEvidenceApi(route: RouteApi, api: RawApi): EvidenceApi {
  return {
    init: (jobId, body) => route('POST /api/ops/technician/:jobId/files/init', { params: { jobId }, body }),
    complete: (jobId, fileId, workspaceId) =>
      route('POST /api/ops/technician/:jobId/files/:fileId/complete', { params: { jobId, fileId }, body: { workspaceId } }),
    cancel: (jobId, fileId, workspaceId) =>
      route('DELETE /api/ops/technician/:jobId/files/:fileId', { params: { jobId, fileId }, body: { workspaceId } }),
    status: (jobId, fileId, workspaceId) =>
      api<{ file: { status: string } }>(`/api/ops/technician/${encodeURIComponent(jobId)}/files/${encodeURIComponent(fileId)}?workspaceId=${encodeURIComponent(workspaceId)}`),
  }
}
