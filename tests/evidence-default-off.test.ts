// Production default for technician photo evidence: OFF. The gallery (C5d) and every evidence route key off
// resolveEvidenceStorage(), so this pins both the resolver and the committed deployment configuration:
// nothing in the repo may switch uploads on.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { resolveEvidenceStorage } from '../packages/backend-core/src/lib/evidenceStorageConfig.ts'

test('uploads are off unless the flag is exactly "true" (and complete)', () => {
  for (const env of [{}, { EVIDENCE_UPLOADS_ENABLED: '' }, { EVIDENCE_UPLOADS_ENABLED: 'false' }, { EVIDENCE_UPLOADS_ENABLED: 'yes' }, { EVIDENCE_UPLOADS_ENABLED: '1' }, { EVIDENCE_UPLOADS_ENABLED: 'true' }]) {
    assert.equal(resolveEvidenceStorage(env as never).enabled, false, JSON.stringify(env))
  }
})

const ROOT = join(import.meta.dirname, '..')
function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

test('no committed deployment or environment config enables evidence uploads', () => {
  const files = [
    ...readdirSync(ROOT).filter((f) => /^(\.env.*|docker-compose.*\.ya?ml|Dockerfile.*|vercel\.json|railway.*|render.*)$/.test(f)).map((f) => join(ROOT, f)),
    ...walk(join(ROOT, 'infra')), ...walk(join(ROOT, 'ops')), ...walk(join(ROOT, '.github', 'workflows')),
  ]
  assert.ok(files.length > 3, 'the scan found the config files')
  const offenders: string[] = []
  for (const f of files) {
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      const code = line.replace(/\s+#.*$/, '').trim()
      if (code.startsWith('#') || code.startsWith('//')) return
      // KEY=true, KEY: "true", "KEY": "true", also the comparison-free forms used by compose and workflows
      if (/EVIDENCE_UPLOADS_ENABLED["']?\s*[:=]\s*["']?true\b/i.test(code)) offenders.push(`${relative(ROOT, f)}:${i + 1}`)
    })
  }
  assert.deepEqual(offenders, [])
})
