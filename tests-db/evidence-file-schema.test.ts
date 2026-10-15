// C1 schema tests: evidence file metadata, retention policy, legal holds and the
// deletion audit log. These exercise the database itself (foreign keys, CHECK
// constraints, the append-only trigger), not an API, because C1 adds no endpoints.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { prisma, resetDb, disconnect, seedUserWithWorkspace } from './helpers/db.ts'

before(async () => { await prisma.$connect() })
after(async () => { await disconnect() })
beforeEach(async () => { await resetDb() })

const SHA = 'a'.repeat(64)

/** The statement must fail at the database, with a message matching `re`. */
async function rejectsWith(p: Promise<unknown>, re: RegExp, label: string) {
  await assert.rejects(p, (e: unknown) => {
    const msg = String((e as Error)?.message ?? e)
    assert.match(msg, re, `${label}: unexpected error: ${msg.slice(0, 300)}`)
    return true
  }, label)
}
const FK = /Foreign key constraint|P2003|23503/i
const CHECK = /check constraint|23514/i
const UNIQUE = /Unique constraint|P2002|23505/i

async function tenant(email: string) {
  const { user, workspace } = await seedUserWithWorkspace(email)
  const site = await prisma.opsJobSite.create({ data: { workspaceId: workspace.id, jobCode: 'S1', siteName: 'Site' } })
  const job = await prisma.job.create({ data: { workspaceId: workspace.id, opsJobSiteId: site.id } })
  const job2 = await prisma.job.create({ data: { workspaceId: workspace.id, opsJobSiteId: site.id } })
  const crew = await prisma.opsCrewMember.create({ data: {
    workspaceId: workspace.id, employeeCode: 'C1', fullName: 'Crew', role: 'TECH', userId: user.id,
  } })
  const evidence = await prisma.jobTechnicianEvidence.create({ data: {
    workspaceId: workspace.id, jobId: job.id, crewMemberId: crew.id, submissionId: randomUUID(), kind: 'NOTE', content: { note: 'n' },
  } })
  const file = (over: Record<string, unknown> = {}) => prisma.evidenceFile.create({ data: {
    workspaceId: workspace.id, jobId: job.id, crewMemberId: crew.id, submissionId: randomUUID(), ...over,
  } as never })
  const key = (name = randomUUID()) => `ws/${workspace.id}/job/${job.id}/final/${name}`
  return { user, ws: workspace, site, job, job2, crew, evidence, file, key }
}

// ── relationships and tenant isolation ───────────────────────────────────────

test('a file is metadata only and links to its evidence, with a primary and a backup copy', async () => {
  const t = await tenant('a@example.test')
  const f = await t.file({ evidenceId: t.evidence.id })
  assert.equal(f.status, 'PENDING')
  assert.equal(f.kind, 'PHOTO')
  await prisma.evidenceFileCopy.create({ data: { workspaceId: t.ws.id, fileId: f.id, location: 'primary', objectKey: t.key() } })
  await prisma.evidenceFileCopy.create({ data: { workspaceId: t.ws.id, fileId: f.id, location: 'backup', objectKey: t.key() } })
  await prisma.evidenceFile.update({ where: { id: f.id }, data: {
    status: 'AVAILABLE', contentType: 'image/jpeg', sizeBytes: 123456, sha256: SHA, width: 2048, height: 1536,
    finalizedAt: new Date(), retainUntil: new Date('2033-10-15T00:00:00Z'),
  } })
  const back = await prisma.evidenceFile.findUniqueOrThrow({ where: { id: f.id }, include: { copies: true, evidence: true } })
  assert.equal(back.copies.length, 2)
  assert.equal(back.evidence?.id, t.evidence.id)
  const ev = await prisma.jobTechnicianEvidence.findUniqueOrThrow({ where: { id: t.evidence.id }, include: { files: true } })
  assert.equal(ev.files.length, 1)
  // Evidence is optional: a file can exist before/without an evidence row.
  assert.equal((await t.file()).evidenceId, null)
})

test('cross-workspace references are rejected by the database', async () => {
  const a = await tenant('a@example.test')
  const b = await tenant('b@example.test')
  await rejectsWith(prisma.evidenceFile.create({ data: {
    workspaceId: a.ws.id, jobId: b.job.id, crewMemberId: a.crew.id, submissionId: randomUUID(),
  } }), FK, "A's file on B's job")
  await rejectsWith(prisma.evidenceFile.create({ data: {
    workspaceId: a.ws.id, jobId: a.job.id, crewMemberId: b.crew.id, submissionId: randomUUID(),
  } }), FK, "A's file by B's crew member")
  await rejectsWith(prisma.evidenceFile.create({ data: {
    workspaceId: a.ws.id, jobId: a.job.id, evidenceId: b.evidence.id, crewMemberId: a.crew.id, submissionId: randomUUID(),
  } }), FK, "A's file on B's evidence")
  // Evidence from a different job in the SAME workspace is also refused: the file is pinned to the evidence's job.
  await rejectsWith(prisma.evidenceFile.create({ data: {
    workspaceId: a.ws.id, jobId: a.job2.id, evidenceId: a.evidence.id, crewMemberId: a.crew.id, submissionId: randomUUID(),
  } }), FK, 'evidence from a different job')
  // A copy cannot attach to another workspace's file.
  const fileB = await b.file()
  await rejectsWith(prisma.evidenceFileCopy.create({ data: {
    workspaceId: a.ws.id, fileId: fileB.id, location: 'primary', objectKey: a.key(),
  } }), FK, "A's copy of B's file")
  // Nor can a hold or a job-scoped hold reach another workspace's job.
  await rejectsWith(prisma.legalHold.create({ data: {
    workspaceId: a.ws.id, scope: 'JOB', jobId: b.job.id, reason: 'x', placedByUserId: a.user.id,
  } }), FK, "A's hold on B's job")
})

test('an object key must sit under its own workspace prefix, and storage locations stay unique', async () => {
  const a = await tenant('a@example.test')
  const b = await tenant('b@example.test')
  const f = await a.file()
  await rejectsWith(prisma.evidenceFileCopy.create({ data: {
    workspaceId: a.ws.id, fileId: f.id, location: 'primary', objectKey: b.key(),
  } }), CHECK, "key under B's prefix")
  await rejectsWith(prisma.evidenceFileCopy.create({ data: {
    workspaceId: a.ws.id, fileId: f.id, location: 'primary', objectKey: 'anything/else',
  } }), CHECK, 'key with no workspace prefix')
  await rejectsWith(prisma.evidenceFileCopy.create({ data: {
    workspaceId: a.ws.id, fileId: f.id, location: 'Primary Bucket!', objectKey: a.key(),
  } }), CHECK, 'location label must be a simple lowercase token')
  const k = a.key('same')
  await prisma.evidenceFileCopy.create({ data: { workspaceId: a.ws.id, fileId: f.id, location: 'primary', objectKey: k } })
  await rejectsWith(prisma.evidenceFileCopy.create({ data: {
    workspaceId: a.ws.id, fileId: f.id, location: 'primary', objectKey: a.key('other'),
  } }), UNIQUE, 'one copy per file per location')
  const f2 = await a.file()
  await rejectsWith(prisma.evidenceFileCopy.create({ data: {
    workspaceId: a.ws.id, fileId: f2.id, location: 'primary', objectKey: k,
  } }), UNIQUE, 'one file per object key per location')
})

test('retried submissions are idempotent per technician and workspace', async () => {
  const a = await tenant('a@example.test')
  const sid = randomUUID()
  await a.file({ submissionId: sid })
  await rejectsWith(a.file({ submissionId: sid }), UNIQUE, 'same submission id')
  const b = await tenant('b@example.test')
  await b.file({ submissionId: sid }) // same id in another workspace is unrelated
})

// ── deletion protection (Restrict) ───────────────────────────────────────────

test('records that still have files cannot be deleted out from under them', async () => {
  const t = await tenant('a@example.test')
  const f = await t.file({ evidenceId: t.evidence.id })
  await rejectsWith(prisma.job.delete({ where: { id: t.job.id } }), FK, 'job with files')
  await rejectsWith(prisma.opsCrewMember.delete({ where: { id: t.crew.id } }), FK, 'crew member with files')
  await rejectsWith(prisma.jobTechnicianEvidence.delete({ where: { id: t.evidence.id } }), FK, 'evidence with files')
  await rejectsWith(prisma.workspace.delete({ where: { id: t.ws.id } }), FK, 'workspace with files')
  await prisma.evidenceFileCopy.create({ data: { workspaceId: t.ws.id, fileId: f.id, location: 'primary', objectKey: t.key() } })
  await rejectsWith(prisma.evidenceFile.delete({ where: { id: f.id } }), FK, 'file with copies')
  assert.ok(await prisma.evidenceFile.findUnique({ where: { id: f.id } }), 'nothing was removed')
})

test('workspaces and jobs WITHOUT files or holds are deleted exactly as before (retention settings go with the workspace)', async () => {
  const t = await tenant('a@example.test')
  await prisma.retentionPolicy.create({ data: { workspaceId: t.ws.id } })
  await prisma.workspace.delete({ where: { id: t.ws.id } })
  assert.equal(await prisma.job.count({ where: { workspaceId: t.ws.id } }), 0)
  assert.equal(await prisma.jobTechnicianEvidence.count({ where: { workspaceId: t.ws.id } }), 0)
  assert.equal(await prisma.retentionPolicy.count({ where: { workspaceId: t.ws.id } }), 0)
})

test('a workspace holding a legal hold cannot be deleted until the hold record is dealt with', async () => {
  const t = await tenant('a@example.test')
  await prisma.legalHold.create({ data: { workspaceId: t.ws.id, scope: 'WORKSPACE', reason: 'Dispute', placedByUserId: t.user.id } })
  await rejectsWith(prisma.workspace.delete({ where: { id: t.ws.id } }), FK, 'workspace with a hold')
})

// ── file and copy state constraints ──────────────────────────────────────────

test('file status, completeness and tombstone rules are enforced', async () => {
  const t = await tenant('a@example.test')
  const f = await t.file()
  await rejectsWith(prisma.evidenceFile.update({ where: { id: f.id }, data: { status: 'DONE' } }), CHECK, 'unknown status')
  await rejectsWith(prisma.evidenceFile.update({ where: { id: f.id }, data: { kind: 'VIDEO' } }), CHECK, 'unknown kind')
  await rejectsWith(prisma.evidenceFile.update({ where: { id: f.id }, data: { status: 'AVAILABLE' } }), CHECK, 'AVAILABLE with nothing known about it')
  await rejectsWith(prisma.evidenceFile.update({ where: { id: f.id }, data: { sha256: 'xyz' } }), CHECK, 'malformed sha256')
  await rejectsWith(prisma.evidenceFile.update({ where: { id: f.id }, data: { sha256: SHA.toUpperCase() } }), CHECK, 'sha256 must be lowercase hex')
  await rejectsWith(prisma.evidenceFile.update({ where: { id: f.id }, data: { sizeBytes: -1 } }), CHECK, 'negative size')
  await rejectsWith(prisma.evidenceFile.update({ where: { id: f.id }, data: { width: 0 } }), CHECK, 'zero width')
  await rejectsWith(prisma.evidenceFile.update({ where: { id: f.id }, data: { contentType: 'JPEG' } }), CHECK, 'malformed content type')
  await rejectsWith(prisma.evidenceFile.update({ where: { id: f.id }, data: { status: 'DELETED' } }), CHECK, 'DELETED without deletedAt')
  await rejectsWith(prisma.evidenceFile.update({ where: { id: f.id }, data: { deletedAt: new Date() } }), CHECK, 'deletedAt while not DELETED')
  const ok = await prisma.evidenceFile.update({ where: { id: f.id }, data: { status: 'DELETED', deletedAt: new Date() } })
  assert.equal(ok.status, 'DELETED')
})

test('copy status rules: VERIFIED needs proof, DELETED needs a timestamp', async () => {
  const t = await tenant('a@example.test')
  const f = await t.file()
  const c = await prisma.evidenceFileCopy.create({ data: { workspaceId: t.ws.id, fileId: f.id, location: 'backup', objectKey: t.key() } })
  await rejectsWith(prisma.evidenceFileCopy.update({ where: { id: c.id }, data: { status: 'VERIFIED' } }), CHECK, 'VERIFIED with no checksum')
  await rejectsWith(prisma.evidenceFileCopy.update({ where: { id: c.id }, data: { status: 'GONE' } }), CHECK, 'unknown status')
  await rejectsWith(prisma.evidenceFileCopy.update({ where: { id: c.id }, data: { status: 'DELETED' } }), CHECK, 'DELETED with no timestamp')
  const v = await prisma.evidenceFileCopy.update({ where: { id: c.id }, data: { status: 'VERIFIED', sha256: SHA, sizeBytes: 10, verifiedAt: new Date() } })
  assert.equal(v.status, 'VERIFIED')
})

// ── retention policy ─────────────────────────────────────────────────────────

test('retention defaults to seven years with automatic deletion OFF, one policy per workspace', async () => {
  const t = await tenant('a@example.test')
  const p = await prisma.retentionPolicy.create({ data: { workspaceId: t.ws.id } })
  assert.equal(p.retentionDays, 2555)
  assert.equal(p.autoDeletionEnabled, false)
  assert.equal(p.startRule, 'LATER_OF_UPLOAD_AND_CLOSEOUT')
  await rejectsWith(prisma.retentionPolicy.create({ data: { workspaceId: t.ws.id } }), UNIQUE, 'second policy')
  const custom = await prisma.retentionPolicy.update({ where: { id: p.id }, data: { retentionDays: 3650, startRule: 'JOB_CLOSEOUT' } })
  assert.equal(custom.retentionDays, 3650)
  await rejectsWith(prisma.retentionPolicy.update({ where: { id: p.id }, data: { retentionDays: 0 } }), CHECK, 'zero days')
  await rejectsWith(prisma.retentionPolicy.update({ where: { id: p.id }, data: { retentionDays: 36501 } }), CHECK, 'absurdly long')
  await rejectsWith(prisma.retentionPolicy.update({ where: { id: p.id }, data: { startRule: 'WHENEVER' } }), CHECK, 'unknown start rule')
  const other = await tenant('b@example.test')
  await prisma.retentionPolicy.create({ data: { workspaceId: other.ws.id, retentionDays: 365 } })
  assert.equal((await prisma.retentionPolicy.findUniqueOrThrow({ where: { workspaceId: t.ws.id } })).retentionDays, 3650)
})

// ── legal holds ──────────────────────────────────────────────────────────────

test('legal holds: scope coherence, release rules, and they outlive attempts to delete the job', async () => {
  const t = await tenant('a@example.test')
  const base = { workspaceId: t.ws.id, reason: 'Dispute with customer', placedByUserId: t.user.id }
  await rejectsWith(prisma.legalHold.create({ data: { ...base, scope: 'WORKSPACE', jobId: t.job.id } }), CHECK, 'workspace hold naming a job')
  await rejectsWith(prisma.legalHold.create({ data: { ...base, scope: 'JOB' } }), CHECK, 'job hold with no job')
  await rejectsWith(prisma.legalHold.create({ data: { ...base, scope: 'EVERYTHING' } }), CHECK, 'unknown scope')
  await rejectsWith(prisma.legalHold.create({ data: { ...base, scope: 'WORKSPACE', reason: '   ' } }), CHECK, 'blank reason')
  const ws = await prisma.legalHold.create({ data: { ...base, scope: 'WORKSPACE' } })
  const jobHold = await prisma.legalHold.create({ data: { ...base, scope: 'JOB', jobId: t.job.id } })
  assert.equal(ws.releasedAt, null)
  // Release: the three fields move together and cannot predate placement.
  await rejectsWith(prisma.legalHold.update({ where: { id: ws.id }, data: { releasedAt: new Date() } }), CHECK, 'released with no releaser')
  await rejectsWith(prisma.legalHold.update({ where: { id: ws.id }, data: { releasedByUserId: t.user.id } }), CHECK, 'releaser with no time')
  await rejectsWith(prisma.legalHold.update({ where: { id: ws.id }, data: {
    releasedAt: new Date(ws.placedAt.getTime() - 60_000), releasedByUserId: t.user.id,
  } }), CHECK, 'released before placed')
  const rel = await prisma.legalHold.update({ where: { id: ws.id }, data: {
    releasedAt: new Date(Date.now() + 1000), releasedByUserId: t.user.id, releaseReason: 'Matter closed',
  } })
  assert.ok(rel.releasedAt)
  assert.equal(await prisma.legalHold.count({ where: { workspaceId: t.ws.id, releasedAt: null } }), 1, 'one hold still active')
  // A held job cannot be deleted, active or released: the record of the hold is kept.
  await rejectsWith(prisma.job.delete({ where: { id: t.job.id } }), FK, 'job with a hold')
  assert.ok(jobHold.id)
})

// ── deletion audit log ───────────────────────────────────────────────────────

test('the deletion log is append-only, and has no foreign keys so it outlives what it describes', async () => {
  const t = await tenant('a@example.test')
  const row = await prisma.evidenceDeletionLog.create({ data: {
    workspaceId: t.ws.id, fileId: 'file-that-no-longer-exists', jobId: t.job.id, event: 'APPROVED',
    actorUserId: t.user.id, sha256: SHA, sizeBytes: 5, details: { note: 'x' },
  } })
  await rejectsWith(prisma.$executeRaw`UPDATE "EvidenceDeletionLog" SET "event" = 'TAMPERED' WHERE id = ${row.id}`, /append-only/i, 'update')
  await rejectsWith(prisma.$executeRaw`DELETE FROM "EvidenceDeletionLog" WHERE id = ${row.id}`, /append-only/i, 'delete')
  await rejectsWith(prisma.evidenceDeletionLog.update({ where: { id: row.id }, data: { event: 'TAMPERED' } }), /append-only/i, 'update via client')
  await rejectsWith(prisma.evidenceDeletionLog.create({ data: { workspaceId: t.ws.id, fileId: 'f', event: '  ' } }), CHECK, 'blank event')
  assert.equal((await prisma.evidenceDeletionLog.findUniqueOrThrow({ where: { id: row.id } })).event, 'APPROVED')
  // Deleting the workspace (which has no files) leaves the log behind.
  await prisma.workspace.delete({ where: { id: t.ws.id } })
  assert.equal(await prisma.evidenceDeletionLog.count({ where: { id: row.id } }), 1)
})

// ── no file contents in PostgreSQL; indexes for the later sweeps ─────────────

test('no column in the new tables can hold file contents', async () => {
  const cols = await prisma.$queryRaw<Array<{ table_name: string; column_name: string; data_type: string }>>`
    SELECT table_name, column_name, data_type FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name IN ('EvidenceFile', 'EvidenceFileCopy', 'RetentionPolicy', 'LegalHold', 'EvidenceDeletionLog')`
  assert.ok(cols.length > 30)
  for (const c of cols) {
    assert.ok(!['bytea', 'oid'].includes(c.data_type), `${c.table_name}.${c.column_name} is ${c.data_type}`)
    assert.ok(!/^(data|blob|content|body|bytes|base64)$/i.test(c.column_name), `${c.table_name}.${c.column_name} looks like a content column`)
  }
  // The only free-form payload is the audit log's small JSON `details`.
  const json = cols.filter(c => c.data_type === 'jsonb').map(c => `${c.table_name}.${c.column_name}`)
  assert.deepEqual(json, ['EvidenceDeletionLog.details'])
})

test('indexes exist for the retention sweep, hold lookups and per-job listing', async () => {
  const idx = (await prisma.$queryRaw<Array<{ indexname: string }>>`
    SELECT indexname FROM pg_indexes WHERE schemaname = 'public'
      AND tablename IN ('EvidenceFile', 'EvidenceFileCopy', 'LegalHold', 'EvidenceDeletionLog', 'JobTechnicianEvidence')`).map(r => r.indexname)
  for (const name of [
    'EvidenceFile_workspaceId_retainUntil_idx', 'EvidenceFile_workspaceId_status_idx', 'EvidenceFile_workspaceId_jobId_createdAt_idx',
    'EvidenceFile_workspaceId_crewMemberId_submissionId_key', 'EvidenceFileCopy_fileId_location_key', 'EvidenceFileCopy_location_objectKey_key',
    'LegalHold_workspaceId_releasedAt_idx', 'EvidenceDeletionLog_fileId_idx', 'JobTechnicianEvidence_workspaceId_jobId_id_key',
  ]) assert.ok(idx.includes(name), `missing index ${name}`)
})

// ── compatibility with the existing technician evidence tables ───────────────

test('existing technician evidence behaves exactly as before the migration', async () => {
  const t = await tenant('a@example.test')
  const sid = randomUUID()
  await prisma.jobTechnicianEvidence.create({ data: {
    workspaceId: t.ws.id, jobId: t.job.id, crewMemberId: t.crew.id, submissionId: sid, kind: 'NOTE', content: { note: 'later' },
  } })
  await rejectsWith(prisma.jobTechnicianEvidence.create({ data: {
    workspaceId: t.ws.id, jobId: t.job.id, crewMemberId: t.crew.id, submissionId: sid, kind: 'NOTE', content: { note: 'dup' },
  } }), UNIQUE, 'idempotency unique still applies')
  // Evidence without files is deleted by job cascade, as before.
  await prisma.job.delete({ where: { id: t.job.id } })
  assert.equal(await prisma.jobTechnicianEvidence.count({ where: { jobId: t.job.id } }), 0)
})
