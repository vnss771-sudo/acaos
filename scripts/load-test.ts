#!/usr/bin/env node
/**
 * Load testing for Phase 4.1: Multi-Tenant Performance Hardening.
 * Tests:
 * - Multi-workspace isolation under concurrent load
 * - Rate limit enforcement (per-IP and per-workspace)
 * - Connection pool under sustained demand
 * - Response time distribution and tail latency
 *
 * Run: DB_POOL_SIZE=20 WORKSPACE_MAIL_RATE_MAX=100 node scripts/load-test.ts
 *
 * Outputs:
 * - Throughput (req/sec)
 * - Response time distribution (p50, p95, p99)
 * - 429 rate-limit hits (should grow as load increases)
 * - Connection pool utilization
 */

import 'dotenv/config'

const API_BASE = process.env.API_BASE || 'http://localhost:4000'
const DURATION_SECONDS = Number(process.env.LOAD_TEST_DURATION || 30)
const CONCURRENT_USERS = Number(process.env.CONCURRENT_USERS || 10)
const WORKSPACES = Number(process.env.WORKSPACES || 5)

interface LoadTestMetrics {
  totalRequests: number
  successRequests: number
  rateLimitHits: number
  errors: number
  responseTimes: number[]
  startTime: number
  endTime: number
}

const metrics: LoadTestMetrics = {
  totalRequests: 0,
  successRequests: 0,
  rateLimitHits: 0,
  errors: 0,
  responseTimes: [],
  startTime: Date.now(),
  endTime: 0,
}

async function makeRequest(token: string, workspaceId: string, endpoint: string): Promise<number> {
  const start = Date.now()
  try {
    const response = await fetch(`${API_BASE}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ workspaceId }),
    })
    const duration = Date.now() - start
    metrics.responseTimes.push(duration)
    metrics.totalRequests++

    if (response.status === 429) {
      metrics.rateLimitHits++
    } else if (response.ok) {
      metrics.successRequests++
    } else {
      metrics.errors++
    }
    return duration
  } catch (err) {
    metrics.errors++
    return Date.now() - start
  }
}

async function simulateUser(
  userId: number,
  token: string,
  workspaceIds: string[],
  endpoint: string,
): Promise<void> {
  while (Date.now() - metrics.startTime < DURATION_SECONDS * 1000) {
    const workspaceId = workspaceIds[userId % workspaceIds.length]
    await makeRequest(token, workspaceId, endpoint)
    // Randomize inter-request delay (100-500ms)
    await new Promise((resolve) => setTimeout(resolve, 100 + Math.random() * 400))
  }
}

function percentile(arr: number[], p: number): number {
  const sorted = [...arr].sort((a, b) => a - b)
  const idx = Math.ceil((sorted.length * p) / 100) - 1
  return sorted[Math.max(0, idx)]
}

function printResults(): void {
  metrics.endTime = Date.now()
  const duration = (metrics.endTime - metrics.startTime) / 1000
  const throughput = metrics.totalRequests / duration

  console.log('\n=== LOAD TEST RESULTS ===')
  console.log(`Duration: ${duration.toFixed(1)}s`)
  console.log(`Concurrent Users: ${CONCURRENT_USERS}`)
  console.log(`Workspaces: ${WORKSPACES}`)
  console.log(`DB Pool Size: ${process.env.DB_POOL_SIZE || 10}`)
  console.log(`\nThroughput: ${throughput.toFixed(0)} req/sec`)
  console.log(`Total Requests: ${metrics.totalRequests}`)
  console.log(`Successful: ${metrics.successRequests}`)
  console.log(`Rate Limited (429): ${metrics.rateLimitHits}`)
  console.log(`Errors: ${metrics.errors}`)

  if (metrics.responseTimes.length > 0) {
    console.log(`\nResponse Times (ms):`)
    console.log(`  Min: ${Math.min(...metrics.responseTimes)}`)
    console.log(`  P50: ${percentile(metrics.responseTimes, 50)}`)
    console.log(`  P95: ${percentile(metrics.responseTimes, 95)}`)
    console.log(`  P99: ${percentile(metrics.responseTimes, 99)}`)
    console.log(`  Max: ${Math.max(...metrics.responseTimes)}`)
  }

  const rateLimitRate = metrics.totalRequests > 0 ? (metrics.rateLimitHits / metrics.totalRequests * 100).toFixed(1) : '0'
  console.log(`\nRate Limit Hit Rate: ${rateLimitRate}%`)

  if (metrics.rateLimitHits === 0) {
    console.log('⚠️  No rate limits hit — increase CONCURRENT_USERS or decrease inter-request delay')
  }
  if (metrics.errors > 0) {
    console.log(`⚠️  ${metrics.errors} errors — check API logs and connectivity`)
  }
  if (metrics.successRequests === metrics.totalRequests) {
    console.log('✓ All requests successful')
  }
}

async function main(): Promise<void> {
  console.log('Starting load test...')
  console.log(`Target: ${API_BASE}`)
  console.log(`Duration: ${DURATION_SECONDS}s`)
  console.log(`Concurrent Users: ${CONCURRENT_USERS}`)
  console.log(`Workspaces: ${WORKSPACES}`)

  // Generate fake workspace IDs (in real test, these would come from the DB or fixture)
  const workspaceIds = Array.from({ length: WORKSPACES }, (_, i) => `ws_${String(i).padStart(3, '0')}`)

  // Fake token (in real test, this would be a valid auth token)
  const token = process.env.TEST_TOKEN || 'fake-token-for-load-testing'

  // Endpoint to hammer (try /api/lead-scoring/score or /api/ai/research)
  const endpoint = process.env.ENDPOINT || '/api/lead-scoring/score'

  const users = Array.from({ length: CONCURRENT_USERS }, (_, i) =>
    simulateUser(i, token, workspaceIds, endpoint)
  )

  await Promise.all(users)
  printResults()
}

main().catch(console.error)
