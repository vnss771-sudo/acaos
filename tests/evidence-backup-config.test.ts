// Unit tests (no database, no network) for the independent-backup configuration and
// the key/store helpers it relies on.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveEvidenceBackup } from '../packages/backend-core/src/lib/evidenceBackupConfig.ts'
import {
  assertKeyForJob, getEvidenceBackupStore, setEvidenceBackupStoreForTests, MemoryEvidenceStore,
} from '../packages/backend-core/src/lib/evidenceStorage.ts'

const ACCOUNT = 'a'.repeat(32)
const GOOD = {
  EVIDENCE_BACKUP_ENABLED: 'true',
  EVIDENCE_BACKUP_ENDPOINT: `https://${ACCOUNT}.r2.cloudflarestorage.com`,
  EVIDENCE_BACKUP_BUCKET: 'acaos-evidence-backup',
  EVIDENCE_BACKUP_ACCESS_KEY_ID: 'BACKUPKEYIDTEST',
  EVIDENCE_BACKUP_SECRET_ACCESS_KEY: 'backup-secret-do-not-leak',
}
const problems = (env: Record<string, string | undefined>) => {
  const s = resolveEvidenceBackup(env)
  return s.enabled ? [] : s.problems
}

test('backups are off unless the flag is exactly "true"', () => {
  for (const flag of [undefined, '', 'false', ' FALSE ']) {
    const s = resolveEvidenceBackup({ ...GOOD, EVIDENCE_BACKUP_ENABLED: flag })
    assert.equal(s.enabled, false); assert.equal(!s.enabled && s.reason, 'flag_off')
  }
  assert.equal(resolveEvidenceBackup({}).enabled, false)
  assert.equal(resolveEvidenceBackup({ ...GOOD, EVIDENCE_BACKUP_ENABLED: 'yes' }).enabled, false)
  assert.equal(resolveEvidenceBackup({ EVIDENCE_BACKUP_ENABLED: 'true' }).enabled, false, 'flag without config stays off')
})

test('a complete R2 configuration is accepted (also the EU and FedRAMP hostnames)', () => {
  assert.equal(resolveEvidenceBackup(GOOD).enabled, true)
  for (const mid of ['.eu', '.fedramp']) {
    assert.equal(resolveEvidenceBackup({ ...GOOD, EVIDENCE_BACKUP_ENDPOINT: `https://${ACCOUNT}${mid}.r2.cloudflarestorage.com` }).enabled, true)
  }
})

test('the endpoint is allow-listed: only https R2 account hosts (SSRF guard)', () => {
  for (const endpoint of [
    'https://storage.example.test', 'https://169.254.169.254', 'https://internal.railway.internal',
    `https://${ACCOUNT}.r2.cloudflarestorage.com.evil.test`, `https://evil.test/${ACCOUNT}.r2.cloudflarestorage.com`,
    'https://short.r2.cloudflarestorage.com', `http://${ACCOUNT}.r2.cloudflarestorage.com`,
    `https://user:pw@${ACCOUNT}.r2.cloudflarestorage.com`, `https://${ACCOUNT}.r2.cloudflarestorage.com/some/path`,
    'not a url',
  ]) {
    assert.equal(resolveEvidenceBackup({ ...GOOD, EVIDENCE_BACKUP_ENDPOINT: endpoint }).enabled, false, endpoint)
  }
})

test('loopback http is allowed for local disposable stores, never in production', () => {
  const local = { ...GOOD, EVIDENCE_BACKUP_ENDPOINT: 'http://127.0.0.1:9000' }
  assert.equal(resolveEvidenceBackup(local).enabled, true)
  assert.equal(resolveEvidenceBackup({ ...local, NODE_ENV: 'production' }).enabled, false)
})

test('every required setting is needed and the bucket name is validated', () => {
  for (const k of ['EVIDENCE_BACKUP_ENDPOINT', 'EVIDENCE_BACKUP_BUCKET', 'EVIDENCE_BACKUP_ACCESS_KEY_ID', 'EVIDENCE_BACKUP_SECRET_ACCESS_KEY']) {
    assert.equal(resolveEvidenceBackup({ ...GOOD, [k]: '' }).enabled, false, k)
  }
  assert.equal(resolveEvidenceBackup({ ...GOOD, EVIDENCE_BACKUP_BUCKET: 'Bad_Bucket' }).enabled, false)
})

test('the backup must be independent of the primary store', () => {
  const primary = {
    EVIDENCE_S3_ENDPOINT: `https://${ACCOUNT}.r2.cloudflarestorage.com`, EVIDENCE_S3_BUCKET: 'acaos-evidence-backup',
    EVIDENCE_S3_ACCESS_KEY_ID: 'PRIMARYKEYID',
  }
  assert.match(problems({ ...GOOD, ...primary }).join(';'), /differ from the primary/)
  // same bucket name on a different account is a different bucket
  assert.equal(resolveEvidenceBackup({ ...GOOD, EVIDENCE_S3_ENDPOINT: 'https://storage.example.test', EVIDENCE_S3_BUCKET: 'acaos-evidence-backup' }).enabled, true)
  // same endpoint, different bucket is still refused: one provider account is one failure domain
  assert.match(problems({ ...GOOD, EVIDENCE_S3_ENDPOINT: GOOD.EVIDENCE_BACKUP_ENDPOINT, EVIDENCE_S3_BUCKET: 'other' }).join(';'), /primary endpoint/)
  assert.match(problems({ ...GOOD, EVIDENCE_S3_ACCESS_KEY_ID: GOOD.EVIDENCE_BACKUP_ACCESS_KEY_ID }).join(';'), /credentials must differ/)
})

test('problems never contain a credential', () => {
  const s = resolveEvidenceBackup({ ...GOOD, EVIDENCE_BACKUP_ENDPOINT: 'https://evil.test', EVIDENCE_BACKUP_BUCKET: 'X' })
  const text = JSON.stringify(s)
  assert.ok(!text.includes('backup-secret-do-not-leak') && !text.includes('BACKUPKEYIDTEST'))
})

test('object keys must sit under the exact workspace and job', () => {
  assertKeyForJob('ws/w1/job/j1/final/abc', 'w1', 'j1')
  for (const [k, w, j] of [
    ['ws/w1/job/j1/final/abc', 'w2', 'j1'], ['ws/w1/job/j1/final/abc', 'w1', 'j2'], ['ws/w1/job/j10/final/abc', 'w1', 'j1'],
    ['ws/w1/job/j1/../j2/final/abc', 'w1', 'j1'], ['ws/w1//job/j1/final/abc', 'w1', 'j1'], ['ws/w1/other/abc', 'w1', 'j1'],
  ]) assert.throws(() => assertKeyForJob(k, w, j), undefined, `${k} ${w} ${j}`)
})

test('the backup store override is test-only', () => {
  const store = new MemoryEvidenceStore()
  setEvidenceBackupStoreForTests(store)
  assert.equal(getEvidenceBackupStore({ endpoint: 'x', bucket: 'b', region: 'auto', accessKeyId: 'a', secretAccessKey: 's', forcePathStyle: false }), store)
  setEvidenceBackupStoreForTests(null)
  const prev = process.env.NODE_ENV
  process.env.NODE_ENV = 'production'
  try { assert.throws(() => setEvidenceBackupStoreForTests(store), /not available in production/) } finally {
    if (prev === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prev
  }
})
