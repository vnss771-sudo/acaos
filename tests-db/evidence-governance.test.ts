// C4 tests: owner-only retention/hold management, the two-step deletion workflow, the
// resumable deletion runner, the external ledger, database-restore reconciliation and
// controlled workspace erasure. Real PostgreSQL and the real routes/processors; in-memory
// stores stand in for the primary, backup and ledger buckets (no network, no credentials).
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { evidenceGovernanceRouter, setApiLedgerForTests } from '../apps/api/src/routes/ops/evidenceGovernance.ts'
import { workspaceRouter } from '../apps/api/src/routes/workspaces/index.ts'
import {
  executeDeletionRequest, reconcileEvidenceLedger, syncHoldLedger, runDeletionCycle, type DeletionStores,
} from '../apps/worker/src/processors/evidenceDeletion.ts'
import { replicateEvidenceFile, sha256Hex } from '../apps/worker/src/processors/evidenceBackup.ts'
import { MemoryEvidenceStore, newEvidenceKeys } from '../packages/backend-core/src/lib/evidenceStorage.ts'
import { EvidenceLedger } from '../packages/backend-core/src/lib/evidenceLedger.ts'
import { lockEvidenceGovernance } from '../packages/backend-core/src/lib/evidenceGovernance.ts'
import { prisma, resetDb, disconnect, seedUser, seedUserWithWorkspace, seedWorkspace, startTestServer, bearer, type TestServer } from './helpers/db.ts'

const MAC = 'm'.repeat(40), SEAL = 's'.repeat(40)
const ENV_KEYS = ['EVIDENCE_DESTRUCTIVE_ENABLED', 'EVIDENCE_DELETION_SEAL_KEY', 'EVIDENCE_LEDGER_ENABLED']
const saved: Record<string, string | undefined> = {}
const YEARS = (n: number) => new Date(Date.now() - n * 365 * 86_400_000)
const DAYS = (n: number) => n * 86_400_000

let gov: TestServer
let ws: TestServer
let primary: MemoryEvidenceStore
let backup: MemoryEvidenceStore
let ledgerStore: MemoryEvidenceStore
let ledger: EvidenceLedger
let stores: DeletionStores

before(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k]
  gov = await startTestServer('/api/ops/evidence-governance', evidenceGovernanceRouter)
  ws = await startTestServer('/api/workspaces', workspaceRouter)
})
after(async () => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
  setApiLedgerForTests(undefined)
  await gov.close(); await ws.close(); await disconnect()
})
beforeEach(async () => {
  await resetDb()
  process.env.EVIDENCE_DESTRUCTIVE_ENABLED = 'true'; process.env.EVIDENCE_DELETION_SEAL_KEY = SEAL
  primary = new MemoryEvidenceStore(); backup = new MemoryEvidenceStore()
  ledgerStore = new MemoryEvidenceStore({ immutable: true })
  ledger = new EvidenceLedger(ledgerStore, MAC)
  setApiLedgerForTests(ledger)
  stores = { primary, backup, ledger, ledgerStore }
})

// ── fixtures ────────────────────────────────────────────────────────────────

let n = 0
async function world() {
  const { user: owner, workspace } = await seedUserWithWorkspace(`o${++n}@example.test`)
  const owner2 = await seedUser(`o2-${n}@example.test`)
  const admin = await seedUser(`a${n}@example.test`)
  const member = await seedUser(`m${n}@example.test`)
  const outsider = await seedUser(`x${n}@example.test`)
  await prisma.membership.createMany({ data: [
    { workspaceId: workspace.id, userId: owner2.id, role: 'owner' }, { workspaceId: workspace.id, userId: admin.id, role: 'admin' }, { workspaceId: workspace.id, userId: member.id, role: 'member' },
  ] })
  const other = await seedWorkspace(outsider.id, { role: 'owner' })   // outsider owns a DIFFERENT workspace
  const site = await prisma.opsJobSite.create({ data: { workspaceId: workspace.id, jobCode: 'S1', siteName: 'Site' } })
  const crew = await prisma.opsCrewMember.create({ data: { workspaceId: workspace.id, employeeCode: `E${n}`, fullName: 'Tech', role: 'TECH' } })
  return { owner, owner2, admin, member, outsider, ws: workspace, other, site, crew }
}
type World = Awaited<ReturnType<typeof world>>

async function job(w: World, over: { closed?: boolean } = {}) {
  const closed = over.closed ?? true
  return prisma.job.create({ data: { workspaceId: w.ws.id, opsJobSiteId: w.site.id, status: closed ? 'COMPLETE' : 'ACTIVE', completedAt: closed ? YEARS(8) : null } })
}

/** An AVAILABLE file, old enough to be out of retention, with primary + backup copies and objects. */
async function file(w: World, j?: { id: string }, over: { finalizedAt?: Date; backedUp?: boolean } = {}) {
  const jb = j ?? await job(w)
  const bytes = Buffer.from(`photo-${randomUUID()}`)
  const sha = sha256Hex(bytes)
  const keys = newEvidenceKeys(w.ws.id, jb.id)
  const f = await prisma.evidenceFile.create({ data: {
    workspaceId: w.ws.id, jobId: jb.id, crewMemberId: w.crew.id, submissionId: randomUUID(), status: 'AVAILABLE', contentType: 'image/jpeg',
    sizeBytes: bytes.length, sha256: sha, finalizedAt: over.finalizedAt ?? YEARS(8),
  } })
  await prisma.evidenceFileCopy.create({ data: { workspaceId: w.ws.id, fileId: f.id, location: 'primary', objectKey: keys.primaryKey, status: 'VERIFIED', sizeBytes: bytes.length, sha256: sha, verifiedAt: new Date() } })
  primary.objects.set(keys.primaryKey, { bytes, contentType: 'image/jpeg' })
  if (over.backedUp !== false) {
    assert.equal((await replicateEvidenceFile({ workspaceId: w.ws.id, fileId: f.id, primary, backup })).outcome, 'verified')
  }
  return { file: f, job: jb, key: keys.primaryKey, bytes, sha }
}

const call = (s: TestServer) => (uid: string | null, method: string, path: string, body?: unknown) =>
  s.request(path, { method, headers: { ...(uid ? { Authorization: bearer(uid) } : {}), 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
const G = (uid: string | null, method: string, path: string, body?: unknown) => call(gov)(uid, method, path, body)
const P = '/api/ops/evidence-governance'

/** Request + approve through the API as the two owners. Returns the request id. */
async function approved(w: World, f: { file: { id: string } }, opts: { reviewer?: string } = {}) {
  const r = await G(w.owner.id, 'POST', `${P}/deletion-requests`, { workspaceId: w.ws.id, fileId: f.file.id, reason: 'Customer contract ended; retention elapsed' })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  const a = await G(opts.reviewer ?? w.owner2.id, 'POST', `${P}/deletion-requests/${r.body.request.id}/approve`, { workspaceId: w.ws.id })
  assert.equal(a.status, 200, JSON.stringify(a.body))
  return r.body.request.id as string
}
const due = (id: string) => prisma.evidenceDeletionRequest.findUniqueOrThrow({ where: { id } }).then((r: { notBefore: Date | null }) => new Date(r.notBefore!.getTime() + 1000))
const run = async (id: string, extra: { now?: Date } = {}) => executeDeletionRequest({ requestId: id, stores, sealKey: SEAL, now: extra.now ?? await due(id) })
const fileStatus = (id: string) => prisma.evidenceFile.findUniqueOrThrow({ where: { id } }).then((f: { status: string }) => f.status)
const holdInDb = (w: World, jobId: string | null) => prisma.legalHold.create({ data: { workspaceId: w.ws.id, scope: jobId ? 'JOB' : 'WORKSPACE', jobId, reason: 'dispute', placedByUserId: w.owner.id } })
const settle = () => new Promise((r) => setTimeout(r, 60))

// ── authorization ───────────────────────────────────────────────────────────

test('every governance endpoint is owner-only and workspace-scoped', async () => {
  const w = await world()
  const f = await file(w)
  const reqId = await approved(w, f)
  const hold = await holdInDb(w, null)
  const endpoints: Array<[string, string, unknown?]> = [
    ['GET', `/policy?workspaceId=${w.ws.id}`], ['PUT', '/policy', { workspaceId: w.ws.id, deletionWaitDays: 14 }],
    ['POST', '/policy/confirm-wait', { workspaceId: w.ws.id }], ['POST', '/policy/cancel-wait', { workspaceId: w.ws.id }],
    ['GET', `/holds?workspaceId=${w.ws.id}`], ['POST', '/holds', { workspaceId: w.ws.id, scope: 'WORKSPACE', reason: 'long enough reason' }],
    ['POST', `/holds/${hold.id}/release`, { workspaceId: w.ws.id, releaseReason: 'long enough reason' }],
    ['GET', `/deletion-requests?workspaceId=${w.ws.id}`], ['POST', '/deletion-requests', { workspaceId: w.ws.id, fileId: f.file.id, reason: 'long enough reason' }],
    ['POST', `/deletion-requests/${reqId}/approve`, { workspaceId: w.ws.id }], ['POST', `/deletion-requests/${reqId}/reject`, { workspaceId: w.ws.id, note: 'long enough reason' }],
    ['POST', `/deletion-requests/${reqId}/cancel`, { workspaceId: w.ws.id }],
  ]
  for (const who of [['admin', w.admin.id], ['member', w.member.id], ['outsider (owner elsewhere)', w.outsider.id], ['anonymous', null]] as const) {
    for (const [method, path, body] of endpoints) {
      const r = await G(who[1], method, `${P}${path}`, body)
      assert.equal(r.status, who[1] ? 403 : 401, `${who[0]} ${method} ${path} -> ${r.status}`)
    }
  }
  // nothing changed
  assert.equal((await prisma.evidenceDeletionRequest.findUniqueOrThrow({ where: { id: reqId } })).status, 'APPROVED')
  assert.equal((await prisma.legalHold.findUniqueOrThrow({ where: { id: hold.id } })).releasedAt, null)
})

test('an owner of another workspace cannot see or act on this workspace\'s files, requests or holds', async () => {
  const a = await world(); const b = await world()
  const fa = await file(a); const reqA = await approved(a, fa); const holdA = await holdInDb(a, null)
  // B's owner presents B's workspace id with A's object ids
  assert.equal((await G(b.owner.id, 'POST', `${P}/deletion-requests`, { workspaceId: b.ws.id, fileId: fa.file.id, reason: 'long enough reason' })).status, 404)
  assert.equal((await G(b.owner.id, 'POST', `${P}/deletion-requests/${reqA}/approve`, { workspaceId: b.ws.id })).status, 404)
  assert.equal((await G(b.owner.id, 'POST', `${P}/deletion-requests/${reqA}/cancel`, { workspaceId: b.ws.id })).status, 404)
  assert.equal((await G(b.owner.id, 'POST', `${P}/holds/${holdA.id}/release`, { workspaceId: b.ws.id, releaseReason: 'long enough reason' })).status, 404)
  const jobA = await job(a)
  assert.equal((await G(b.owner.id, 'POST', `${P}/holds`, { workspaceId: b.ws.id, scope: 'JOB', jobId: jobA.id, reason: 'long enough reason' })).status, 404)
  assert.equal(((await G(b.owner.id, 'GET', `${P}/deletion-requests?workspaceId=${b.ws.id}`)).body.requests as unknown[]).length, 0)
  assert.equal(((await G(b.owner.id, 'GET', `${P}/holds?workspaceId=${b.ws.id}`)).body.holds as unknown[]).length, 0)
  // and the runner cannot be tricked into deleting A's file through B: the request is bound to A
  assert.equal(await fileStatus(fa.file.id), 'AVAILABLE')
})

// ── destructive flag ────────────────────────────────────────────────────────

test('with the destructive flag off, request and review answer 503 while holds and policy still work', async () => {
  const w = await world(); const f = await file(w)
  for (const v of [undefined, 'false', 'yes']) {
    if (v === undefined) delete process.env.EVIDENCE_DESTRUCTIVE_ENABLED; else process.env.EVIDENCE_DESTRUCTIVE_ENABLED = v
    assert.equal((await G(w.owner.id, 'POST', `${P}/deletion-requests`, { workspaceId: w.ws.id, fileId: f.file.id, reason: 'long enough reason' })).status, 503)
  }
  process.env.EVIDENCE_DESTRUCTIVE_ENABLED = 'true'
  const reqId = await approved(w, f)
  delete process.env.EVIDENCE_DESTRUCTIVE_ENABLED
  assert.equal((await G(w.owner2.id, 'POST', `${P}/deletion-requests/${reqId}/approve`, { workspaceId: w.ws.id })).status, 503)
  // protective endpoints still work
  assert.equal((await G(w.owner.id, 'POST', `${P}/holds`, { workspaceId: w.ws.id, scope: 'WORKSPACE', reason: 'long enough reason' })).status, 201)
  assert.equal((await G(w.owner.id, 'GET', `${P}/policy?workspaceId=${w.ws.id}`)).status, 200)
  // seal key missing/short also disables it
  process.env.EVIDENCE_DESTRUCTIVE_ENABLED = 'true'; process.env.EVIDENCE_DELETION_SEAL_KEY = 'short'
  assert.equal((await G(w.owner.id, 'POST', `${P}/deletion-requests`, { workspaceId: w.ws.id, fileId: f.file.id, reason: 'long enough reason' })).status, 503)
  // and the runner refuses without full configuration, touching nothing
  const r = await runDeletionCycle({ env: {} })
  assert.ok('skipped' in r && r.skipped === 'flag_off')
})

// ── policy ──────────────────────────────────────────────────────────────────

test('policy defaults, lengthening, cooling-off for shortening, and what cannot be changed', async () => {
  const w = await world()
  let p = (await G(w.owner.id, 'GET', `${P}/policy?workspaceId=${w.ws.id}`)).body.policy
  assert.deepEqual({ r: p.retentionDays, d: p.deletionWaitDays, auto: p.autoDeletionEnabled }, { r: 2555, d: 7, auto: false })
  assert.equal((await G(w.owner.id, 'PUT', `${P}/policy`, { workspaceId: w.ws.id, deletionWaitDays: 14 })).body.waitStatus, 'applied')
  const shorten = await G(w.owner.id, 'PUT', `${P}/policy`, { workspaceId: w.ws.id, deletionWaitDays: 3 })
  assert.equal(shorten.body.waitStatus, 'pending'); assert.equal(shorten.body.policy.deletionWaitDays, 14, 'still 14 until confirmed')
  assert.equal((await G(w.owner.id, 'POST', `${P}/policy/confirm-wait`, { workspaceId: w.ws.id })).status, 409, 'cooling-off')
  await prisma.retentionPolicy.update({ where: { workspaceId: w.ws.id }, data: { pendingWaitRequestedAt: new Date(Date.now() - DAYS(2)) } })
  assert.equal((await G(w.owner2.id, 'POST', `${P}/policy/confirm-wait`, { workspaceId: w.ws.id })).body.deletionWaitDays, 3)
  p = (await G(w.owner.id, 'GET', `${P}/policy?workspaceId=${w.ws.id}`)).body.policy
  assert.deepEqual({ d: p.deletionWaitDays, pend: p.pendingWaitDays }, { d: 3, pend: null })
  // cancel a pending shortening
  await G(w.owner.id, 'PUT', `${P}/policy`, { workspaceId: w.ws.id, deletionWaitDays: 1 })
  assert.equal((await G(w.owner.id, 'POST', `${P}/policy/cancel-wait`, { workspaceId: w.ws.id })).status, 200)
  assert.equal((await G(w.owner.id, 'POST', `${P}/policy/cancel-wait`, { workspaceId: w.ws.id })).status, 409)
  // lengthening retention is allowed; shortening it is not
  assert.equal((await G(w.owner.id, 'PUT', `${P}/policy`, { workspaceId: w.ws.id, retentionDays: 3000 })).status, 200)
  assert.equal((await G(w.owner.id, 'PUT', `${P}/policy`, { workspaceId: w.ws.id, retentionDays: 2000 })).status, 409)
  // automatic deletion and unknown fields cannot be set; bounds hold
  for (const bad of [{ autoDeletionEnabled: true }, { startRule: 'UPLOAD' }, { deletionWaitDays: 0 }, { deletionWaitDays: 366 }, { deletionWaitDays: 1.5 }, { retentionDays: 0 }]) {
    assert.equal((await G(w.owner.id, 'PUT', `${P}/policy`, { workspaceId: w.ws.id, ...bad })).status, 400, JSON.stringify(bad))
  }
  assert.equal((await prisma.retentionPolicy.findUniqueOrThrow({ where: { workspaceId: w.ws.id } })).autoDeletionEnabled, false)
  await settle()
  const types = (await prisma.auditEvent.findMany({ where: { workspaceId: w.ws.id, type: { startsWith: 'evidence.policy' } } })).map((e: { type: string }) => e.type)
  assert.ok(types.includes('evidence.policy.updated') && types.includes('evidence.policy.wait_confirmed') && types.includes('evidence.policy.wait_cancelled'))
})

// ── legal holds ─────────────────────────────────────────────────────────────

test('holds: workspace and job scope, validation, release, audit, and the external ledger', async () => {
  const w = await world(); const j = await job(w)
  assert.equal((await G(w.owner.id, 'POST', `${P}/holds`, { workspaceId: w.ws.id, scope: 'JOB', reason: 'long enough reason' })).status, 400, 'JOB needs jobId')
  assert.equal((await G(w.owner.id, 'POST', `${P}/holds`, { workspaceId: w.ws.id, scope: 'WORKSPACE', jobId: j.id, reason: 'long enough reason' })).status, 400)
  assert.equal((await G(w.owner.id, 'POST', `${P}/holds`, { workspaceId: w.ws.id, scope: 'WORKSPACE', reason: 'short' })).status, 400)
  assert.equal((await G(w.owner.id, 'POST', `${P}/holds`, { workspaceId: w.ws.id, scope: 'JOB', jobId: 'nope', reason: 'long enough reason' })).status, 404)
  const h1 = await G(w.owner.id, 'POST', `${P}/holds`, { workspaceId: w.ws.id, scope: 'JOB', jobId: j.id, reason: 'regulator enquiry 2026-14' })
  const h2 = await G(w.owner.id, 'POST', `${P}/holds`, { workspaceId: w.ws.id, scope: 'WORKSPACE', reason: 'litigation hold notice' })
  assert.equal(h1.status, 201); assert.equal(h1.body.ledgered, true); assert.equal(h2.body.hold.scope, 'WORKSPACE')
  assert.equal(((await G(w.owner.id, 'GET', `${P}/holds?workspaceId=${w.ws.id}&active=true`)).body.holds as unknown[]).length, 2)
  const rel = await G(w.owner2.id, 'POST', `${P}/holds/${h1.body.hold.id}/release`, { workspaceId: w.ws.id, releaseReason: 'enquiry closed, written confirmation' })
  assert.equal(rel.status, 200); assert.equal(rel.body.hold.releasedByUserId, w.owner2.id); assert.equal(rel.body.ledgered, true)
  assert.equal((await G(w.owner.id, 'POST', `${P}/holds/${h1.body.hold.id}/release`, { workspaceId: w.ws.id, releaseReason: 'enquiry closed, written confirmation' })).status, 409)
  assert.equal(((await G(w.owner.id, 'GET', `${P}/holds?workspaceId=${w.ws.id}&active=false`)).body.holds as unknown[]).length, 1)
  await settle()
  const types = (await prisma.auditEvent.findMany({ where: { workspaceId: w.ws.id, type: { startsWith: 'evidence.hold' } } })).map((e: { type: string }) => e.type).sort()
  assert.deepEqual(types, ['evidence.hold.placed', 'evidence.hold.placed', 'evidence.hold.released'])
  const { holds } = await ledger.holdStates(w.ws.id)
  assert.equal(holds.get(h1.body.hold.id)?.released, true); assert.equal(holds.get(h2.body.hold.id)?.released, undefined)
  const row = await prisma.legalHold.findUniqueOrThrow({ where: { id: h1.body.hold.id } })
  assert.ok(row.ledgeredAt && row.releaseLedgeredAt)
})

test('holds are written to the ledger first: an unreachable ledger means no acknowledged hold, never a silently lost one', async () => {
  const w = await world(); const j = await job(w)
  const place = () => G(w.owner.id, 'POST', `${P}/holds`, { workspaceId: w.ws.id, scope: 'JOB', jobId: j.id, reason: 'litigation hold notice' })
  ledgerStore.failNext = { op: 'putBytes', times: 100 }                 // ledger configured but unreachable
  const down = await place()
  assert.equal(down.status, 503); assert.match(down.body.error, /durably/)
  assert.equal(await prisma.legalHold.count({ where: { workspaceId: w.ws.id } }), 0, 'nothing was created')
  assert.equal(await prisma.auditEvent.count({ where: { workspaceId: w.ws.id, type: 'evidence.hold.placed' } }), 0)
  ledgerStore.failNext = null
  const ok = await place()
  assert.equal(ok.status, 201); assert.equal(ok.body.ledgered, true)
  const row = await prisma.legalHold.findUniqueOrThrow({ where: { id: ok.body.hold.id } })
  assert.ok(row.ledgeredAt, 'ledgered before it was acknowledged')
  assert.equal((await ledger.holdStates(w.ws.id)).holds.get(row.id)?.placed?.jobId, j.id)
})

test('a database restore right after a hold was acknowledged cannot lose it', async () => {
  const w = await world(); const j = await job(w)
  const before = await snapshot(w.ws.id)                                // the "older backup", before the hold
  const h = await G(w.owner.id, 'POST', `${P}/holds`, { workspaceId: w.ws.id, scope: 'JOB', jobId: j.id, reason: 'regulator enquiry 2026-14' })
  assert.equal(h.status, 201)
  await restoreSnapshot(w.ws.id, before)                                // restore: the hold row is gone
  assert.equal(await prisma.legalHold.count({ where: { workspaceId: w.ws.id } }), 0)
  const rep = await reconcileEvidenceLedger({ stores })
  assert.equal(rep.holdsRecreated, 1)
  const back = await prisma.legalHold.findUniqueOrThrow({ where: { id: h.body.hold.id } })
  assert.deepEqual({ scope: back.scope, job: back.jobId, active: back.releasedAt === null }, { scope: 'JOB', job: j.id, active: true })
})

test('with no ledger configured a hold is database-only; the runner back-fills it, and pauses until every hold is durable', async () => {
  const w = await world(); const f = await file(w); const id = await approved(w, f)
  setApiLedgerForTests(null)                                            // ledger not configured for the API
  const h = await G(w.owner.id, 'POST', `${P}/holds`, { workspaceId: w.ws.id, scope: 'WORKSPACE', reason: 'litigation hold notice' })
  assert.equal(h.status, 201); assert.equal(h.body.ledgered, false)
  assert.equal((await prisma.legalHold.findUniqueOrThrow({ where: { id: h.body.hold.id } })).ledgeredAt, null)
  // ledger down: the runner does nothing at all
  ledgerStore.failNext = { op: 'putBytes', times: 100 }
  const down = await runDeletionCycle({ stores, sealKey: SEAL, now: await due(id) })
  assert.ok('skipped' in down, JSON.stringify(down))
  assert.ok(primary.objects.has(f.key) && backup.objects.has(f.key)); assert.equal(await fileStatus(f.file.id), 'AVAILABLE')
  // ledger back: the hold is back-filled, and being active it blocks the deletion itself
  ledgerStore.failNext = null
  const next = await runDeletionCycle({ stores, sealKey: SEAL, now: await due(id) })
  assert.ok('executed' in next && next.holdsSynced >= 1 && next.executed[0].result.outcome === 'blocked', JSON.stringify(next))
  assert.equal((await ledger.holdStates(w.ws.id)).holds.get(h.body.hold.id)?.placed?.scope, 'WORKSPACE')
  // a hold the ledger cannot accept (its slot already holds a DIFFERENT entry) keeps the runner paused
  const w2 = await world(); const f2 = await file(w2); const id2 = await approved(w2, f2)
  const stuck = await holdInDb(w2, null)
  await ledger.append({ type: 'HOLD_PLACED', workspaceId: w2.ws.id, holdId: stuck.id, scope: 'JOB', jobId: 'other', placedBy: 'x', at: new Date().toISOString() })
  const paused = await runDeletionCycle({ stores, sealKey: SEAL, now: await due(id2) })
  assert.ok('skipped' in paused && paused.skipped === 'holds_not_durable', JSON.stringify(paused))
  assert.ok(primary.objects.has(f2.key)); assert.equal(await fileStatus(f2.file.id), 'AVAILABLE')
})

// ── request / review / wait ─────────────────────────────────────────────────

test('request validation: retention, holds, state, duplicates', async () => {
  const w = await world()
  const reason = 'Customer contract ended; retention elapsed'
  const ask = (fileId: string) => G(w.owner.id, 'POST', `${P}/deletion-requests`, { workspaceId: w.ws.id, fileId, reason })
  const young = await file(w, undefined, { finalizedAt: new Date() })
  const youngOpen = await file(w, await job(w, { closed: false }), { finalizedAt: YEARS(9) })
  assert.equal((await ask(young.file.id)).status, 409, 'retention active (job closed 8y ago, uploaded now)')
  assert.equal((await ask(youngOpen.file.id)).status, 409, 'job still open: retention cannot be determined')
  assert.equal((await G(w.owner.id, 'POST', `${P}/deletion-requests`, { workspaceId: w.ws.id, fileId: young.file.id, reason: 'short' })).status, 400)
  assert.equal((await ask('missing')).status, 404)
  const ok = await file(w)
  await holdInDb(w, ok.job.id)
  assert.equal((await ask(ok.file.id)).status, 409, 'a legal hold blocks the request')
  const ok2 = await file(w)
  const first = await ask(ok2.file.id); assert.equal(first.status, 201)
  assert.equal((await ask(ok2.file.id)).status, 409, 'one open request per file')
  assert.equal(JSON.stringify(first.body).includes('approvalSeal'), false, 'the seal is never exposed')
  await prisma.evidenceFile.update({ where: { id: ok2.file.id }, data: { status: 'DELETING' } })
  const ok3 = await file(w); await prisma.evidenceFile.update({ where: { id: ok3.file.id }, data: { status: 'REJECTED' } })
  assert.equal((await ask(ok3.file.id)).status, 409, 'only AVAILABLE evidence')
})

test('review starts a 7-day wait (policy-driven), is sealed, and can be rejected or cancelled', async () => {
  const w = await world(); const f = await file(w)
  const r = (await G(w.owner.id, 'POST', `${P}/deletion-requests`, { workspaceId: w.ws.id, fileId: f.file.id, reason: 'Customer contract ended' })).body.request
  assert.equal(r.status, 'REQUESTED')
  const before = Date.now()
  const a = (await G(w.owner2.id, 'POST', `${P}/deletion-requests/${r.id}/approve`, { workspaceId: w.ws.id, note: 'checked with the customer' })).body.request
  assert.equal(a.status, 'APPROVED'); assert.equal(a.waitDays, 7); assert.equal(a.reviewedByUserId, w.owner2.id)
  assert.ok(new Date(a.notBefore).getTime() - before >= DAYS(7) - 1000, 'at least seven days')
  assert.ok(new Date(a.approvalExpiresAt).getTime() > new Date(a.notBefore).getTime())
  const row = await prisma.evidenceDeletionRequest.findUniqueOrThrow({ where: { id: r.id } })
  assert.match(row.approvalSeal ?? '', /^[0-9a-f]{64}$/)
  assert.equal((await G(w.owner.id, 'POST', `${P}/deletion-requests/${r.id}/approve`, { workspaceId: w.ws.id })).status, 409, 'cannot approve twice')
  assert.equal((await G(w.owner.id, 'POST', `${P}/deletion-requests/${r.id}/reject`, { workspaceId: w.ws.id, note: 'long enough reason' })).status, 409, 'cannot reject an approved request')
  assert.equal((await G(w.owner.id, 'POST', `${P}/deletion-requests/${r.id}/cancel`, { workspaceId: w.ws.id })).status, 200)
  assert.equal((await prisma.evidenceDeletionRequest.findUniqueOrThrow({ where: { id: r.id } })).activeFileId, null)
  // a cancelled request frees the file for a new one, which can be rejected
  const r2 = (await G(w.owner.id, 'POST', `${P}/deletion-requests`, { workspaceId: w.ws.id, fileId: f.file.id, reason: 'second attempt, reason given' })).body.request
  assert.equal((await G(w.owner.id, 'POST', `${P}/deletion-requests/${r2.id}/reject`, { workspaceId: w.ws.id, note: 'not needed any more' })).body.request.status, 'REJECTED')
  // a non-default wait applies to new reviews only
  await G(w.owner.id, 'PUT', `${P}/policy`, { workspaceId: w.ws.id, deletionWaitDays: 30 })
  const r3 = (await G(w.owner.id, 'POST', `${P}/deletion-requests`, { workspaceId: w.ws.id, fileId: f.file.id, reason: 'third attempt, reason given' })).body.request
  const a3 = (await G(w.owner.id, 'POST', `${P}/deletion-requests/${r3.id}/approve`, { workspaceId: w.ws.id })).body.request
  assert.equal(a3.waitDays, 30)
  await settle()
  const types = (await prisma.auditEvent.findMany({ where: { workspaceId: w.ws.id, type: { startsWith: 'evidence.deletion' } } })).map((e: { type: string }) => e.type)
  for (const t of ['requested', 'approved', 'cancelled', 'rejected']) assert.ok(types.includes(`evidence.deletion.${t}`), t)
})

test('a workspace can require a different owner to review', async () => {
  const w = await world(); const f = await file(w)
  await G(w.owner.id, 'PUT', `${P}/policy`, { workspaceId: w.ws.id, requireDistinctReviewer: true })
  const r = (await G(w.owner.id, 'POST', `${P}/deletion-requests`, { workspaceId: w.ws.id, fileId: f.file.id, reason: 'Customer contract ended' })).body.request
  assert.equal((await G(w.owner.id, 'POST', `${P}/deletion-requests/${r.id}/approve`, { workspaceId: w.ws.id })).status, 403, 'self-review refused')
  assert.equal((await G(w.owner2.id, 'POST', `${P}/deletion-requests/${r.id}/approve`, { workspaceId: w.ws.id })).status, 200)
})

test('a hold placed after the request blocks review', async () => {
  const w = await world(); const f = await file(w)
  const r = (await G(w.owner.id, 'POST', `${P}/deletion-requests`, { workspaceId: w.ws.id, fileId: f.file.id, reason: 'Customer contract ended' })).body.request
  await holdInDb(w, null)
  assert.equal((await G(w.owner2.id, 'POST', `${P}/deletion-requests/${r.id}/approve`, { workspaceId: w.ws.id })).status, 409)
})

// ── execution ───────────────────────────────────────────────────────────────

test('the waiting period is honoured; after it, deletion removes both copies, is ledgered, and is idempotent', async () => {
  const w = await world(); const f = await file(w)
  const id = await approved(w, f)
  const early = await run(id, { now: new Date() })
  assert.equal(early.outcome, 'not_due')
  assert.ok(primary.objects.has(f.key) && backup.objects.has(f.key)); assert.equal(await fileStatus(f.file.id), 'AVAILABLE')

  const r = await run(id)
  assert.deepEqual(r, { outcome: 'completed' })
  assert.ok(!primary.objects.has(f.key) && !backup.objects.has(f.key), 'both copies removed')
  const row = await prisma.evidenceFile.findUniqueOrThrow({ where: { id: f.file.id }, include: { copies: true } })
  assert.equal(row.status, 'DELETED'); assert.ok(row.deletedAt); assert.equal(row.sha256, f.sha, 'tombstone keeps the hash')
  assert.ok(row.copies.every((c: { status: string }) => c.status === 'DELETED'))
  const req = await prisma.evidenceDeletionRequest.findUniqueOrThrow({ where: { id } })
  assert.equal(req.status, 'COMPLETED'); assert.equal(req.activeFileId, null); assert.ok(req.completedAt)
  const st = (await ledger.fileStates(w.ws.id)).states.get(f.file.id)!
  assert.equal(st.completed, true); assert.equal(st.started?.sha256, f.sha); assert.equal(st.started?.reviewedBy, w.owner2.id)
  const log = await prisma.evidenceDeletionLog.findMany({ where: { fileId: f.file.id } })
  assert.equal(log.length, 1); assert.equal(log[0].event, 'DELETED'); assert.equal(log[0].actorUserId, w.owner2.id)
  assert.deepEqual(await run(id), { outcome: 'already_completed' })
  assert.equal((await prisma.evidenceDeletionLog.count({ where: { fileId: f.file.id } })), 1)
  assert.ok((await ledger.verifyChain(w.ws.id)).ok)
  // a deleted file can be neither requested again nor restored
  assert.equal((await G(w.owner.id, 'POST', `${P}/deletion-requests`, { workspaceId: w.ws.id, fileId: f.file.id, reason: 'again, with a reason' })).status, 409)
})

test('only APPROVED or EXECUTING requests are executed', async () => {
  const w = await world(); const f = await file(w)
  const r = (await G(w.owner.id, 'POST', `${P}/deletion-requests`, { workspaceId: w.ws.id, fileId: f.file.id, reason: 'Customer contract ended' })).body.request
  assert.equal((await executeDeletionRequest({ requestId: r.id, stores, sealKey: SEAL, now: new Date(Date.now() + DAYS(30)) })).outcome, 'skipped')
  assert.equal((await executeDeletionRequest({ requestId: 'missing', stores, sealKey: SEAL })).outcome, 'skipped')
  assert.ok(primary.objects.has(f.key))
})

// ── forged and expired approvals ────────────────────────────────────────────

test('forged approvals are inert: bad seal, tampered fields, wrong key, direct SQL', async () => {
  const w = await world(); const f = await file(w)
  // (a) a request flipped to APPROVED straight in the database, with a plausible but unsigned seal
  const r = (await G(w.owner.id, 'POST', `${P}/deletion-requests`, { workspaceId: w.ws.id, fileId: f.file.id, reason: 'Customer contract ended' })).body.request
  const now = new Date(Date.now() - DAYS(10))
  await prisma.evidenceDeletionRequest.update({ where: { id: r.id }, data: {
    status: 'APPROVED', reviewedByUserId: w.owner2.id, reviewedAt: now, waitDays: 7, notBefore: new Date(now.getTime() + DAYS(7)),
    approvalExpiresAt: new Date(now.getTime() + DAYS(37)), approvalSeal: 'f'.repeat(64),
  } })
  const forged = await executeDeletionRequest({ requestId: r.id, stores, sealKey: SEAL, now: new Date() })
  assert.deepEqual(forged, { outcome: 'blocked', reason: 'seal_invalid' })
  assert.ok(primary.objects.has(f.key) && backup.objects.has(f.key)); assert.equal(await fileStatus(f.file.id), 'AVAILABLE')
  assert.equal((await prisma.evidenceDeletionRequest.findUniqueOrThrow({ where: { id: r.id } })).lastError, 'seal_invalid')
  assert.equal((await ledger.fileStates(w.ws.id)).states.size, 0, 'nothing was ledgered either')

  // (b) a genuine approval whose recorded reviewer / dates / file hash are altered afterwards
  const w2 = await world(); const g = await file(w2)
  const id = await approved(w2, g)
  const tamper: Array<Record<string, unknown>> = [
    { reviewedByUserId: w2.admin.id }, { waitDays: 1 }, { notBefore: new Date(Date.now() - 1000) }, { approvalExpiresAt: new Date(Date.now() + DAYS(900)) },
  ]
  for (const t of tamper) {
    const keep = await prisma.evidenceDeletionRequest.findUniqueOrThrow({ where: { id } })
    // the CHECK constraint (notBefore >= reviewedAt + waitDays) may itself reject some edits; either way nothing is deleted
    try { await prisma.evidenceDeletionRequest.update({ where: { id }, data: t as never }) } catch { continue }
    assert.deepEqual(await executeDeletionRequest({ requestId: id, stores, sealKey: SEAL, now: new Date(Date.now() + DAYS(60)) }), { outcome: 'blocked', reason: 'seal_invalid' }, JSON.stringify(t))
    await prisma.evidenceDeletionRequest.update({ where: { id }, data: { reviewedByUserId: keep.reviewedByUserId, waitDays: keep.waitDays, notBefore: keep.notBefore, approvalExpiresAt: keep.approvalExpiresAt } })
  }
  assert.ok(primary.objects.has(g.key)); assert.equal(await fileStatus(g.file.id), 'AVAILABLE')
  // (c) the genuine approval verifies only under the genuine key
  assert.equal((await executeDeletionRequest({ requestId: id, stores, sealKey: 'k'.repeat(40), now: await due(id) })).outcome, 'blocked')
  assert.equal((await run(id)).outcome, 'completed')
  // (d) a seal for one request cannot be reused on another file's request
  const w3 = await world(); const h1 = await file(w3); const h2 = await file(w3)
  const id1 = await approved(w3, h1)
  const r2 = (await G(w3.owner.id, 'POST', `${P}/deletion-requests`, { workspaceId: w3.ws.id, fileId: h2.file.id, reason: 'Customer contract ended' })).body.request
  const donor = await prisma.evidenceDeletionRequest.findUniqueOrThrow({ where: { id: id1 } })
  await prisma.evidenceDeletionRequest.update({ where: { id: r2.id }, data: {
    status: 'APPROVED', reviewedByUserId: donor.reviewedByUserId, reviewedAt: donor.reviewedAt, waitDays: donor.waitDays, notBefore: donor.notBefore, approvalExpiresAt: donor.approvalExpiresAt, approvalSeal: donor.approvalSeal,
  } })
  assert.deepEqual(await executeDeletionRequest({ requestId: r2.id, stores, sealKey: SEAL, now: await due(id1) }), { outcome: 'blocked', reason: 'seal_invalid' })
  assert.ok(primary.objects.has(h2.key))
})

test('an expired approval is cancelled, not executed', async () => {
  const w = await world(); const f = await file(w)
  const id = await approved(w, f)
  const req = await prisma.evidenceDeletionRequest.findUniqueOrThrow({ where: { id } })
  const r = await executeDeletionRequest({ requestId: id, stores, sealKey: SEAL, now: new Date(req.approvalExpiresAt!.getTime() + 1000) })
  assert.deepEqual(r, { outcome: 'blocked', reason: 'approval_expired' })
  const after = await prisma.evidenceDeletionRequest.findUniqueOrThrow({ where: { id } })
  assert.equal(after.status, 'CANCELLED'); assert.equal(after.activeFileId, null)
  assert.ok(primary.objects.has(f.key)); assert.equal(await fileStatus(f.file.id), 'AVAILABLE')
  assert.equal((await run(id)).outcome, 'skipped', 'a cancelled request stays cancelled')
})

// ── legal holds vs execution ────────────────────────────────────────────────

test('an active hold blocks execution (workspace or job scope) until released', async () => {
  const w = await world(); const f = await file(w)
  const id = await approved(w, f)
  const h = await holdInDb(w, f.job.id)
  assert.deepEqual(await run(id), { outcome: 'blocked', reason: 'legal_hold' })
  assert.ok(primary.objects.has(f.key) && backup.objects.has(f.key)); assert.equal(await fileStatus(f.file.id), 'AVAILABLE')
  assert.equal((await prisma.evidenceDeletionRequest.findUniqueOrThrow({ where: { id } })).status, 'APPROVED')
  await prisma.legalHold.update({ where: { id: h.id }, data: { releasedAt: new Date(), releasedByUserId: w.owner.id, releaseReason: 'closed' } })
  const wsHold = await holdInDb(w, null)
  assert.deepEqual(await run(id), { outcome: 'blocked', reason: 'legal_hold' })
  await prisma.legalHold.update({ where: { id: wsHold.id }, data: { releasedAt: new Date(), releasedByUserId: w.owner.id, releaseReason: 'closed' } })
  // a hold on a DIFFERENT job does not block this file
  const other = await job(w); await holdInDb(w, other.id)
  assert.equal((await run(id)).outcome, 'completed')
})

test('hold placement racing deletion start: never both (no hold taken after the deletion began, no deletion after a hold)', async () => {
  const w = await world()
  for (let i = 0; i < 12; i++) {
    const f = await file(w); const id = await approved(w, f)
    const at = await due(id)
    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))
    const [exec, hold] = await Promise.all([
      delay(i % 4).then(() => executeDeletionRequest({ requestId: id, stores, sealKey: SEAL, now: at })),
      delay((i >> 2) % 3).then(() => G(w.owner.id, 'POST', `${P}/holds`, { workspaceId: w.ws.id, scope: 'JOB', jobId: f.job.id, reason: `litigation hold ${i} notice` })),
    ])
    assert.equal(hold.status, 201)
    const status = await fileStatus(f.file.id)
    if (hold.body.filesAlreadyDeletingOrDeleted === 0) {
      // the hold committed first: the deletion must not have started
      assert.equal(status, 'AVAILABLE', `iteration ${i}: hold won but file is ${status}`)
      assert.ok(primary.objects.has(f.key) && backup.objects.has(f.key))
      assert.equal(exec.outcome, 'blocked')
    } else {
      // the deletion started first: it was allowed to finish or is visibly in progress, never silently dropped
      assert.ok(['DELETING', 'DELETED'].includes(status), `iteration ${i}: ${status}`)
    }
    // a deletion that began is resumable once any hold is released, so the invariant holds on a re-run too
    await prisma.legalHold.updateMany({ where: { workspaceId: w.ws.id, jobId: f.job.id, releasedAt: null }, data: { releasedAt: new Date(), releasedByUserId: w.owner.id, releaseReason: 'test' } })
    await executeDeletionRequest({ requestId: id, stores, sealKey: SEAL, now: at })
  }
})

test('deletion start waits for an in-flight hold placement (the governance lock serialises them)', async () => {
  const w = await world(); const f = await file(w); const id = await approved(w, f)
  const at = await due(id)
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))
  // A hold placement is mid-transaction: it holds the lock and has inserted its (uncommitted) row.
  const placing = prisma.$transaction(async (tx) => {
    await lockEvidenceGovernance(tx, w.ws.id)
    await tx.legalHold.create({ data: { workspaceId: w.ws.id, scope: 'JOB', jobId: f.job.id, reason: 'placing now', placedByUserId: w.owner.id } })
    await delay(600)
  })
  await delay(100)
  const started = Date.now()
  const result = await executeDeletionRequest({ requestId: id, stores, sealKey: SEAL, now: at })   // begins while the lock is held
  await placing
  assert.ok(Date.now() - started >= 300, 'the execution waited for the placement to finish')
  assert.deepEqual(result, { outcome: 'blocked', reason: 'legal_hold' }, 'and then saw the committed hold')
  assert.equal(await fileStatus(f.file.id), 'AVAILABLE'); assert.ok(primary.objects.has(f.key) && backup.objects.has(f.key))
})

test('a hold that appears mid-deletion stops it visibly; the backup survives and the run resumes after release', async () => {
  const w = await world(); const f = await file(w)
  const id = await approved(w, f)
  const realDelete = primary.delete.bind(primary)
  let hold: { id: string } | null = null
  primary.delete = async (k: string) => { await realDelete(k); if (!hold) hold = await holdInDb(w, f.job.id) }
  const r = await run(id)
  assert.deepEqual(r, { outcome: 'failed', reason: 'legal_hold' })
  assert.ok(!primary.objects.has(f.key), 'the primary had already been removed'); assert.ok(backup.objects.has(f.key), 'the backup is retained')
  assert.equal(await fileStatus(f.file.id), 'DELETING')
  const req = await prisma.evidenceDeletionRequest.findUniqueOrThrow({ where: { id } })
  assert.equal(req.status, 'EXECUTING'); assert.equal(req.lastError, 'legal_hold'); assert.ok(req.attempts >= 1)
  assert.deepEqual(await run(id), { outcome: 'blocked', reason: 'legal_hold' }, 'still held')
  await prisma.legalHold.update({ where: { id: hold!.id }, data: { releasedAt: new Date(), releasedByUserId: w.owner.id, releaseReason: 'closed' } })
  primary.delete = realDelete
  assert.deepEqual(await run(id), { outcome: 'completed' })
  assert.ok(!backup.objects.has(f.key)); assert.equal(await fileStatus(f.file.id), 'DELETED')
})

// ── partial failure, resumability, crashes ──────────────────────────────────

test('a failed backup delete leaves the deletion visible and recoverable; the retry finishes it', async () => {
  const w = await world(); const f = await file(w)
  const id = await approved(w, f)
  backup.failNext = { op: 'delete', times: 1 }
  const r = await run(id)
  assert.deepEqual(r, { outcome: 'failed', reason: 'backup_delete_failed' })
  assert.ok(!primary.objects.has(f.key) && backup.objects.has(f.key), 'primary gone, backup remains')
  assert.equal(await fileStatus(f.file.id), 'DELETING', 'NOT marked DELETED until both copies are verified gone')
  const req = await prisma.evidenceDeletionRequest.findUniqueOrThrow({ where: { id } })
  assert.deepEqual({ s: req.status, e: req.lastError, a: req.attempts }, { s: 'EXECUTING', e: 'backup_delete_failed', a: 1 })
  assert.equal((await ledger.fileStates(w.ws.id)).states.get(f.file.id)?.completed, undefined, 'no completion recorded yet')
  assert.deepEqual(await run(id), { outcome: 'completed' })
  assert.equal(await fileStatus(f.file.id), 'DELETED'); assert.equal((await prisma.evidenceDeletionRequest.findUniqueOrThrow({ where: { id } })).lastError, null)
})

test('a delete that "succeeds" but leaves the object is detected and not recorded as deleted', async () => {
  const w = await world(); const f = await file(w)
  const id = await approved(w, f)
  backup.delete = async () => {}                                      // provider ignores the delete
  assert.deepEqual(await run(id), { outcome: 'failed', reason: 'backup_still_present' })
  assert.equal(await fileStatus(f.file.id), 'DELETING')
  assert.equal((await ledger.fileStates(w.ws.id)).states.get(f.file.id)?.completed, undefined)
})

test('a ledger outage stops deletion before any object is touched', async () => {
  const w = await world(); const f = await file(w)
  const id = await approved(w, f)
  ledgerStore.failNext = { op: 'putBytes', times: 50 }
  const r = await run(id)
  assert.deepEqual(r, { outcome: 'failed', reason: 'ledger_unavailable' })
  assert.ok(primary.objects.has(f.key) && backup.objects.has(f.key), 'nothing deleted without the ledger record')
  ledgerStore.failNext = null
  assert.equal((await run(id)).outcome, 'completed')
})

test('worker crash at every step: re-running always converges on a complete, ledgered deletion', async () => {
  // The runner is killed at each externally visible step; simulate that by running the real
  // steps and abandoning the process state at that point (only the DB and stores survive).
  for (const stopAfter of ['began', 'ledger_started', 'primary_deleted', 'backup_deleted', 'ledger_completed'] as const) {
    const w = await world(); const f = await file(w)
    const id = await approved(w, f)
    const req = await prisma.evidenceDeletionRequest.findUniqueOrThrow({ where: { id } })
    // step: begin (APPROVED -> EXECUTING, file -> DELETING)
    await prisma.evidenceDeletionRequest.update({ where: { id }, data: { status: 'EXECUTING', executionStartedAt: new Date() } })
    await prisma.evidenceFile.update({ where: { id: f.file.id }, data: { status: 'DELETING' } })
    const entry = {
      type: 'FILE_DELETION_STARTED' as const, workspaceId: w.ws.id, fileId: f.file.id, jobId: f.job.id, requestId: id, sha256: f.sha, sizeBytes: f.bytes.length,
      primaryKey: f.key, backupKey: f.key, requestedBy: req.requestedByUserId, reviewedBy: req.reviewedByUserId!, approvedAt: req.reviewedAt!.toISOString(), notBefore: req.notBefore!.toISOString(), at: new Date().toISOString(),
    }
    if (stopAfter !== 'began') await ledger.append(entry)
    if (['primary_deleted', 'backup_deleted', 'ledger_completed'].includes(stopAfter)) primary.objects.delete(f.key)
    if (['backup_deleted', 'ledger_completed'].includes(stopAfter)) backup.objects.delete(f.key)
    if (stopAfter === 'ledger_completed') await ledger.append({ type: 'FILE_DELETION_COMPLETED', workspaceId: w.ws.id, fileId: f.file.id, requestId: id, at: new Date().toISOString() })
    // restart
    assert.deepEqual(await run(id), { outcome: 'completed' }, stopAfter)
    assert.ok(!primary.objects.has(f.key) && !backup.objects.has(f.key), stopAfter)
    assert.equal(await fileStatus(f.file.id), 'DELETED', stopAfter)
    const st = (await ledger.fileStates(w.ws.id)).states.get(f.file.id)!
    assert.equal(st.completed, true, stopAfter); assert.ok(st.started, stopAfter)
    assert.equal(await prisma.evidenceDeletionLog.count({ where: { fileId: f.file.id } }), 1, stopAfter)
  }
})

// ── database restore scenarios ──────────────────────────────────────────────

/** Capture and later restore the evidence tables of one workspace, as a database restore would. */
async function snapshot(wsId: string) {
  return {
    files: await prisma.evidenceFile.findMany({ where: { workspaceId: wsId } }),
    copies: await prisma.evidenceFileCopy.findMany({ where: { workspaceId: wsId } }),
    requests: await prisma.evidenceDeletionRequest.findMany({ where: { workspaceId: wsId } }),
    holds: await prisma.legalHold.findMany({ where: { workspaceId: wsId } }),
  }
}
async function restoreSnapshot(wsId: string, s: Awaited<ReturnType<typeof snapshot>>) {
  await prisma.evidenceDeletionRequest.deleteMany({ where: { workspaceId: wsId } })
  await prisma.evidenceFileCopy.deleteMany({ where: { workspaceId: wsId } })
  await prisma.evidenceFile.deleteMany({ where: { workspaceId: wsId } })
  await prisma.legalHold.deleteMany({ where: { workspaceId: wsId } })
  await prisma.evidenceFile.createMany({ data: s.files })
  await prisma.evidenceFileCopy.createMany({ data: s.copies })
  await prisma.evidenceDeletionRequest.createMany({ data: s.requests })
  await prisma.legalHold.createMany({ data: s.holds })
}

test('restoring an older database cannot resurrect deleted evidence: reconciliation re-applies the tombstone', async () => {
  const w = await world(); const f = await file(w)
  const snap = await snapshot(w.ws.id)                                // the "older backup": file AVAILABLE, no request
  const id = await approved(w, f)
  assert.equal((await run(id)).outcome, 'completed')
  await restoreSnapshot(w.ws.id, snap)                                // database rolled back
  assert.equal(await fileStatus(f.file.id), 'AVAILABLE', 'the restore did resurrect the row...')
  // ...and a stale object copy (e.g. from a storage snapshot) is back too
  primary.objects.set(f.key, { bytes: f.bytes, contentType: 'image/jpeg' }); backup.objects.set(f.key, { bytes: f.bytes, contentType: 'image/jpeg' })
  const rep = await reconcileEvidenceLedger({ stores })
  assert.equal(rep.retombstoned, 1); assert.deepEqual(rep.conflicts, [])
  assert.equal(await fileStatus(f.file.id), 'DELETED', '...and reconciliation put the tombstone back')
  assert.ok(!primary.objects.has(f.key) && !backup.objects.has(f.key), 'stale objects removed')
  const copies = await prisma.evidenceFileCopy.findMany({ where: { fileId: f.file.id } })
  assert.ok(copies.every((c: { status: string }) => c.status === 'DELETED'))
  assert.equal(await prisma.evidenceDeletionLog.count({ where: { fileId: f.file.id, event: 'RECONCILED_DELETED' } }), 1)
  // the resurrected file cannot be served or re-uploaded as available; running again is a no-op
  const again = await reconcileEvidenceLedger({ stores })
  assert.deepEqual({ r: again.retombstoned, m: again.resumed }, { r: 0, m: 0 })
})

test('restore to a point before the request existed, with the deletion only started: it is resumed from the ledger', async () => {
  const w = await world(); const f = await file(w)
  const snap = await snapshot(w.ws.id)
  const id = await approved(w, f)
  const req = await prisma.evidenceDeletionRequest.findUniqueOrThrow({ where: { id } })
  await ledger.append({
    type: 'FILE_DELETION_STARTED', workspaceId: w.ws.id, fileId: f.file.id, jobId: f.job.id, requestId: id, sha256: f.sha, sizeBytes: f.bytes.length, primaryKey: f.key, backupKey: f.key,
    requestedBy: req.requestedByUserId, reviewedBy: req.reviewedByUserId!, approvedAt: req.reviewedAt!.toISOString(), notBefore: req.notBefore!.toISOString(), at: new Date().toISOString(),
  })
  primary.objects.delete(f.key)                                       // crashed after the primary was deleted
  await restoreSnapshot(w.ws.id, snap)
  const rep = await reconcileEvidenceLedger({ stores })
  assert.equal(rep.resumed, 1)
  assert.equal(await fileStatus(f.file.id), 'DELETED'); assert.ok(!backup.objects.has(f.key))
  assert.equal((await ledger.fileStates(w.ws.id)).states.get(f.file.id)?.completed, true)
})

test('a started-but-unfinished deletion is NOT resumed if a legal hold now covers the file', async () => {
  const w = await world(); const f = await file(w)
  const snap = await snapshot(w.ws.id)
  const id = await approved(w, f); const req = await prisma.evidenceDeletionRequest.findUniqueOrThrow({ where: { id } })
  await ledger.append({
    type: 'FILE_DELETION_STARTED', workspaceId: w.ws.id, fileId: f.file.id, jobId: f.job.id, requestId: id, sha256: f.sha, sizeBytes: null, primaryKey: f.key, backupKey: f.key,
    requestedBy: req.requestedByUserId, reviewedBy: req.reviewedByUserId!, approvedAt: req.reviewedAt!.toISOString(), notBefore: req.notBefore!.toISOString(), at: new Date().toISOString(),
  })
  await restoreSnapshot(w.ws.id, snap)
  await holdInDb(w, f.job.id)
  const rep = await reconcileEvidenceLedger({ stores })
  assert.deepEqual(rep.conflicts, [{ workspaceId: w.ws.id, fileId: f.file.id, reason: 'legal_hold_after_started' }])
  assert.ok(primary.objects.has(f.key) && backup.objects.has(f.key)); assert.equal(await fileStatus(f.file.id), 'AVAILABLE')
})

test('a restore that loses a legal hold (or its release) is corrected from the ledger', async () => {
  const w = await world(); const j = await job(w)
  const placed = await G(w.owner.id, 'POST', `${P}/holds`, { workspaceId: w.ws.id, scope: 'JOB', jobId: j.id, reason: 'regulator enquiry 2026-14' })
  const toRelease = await G(w.owner.id, 'POST', `${P}/holds`, { workspaceId: w.ws.id, scope: 'WORKSPACE', reason: 'litigation hold notice' })
  const snapBeforeAnything = await snapshot(w.ws.id)                 // both holds present, none released
  await G(w.owner.id, 'POST', `${P}/holds/${toRelease.body.hold.id}/release`, { workspaceId: w.ws.id, releaseReason: 'matter settled, confirmed' })
  // older database: has the second hold still active (its release is lost) ...
  await restoreSnapshot(w.ws.id, snapBeforeAnything)
  // ... and has lost the first hold entirely
  await prisma.legalHold.delete({ where: { id: placed.body.hold.id } })
  const rep = await reconcileEvidenceLedger({ stores })
  assert.equal(rep.holdsRecreated, 1); assert.equal(rep.holdsEnded, 1)
  const first = await prisma.legalHold.findUniqueOrThrow({ where: { id: placed.body.hold.id } })
  assert.equal(first.releasedAt, null, 'the lost hold is active again'); assert.equal(first.jobId, j.id)
  assert.ok((await prisma.legalHold.findUniqueOrThrow({ where: { id: toRelease.body.hold.id } })).releasedAt, 'the released hold is released again')
  // a hold whose job no longer exists in the older database cannot be recreated: reported, not hidden
  const j2 = await job(w)
  const h3 = await G(w.owner.id, 'POST', `${P}/holds`, { workspaceId: w.ws.id, scope: 'JOB', jobId: j2.id, reason: 'another enquiry, noted' })
  await prisma.legalHold.delete({ where: { id: h3.body.hold.id } }); await prisma.job.delete({ where: { id: j2.id } })
  assert.equal((await reconcileEvidenceLedger({ stores })).holdsUnrecoverable, 1)
})

test('forged ledger entries never cause a deletion', async () => {
  const w = await world(); const f = await file(w)
  const attacker = new EvidenceLedger(ledgerStore, 'x'.repeat(40))   // can write to the bucket, lacks the MAC key
  await attacker.append({
    type: 'FILE_DELETION_STARTED', workspaceId: w.ws.id, fileId: f.file.id, jobId: f.job.id, requestId: 'forged', sha256: f.sha, sizeBytes: 1, primaryKey: f.key, backupKey: f.key,
    requestedBy: 'x', reviewedBy: 'y', approvedAt: new Date().toISOString(), notBefore: new Date().toISOString(), at: new Date().toISOString(),
  })
  const rep = await reconcileEvidenceLedger({ stores })
  assert.equal(rep.invalidLedgerEntries, 1); assert.equal(rep.retombstoned + rep.resumed, 0)
  assert.ok(primary.objects.has(f.key) && backup.objects.has(f.key)); assert.equal(await fileStatus(f.file.id), 'AVAILABLE')
})

// ── the runner cycle and the ledger gate ────────────────────────────────────

test('the runner refuses a ledger it cannot prove immutable, and runs end to end with one', async () => {
  const w = await world(); const f = await file(w)
  const id = await approved(w, f)
  const mutable = new MemoryEvidenceStore()                           // credential could overwrite/delete
  const bad = await runDeletionCycle({ stores: { ...stores, ledgerStore: mutable, ledger: new EvidenceLedger(mutable, MAC) }, sealKey: SEAL, now: await due(id) })
  assert.ok('skipped' in bad && bad.skipped === 'ledger_not_trusted' && bad.probe.level === 'create_only')
  assert.ok(primary.objects.has(f.key) && backup.objects.has(f.key), 'nothing touched')
  // dev override accepts create-only; production config forbids it (covered in the unit tests)
  const dev = await runDeletionCycle({ stores: { ...stores, ledgerStore: mutable, ledger: new EvidenceLedger(mutable, MAC) }, sealKey: SEAL, allowUnenforcedLedger: true, now: await due(id) })
  assert.ok('executed' in dev && dev.executed[0].result.outcome === 'completed')
  // an immutable ledger passes the gate
  const w2 = await world(); const g = await file(w2); const id2 = await approved(w2, g)
  const ok = await runDeletionCycle({ stores, sealKey: SEAL, now: await due(id2) })
  assert.ok('executed' in ok && ok.executed.some((e) => e.requestId === id2 && e.result.outcome === 'completed'))
  assert.equal(await fileStatus(g.file.id), 'DELETED')
  // an unreachable ledger also stops the cycle
  ledgerStore.failNext = { op: 'putBytes', times: 5 }
  const down = await runDeletionCycle({ stores, sealKey: SEAL })
  assert.ok('skipped' in down)
})

test('the cycle picks up due requests oldest first and leaves not-yet-due ones alone', async () => {
  const w = await world()
  const a = await file(w); const b = await file(w)
  const idA = await approved(w, a); const idB = await approved(w, b)
  const futureOnly = await runDeletionCycle({ stores, sealKey: SEAL, now: new Date() })
  assert.ok('executed' in futureOnly && futureOnly.executed.length === 0)
  const both = await runDeletionCycle({ stores, sealKey: SEAL, now: new Date(Date.now() + DAYS(8)) })
  assert.ok('executed' in both)
  assert.deepEqual('executed' in both ? both.executed.map((e) => e.requestId) : [], [idA, idB])
})

// ── workspace erasure ───────────────────────────────────────────────────────

const erase = (w: World, uid: string) =>
  ws.request(`/api/workspaces/${w.ws.id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json', Authorization: bearer(uid) }, body: JSON.stringify({ confirmName: w.ws.name }) })
const fresh = (uid: string) => prisma.user.update({ where: { id: uid }, data: { lastReauthAt: new Date() } })

test('workspace erasure never bypasses holds, retention-process, open requests or the ledger', async () => {
  const w = await world(); const f = await file(w); await fresh(w.owner.id)
  // evidence present and deletion workflow on: blocked because the file is not deleted
  let r = await erase(w, w.owner.id)
  assert.equal(r.status, 409); assert.match(JSON.stringify(r.body), /evidence_not_deleted/)
  // open request
  const id = await approved(w, f)
  r = await erase(w, w.owner.id); assert.match(JSON.stringify(r.body), /open_deletion_requests/)
  assert.equal((await run(id)).outcome, 'completed')
  // an active hold blocks even though everything is deleted
  const h = await holdInDb(w, null)
  r = await erase(w, w.owner.id); assert.equal(r.status, 409); assert.match(JSON.stringify(r.body), /active_legal_hold/)
  await prisma.legalHold.update({ where: { id: h.id }, data: { releasedAt: new Date(), releasedByUserId: w.owner.id, releaseReason: 'closed' } })
  // the release is not in the ledger yet
  r = await erase(w, w.owner.id); assert.match(JSON.stringify(r.body), /holds_not_ledgered/)
  await syncHoldLedger(ledger)
  // ledger does not confirm the deletion (e.g. an unrelated or empty ledger): blocked
  setApiLedgerForTests(new EvidenceLedger(new MemoryEvidenceStore({ immutable: true }), MAC))
  r = await erase(w, w.owner.id); assert.match(JSON.stringify(r.body), /ledger_unconfirmed/)
  setApiLedgerForTests(null)
  r = await erase(w, w.owner.id); assert.match(JSON.stringify(r.body), /ledger_unavailable/)
  assert.ok(await prisma.workspace.findUnique({ where: { id: w.ws.id } }), 'the workspace is still there after every refusal')
  assert.equal(await prisma.evidenceFile.count({ where: { workspaceId: w.ws.id } }), 1)
  // destructive operations disabled: the legacy refusal applies
  setApiLedgerForTests(ledger); delete process.env.EVIDENCE_DESTRUCTIVE_ENABLED
  r = await erase(w, w.owner.id); assert.equal(r.status, 409); assert.match(JSON.stringify(r.body), /deletion_disabled/)
})

test('a fully deleted, ledger-confirmed, hold-free workspace can be erased; the ledger and deletion log outlive it', async () => {
  const w = await world(); const f1 = await file(w); const f2 = await file(w)
  const id1 = await approved(w, f1); const id2 = await approved(w, f2)
  assert.equal((await run(id1)).outcome, 'completed'); assert.equal((await run(id2)).outcome, 'completed')
  const h = await holdInDb(w, null)
  await prisma.legalHold.update({ where: { id: h.id }, data: { releasedAt: new Date(), releasedByUserId: w.owner.id, releaseReason: 'closed' } })
  await syncHoldLedger(ledger)
  await fresh(w.owner.id)
  const r = await erase(w, w.owner.id)
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(await prisma.workspace.findUnique({ where: { id: w.ws.id } }), null)
  for (const m of ['evidenceFile', 'evidenceFileCopy', 'evidenceDeletionRequest', 'legalHold'] as const) {
    assert.equal(await (prisma[m] as unknown as { count: (a: unknown) => Promise<number> }).count({ where: { workspaceId: w.ws.id } }), 0, m)
  }
  assert.equal(await ledger.isErased(w.ws.id), true, 'the erasure is recorded externally first')
  assert.equal((await ledger.fileStates(w.ws.id)).states.size, 2, 'the deletion records remain')
  assert.equal(await prisma.evidenceDeletionLog.count({ where: { workspaceId: w.ws.id } }), 2, 'the FK-free deletion log remains')
  assert.ok((await ledger.verifyChain(w.ws.id)).ok)
})

test('erasure re-checks under the governance lock: a file or hold that appears at the last moment aborts it', async () => {
  const w = await world(); await fresh(w.owner.id)
  const f = await file(w); const id = await approved(w, f); assert.equal((await run(id)).outcome, 'completed')
  await syncHoldLedger(ledger)
  // simulate a new upload landing after the pre-check but before the delete: wrap the ledger append that precedes the transaction
  const orig = ledger.append.bind(ledger)
  ledger.append = async (e) => { if (e.type === 'WORKSPACE_ERASED') { await holdInDb(w, null) } return orig(e) }
  const r = await erase(w, w.owner.id)
  ledger.append = orig
  assert.equal(r.status, 409); assert.match(JSON.stringify(r.body), /active_legal_hold/)
  assert.ok(await prisma.workspace.findUnique({ where: { id: w.ws.id } }))
  assert.equal(await prisma.evidenceFile.count({ where: { workspaceId: w.ws.id } }), 1, 'nothing was removed')
})

test('a workspace with no evidence at all is erased exactly as before', async () => {
  const w = await world(); await fresh(w.owner.id)
  assert.equal((await erase(w, w.owner.id)).status, 200)
  assert.equal(await prisma.workspace.findUnique({ where: { id: w.ws.id } }), null)
})

// ── database-level guarantees ───────────────────────────────────────────────

test('database constraints: the wait is enforced, one active request per file, consistent state', async () => {
  const w = await world(); const f = await file(w)
  const base = { workspaceId: w.ws.id, fileId: f.file.id, jobId: f.job.id, requestedByUserId: w.owner.id, reason: 'Customer contract ended' }
  const now = new Date()
  const okApproved = { status: 'APPROVED', reviewedByUserId: w.owner2.id, reviewedAt: now, waitDays: 7, notBefore: new Date(now.getTime() + DAYS(7)), approvalExpiresAt: new Date(now.getTime() + DAYS(37)), approvalSeal: 'a'.repeat(64) }
  await assert.rejects(() => prisma.evidenceDeletionRequest.create({ data: { ...base, ...okApproved, notBefore: new Date(now.getTime() + DAYS(6)), activeFileId: f.file.id } }), undefined, 'wait shorter than waitDays')
  await assert.rejects(() => prisma.evidenceDeletionRequest.create({ data: { ...base, status: 'APPROVED', activeFileId: f.file.id } }), undefined, 'approved without approval fields')
  await assert.rejects(() => prisma.evidenceDeletionRequest.create({ data: { ...base, reason: 'short' , activeFileId: f.file.id } }), undefined, 'reason too short')
  await assert.rejects(() => prisma.evidenceDeletionRequest.create({ data: { ...base, activeFileId: null } }), undefined, 'active request must hold the key')
  await assert.rejects(() => prisma.evidenceDeletionRequest.create({ data: { ...base, activeFileId: 'other' } }), undefined, 'key must be the file id')
  await assert.rejects(() => prisma.evidenceDeletionRequest.create({ data: { ...base, status: 'COMPLETED', activeFileId: null } }), undefined, 'completed needs completedAt')
  await assert.rejects(() => prisma.evidenceDeletionRequest.create({ data: { ...base, waitDays: 0, activeFileId: f.file.id } }), undefined, 'waitDays bound')
  await prisma.evidenceDeletionRequest.create({ data: { ...base, activeFileId: f.file.id } })
  await assert.rejects(() => prisma.evidenceDeletionRequest.create({ data: { ...base, activeFileId: f.file.id } }), undefined, 'one active request per file')
  // a closed request does not hold the key
  await prisma.evidenceDeletionRequest.create({ data: { ...base, status: 'REJECTED', activeFileId: null } })
  // tenant isolation at the database level: a request cannot point at another workspace's file
  const o = await world(); const of = await file(o)
  await assert.rejects(() => prisma.evidenceDeletionRequest.create({ data: { ...base, workspaceId: w.ws.id, fileId: of.file.id, jobId: of.job.id, activeFileId: of.file.id } }), undefined, 'composite FK')
  // the policy bounds
  await prisma.retentionPolicy.create({ data: { workspaceId: w.ws.id } })
  await assert.rejects(() => prisma.retentionPolicy.update({ where: { workspaceId: w.ws.id }, data: { deletionWaitDays: 0 } }))
  await assert.rejects(() => prisma.retentionPolicy.update({ where: { workspaceId: w.ws.id }, data: { pendingWaitDays: 3 } }), undefined, 'pending trio must be complete')
})
