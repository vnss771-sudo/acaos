// Unit test for the stale-send recovery threshold parse (pure/env).

import test from 'node:test'
import assert from 'node:assert/strict'
import { staleSendRecoveryMinutes } from '../packages/backend-core/src/lib/staleSends.ts'

test('staleSendRecoveryMinutes defaults to 120 and honors a valid override', () => {
  const saved = process.env.STALE_SENDING_RECOVERY_MINUTES
  try {
    delete process.env.STALE_SENDING_RECOVERY_MINUTES
    assert.equal(staleSendRecoveryMinutes(), 120)
    process.env.STALE_SENDING_RECOVERY_MINUTES = '30'
    assert.equal(staleSendRecoveryMinutes(), 30)
    process.env.STALE_SENDING_RECOVERY_MINUTES = '0'
    assert.equal(staleSendRecoveryMinutes(), 120, 'sub-1 falls back to default')
    process.env.STALE_SENDING_RECOVERY_MINUTES = 'nope'
    assert.equal(staleSendRecoveryMinutes(), 120)
  } finally {
    if (saved === undefined) delete process.env.STALE_SENDING_RECOVERY_MINUTES
    else process.env.STALE_SENDING_RECOVERY_MINUTES = saved
  }
})
