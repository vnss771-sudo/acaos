import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getRuntimeMetadata, getBuildInfoLabels, getProcessStartTimeSeconds } from '../packages/backend-core/src/lib/release.ts'

test('runtime metadata includes canonical releaseId', () => {
  const metadata = getRuntimeMetadata('acaos-api')
  assert.equal(metadata.service, 'acaos-api')
  assert.ok(metadata.releaseId)
  assert.ok(metadata.version)
})

test('build info labels include service and release_id', () => {
  const labels = getBuildInfoLabels('acaos-worker')
  assert.equal(labels.service, 'acaos-worker')
  assert.ok(labels.release_id)
})

test('process start time is a unix timestamp', () => {
  assert.equal(Number.isInteger(getProcessStartTimeSeconds()), true)
  assert.ok(getProcessStartTimeSeconds() > 0)
})
