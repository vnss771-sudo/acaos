import test from 'node:test'
import assert from 'node:assert/strict'
import { requireEnv, hasEnv } from '../apps/api/src/lib/env.ts'

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const saved: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try { fn() } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

// ---------------------------------------------------------------------------
// requireEnv
// ---------------------------------------------------------------------------
test('requireEnv: throws when single var missing', () => {
  withEnv({ TEST_VAR_X: undefined }, () => {
    assert.throws(() => requireEnv(['TEST_VAR_X']), /Missing required environment variables/)
  })
})

test('requireEnv: error message lists the missing key', () => {
  withEnv({ TEST_VAR_X: undefined }, () => {
    assert.throws(() => requireEnv(['TEST_VAR_X']), /TEST_VAR_X/)
  })
})

test('requireEnv: throws listing ALL missing vars', () => {
  withEnv({ TEST_VAR_A: undefined, TEST_VAR_B: undefined }, () => {
    assert.throws(() => requireEnv(['TEST_VAR_A', 'TEST_VAR_B']), /TEST_VAR_A/)
    withEnv({ TEST_VAR_A: undefined, TEST_VAR_B: undefined }, () => {
      try {
        requireEnv(['TEST_VAR_A', 'TEST_VAR_B'])
      } catch (e: any) {
        assert.ok(e.message.includes('TEST_VAR_A'))
        assert.ok(e.message.includes('TEST_VAR_B'))
      }
    })
  })
})

test('requireEnv: does not throw when all vars present', () => {
  withEnv({ TEST_VAR_X: 'hello' }, () => {
    assert.doesNotThrow(() => requireEnv(['TEST_VAR_X']))
  })
})

test('requireEnv: treats whitespace-only value as missing', () => {
  withEnv({ TEST_VAR_X: '   ' }, () => {
    assert.throws(() => requireEnv(['TEST_VAR_X']), /Missing required/)
  })
})

test('requireEnv: treats empty string as missing', () => {
  withEnv({ TEST_VAR_X: '' }, () => {
    assert.throws(() => requireEnv(['TEST_VAR_X']), /Missing required/)
  })
})

test('requireEnv: passes when some vars present and required list matches', () => {
  withEnv({ TEST_VAR_X: 'val', TEST_VAR_Y: 'other' }, () => {
    assert.doesNotThrow(() => requireEnv(['TEST_VAR_X', 'TEST_VAR_Y']))
  })
})

test('requireEnv: empty key list never throws', () => {
  assert.doesNotThrow(() => requireEnv([]))
})

// ---------------------------------------------------------------------------
// hasEnv
// ---------------------------------------------------------------------------
test('hasEnv: returns false when any var missing', () => {
  withEnv({ TEST_VAR_X: undefined }, () => {
    assert.equal(hasEnv(['TEST_VAR_X']), false)
  })
})

test('hasEnv: returns false when var is whitespace-only', () => {
  withEnv({ TEST_VAR_X: '   ' }, () => {
    assert.equal(hasEnv(['TEST_VAR_X']), false)
  })
})

test('hasEnv: returns false when var is empty string', () => {
  withEnv({ TEST_VAR_X: '' }, () => {
    assert.equal(hasEnv(['TEST_VAR_X']), false)
  })
})

test('hasEnv: returns true when single var present', () => {
  withEnv({ TEST_VAR_X: 'value' }, () => {
    assert.equal(hasEnv(['TEST_VAR_X']), true)
  })
})

test('hasEnv: returns true when all vars present', () => {
  withEnv({ TEST_VAR_A: 'a', TEST_VAR_B: 'b' }, () => {
    assert.equal(hasEnv(['TEST_VAR_A', 'TEST_VAR_B']), true)
  })
})

test('hasEnv: returns false when one of many vars missing', () => {
  withEnv({ TEST_VAR_A: 'a', TEST_VAR_B: undefined }, () => {
    assert.equal(hasEnv(['TEST_VAR_A', 'TEST_VAR_B']), false)
  })
})

test('hasEnv: empty key list returns true', () => {
  assert.equal(hasEnv([]), true)
})
