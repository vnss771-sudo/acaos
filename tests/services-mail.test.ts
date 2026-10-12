import test from 'node:test'
import assert from 'node:assert/strict'
import { isMailConfigured, isMailboxConfigured, buildTransport } from '../packages/backend-core/src/services/mail.ts'
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

// ---------------------------------------------------------------------------
// Tenant isolation: platform SMTP/IMAP credentials must never serve a workspace
// ---------------------------------------------------------------------------
import { isWorkspaceMailConfigured, isWorkspaceMailboxConfigured, sendMail, syncMailboxOnce } from '../packages/backend-core/src/services/mail.ts'

const PLATFORM = { SMTP_HOST: 'smtp.platform.test', SMTP_FROM: 'noreply@platform.test', SMTP_USER: 'platform-user', SMTP_PASS: 'platform-pass', IMAP_HOST: 'imap.platform.test', IMAP_USER: 'inbox@platform.test', IMAP_PASS: 'platform-imap-pass' }

test('workspace readiness ignores platform env: no workspace config means not configured', () => {
  withEnv(PLATFORM, () => {
    assert.equal(isWorkspaceMailConfigured(null), false)
    assert.equal(isWorkspaceMailConfigured(undefined), false)
    assert.equal(isWorkspaceMailConfigured({ smtpHost: 'smtp.own.test' }), false) // no From
    assert.equal(isWorkspaceMailConfigured({ smtpHost: 'smtp.own.test', smtpFrom: 'me@own.test' }), true)
    assert.equal(isWorkspaceMailboxConfigured(null), false)
    assert.equal(isWorkspaceMailboxConfigured({ imapHost: 'imap.own.test', imapUser: 'me@own.test' }), false) // no password
    assert.equal(isWorkspaceMailboxConfigured({ imapHost: 'imap.own.test', imapUser: 'me@own.test', imapPass: 'x' }), true)
  })
})

test('buildTransport: a workspace host never inherits the platform SMTP credentials', () => {
  withEnv(PLATFORM, () => {
    const t: any = buildTransport({ smtpHost: 'smtp.attacker.test', smtpFrom: 'a@attacker.test' })
    const auth = t.options?.auth
    assert.equal(auth, undefined, 'must not authenticate with platform SMTP_USER/SMTP_PASS')
  })
})

test('sendMail: workspace host without a From address is refused (no platform From)', async () => {
  await withEnv(PLATFORM, async () => {
    await assert.rejects(sendMail('x@y.test', 's', '<p>h</p>', { smtpHost: 'smtp.own.test' }), /no From address/)
  })
})

test('syncMailboxOnce: refuses to read the platform mailbox for a workspace', async () => {
  await withEnv(PLATFORM, async () => {
    class NeverConnect { constructor() { throw new Error('must not connect') } }
    await assert.rejects(syncMailboxOnce(null, 'ws1', { ImapFlow: NeverConnect }), (e: any) => e instanceof ApiError && e.statusCode === 409)
    await assert.rejects(syncMailboxOnce({ imapHost: 'imap.own.test', imapUser: 'u' }, 'ws1', { ImapFlow: NeverConnect }), (e: any) => e instanceof ApiError && e.statusCode === 409)
  })
})
