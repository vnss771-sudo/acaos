#!/usr/bin/env node
import assert from 'node:assert/strict'
import { evaluatePilotPolicy } from './preflight-contract.mjs'

const safe = () => ({
  NODE_ENV: 'production', SAFE_LAUNCH_MODE: 'true', TENANT_GUARD_MODE: 'enforce',
  REPUTATION_GUARD_MODE: 'enforce', FOLLOWUPS_ENABLED: 'false', COMPLIANCE_GATE_ENABLED: 'false',
  DATABASE_URL: 'postgres://example', REDIS_URL: 'redis://example', JWT_SECRET: 'x'.repeat(64),
  EMAIL_ENCRYPTION_KEY: 'x'.repeat(64), OPENAI_API_KEY: 'test', STRIPE_SECRET_KEY: 'sk_live_test',
  STRIPE_WEBHOOK_SECRET: 'whsec_test', STRIPE_PRICE_STARTER: 'price_starter', STRIPE_PRICE_GROWTH: 'price_growth',
  METRICS_TOKEN: 'metrics', API_URL: 'https://api.example.com', WEB_URL: 'https://app.example.com',
  ALLOWED_ORIGINS: 'https://app.example.com', ACAOS_RELEASE_SHA: '0123456789abcdef0123456789abcdef01234567',
  ACAOS_RELEASE_ID: '1.4.0+0123456789ab',
})
const get = (r, id) => r.checks.find((c) => c.id === id)?.status

assert.equal(evaluatePilotPolicy(safe()).safe, true)
assert.equal(evaluatePilotPolicy({ ...safe(), AUTONOMOUS_OUTREACH_MODE: 'off' }).safe, true)
for (const [key, value, id] of [
  ['TENANT_GUARD_MODE', 'observe', 'policy.tenant_guard'],
  ['REPUTATION_GUARD_MODE', 'observe', 'policy.reputation_guard'],
  ['SAFE_LAUNCH_MODE', 'false', 'policy.safe_launch'],
  ['FOLLOWUPS_ENABLED', 'true', 'policy.followups'],
  ['AUTONOMOUS_OUTREACH_MODE', 'active', 'policy.autonomy'],
  ['API_URL', 'http://api.example.com', 'url.api_url'],
]) {
  const env = safe(); env[key] = value
  const report = evaluatePilotPolicy(env)
  assert.equal(report.safe, false, `${key} must make preflight unsafe`)
  assert.equal(get(report, id), 'FAIL')
}
for (const [key, id] of [
  ['COMPLIANCE_GATE_ENABLED', 'policy.compliance_gate'],
  ['ACAOS_RELEASE_SHA', 'release.commit'],
]) {
  const env = safe(); delete env[key]
  if (key === 'ACAOS_RELEASE_SHA') delete env.ACAOS_RELEASE_ID
  const report = evaluatePilotPolicy(env)
  assert.equal(get(report, id), 'FAIL')
}
console.log('preflight-contract selftest: PASS')
