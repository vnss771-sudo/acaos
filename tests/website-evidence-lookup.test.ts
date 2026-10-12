// Regression: the pinned DNS lookup must satisfy both Node call shapes (single address and { all: true }).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pinnedLookup } from '../packages/backend-core/src/lib/websiteEvidenceFetch.ts'

test('pinnedLookup answers the single-address form', () => {
  let got: unknown[] = []
  pinnedLookup('93.184.216.34')('example.com', {}, (...a) => { got = a })
  assert.deepEqual(got, [null, '93.184.216.34', 4])
})

test('pinnedLookup answers the { all: true } form with an array (Node 20+ default)', () => {
  let got: unknown[] = []
  pinnedLookup('93.184.216.34')('example.com', { all: true }, (...a) => { got = a })
  assert.deepEqual(got, [null, [{ address: '93.184.216.34', family: 4 }]])
})
