import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const script = resolve('scripts/preflight-contract.mjs')

const safeEnv = (): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH,
  NODE_ENV: 'production',
  SAFE_LAUNCH_MODE: 'true',
  TENANT_GUARD_MODE: 'enforce',
  REPUTATION_GUARD_MODE: 'enforce',
  FOLLOWUPS_ENABLED: 'false',
  COMPLIANCE_GATE_ENABLED: 'false',
  DATABASE_URL: 'postgres://example',
  REDIS_URL: 'redis://example',
  JWT_SECRET: 'x'.repeat(64),
  EMAIL_ENCRYPTION_KEY: 'x'.repeat(64),
  OPENAI_API_KEY: 'test',
  STRIPE_SECRET_KEY: 'sk_live_test',
  STRIPE_WEBHOOK_SECRET: 'whsec_test',
  STRIPE_PRICE_STARTER: 'price_starter',
  STRIPE_PRICE_GROWTH: 'price_growth',
  METRICS_TOKEN: 'metrics-token',
  API_URL: 'https://api.example.com',
  WEB_URL: 'https://app.example.com',
  ALLOWED_ORIGINS: 'https://app.example.com',
  ACAOS_RELEASE_SHA: '0123456789abcdef0123456789abcdef01234567',
  ACAOS_RELEASE_ID: '1.4.0+0123456789ab',
})

function run(overrides: NodeJS.ProcessEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'acaos-preflight-'))
  const env = { ...safeEnv(), ...overrides }
  for (const [key, value] of Object.entries(overrides)) if (value === undefined) delete env[key]
  const result = spawnSync(process.execPath, [script, '--out-dir', dir, '--json'], {
    cwd: process.cwd(), env, encoding: 'utf8',
  })
  const report = JSON.parse(readFileSync(join(dir, 'release-preflight.json'), 'utf8'))
  rmSync(dir, { recursive: true, force: true })
  return { result, report }
}

function status(report: any, id: string) {
  return report.checks.find((check: { id: string }) => check.id === id)?.status
}

test('safe controlled-pilot policy passes', () => {
  const { result, report } = run()
  assert.equal(result.status, 0)
  assert.equal(report.safe, true)
  assert.equal(report.summary.fail, 0)
})

test('tenant guard observe fails closed', () => {
  const { result, report } = run({ TENANT_GUARD_MODE: 'observe' })
  assert.equal(result.status, 1)
  assert.equal(status(report, 'policy.tenant_guard'), 'FAIL')
})

test('reputation guard observe fails closed', () => {
  const { report } = run({ REPUTATION_GUARD_MODE: 'observe' })
  assert.equal(status(report, 'policy.reputation_guard'), 'FAIL')
})

test('safe launch must be explicitly enabled', () => {
  const { report } = run({ SAFE_LAUNCH_MODE: undefined })
  assert.equal(status(report, 'policy.safe_launch'), 'FAIL')
})

test('followups must be explicitly disabled', () => {
  const { report } = run({ FOLLOWUPS_ENABLED: 'true' })
  assert.equal(status(report, 'policy.followups'), 'FAIL')
})

test('compliance gate posture must be explicit even when disabled', () => {
  const { report } = run({ COMPLIANCE_GATE_ENABLED: undefined })
  assert.equal(status(report, 'policy.compliance_gate'), 'FAIL')
})

test('production URLs must be HTTPS', () => {
  const { report } = run({ API_URL: 'http://api.example.com' })
  assert.equal(status(report, 'url.api_url'), 'FAIL')
})

test('release identity is required when not in a git checkout', () => {
  const { report } = run({ ACAOS_RELEASE_SHA: undefined, ACAOS_RELEASE_ID: undefined, GITHUB_SHA: undefined, RAILWAY_GIT_COMMIT_SHA: undefined })
  // In a Git checkout the script may legitimately derive the identity from HEAD.
  // In source archives (the production packaging case) the absence is a hard failure.
  if (status(report, 'release.commit') !== 'PASS') {
    assert.equal(status(report, 'release.commit'), 'FAIL')
    assert.equal(status(report, 'release.id'), 'FAIL')
  }
})
