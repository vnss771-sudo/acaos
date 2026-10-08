#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

const boolToken = (value) => {
  if (value === undefined) return undefined
  const token = String(value).trim().toLowerCase()
  if (['true', '1', 'yes', 'on'].includes(token)) return true
  if (['false', '0', 'no', 'off'].includes(token)) return false
  return null
}

const nonEmpty = (value) => typeof value === 'string' && value.trim().length > 0

const gitHead = () => {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8').trim()
  } catch {
    return undefined
  }
}

const packageVersion = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version || 'unknown'
  } catch {
    return 'unknown'
  }
}

export function resolveReleaseIdentity(env = process.env) {
  const commit = env.ACAOS_RELEASE_SHA?.trim()
    || env.GITHUB_SHA?.trim()
    || env.RAILWAY_GIT_COMMIT_SHA?.trim()
    || gitHead()
  const version = env.ACAOS_RELEASE_VERSION?.trim() || packageVersion()
  const releaseId = env.ACAOS_RELEASE_ID?.trim()
    || (commit && commit !== 'unknown' ? `${version}+${commit.slice(0, 12)}` : undefined)
  return { version, commit, releaseId }
}

function urlCheck(name, raw, { required = true, https = true } = {}) {
  if (!nonEmpty(raw)) {
    return {
      id: `url.${name.toLowerCase()}`,
      status: required ? 'FAIL' : 'WARN',
      message: required ? `${name} is required` : `${name} is not configured`,
    }
  }
  try {
    const parsed = new URL(raw)
    if (https && parsed.protocol !== 'https:') {
      return { id: `url.${name.toLowerCase()}`, status: 'FAIL', message: `${name} must use https:// in production` }
    }
    return { id: `url.${name.toLowerCase()}`, status: 'PASS', message: `${name}=${parsed.origin}` }
  } catch {
    return { id: `url.${name.toLowerCase()}`, status: 'FAIL', message: `${name} is not a valid URL` }
  }
}

function exactCheck(id, label, actual, expected) {
  const normalized = (actual ?? '').trim().toLowerCase()
  const wanted = expected.toLowerCase()
  return normalized === wanted
    ? { id, status: 'PASS', message: `${label}=${actual}` }
    : { id, status: 'FAIL', message: `${label} must be ${expected}; got ${nonEmpty(actual) ? actual : '<unset>'}` }
}

function explicitBoolCheck(id, label, actual, expected) {
  const parsed = boolToken(actual)
  if (parsed === null) return { id, status: 'FAIL', message: `${label} must be an explicit boolean token; got ${actual}` }
  if (parsed === undefined) return { id, status: 'FAIL', message: `${label} must be explicitly set to ${expected}` }
  return parsed === expected
    ? { id, status: 'PASS', message: `${label}=${actual}` }
    : { id, status: 'FAIL', message: `${label} must be ${expected}; got ${actual}` }
}

function requiredSecretCheck(name, env) {
  return nonEmpty(env[name])
    ? { id: `env.${name.toLowerCase()}`, status: 'PASS', message: `${name} is set` }
    : { id: `env.${name.toLowerCase()}`, status: 'FAIL', message: `${name} is required for the controlled production pilot` }
}

export function evaluatePilotPolicy(env = process.env) {
  const checks = []

  checks.push(exactCheck('policy.node_env', 'NODE_ENV', env.NODE_ENV, 'production'))
  checks.push(explicitBoolCheck('policy.safe_launch', 'SAFE_LAUNCH_MODE', env.SAFE_LAUNCH_MODE, true))
  checks.push(exactCheck('policy.tenant_guard', 'TENANT_GUARD_MODE', env.TENANT_GUARD_MODE, 'enforce'))
  checks.push(exactCheck('policy.reputation_guard', 'REPUTATION_GUARD_MODE', env.REPUTATION_GUARD_MODE, 'enforce'))
  checks.push(explicitBoolCheck('policy.followups', 'FOLLOWUPS_ENABLED', env.FOLLOWUPS_ENABLED, false))

  const compliance = boolToken(env.COMPLIANCE_GATE_ENABLED)
  checks.push(
    compliance === undefined
      ? { id: 'policy.compliance_gate', status: 'FAIL', message: 'COMPLIANCE_GATE_ENABLED must be explicitly set to true or false so the legal/compliance posture is deliberate' }
      : compliance === null
        ? { id: 'policy.compliance_gate', status: 'FAIL', message: `COMPLIANCE_GATE_ENABLED has invalid boolean value: ${env.COMPLIANCE_GATE_ENABLED}` }
        : { id: 'policy.compliance_gate', status: 'PASS', message: `COMPLIANCE_GATE_ENABLED=${env.COMPLIANCE_GATE_ENABLED} (explicit ${compliance ? 'enabled' : 'disabled'} posture)` },
  )

  for (const key of [
    'DATABASE_URL',
    'REDIS_URL',
    'JWT_SECRET',
    'EMAIL_ENCRYPTION_KEY',
    'OPENAI_API_KEY',
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'STRIPE_PRICE_STARTER',
    'STRIPE_PRICE_GROWTH',
    'METRICS_TOKEN',
  ]) checks.push(requiredSecretCheck(key, env))

  checks.push(urlCheck('API_URL', env.API_URL))
  checks.push(urlCheck('WEB_URL', env.WEB_URL))
  for (const key of ['SMOKE_API_URL', 'SMOKE_WORKER_URL', 'SMOKE_WEB_URL']) {
    if (nonEmpty(env[key])) checks.push(urlCheck(key, env[key], { required: false, https: true }))
  }

  if (nonEmpty(env.ALLOWED_ORIGINS)) {
    const origins = env.ALLOWED_ORIGINS.split(',').map((v) => v.trim()).filter(Boolean)
    const bad = origins.filter((origin) => {
      try { return new URL(origin).protocol !== 'https:' } catch { return true }
    })
    checks.push(bad.length === 0
      ? { id: 'url.allowed_origins', status: 'PASS', message: `ALLOWED_ORIGINS contains ${origins.length} HTTPS origin(s)` }
      : { id: 'url.allowed_origins', status: 'FAIL', message: `ALLOWED_ORIGINS must contain only valid HTTPS origins; invalid: ${bad.join(', ')}` })
  } else {
    checks.push({ id: 'url.allowed_origins', status: 'WARN', message: 'ALLOWED_ORIGINS is unset; WEB_URL will be the sole CORS fallback' })
  }

  const release = resolveReleaseIdentity(env)
  checks.push(release.commit && release.commit !== 'unknown'
    ? { id: 'release.commit', status: 'PASS', message: `release commit=${release.commit}` }
    : { id: 'release.commit', status: 'FAIL', message: 'release commit identity is unavailable; set ACAOS_RELEASE_SHA/GITHUB_SHA/RAILWAY_GIT_COMMIT_SHA or run from a Git checkout' })
  checks.push(nonEmpty(release.releaseId)
    ? { id: 'release.id', status: 'PASS', message: `releaseId=${release.releaseId}` }
    : { id: 'release.id', status: 'FAIL', message: 'ACAOS release identity is unavailable' })

  if (env.RATE_LIMIT_DISABLED === 'true') {
    checks.push({ id: 'policy.rate_limit', status: 'FAIL', message: 'RATE_LIMIT_DISABLED=true is forbidden in production' })
  } else {
    checks.push({ id: 'policy.rate_limit', status: 'PASS', message: 'rate limiting is not explicitly disabled' })
  }

  if (env.COOKIE_SECURE === 'false') {
    checks.push({ id: 'policy.cookie_secure', status: 'FAIL', message: 'COOKIE_SECURE=false is forbidden in production' })
  } else {
    checks.push({ id: 'policy.cookie_secure', status: 'PASS', message: 'secure-cookie policy is not explicitly disabled' })
  }

  const failCount = checks.filter((c) => c.status === 'FAIL').length
  const warnCount = checks.filter((c) => c.status === 'WARN').length
  const passCount = checks.filter((c) => c.status === 'PASS').length

  return {
    schemaVersion: 1,
    kind: 'acaos-pilot-preflight-policy',
    generatedAt: new Date().toISOString(),
    safe: failCount === 0,
    summary: { pass: passCount, warn: warnCount, fail: failCount },
    release,
    explicitPolicy: {
      nodeEnv: env.NODE_ENV ?? null,
      safeLaunchMode: boolToken(env.SAFE_LAUNCH_MODE),
      tenantGuardMode: env.TENANT_GUARD_MODE ?? null,
      reputationGuardMode: env.REPUTATION_GUARD_MODE ?? null,
      followupsEnabled: boolToken(env.FOLLOWUPS_ENABLED),
      complianceGateEnabled: compliance === undefined || compliance === null ? null : compliance,
    },
    checks,
  }
}

export function renderMarkdown(report) {
  const lines = [
    '# ACAOS Pilot Preflight Policy Report',
    '',
    `- Generated: ${report.generatedAt}`,
    `- Overall: **${report.safe ? 'PASS' : 'FAIL'}**`,
    `- Release ID: ${report.release.releaseId ?? 'unavailable'}`,
    `- Commit: ${report.release.commit ?? 'unavailable'}`,
    `- Checks: ${report.summary.pass} PASS / ${report.summary.warn} WARN / ${report.summary.fail} FAIL`,
    '',
    '| Status | Check | Detail |',
    '| --- | --- | --- |',
    ...report.checks.map((check) => `| ${check.status} | \`${check.id}\` | ${check.message.replaceAll('|', '\\|')} |`),
    '',
  ]
  return `${lines.join('\n')}\n`
}

export function writeReport(report, outDir) {
  fs.mkdirSync(outDir, { recursive: true })
  const jsonPath = path.join(outDir, 'release-preflight.json')
  const mdPath = path.join(outDir, 'release-preflight.md')
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`)
  fs.writeFileSync(mdPath, renderMarkdown(report))
  return { jsonPath, mdPath }
}

function parseArgs(argv) {
  const out = { outDir: path.join(root, 'dist-pack', 'preflight') }
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--out-dir') out.outDir = path.resolve(root, argv[++i])
    else if (argv[i] === '--json') out.jsonOnly = true
    else throw new Error(`Unknown argument: ${argv[i]}`)
  }
  return out
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let args
  try { args = parseArgs(process.argv) } catch (error) {
    console.error(`[preflight] ${error instanceof Error ? error.message : String(error)}`)
    process.exit(2)
  }
  const report = evaluatePilotPolicy(process.env)
  const files = writeReport(report, args.outDir)
  if (args.jsonOnly) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } else {
    console.log(`ACAOS controlled-pilot policy preflight: ${report.safe ? 'PASS' : 'FAIL'}`)
    for (const check of report.checks) console.log(`[${check.status}] ${check.id}: ${check.message}`)
    console.log(`Artifacts: ${files.jsonPath}, ${files.mdPath}`)
  }
  process.exit(report.safe ? 0 : 1)
}
