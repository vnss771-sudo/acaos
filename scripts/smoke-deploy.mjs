#!/usr/bin/env node
import process from 'node:process'

function readArg(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

async function fetchJson(url) {
  const res = await fetch(url)
  const text = await res.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = { raw: text }
  }
  return { status: res.status, headers: res.headers, body }
}

function fail(message) {
  console.error(message)
  process.exit(1)
}

const apiUrl = readArg('--api-url') ?? process.env.SMOKE_API_URL
const workerUrl = readArg('--worker-url') ?? process.env.SMOKE_WORKER_URL
const expectVersion = readArg('--expect-version') ?? process.env.EXPECT_VERSION
const expectCommit = readArg('--expect-commit') ?? process.env.EXPECT_COMMIT

if (!apiUrl && !workerUrl) fail('Provide --api-url and/or --worker-url (or SMOKE_API_URL / SMOKE_WORKER_URL).')

const targets = []
if (apiUrl) targets.push({ name: 'api', url: apiUrl.replace(/\/$/, '') + '/api/ready' })
if (workerUrl) targets.push({ name: 'worker', url: workerUrl.replace(/\/$/, '') + '/ready' })

const results = []
for (const target of targets) {
  const result = await fetchJson(target.url)
  if (result.status !== 200 || result.body?.ok !== true) {
    fail(`[smoke] ${target.name} readiness failed: ${target.url} -> status=${result.status} body=${JSON.stringify(result.body)}`)
  }
  const headerReleaseId = result.headers.get('x-acaos-release-id')
  if (!headerReleaseId) fail(`[smoke] ${target.name} did not return X-Acaos-Release-Id.`)
  if (expectVersion && result.body?.version !== expectVersion) {
    fail(`[smoke] ${target.name} version drift: expected ${expectVersion}, got ${result.body?.version ?? 'missing'}`)
  }
  if (expectCommit && result.body?.commit !== expectCommit) {
    fail(`[smoke] ${target.name} commit drift: expected ${expectCommit}, got ${result.body?.commit ?? 'missing'}`)
  }
  results.push({ target: target.name, releaseId: headerReleaseId, version: result.body?.version, commit: result.body?.commit })
}

if (results.length > 1) {
  const releaseIds = new Set(results.map((result) => result.releaseId))
  if (releaseIds.size > 1) {
    fail(`[smoke] release drift detected across targets: ${JSON.stringify(results)}`)
  }
}

console.log(`[smoke] ok ${JSON.stringify(results)}`)
