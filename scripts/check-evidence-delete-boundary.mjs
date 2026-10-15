// Evidence deletion boundary (C4). Deleting evidence objects is the job of ONE
// dedicated runner holding separate credentials. This static check keeps the rest of the
// code from quietly growing a path that can do it:
//   1. only the runner may reference the EVIDENCE_DELETE_* credentials or build the
//      delete-capable stores (processors/evidenceDeletion.ts, scripts/evidence-deletion.ts,
//      and the config module that defines them);
//   2. the API must not import the deletion executor;
//   3. the backup replication module and the API upload routes never call delete() on a store.
// Provider-level scoping still has to be done with separate tokens (see
// docs/runbooks/EVIDENCE_DELETION.md); this check only guards the code.
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const failures = []
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist') continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(ts|mjs|js)$/.test(e.name)) out.push(p)
  }
  return out
}
const rel = (p) => path.relative(root, p).split(path.sep).join('/')
const code = (p) => fs.readFileSync(p, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')

const RUNNER_ONLY = new Set([
  'apps/worker/src/processors/evidenceDeletion.ts',
  'scripts/evidence-deletion.ts',
  'packages/backend-core/src/lib/evidenceDeletionConfig.ts',
  // the upload / backup resolvers refuse to start when these variables are present
  'packages/backend-core/src/lib/evidenceStorageConfig.ts',
  'packages/backend-core/src/lib/evidenceBackupConfig.ts',
])
for (const dir of ['apps/api/src', 'apps/worker/src', 'packages/backend-core/src', 'scripts']) {
  for (const f of walk(path.join(root, dir))) {
    const r = rel(f)
    const text = code(f)
    if (/EVIDENCE_DELETE_|resolveEvidenceDeletion\b|buildDeletionStores\b/.test(text) && !RUNNER_ONLY.has(r) && r !== 'scripts/check-evidence-delete-boundary.mjs') {
      failures.push(`${r}: only the deletion runner may reference EVIDENCE_DELETE_* credentials or build delete-capable stores`)
    }
    if (r.startsWith('apps/api/src/') && /processors\/evidenceDeletion|evidenceDeletion\.js/.test(text)) failures.push(`${r}: the API must not import the deletion executor`)
  }
}
for (const f of ['apps/worker/src/processors/evidenceBackup.ts', 'apps/api/src/routes/ops/evidenceFiles.ts', 'apps/api/src/routes/ops/evidenceGovernance.ts']) {
  if (/\.delete\(/.test(code(path.join(root, f)))) failures.push(`${f}: must not call delete() on an object store`)
}
if (failures.length) {
  console.error('Evidence deletion boundary check FAILED')
  for (const f of failures) console.error(`- ${f}`)
  process.exit(1)
}
console.log('Evidence deletion boundary check PASS')
