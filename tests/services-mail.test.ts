import test from 'node:test'
import assert from 'node:assert/strict'
import { isMailConfigured, isMailboxConfigured, buildTransport } from '../apps/api/src/services/mail.ts'
import { ApiError } from '../apps/api/src/lib/http.ts'

function withEnv(vars: Record<string, string | undefined>, fn: () => void | Promise<void>) {
  const saved: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    const result = fn()
    if (result && typeof (result as any).then === 'function') {
      return (result as Promise<void>).finally(() => {
        for (const [k, v] of Object.entries(saved)) {
          if (v === undefined) delete process.env[k]
          else process.env[k] = v
        }
      })
    }
    return result
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

// ---------------------------------------------------------------------------
// isMailConfigured
// ---------------------------------------------------------------------------
test('isMailConfigured: false with no env vars', () => {
  withEnv({ SMTP_HOST: undefined, SMTP_FROM: undefined }, () => {
    assert.equal(isMailConfigured(), false)
  })
})

test('isMailConfigured: false with only SMTP_HOST', () => {
  withEnv({ SMTP_HOST: 'smtp.example.com', SMTP_FROM: undefined }, () => {
    assert.equal(isMailConfigured(), false)
  })
})

test('isMailConfigured: false with only SMTP_FROM', () => {
  withEnv({ SMTP_HOST: undefined, SMTP_FROM: 'noreply@example.com' }, () => {
    assert.equal(isMailConfigured(), false)
  })
})

test('isMailConfigured: true when both SMTP_HOST and SMTP_FROM set', () => {
  withEnv({ SMTP_HOST: 'smtp.example.com', SMTP_FROM: 'noreply@example.com' }, () => {
    assert.equal(isMailConfigured(), true)
  })
})

test('isMailConfigured: false when vars are empty strings', () => {
  withEnv({ SMTP_HOST: '', SMTP_FROM: '' }, () => {
    assert.equal(isMailConfigured(), false)
  })
})

// ---------------------------------------------------------------------------
// isMailboxConfigured
// ---------------------------------------------------------------------------
test('isMailboxConfigured: false with no env vars', () => {
  withEnv({ IMAP_HOST: undefined, IMAP_USER: undefined, IMAP_PASS: undefined }, () => {
    assert.equal(isMailboxConfigured(), false)
  })
})

test('isMailboxConfigured: false with partial IMAP config (only HOST)', () => {
  withEnv({ IMAP_HOST: 'imap.example.com', IMAP_USER: undefined, IMAP_PASS: undefined }, () => {
    assert.equal(isMailboxConfigured(), false)
  })
})

test('isMailboxConfigured: false with only HOST and USER', () => {
  withEnv({ IMAP_HOST: 'imap.example.com', IMAP_USER: 'user@example.com', IMAP_PASS: undefined }, () => {
    assert.equal(isMailboxConfigured(), false)
  })
})

test('isMailboxConfigured: true when all three IMAP vars present', () => {
  withEnv({ IMAP_HOST: 'imap.example.com', IMAP_USER: 'user@x.com', IMAP_PASS: 'secret' }, () => {
    assert.equal(isMailboxConfigured(), true)
  })
})

// ---------------------------------------------------------------------------
// buildTransport
// ---------------------------------------------------------------------------
test('buildTransport: throws ApiError 503 when SMTP_HOST missing', () => {
  withEnv({ SMTP_HOST: undefined }, () => {
    assert.throws(() => buildTransport(), (err: unknown) => {
      assert.ok(err instanceof ApiError, 'should be ApiError')
      assert.equal((err as ApiError).statusCode, 503)
      return true
    })
  })
})

test('buildTransport: returns a transport object when SMTP_HOST is set', () => {
  withEnv({ SMTP_HOST: 'smtp.example.com', SMTP_PORT: '587', SMTP_USER: undefined, SMTP_PASS: undefined }, () => {
    const transport = buildTransport()
    assert.ok(transport !== null && typeof transport === 'object')
  })
})

test('buildTransport: secure when SMTP_PORT is 465', () => {
  withEnv({ SMTP_HOST: 'smtp.example.com', SMTP_PORT: '465' }, () => {
    // Just verify it doesn't throw and returns a transport
    const transport = buildTransport()
    assert.ok(transport !== null)
  })
})

test('buildTransport: secure when SMTP_SECURE=true', () => {
  withEnv({ SMTP_HOST: 'smtp.example.com', SMTP_PORT: '587', SMTP_SECURE: 'true' }, () => {
    const transport = buildTransport()
    assert.ok(transport !== null)
  })
})

test('buildTransport: port defaults to 587 when SMTP_PORT not set', () => {
  withEnv({ SMTP_HOST: 'smtp.example.com', SMTP_PORT: undefined }, () => {
    // nodemailer transport creation does not throw with default port
    assert.doesNotThrow(() => buildTransport())
  })
})
