#!/usr/bin/env node
// Canary/blue-green bake-and-gate for a freshly-deployed ACAOS API instance.
//
// Platform-agnostic by design: this repo has no single deploy target baked
// into CI (docs/DEPLOYMENT.md describes a generic "build the images, run them
// on your platform" flow — Railway, Fly, k8s, ECS, or a bare box are all in
// scope, and none is committed to in this repo). Rather than build a
// bespoke control loop for one platform's canary/traffic-shifting mechanism,
// this script implements the one piece that's genuinely platform-agnostic
// and was missing: a real health/burn-rate GATE that works against any
// canary slot/instance a platform can stand up, using only the two endpoints
// every ACAOS API instance already exposes (per docs/DEPLOYMENT.md):
// `/api/ready` and `/metrics`.
//
// A deploy pipeline wires this in as: deploy the new image to a canary
// slot/instance -> run this gate against its URL -> only flip traffic
// (whatever "promote" means on your platform: a Railway/Fly domain swap, a
// k8s Service selector flip, an ALB target-group swap, ...) on exit 0;
// on a non-zero exit, do not promote and redeploy the previous known-good
// tag (docs/DEPLOYMENT.md's existing manual rollback step, automated).
//
// The failure threshold reuses the SAME fast-burn multiplier
// ops/monitoring/alerts.yml's ApiSuccessBudgetBurn alert uses against the
// 99.5% (0.5% error budget) API-success SLO in docs/SLO.md: 14.4x the 0.5%
// budget = 7.2% instantaneous 5xx rate. Reusing that number (rather than
// inventing a new one) keeps "the canary looks unhealthy" consistent with
// what would already page an operator in steady-state production.
//
// Usage:
//   CANARY_URL=https://canary.example.com node scripts/rollout-gate.mjs
//
// Env:
//   CANARY_URL              required — base URL of the freshly-deployed canary
//   BAKE_SECONDS            default 120  — how long to observe before deciding
//   POLL_INTERVAL_SECONDS   default 10   — /api/ready probe cadence during the bake
//   ERROR_RATE_THRESHOLD    default 0.072 (14.4 * 0.005 — see above)
//   MIN_SAMPLE_REQUESTS     default 20   — below this many requests observed
//                           during the bake, the error-rate sample is too small
//                           to trust; the gate then passes on readiness alone
//                           rather than failing on statistical noise from a
//                           quiet canary.
import { setTimeout as sleep } from 'node:timers/promises'

const CANARY_URL = (process.env.CANARY_URL || '').replace(/\/$/, '')
const BAKE_SECONDS = Number(process.env.BAKE_SECONDS || 120)
const POLL_INTERVAL_SECONDS = Number(process.env.POLL_INTERVAL_SECONDS || 10)
const ERROR_RATE_THRESHOLD = Number(process.env.ERROR_RATE_THRESHOLD || 14.4 * 0.005)
const MIN_SAMPLE_REQUESTS = Number(process.env.MIN_SAMPLE_REQUESTS || 20)
const FETCH_TIMEOUT_MS = 10_000

if (!CANARY_URL) {
  console.error('✗ CANARY_URL is required (base URL of the freshly-deployed canary instance).')
  process.exit(1)
}

async function fetchText(urlPath) {
  const res = await fetch(`${CANARY_URL}${urlPath}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  return { ok: res.ok, status: res.status, text: await res.text() }
}

// Parse Prometheus text exposition for http_requests_total, summed by whether
// the status label is a 5xx. Tolerant of label ordering/extra labels — only
// requires the exact metric name and a status="5xx" label somewhere in {}.
function sumHttpRequests(metricsText) {
  let total = 0
  let serverErrors = 0
  for (const line of metricsText.split('\n')) {
    const m = line.match(/^http_requests_total\{([^}]*)\}\s+([0-9.eE+-]+)\s*$/)
    if (!m) continue
    const value = Number(m[2])
    if (!Number.isFinite(value)) continue
    total += value
    if (/status="5\d\d"/.test(m[1])) serverErrors += value
  }
  return { total, serverErrors }
}

async function main() {
  console.log(`[rollout-gate] baking ${CANARY_URL} for ${BAKE_SECONDS}s (readiness probe every ${POLL_INTERVAL_SECONDS}s)…`)

  const startMetrics = await fetchText('/metrics').catch(() => null)
  const startCounts = startMetrics?.ok ? sumHttpRequests(startMetrics.text) : { total: 0, serverErrors: 0 }
  if (!startMetrics?.ok) console.warn('[rollout-gate] could not read /metrics before the bake — burn-rate check will be skipped if this persists.')

  const deadline = Date.now() + BAKE_SECONDS * 1000
  let readyChecks = 0
  let readyFailures = 0
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_SECONDS * 1000)
    readyChecks++
    try {
      const ready = await fetchText('/api/ready')
      if (!ready.ok) {
        readyFailures++
        console.warn(`[rollout-gate] /api/ready returned ${ready.status} at ${new Date().toISOString()}`)
      }
    } catch (err) {
      readyFailures++
      console.warn(`[rollout-gate] /api/ready unreachable: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const endMetrics = await fetchText('/metrics').catch(() => null)
  const endCounts = endMetrics?.ok ? sumHttpRequests(endMetrics.text) : startCounts

  const deltaTotal = Math.max(0, endCounts.total - startCounts.total)
  const deltaErrors = Math.max(0, endCounts.serverErrors - startCounts.serverErrors)
  const errorRate = deltaTotal > 0 ? deltaErrors / deltaTotal : 0

  console.log(`[rollout-gate] readiness: ${readyChecks - readyFailures}/${readyChecks} ok`)
  console.log(`[rollout-gate] requests observed during bake: ${deltaTotal} (${deltaErrors} 5xx, ${(errorRate * 100).toFixed(2)}%)`)

  const failures = []
  if (readyChecks > 0 && readyFailures === readyChecks) {
    failures.push(`/api/ready failed every check (${readyFailures}/${readyChecks}) during the bake`)
  } else if (readyFailures > 0) {
    failures.push(`/api/ready failed ${readyFailures}/${readyChecks} times during the bake`)
  }
  if (deltaTotal >= MIN_SAMPLE_REQUESTS && errorRate > ERROR_RATE_THRESHOLD) {
    failures.push(`5xx burn rate ${(errorRate * 100).toFixed(2)}% exceeds the ${(ERROR_RATE_THRESHOLD * 100).toFixed(2)}% fast-burn threshold`)
  }

  if (failures.length) {
    console.error('✗ Canary failed its bake — DO NOT promote:')
    for (const f of failures) console.error(`    ${f}`)
    process.exit(1)
  }
  console.log('✓ Canary is healthy — safe to promote.')
}

main().catch((err) => { console.error('[rollout-gate] failed:', err); process.exit(1) })
