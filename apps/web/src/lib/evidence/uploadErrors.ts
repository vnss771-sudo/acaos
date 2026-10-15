// Classification of everything that can go wrong during an upload, as short machine codes. Only
// the code (and an HTTP status) is ever persisted or logged: never a raw error message, a URL or
// a header, because a failure from the storage host can echo the signed URL.

export type UploadErrorCode =
  // retry automatically, with backoff
  | 'network' | 'timeout' | 'server_busy' | 'rate_limited' | 'uploads_disabled'
  // stop and ask the person to sign in again; the photo stays queued
  | 'auth_required'
  // final: this photo will not be accepted as it is
  | 'forbidden' | 'job_closed' | 'not_found' | 'limit_reached' | 'too_large' | 'invalid'
  | 'conflict' | 'upload_rejected' | 'server_rejected'
  // the device itself
  | 'storage_full'
  | 'unknown'

export type Disposition = 'retry' | 'pause_auth' | 'final'

const DISPOSITION: Record<UploadErrorCode, Disposition> = {
  network: 'retry', timeout: 'retry', server_busy: 'retry', rate_limited: 'retry', uploads_disabled: 'retry',
  auth_required: 'pause_auth',
  forbidden: 'final', job_closed: 'final', not_found: 'final', limit_reached: 'final', too_large: 'final', invalid: 'final',
  conflict: 'final', upload_rejected: 'final', server_rejected: 'final',
  storage_full: 'final', unknown: 'retry',
}
export const dispositionOf = (c: UploadErrorCode): Disposition => DISPOSITION[c]

/** Text for the person using the app. Fixed strings: nothing from the network reaches the screen. */
export const ERROR_TEXT: Record<UploadErrorCode, string> = {
  network: 'No connection. Will retry automatically.',
  timeout: 'The connection is too slow. Will retry automatically.',
  server_busy: 'The server is busy. Will retry automatically.',
  rate_limited: 'Too many uploads at once. Will retry automatically.',
  uploads_disabled: 'Photo uploads are not available right now. Will retry later.',
  auth_required: 'Sign in again to continue uploading. Your photos are saved on this phone.',
  forbidden: 'You are no longer assigned to this job.',
  job_closed: 'This job is closed, so photos can no longer be added.',
  not_found: 'This job could not be found.',
  limit_reached: 'This job has reached its photo limit.',
  too_large: 'This photo is too large to upload.',
  invalid: 'This photo was not accepted.',
  conflict: 'This photo conflicts with an earlier upload.',
  upload_rejected: 'The storage service rejected this photo.',
  server_rejected: 'The photo could not be processed and was not saved.',
  storage_full: 'There is not enough space on this phone to keep more photos.',
  unknown: 'Something went wrong. Will retry automatically.',
}

type Statusish = { status?: unknown; message?: unknown; name?: unknown }
const statusOf = (e: unknown): number | null => (typeof (e as Statusish)?.status === 'number' ? (e as { status: number }).status : null)
const msgOf = (e: unknown): string => (typeof (e as Statusish)?.message === 'string' ? (e as { message: string }).message.toLowerCase() : '')

/** An error thrown by the API client (ApiRequestError, or anything with a numeric `status`). */
export function classifyApiError(e: unknown): { code: UploadErrorCode; status: number | null } {
  const status = statusOf(e)
  const m = msgOf(e)
  if (status === null) {
    if (/timed out|timeout/.test(m)) return { code: 'timeout', status }
    // fetch() rejects with a TypeError ("Failed to fetch") when the network is down.
    return { code: 'network', status }
  }
  if (status === 401) return { code: 'auth_required', status }
  if (status === 403) return { code: 'forbidden', status }
  if (status === 404) return { code: 'not_found', status }
  if (status === 409) {
    if (/not active/.test(m)) return { code: 'job_closed', status }
    if (/limit|quota/.test(m)) return { code: 'limit_reached', status }
    if (/submission id already used/.test(m)) return { code: 'conflict', status }
    return { code: 'conflict', status }
  }
  if (status === 410) return { code: 'server_rejected', status }
  if (status === 413) return { code: 'too_large', status }
  if (status === 429) return { code: 'rate_limited', status }
  if (status === 503) return { code: 'uploads_disabled', status }
  if (status === 400 || status === 422) return { code: 'invalid', status }
  if (status >= 500) return { code: 'server_busy', status }
  return { code: 'unknown', status }
}

/** The result of the storage PUT. */
export function classifyPutStatus(status: number, outcome: { timedOut?: boolean; networkError?: boolean }): UploadErrorCode | null {
  if (status >= 200 && status < 300) return null
  if (outcome.timedOut) return 'timeout'
  if (status === 0 || outcome.networkError) return 'network'
  if (status === 403) return 'upload_rejected' // expired, or wrong size/type: the engine re-signs once before giving up
  if (status === 408 || status === 429 || status >= 500) return 'server_busy'
  return 'upload_rejected'
}

/** The "upload not found" answer to `complete`: the object never arrived, so upload again. */
export const isUploadMissing = (e: unknown) => statusOf(e) === 409 && /upload not found|not.*finished|expired/.test(msgOf(e))
