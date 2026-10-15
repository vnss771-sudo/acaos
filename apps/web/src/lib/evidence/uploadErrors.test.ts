import { describe, it, expect } from 'vitest'
import { classifyApiError, classifyPutStatus, dispositionOf, isUploadMissing, ERROR_TEXT, type UploadErrorCode } from './uploadErrors'

const err = (status: number | undefined, message = '') => Object.assign(new Error(message), status === undefined ? {} : { status })

describe('classifyApiError', () => {
  it.each([
    [undefined, 'Failed to fetch', 'network'],
    [undefined, 'Request timed out — please try again.', 'timeout'],
    [401, 'Session expired', 'auth_required'],
    [403, 'Assignment revoked', 'forbidden'],
    [403, 'Not assigned to this job', 'forbidden'],
    [404, 'Job not found', 'not_found'],
    [409, 'Job is not active', 'job_closed'],
    [409, 'This job has reached its file limit', 'limit_reached'],
    [409, 'This workspace has reached its evidence storage quota', 'limit_reached'],
    [409, 'Submission ID already used for a different upload', 'conflict'],
    [410, 'File is no longer available', 'server_rejected'],
    [413, 'File exceeds the maximum upload size', 'too_large'],
    [429, 'Too many unfinished uploads', 'rate_limited'],
    [503, 'Evidence uploads are not enabled', 'uploads_disabled'],
    [400, 'Invalid body', 'invalid'],
    [500, 'boom', 'server_busy'],
    [502, 'bad gateway', 'server_busy'],
  ] as const)('%s %s -> %s', (status, message, code) => {
    expect(classifyApiError(err(status, message)).code).toBe(code)
  })
  it('handles non-Error values', () => {
    expect(classifyApiError(undefined).code).toBe('network')
    expect(classifyApiError('x').code).toBe('network')
  })
})

describe('dispositions and text', () => {
  it('retries transient failures, stops on final ones, pauses for auth', () => {
    for (const c of ['network', 'timeout', 'server_busy', 'rate_limited', 'uploads_disabled'] as const) expect(dispositionOf(c)).toBe('retry')
    expect(dispositionOf('auth_required')).toBe('pause_auth')
    for (const c of ['forbidden', 'job_closed', 'not_found', 'limit_reached', 'too_large', 'invalid', 'conflict', 'upload_rejected', 'server_rejected', 'storage_full'] as const) expect(dispositionOf(c)).toBe('final')
  })
  it('has fixed text for every code and none of it can contain a URL', () => {
    const codes = Object.keys(ERROR_TEXT) as UploadErrorCode[]
    for (const c of codes) { expect(ERROR_TEXT[c].length).toBeGreaterThan(5); expect(ERROR_TEXT[c]).not.toMatch(/https?:|X-Amz|\//) }
  })
})

describe('classifyPutStatus', () => {
  it('maps the storage response', () => {
    expect(classifyPutStatus(200, {})).toBeNull()
    expect(classifyPutStatus(204, {})).toBeNull()
    expect(classifyPutStatus(0, { networkError: true })).toBe('network')
    expect(classifyPutStatus(0, { timedOut: true })).toBe('timeout')
    expect(classifyPutStatus(403, {})).toBe('upload_rejected')
    expect(classifyPutStatus(500, {})).toBe('server_busy')
    expect(classifyPutStatus(503, {})).toBe('server_busy')
    expect(classifyPutStatus(400, {})).toBe('upload_rejected')
  })
  it('recognises the "upload not found" answer to complete', () => {
    expect(isUploadMissing(err(409, 'Upload not found; it may not have finished or its link has expired'))).toBe(true)
    expect(isUploadMissing(err(409, 'Job is not active'))).toBe(false)
    expect(isUploadMissing(err(500, 'Upload not found'))).toBe(false)
  })
})
