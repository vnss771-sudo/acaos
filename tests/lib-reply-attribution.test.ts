import test from 'node:test'
import assert from 'node:assert/strict'
import type { Prisma } from '@prisma/client'
import { findBestMatchingOutreachSent } from '../packages/backend-core/src/lib/replyAttribution.ts'

// Unit tests for the inbound-reply attribution core. The function is deliberately
// conservative ("a wrong match is worse than no match"), so these tests pin every
// branch of the precedence ladder AND assert the query shape (workspace scoping,
// SENT-only, most-recent ordering) that keeps the match safe and tenant-isolated.
//
// It takes a Prisma.TransactionClient, so we drive it with an in-memory fake that
// records the args each query was called with — no database needed.

type SentRow = { id: string; leadId: string | null; campaignId: string | null; toEmail: string | null }

function makeTx(opts: { findFirst?: SentRow | null; findMany?: SentRow[] }) {
  const calls = { findFirst: [] as any[], findMany: [] as any[] }
  const tx = {
    outreachSent: {
      async findFirst(args: any) { calls.findFirst.push(args); return opts.findFirst ?? null },
      async findMany(args: any) { calls.findMany.push(args); return opts.findMany ?? [] },
    },
  } as unknown as Prisma.TransactionClient
  return { tx, calls }
}

const WS = 'ws_1'

test('MESSAGE_ID: In-Reply-To resolving to a messageId wins and short-circuits the lead lookup', async () => {
  const row: SentRow = { id: 'os_1', leadId: 'lead_1', campaignId: 'camp_1', toEmail: 'a@example.com' }
  const { tx, calls } = makeTx({ findFirst: row, findMany: [{ id: 'os_other', leadId: 'lead_1', campaignId: 'camp_1', toEmail: 'a@example.com' }] })

  const m = await findBestMatchingOutreachSent(tx, { workspaceId: WS, inReplyTo: 'msg-123', leadId: 'lead_1' })

  assert.equal(m.method, 'MESSAGE_ID')
  assert.equal(m.outreachSentId, 'os_1')
  assert.equal(m.leadId, 'lead_1')
  assert.equal(m.campaignId, 'camp_1')
  assert.equal(m.toEmail, 'a@example.com')
  // Precedence: a messageId hit must not even query the lead's sends.
  assert.equal(calls.findMany.length, 0, 'lead lookup must be skipped once messageId matches')
  // Tenant + header scoping on the messageId lookup.
  assert.deepEqual(calls.findFirst[0].where, { workspaceId: WS, messageId: 'msg-123' })
})

test('EMAIL_UNIQUE: no messageId match, exactly one SENT row for the lead', async () => {
  const { tx, calls } = makeTx({ findFirst: null, findMany: [
    { id: 'os_1', leadId: 'lead_1', campaignId: 'camp_1', toEmail: 'a@example.com' },
  ] })

  const m = await findBestMatchingOutreachSent(tx, { workspaceId: WS, inReplyTo: 'msg-unknown', leadId: 'lead_1' })

  assert.equal(m.method, 'EMAIL_UNIQUE')
  assert.equal(m.outreachSentId, 'os_1')
  // We tried the messageId path first (it just missed), then fell back to the lead.
  assert.equal(calls.findFirst.length, 1)
  assert.equal(calls.findMany.length, 1)
  // The lead lookup is workspace-scoped, SENT-only, most-recent-first, capped at 2.
  assert.deepEqual(calls.findMany[0].where, { workspaceId: WS, leadId: 'lead_1', status: 'SENT' })
  assert.deepEqual(calls.findMany[0].orderBy, { sentAt: 'desc' })
  assert.equal(calls.findMany[0].take, 2)
})

test('MOST_RECENT_LEAD_SEND: several SENT rows → pick the most recent and record the ambiguity', async () => {
  const { tx } = makeTx({ findFirst: null, findMany: [
    { id: 'os_recent', leadId: 'lead_1', campaignId: 'camp_2', toEmail: 'a@example.com' },
    { id: 'os_older', leadId: 'lead_1', campaignId: 'camp_1', toEmail: 'a@example.com' },
  ] })

  const m = await findBestMatchingOutreachSent(tx, { workspaceId: WS, inReplyTo: null, leadId: 'lead_1' })

  assert.equal(m.method, 'MOST_RECENT_LEAD_SEND')
  assert.equal(m.outreachSentId, 'os_recent', 'must take the first row (orderBy sentAt desc)')
  assert.equal(m.campaignId, 'camp_2')
})

test('no inReplyTo skips the messageId query entirely and goes straight to the lead', async () => {
  const { tx, calls } = makeTx({ findMany: [
    { id: 'os_1', leadId: 'lead_1', campaignId: 'camp_1', toEmail: 'a@example.com' },
  ] })

  const m = await findBestMatchingOutreachSent(tx, { workspaceId: WS, inReplyTo: null, leadId: 'lead_1' })

  assert.equal(m.method, 'EMAIL_UNIQUE')
  assert.equal(calls.findFirst.length, 0, 'no In-Reply-To → no messageId query')
})

test('NO_MATCH: lead has no SENT rows → recorded, not guessed (leadId preserved)', async () => {
  const { tx } = makeTx({ findFirst: null, findMany: [] })

  const m = await findBestMatchingOutreachSent(tx, { workspaceId: WS, inReplyTo: 'msg-x', leadId: 'lead_9' })

  assert.equal(m.method, 'NO_MATCH')
  assert.equal(m.outreachSentId, null)
  assert.equal(m.leadId, 'lead_9', 'the unmatched lead is carried through for telemetry')
  assert.equal(m.campaignId, null)
  assert.equal(m.toEmail, null)
})

test('NO_MATCH: neither In-Reply-To nor leadId → no queries at all', async () => {
  const { tx, calls } = makeTx({})

  const m = await findBestMatchingOutreachSent(tx, { workspaceId: WS, inReplyTo: null, leadId: null })

  assert.equal(m.method, 'NO_MATCH')
  assert.equal(m.leadId, null)
  assert.equal(calls.findFirst.length, 0)
  assert.equal(calls.findMany.length, 0)
})
