// Static guard: every outbound provider call must route through the shared
// providerFetch client (timeout/retry/size-bound/breaker), so no raw `fetch(`
// may remain in the provider source files. Fails the build if a new raw fetch
// is introduced.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

const PROVIDER_FILES = [
  'apps/api/src/lib/prospectSources.ts',
  'packages/backend-core/src/services/apollo.ts',
  'packages/backend-core/src/services/hunter.ts',
]

// Matches a raw `fetch(` call but NOT `providerFetch(` (capital F after
// "provider" means the lowercase `fetch(` token never appears there).
const RAW_FETCH = /\bfetch\s*\(/

for (const rel of PROVIDER_FILES) {
  test(`${rel} contains no raw fetch( call`, () => {
    const src = readFileSync(root + rel, 'utf8')
    assert.ok(!RAW_FETCH.test(src), `raw fetch( found in ${rel} — route it through providerFetch`)
  })
}
