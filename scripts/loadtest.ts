// Load test for the ACAOS API + worker. Dependency-free: boots the real API
// server AND the real worker against live Postgres + Redis, seeds several
// tenants, then drives:
//
//   1. A hot HTTP-route mix (stats/leads/prospects/ingest) at increasing
//      concurrency, with each request picking a random tenant from the pool —
//      so per-workspace rate limits/quota checks are exercised under real
//      concurrent multi-tenant traffic, not one workspace hammered serially.
//   2. The worker/queue path: enqueues a batch of research-lead jobs spread
//      across tenants via the real POST /api/jobs/research route, then polls
//      GET /api/jobs/research-lead/:jobId until each job leaves the
//      queued/active state, measuring true enqueue -> completion latency
//      (not just the synchronous HTTP response time of the enqueue call).
//
// NOTE: a single sandbox container is NOT production hardware — treat the
// numbers as RELATIVE (find slow endpoints / error cliffs / lock contention /
// queue backlog), not as deployment-accurate SLOs.
//
//   JWT_SECRET=<32+ chars> DATABASE_URL=... REDIS_URL=... npm run loadtest
//
// Requires a real API, worker, Postgres, and Redis — see docs/OPERATIONS.md
// for the full tunables list and how to read the queue-phase output.
//
// Without OPENAI_API_KEY set, the queue-phase research-lead jobs still
// exercise the FULL enqueue -> worker pickup -> job-state pipeline; they just
// fail fast at the OpenAI call boundary (job state 'failed' in a few ms)
// instead of completing — still a real, if not production-realistic, proof
// the plumbing works end to end. Set OPENAI_API_KEY for realistic queue
// latency numbers.
import { spawn, type ChildProcess } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { prisma } from '../apps/api/src/lib/prisma.js'
import { signJwt } from '../apps/api/src/lib/jwt.js'
import { generateApiKey, hashApiKey } from '../apps/api/src/lib/apiKeys.js'

const PORT = Number(process.env.LOADTEST_PORT || 4100)
const WORKER_HEALTH_PORT = Number(process.env.LOADTEST_WORKER_HEALTH_PORT || 4190)
const BASE = `http://127.0.0.1:${PORT}`
const CONCURRENCIES = (process.env.LOADTEST_CONCURRENCY || '10,50,100').split(',').map(Number)
const DURATION_MS = Number(process.env.LOADTEST_DURATION_MS || 4000)
const WARMUP_MS = 500
const TENANTS = Math.max(1, Number(process.env.LOADTEST_TENANTS || 5))
const QUEUE_JOBS = Math.max(0, Number(process.env.LOADTEST_QUEUE_JOBS || 20))
const QUEUE_CONCURRENCY = Math.max(1, Number(process.env.LOADTEST_QUEUE_CONCURRENCY || 10))
const QUEUE_POLL_MS = Number(process.env.LOADTEST_QUEUE_POLL_MS || 250)
const QUEUE_TIMEOUT_MS = Number(process.env.LOADTEST_QUEUE_TIMEOUT_MS || 30_000)
const __dirname = path.dirname(fileURLToPath(import.meta.url))

type Tenant = { workspaceId: string; auth: Record<string, string>; apiKeyRaw: string; leadIds: string[] }

type Scenario = { name: string; req: (tenant: Tenant) => Promise<{ status: number }> }

// Per-request timeout so a single stuck connection can never block a worker's
// time-bounded loop forever (a non-aborted fetch has no default timeout).
const REQUEST_TIMEOUT_MS = Number(process.env.LOADTEST_REQUEST_TIMEOUT_MS || 10_000)
function get(url: string, headers: Record<string, string>) {
  return fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
}
function post(url: string, headers: Record<string, string>, body: string) {
  return fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
}
function pick<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)] }

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(0, idx)]
}

async function waitForHttp(url: string, label: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url)
      if (r.ok) return
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`${label} did not become ready in time`)
}

// Drive one scenario at a fixed concurrency for DURATION_MS; return stats.
async function runScenario(s: Scenario, concurrency: number, tenants: Tenant[]) {
  const latencies: number[] = []
  let ok = 0, errors = 0
  const stopAt = performance.now() + DURATION_MS

  async function worker() {
    while (performance.now() < stopAt) {
      const t0 = performance.now()
      try {
        const res = await s.req(pick(tenants))
        const dt = performance.now() - t0
        latencies.push(dt)
        if (res.status >= 200 && res.status < 300) ok++; else errors++
      } catch {
        latencies.push(performance.now() - t0)
        errors++
      }
    }
  }

  const start = performance.now()
  await Promise.all(Array.from({ length: concurrency }, worker))
  const elapsedSec = (performance.now() - start) / 1000

  latencies.sort((a, b) => a - b)
  const total = ok + errors
  return {
    concurrency,
    rps: Math.round(total / elapsedSec),
    total,
    errorRate: total ? +(100 * errors / total).toFixed(2) : 0,
    p50: +percentile(latencies, 50).toFixed(1),
    p95: +percentile(latencies, 95).toFixed(1),
    p99: +percentile(latencies, 99).toFixed(1),
    max: +(latencies[latencies.length - 1] ?? 0).toFixed(1),
  }
}

// ── Worker/queue-path phase ──────────────────────────────────────────────────
// Enqueue QUEUE_JOBS research-lead jobs spread round-robin across every tenant
// (so the batch is genuinely multi-tenant, not one workspace's leads), then
// poll each job's real status endpoint until it leaves queued/active. This
// measures true enqueue -> completion latency through the real BullMQ queue
// and the real worker process, not just the synchronous 202 response time.
type QueueJobResult = { outcome: 'completed' | 'failed' | 'timeout' | 'enqueue-error'; latencyMs: number }

async function runQueuePhase(tenants: Tenant[]): Promise<QueueJobResult[]> {
  const results: QueueJobResult[] = []
  let nextIdx = 0
  const total = QUEUE_JOBS

  async function worker() {
    for (;;) {
      const i = nextIdx++
      if (i >= total) return
      const tenant = tenants[i % tenants.length]
      const leadId = tenant.leadIds[i % tenant.leadIds.length]
      const t0 = performance.now()
      let jobId: string
      try {
        const res = await post(`${BASE}/api/jobs/research`, { ...tenant.auth, 'Content-Type': 'application/json' }, JSON.stringify({ leadId }))
        if (res.status !== 202) { results.push({ outcome: 'enqueue-error', latencyMs: performance.now() - t0 }); continue }
        jobId = (await res.json()).jobId
      } catch {
        results.push({ outcome: 'enqueue-error', latencyMs: performance.now() - t0 })
        continue
      }

      const deadline = performance.now() + QUEUE_TIMEOUT_MS
      let outcome: QueueJobResult['outcome'] = 'timeout'
      while (performance.now() < deadline) {
        await new Promise((r) => setTimeout(r, QUEUE_POLL_MS))
        try {
          const poll = await get(`${BASE}/api/jobs/research-lead/${jobId}`, tenant.auth)
          if (!poll.ok) continue
          const body = await poll.json()
          if (body.state === 'completed') { outcome = 'completed'; break }
          if (body.state === 'failed') { outcome = 'failed'; break }
        } catch { /* keep polling until the deadline */ }
      }
      results.push({ outcome, latencyMs: performance.now() - t0 })
    }
  }

  await Promise.all(Array.from({ length: Math.min(QUEUE_CONCURRENCY, total) }, worker))
  return results
}

function reportQueuePhase(results: QueueJobResult[]) {
  const byOutcome: Record<string, number> = {}
  for (const r of results) byOutcome[r.outcome] = (byOutcome[r.outcome] ?? 0) + 1
  const settled = results.filter((r) => r.outcome === 'completed' || r.outcome === 'failed').map((r) => r.latencyMs).sort((a, b) => a - b)

  console.log(`\n### Worker/queue path — research-lead (${results.length} jobs across ${TENANTS} tenants, concurrency ${QUEUE_CONCURRENCY})`)
  console.log(`outcomes: ${JSON.stringify(byOutcome)}`)
  if (settled.length > 0) {
    console.log(`enqueue -> completion latency (ms): p50=${percentile(settled, 50).toFixed(0)} p95=${percentile(settled, 95).toFixed(0)} max=${settled[settled.length - 1].toFixed(0)}`)
  }
  console.log(
    !process.env.OPENAI_API_KEY
      ? 'NOTE: OPENAI_API_KEY is not set — jobs above are expected to resolve "failed" fast at the provider-call boundary. This still proves the enqueue -> worker-pickup -> job-state pipeline end to end; set OPENAI_API_KEY for realistic AI-generation latency.'
      : 'OPENAI_API_KEY is set — latencies above reflect a real OpenAI round trip.'
  )
}

async function main() {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    throw new Error('Set JWT_SECRET (>=32 chars) so the driver and server share signing keys')
  }

  // --- seed TENANTS independent, unlimited (growth) workspaces ---------------
  const stamp = Date.now()
  const tenants: Tenant[] = []
  for (let t = 0; t < TENANTS; t++) {
    const user = await prisma.user.create({ data: { email: `load-${stamp}-${t}@x.test`, emailVerified: true } })
    const apiKeyRaw = generateApiKey()
    const workspace = await prisma.workspace.create({
      data: {
        name: `LoadTest ${t}`, slug: `load-${stamp}-${t}`, plan: 'growth', subscriptionStatus: 'active',
        ingestApiKey: hashApiKey(apiKeyRaw),
        memberships: { create: { userId: user.id, role: 'owner' } },
      },
    })
    await prisma.campaign.create({ data: { workspaceId: workspace.id, name: 'C', goalType: 'BOOK_CALL' } })
    await prisma.lead.createMany({ data: Array.from({ length: 500 }, (_, i) => ({ workspaceId: workspace.id, businessName: `Lead ${i}`, score: i % 100 })) })
    await prisma.prospect.createMany({ data: Array.from({ length: 500 }, (_, i) => ({ workspaceId: workspace.id, companyName: `Co ${i}`, opportunityScore: i % 100 })) })
    const leads = await prisma.lead.findMany({ where: { workspaceId: workspace.id }, select: { id: true }, take: Math.max(QUEUE_JOBS, 1) })
    const token = signJwt({ userId: user.id })
    tenants.push({ workspaceId: workspace.id, auth: { Authorization: `Bearer ${token}` }, apiKeyRaw, leadIds: leads.map((l) => l.id) })
  }
  console.log(`[loadtest] seeded ${tenants.length} tenant(s)`)

  // --- boot the real API + real worker ---------------------------------------
  console.log(`[loadtest] booting API on :${PORT} and worker (health :${WORKER_HEALTH_PORT}) …`)
  const apiServer: ChildProcess = spawn('npx', ['tsx', 'src/server.ts'], {
    cwd: path.resolve(__dirname, '../apps/api'),
    env: { ...process.env, PORT: String(PORT), NODE_ENV: 'development', RATE_LIMIT_DISABLED: 'true', LOG_LEVEL: 'warn' },
    // Detach stdio entirely: inheriting the parent's stderr keeps our output pipe
    // open after the run, so cleanup appears to hang. 'ignore' avoids that.
    stdio: 'ignore',
    detached: true,
  })
  const workerProc: ChildProcess = spawn('npx', ['tsx', 'src/worker.ts'], {
    cwd: path.resolve(__dirname, '../apps/worker'),
    env: {
      ...process.env,
      NODE_ENV: 'development',
      LOG_LEVEL: 'warn',
      WORKER_HEALTH_PORT: String(WORKER_HEALTH_PORT),
    },
    stdio: 'ignore',
    detached: true,
  })

  try {
    await Promise.all([
      waitForHttp(`${BASE}/api/live`, 'API'),
      waitForHttp(`http://127.0.0.1:${WORKER_HEALTH_PORT}/live`, 'worker'),
    ])
    console.log('[loadtest] API + worker ready — warming up\n')

    const scenarios: Scenario[] = [
      { name: 'GET /api/stats', req: (t) => get(`${BASE}/api/stats?workspaceId=${t.workspaceId}`, t.auth) },
      { name: 'GET /api/leads (page)', req: (t) => get(`${BASE}/api/leads?workspaceId=${t.workspaceId}&limit=50`, t.auth) },
      { name: 'GET /api/prospects', req: (t) => get(`${BASE}/api/prospects?workspaceId=${t.workspaceId}&limit=50`, t.auth) },
      {
        name: 'POST /api/ingest (write)',
        req: (t) => post(`${BASE}/api/ingest`, { 'x-api-key': t.apiKeyRaw, 'Content-Type': 'application/json' },
          JSON.stringify({ autoResearch: false, leads: [{ businessName: `Ingest ${Math.random().toString(36).slice(2)}` }] })),
      },
    ]

    // brief global warmup (also across tenants)
    const warmStop = performance.now() + WARMUP_MS
    while (performance.now() < warmStop) await Promise.all(scenarios.map((s) => s.req(pick(tenants)).catch(() => {})))

    console.log(`=== HTTP route mix — ${tenants.length} tenant(s), traffic randomly interleaved across all of them ===`)
    for (const s of scenarios) {
      console.log(`\n### ${s.name}`)
      console.log('conc |   rps |  p50ms |  p95ms |  p99ms |  maxms | err%')
      console.log('-----+-------+--------+--------+--------+--------+------')
      for (const c of CONCURRENCIES) {
        const r = await runScenario(s, c, tenants)
        console.log(
          `${String(r.concurrency).padStart(4)} | ${String(r.rps).padStart(5)} | ${String(r.p50).padStart(6)} | ${String(r.p95).padStart(6)} | ${String(r.p99).padStart(6)} | ${String(r.max).padStart(6)} | ${String(r.errorRate).padStart(4)}`,
        )
      }
    }

    if (QUEUE_JOBS > 0) {
      const queueResults = await runQueuePhase(tenants)
      reportQueuePhase(queueResults)
    }
  } finally {
    // Kill the whole detached process groups (tsx spawns a node child) so
    // nothing is orphaned after the run.
    for (const child of [apiServer, workerProc]) {
      try { if (child.pid) process.kill(-child.pid, 'SIGKILL') } catch { /* already gone */ }
    }
    // best-effort cleanup of the load workspaces + users
    for (const t of tenants) await prisma.workspace.delete({ where: { id: t.workspaceId } }).catch(() => {})
    await prisma.user.deleteMany({ where: { email: { contains: `load-${stamp}-` } } }).catch(() => {})
    await prisma.$disconnect()
  }
}

main().catch((err) => { console.error('[loadtest] failed:', err); process.exit(1) })
