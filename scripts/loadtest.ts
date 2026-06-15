// Focused smoke load test for the ACAOS API. Dependency-free: boots the real
// server against live Postgres + Redis, then drives a handful of hot endpoints
// with Node's built-in fetch at increasing concurrency, reporting RPS + latency
// percentiles + error rate so we can spot the knee in the curve.
//
// NOTE: a single sandbox container is NOT production hardware — treat the numbers
// as RELATIVE (find slow endpoints / error cliffs / lock contention), not as
// deployment-accurate SLOs.
//
//   JWT_SECRET=<32+ chars> DATABASE_URL=... REDIS_URL=... tsx scripts/loadtest.ts
//
import { spawn, type ChildProcess } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { prisma } from '../apps/api/src/lib/prisma.js'
import { signJwt } from '../apps/api/src/lib/jwt.js'
import { generateApiKey, hashApiKey } from '../apps/api/src/lib/apiKeys.js'

const PORT = Number(process.env.LOADTEST_PORT || 4100)
const BASE = `http://127.0.0.1:${PORT}`
const CONCURRENCIES = (process.env.LOADTEST_CONCURRENCY || '10,50,100').split(',').map(Number)
const DURATION_MS = Number(process.env.LOADTEST_DURATION_MS || 4000)
const WARMUP_MS = 500
const __dirname = path.dirname(fileURLToPath(import.meta.url))

type Scenario = { name: string; req: () => Promise<{ status: number }> }

// Per-request timeout so a single stuck connection can never block a worker's
// time-bounded loop forever (a non-aborted fetch has no default timeout).
const REQUEST_TIMEOUT_MS = Number(process.env.LOADTEST_REQUEST_TIMEOUT_MS || 10_000)
function get(url: string, headers: Record<string, string>) {
  return fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
}
function post(url: string, headers: Record<string, string>, body: string) {
  return fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(0, idx)]
}

async function waitForServer(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/api/live`)
      if (r.ok) return
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 250))
  }
  throw new Error('server did not become ready in time')
}

// Drive one scenario at a fixed concurrency for DURATION_MS; return stats.
async function runScenario(s: Scenario, concurrency: number) {
  const latencies: number[] = []
  let ok = 0, errors = 0
  const stopAt = performance.now() + DURATION_MS

  async function worker() {
    while (performance.now() < stopAt) {
      const t0 = performance.now()
      try {
        const res = await s.req()
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

async function main() {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    throw new Error('Set JWT_SECRET (>=32 chars) so the driver and server share signing keys')
  }

  // --- seed an unlimited (growth) workspace with representative data ----------
  const stamp = Date.now()
  const user = await prisma.user.create({ data: { email: `load-${stamp}@x.test`, emailVerified: true } })
  const apiKeyRaw = generateApiKey()
  const workspace = await prisma.workspace.create({
    data: {
      name: 'LoadTest', slug: `load-${stamp}`, plan: 'growth', subscriptionStatus: 'active',
      ingestApiKey: hashApiKey(apiKeyRaw),
      memberships: { create: { userId: user.id, role: 'owner' } },
    },
  })
  await prisma.campaign.create({ data: { workspaceId: workspace.id, name: 'C', goalType: 'BOOK_CALL' } })
  await prisma.lead.createMany({ data: Array.from({ length: 500 }, (_, i) => ({ workspaceId: workspace.id, businessName: `Lead ${i}`, score: i % 100 })) })
  await prisma.prospect.createMany({ data: Array.from({ length: 500 }, (_, i) => ({ workspaceId: workspace.id, companyName: `Co ${i}`, opportunityScore: i % 100 })) })
  const token = signJwt({ userId: user.id })
  const auth = { Authorization: `Bearer ${token}` }
  const ws = workspace.id

  // --- boot the real server --------------------------------------------------
  console.log(`[loadtest] booting API on :${PORT} …`)
  const server: ChildProcess = spawn('npx', ['tsx', 'src/server.ts'], {
    cwd: path.resolve(__dirname, '../apps/api'),
    env: { ...process.env, PORT: String(PORT), NODE_ENV: 'development', RATE_LIMIT_DISABLED: 'true', LOG_LEVEL: 'warn' },
    // Detach stdio entirely: inheriting the parent's stderr keeps our output pipe
    // open after the run, so cleanup appears to hang. 'ignore' avoids that.
    stdio: 'ignore',
    detached: true,
  })

  try {
    await waitForServer()
    console.log('[loadtest] server ready — warming up\n')

    const scenarios: Scenario[] = [
      { name: 'GET /api/stats', req: () => get(`${BASE}/api/stats?workspaceId=${ws}`, auth) },
      { name: 'GET /api/leads (page)', req: () => get(`${BASE}/api/leads?workspaceId=${ws}&limit=50`, auth) },
      { name: 'GET /api/prospects', req: () => get(`${BASE}/api/prospects?workspaceId=${ws}&limit=50`, auth) },
      {
        name: 'POST /api/ingest (write)',
        req: () => post(`${BASE}/api/ingest`, { 'x-api-key': apiKeyRaw, 'Content-Type': 'application/json' },
          JSON.stringify({ autoResearch: false, leads: [{ businessName: `Ingest ${Math.random().toString(36).slice(2)}` }] })),
      },
    ]

    // brief global warmup
    const warmStop = performance.now() + WARMUP_MS
    while (performance.now() < warmStop) await Promise.all(scenarios.map(s => s.req().catch(() => {})))

    for (const s of scenarios) {
      console.log(`\n### ${s.name}`)
      console.log('conc |   rps |  p50ms |  p95ms |  p99ms |  maxms | err%')
      console.log('-----+-------+--------+--------+--------+--------+------')
      for (const c of CONCURRENCIES) {
        const r = await runScenario(s, c)
        console.log(
          `${String(r.concurrency).padStart(4)} | ${String(r.rps).padStart(5)} | ${String(r.p50).padStart(6)} | ${String(r.p95).padStart(6)} | ${String(r.p99).padStart(6)} | ${String(r.max).padStart(6)} | ${String(r.errorRate).padStart(4)}`,
        )
      }
    }
  } finally {
    // Kill the whole detached process group (tsx spawns a node child) so nothing
    // is orphaned after the run.
    try { if (server.pid) process.kill(-server.pid, 'SIGKILL') } catch { /* already gone */ }
    // best-effort cleanup of the load workspace + user
    await prisma.workspace.delete({ where: { id: ws } }).catch(() => {})
    await prisma.user.delete({ where: { id: user.id } }).catch(() => {})
    await prisma.$disconnect()
  }
}

main().catch((err) => { console.error('[loadtest] failed:', err); process.exit(1) })
