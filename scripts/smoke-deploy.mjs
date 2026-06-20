#!/usr/bin/env node
import fs from 'node:fs'
import process from 'node:process'

function readArg(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function firstDefined(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return undefined
}

function parseTimeout(raw) {
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) {
    fail(`Invalid timeout: ${raw}`)
  }
  return value
}

function fail(message) {
  console.error(message)
  process.exit(1)
}

function readManifest(manifestPath) {
  if (!manifestPath) return undefined
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    fail(`[smoke] failed to read manifest ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function fetchText(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? 10000
  const headers = new Headers(options.headers ?? {})
  let signal
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    signal = AbortSignal.timeout(timeoutMs)
  }
  const response = await fetch(url, {
    headers,
    signal,
  })
  const text = await response.text()
  return { response, text }
}

async function fetchJson(url, options = {}) {
  const { response, text } = await fetchText(url, options)
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = { raw: text }
  }
  return { status: response.status, headers: response.headers, body }
}

function jsonOf(value) {
  return JSON.stringify(value)
}

const manifestPath = firstDefined(
  readArg('--manifest'),
  process.env.SMOKE_MANIFEST,
  process.env.DEPLOY_RELEASE_MANIFEST,
)
const manifest = readManifest(manifestPath)

const apiUrl = firstDefined(
  readArg('--api-url'),
  process.env.SMOKE_API_URL,
  process.env.DEPLOY_API_URL,
)
const workerUrl = firstDefined(
  readArg('--worker-url'),
  process.env.SMOKE_WORKER_URL,
  process.env.DEPLOY_WORKER_URL,
)
const webUrl = firstDefined(
  readArg('--web-url'),
  process.env.SMOKE_WEB_URL,
  process.env.DEPLOY_WEB_URL,
)
const expectVersion = firstDefined(
  readArg('--expect-version'),
  process.env.EXPECT_VERSION,
  process.env.DEPLOY_EXPECT_VERSION,
  manifest?.version,
)
const expectCommit = firstDefined(
  readArg('--expect-commit'),
  process.env.EXPECT_COMMIT,
  process.env.DEPLOY_EXPECT_COMMIT,
  manifest?.commit,
)
const expectReleaseId = firstDefined(
  readArg('--expect-release-id'),
  process.env.EXPECT_RELEASE_ID,
  process.env.DEPLOY_EXPECT_RELEASE_ID,
  manifest?.releaseId,
)
const metricsToken = firstDefined(
  readArg('--metrics-token'),
  process.env.METRICS_TOKEN,
  process.env.DEPLOY_METRICS_TOKEN,
)
const timeoutMs = parseTimeout(firstDefined(
  readArg('--timeout-ms'),
  process.env.SMOKE_TIMEOUT_MS,
  process.env.DEPLOY_SMOKE_TIMEOUT_MS,
  '10000',
))

if (!apiUrl && !workerUrl && !webUrl) {
  fail('Provide --api-url and/or --worker-url and/or --web-url (or SMOKE_* / DEPLOY_* env vars).')
}

const targets = []
if (apiUrl) {
  const baseUrl = apiUrl.replace(/\/$/, '')
  targets.push({ name: 'api', readyUrl: `${baseUrl}/api/ready`, metricsUrl: `${baseUrl}/metrics` })
}
if (workerUrl) {
  const baseUrl = workerUrl.replace(/\/$/, '')
  targets.push({ name: 'worker', readyUrl: `${baseUrl}/ready`, metricsUrl: `${baseUrl}/metrics` })
}

const results = []
for (const target of targets) {
  const result = await fetchJson(target.readyUrl, { timeoutMs })
  if (result.status !== 200 || result.body?.ok !== true) {
    fail(`[smoke] ${target.name} readiness failed: ${target.readyUrl} -> status=${result.status} body=${jsonOf(result.body)}`)
  }
  const headerReleaseId = result.headers.get('x-acaos-release-id')
  if (!headerReleaseId) {
    fail(`[smoke] ${target.name} did not return X-Acaos-Release-Id.`)
  }
  const bodyReleaseId = typeof result.body?.releaseId === 'string' ? result.body.releaseId : undefined
  if (bodyReleaseId && bodyReleaseId !== headerReleaseId) {
    fail(`[smoke] ${target.name} releaseId mismatch between header/body: header=${headerReleaseId} body=${bodyReleaseId}`)
  }
  if (expectVersion && result.body?.version !== expectVersion) {
    fail(`[smoke] ${target.name} version drift: expected ${expectVersion}, got ${result.body?.version ?? 'missing'}`)
  }
  if (expectCommit && result.body?.commit !== expectCommit) {
    fail(`[smoke] ${target.name} commit drift: expected ${expectCommit}, got ${result.body?.commit ?? 'missing'}`)
  }
  if (expectReleaseId && headerReleaseId !== expectReleaseId) {
    fail(`[smoke] ${target.name} releaseId drift: expected ${expectReleaseId}, got ${headerReleaseId}`)
  }

  const summary = {
    target: target.name,
    releaseId: headerReleaseId,
    version: result.body?.version,
    commit: result.body?.commit,
    metricsChecked: false,
  }

  if (metricsToken) {
    const metrics = await fetchText(target.metricsUrl, {
      timeoutMs,
      headers: { Authorization: `Bearer ${metricsToken}` },
    })
    if (metrics.response.status !== 200) {
      fail(`[smoke] ${target.name} metrics failed: ${target.metricsUrl} -> status=${metrics.response.status}`)
    }
    if (!metrics.text.includes('acaos_build_info')) {
      fail(`[smoke] ${target.name} metrics missing acaos_build_info.`)
    }
    summary.metricsChecked = true
  }

  results.push(summary)
}

if (results.length > 1) {
  const releaseIds = new Set(results.map((result) => result.releaseId))
  if (releaseIds.size > 1) {
    fail(`[smoke] release drift detected across targets: ${jsonOf(results)}`)
  }
}

if (webUrl) {
  const { response } = await fetchText(webUrl, { timeoutMs })
  if (response.status < 200 || response.status >= 400) {
    fail(`[smoke] web probe failed: ${webUrl} -> status=${response.status}`)
  }
}

console.log(`[smoke] ok ${jsonOf({ results, webChecked: Boolean(webUrl), manifest: manifestPath ?? null })}`)
