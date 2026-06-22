import test from 'node:test'
import assert from 'node:assert/strict'
import { UnrecoverableError } from 'bullmq'
import {
  parseJobPayload,
  ResearchLeadPayloadSchema,
  GenerateOutreachPayloadSchema,
  AnalyzeReplyPayloadSchema,
  SyncMailboxPayloadSchema,
  ScoreProspectsPayloadSchema,
  SendCampaignPayloadSchema,
} from '../packages/backend-core/src/lib/queueSchemas.ts'

test('parseJobPayload: returns the typed payload for a valid research job', () => {
  const out = parseJobPayload(ResearchLeadPayloadSchema, 'research-lead', { leadId: 'lead_1', workspaceId: 'ws_1' })
  assert.equal(out.leadId, 'lead_1')
  assert.equal(out.workspaceId, 'ws_1')
})

test('parseJobPayload: throws a non-retryable UnrecoverableError on a malformed payload', () => {
  assert.throws(
    () => parseJobPayload(ResearchLeadPayloadSchema, 'research-lead', { workspaceId: 'ws_1' }),
    (err: unknown) => {
      // UnrecoverableError tells BullMQ not to retry — a bad payload never heals.
      assert.ok(err instanceof UnrecoverableError)
      assert.match((err as Error).message, /QUEUE_PAYLOAD_INVALID/)
      assert.match((err as Error).message, /research-lead/)
      assert.match((err as Error).message, /leadId/)
      return true
    },
  )
})

test('parseJobPayload: lead-scoped jobs REQUIRE workspaceId (tenant scope)', () => {
  // The worker fetches the lead by id + workspaceId, so a payload without a
  // workspace must fail fast rather than letting a job run unscoped.
  for (const [schema, queue] of [
    [ResearchLeadPayloadSchema, 'research-lead'],
    [GenerateOutreachPayloadSchema, 'generate-outreach'],
  ] as const) {
    assert.throws(
      () => parseJobPayload(schema, queue, { leadId: 'lead_1' }),
      (err: unknown) => err instanceof UnrecoverableError && /workspaceId/.test((err as Error).message),
      `${queue} must reject a payload missing workspaceId`,
    )
  }
})

test('parseJobPayload: rejects an empty leadId (min length)', () => {
  assert.throws(
    () => parseJobPayload(ResearchLeadPayloadSchema, 'research-lead', { leadId: '' }),
    (err: unknown) => err instanceof UnrecoverableError,
  )
})

test('parseJobPayload: rejects a non-object payload', () => {
  assert.throws(
    () => parseJobPayload(ScoreProspectsPayloadSchema, 'score-prospects', null),
    (err: unknown) => err instanceof UnrecoverableError,
  )
})

test('analyze-reply payload: requires a non-empty replyBody', () => {
  assert.throws(
    () => parseJobPayload(AnalyzeReplyPayloadSchema, 'analyze-reply', { leadId: 'l1' }),
    (err: unknown) => err instanceof UnrecoverableError,
  )
  const ok = parseJobPayload(AnalyzeReplyPayloadSchema, 'analyze-reply', { replyBody: 'sure, tell me more' })
  assert.equal(ok.replyBody, 'sure, tell me more')
  assert.equal(ok.leadId, undefined)
})

test('sync-mailbox payload: accepts the auto-sync scheduler job ({ autoSync: true })', () => {
  const out = parseJobPayload(SyncMailboxPayloadSchema, 'sync-mailbox', { autoSync: true })
  assert.equal(out.autoSync, true)
})

test('sync-mailbox payload: accepts a targeted workspace sync', () => {
  const out = parseJobPayload(SyncMailboxPayloadSchema, 'sync-mailbox', { workspaceId: 'ws_1' })
  assert.equal(out.workspaceId, 'ws_1')
})

test('sync-mailbox payload: rejects an empty job that is neither auto nor targeted', () => {
  assert.throws(
    () => parseJobPayload(SyncMailboxPayloadSchema, 'sync-mailbox', {}),
    (err: unknown) => err instanceof UnrecoverableError,
  )
})

test('send-campaign payload: requires campaignId + workspaceId and accepts optional leadIds', () => {
  const out = parseJobPayload(SendCampaignPayloadSchema, 'send-campaign', {
    campaignId: 'c1',
    workspaceId: 'ws_1',
    leadIds: ['l1', 'l2'],
  })
  assert.deepEqual(out.leadIds, ['l1', 'l2'])

  assert.throws(
    () => parseJobPayload(SendCampaignPayloadSchema, 'send-campaign', { campaignId: 'c1' }),
    (err: unknown) => err instanceof UnrecoverableError && /workspaceId/.test((err as Error).message),
  )
})

test('payload versioning: accepts an optional schemaVersion + requestId envelope', () => {
  const out = parseJobPayload(SendCampaignPayloadSchema, 'send-campaign', {
    campaignId: 'c1', workspaceId: 'ws_1', schemaVersion: 1, requestId: 'req_abc',
  })
  assert.equal(out.schemaVersion, 1)
  assert.equal(out.requestId, 'req_abc')
})

test('payload versioning: a payload with no version still validates (older producer)', () => {
  const out = parseJobPayload(SendCampaignPayloadSchema, 'send-campaign', {
    campaignId: 'c1', workspaceId: 'ws_1',
  })
  assert.equal(out.schemaVersion, undefined)
})

test('payload versioning: an unknown extra field is stripped, not rejected (newer producer)', () => {
  const out = parseJobPayload(ScoreProspectsPayloadSchema, 'score-prospects', {
    workspaceId: 'ws_1', schemaVersion: 2, somethingNew: 'ignored',
  }) as Record<string, unknown>
  assert.equal(out.workspaceId, 'ws_1')
  assert.equal('somethingNew' in out, false)
})
