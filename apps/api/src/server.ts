import 'dotenv/config'
import { createHash, timingSafeEqual } from 'node:crypto'
import express from 'express'
import cors from 'cors'
import compression from 'compression'
import { authRouter } from './routes/auth.js'
import { billingRouter } from './routes/billing.js'
import { aiRouter } from './routes/ai.js'
import { mailboxRouter } from './routes/mailbox.js'
import { workspaceRouter } from './routes/workspaces.js'
import { campaignsRouter } from './routes/campaigns.js'
import { missionsRouter } from './routes/missions.js'
import { leadsRouter } from './routes/leads.js'
import { statsRouter } from './routes/stats.js'
import { inboxRouter } from './routes/inbox.js'
import { sendsRouter } from './routes/sends.js'
import { webhooksRouter } from './routes/webhooks.js'
import { jobsRouter } from './routes/jobs.js'
import { ingestRouter } from './routes/ingest.js'
import { outcomesRouter } from './routes/outcomes.js'
import { prospectsRouter } from './routes/prospects.js'
import { packsRouter } from './routes/packs.js'
import { signalsRouter } from './routes/signals.js'
import { intelligenceRouter } from './routes/intelligence.js'
import { adminRouter } from './routes/admin.js'
import { unsubscribeRouter } from './routes/unsubscribe.js'
import { legalRouter } from './routes/legal.js'
import { errorHandler, notFoundHandler } from './lib/http.js'
import { securityHeaders } from './middleware/securityHeaders.js'
import { requestContext } from './middleware/requestContext.js'
import { metricsMiddleware } from './middleware/metrics.js'
import { renderMetrics, METRICS_CONTENT_TYPE, setDependencyUp } from './lib/metrics.js'
import { generalRateLimit } from './middleware/rateLimit.js'
import { prisma } from './lib/prisma.js'
import { isProduction, isOriginAllowed, validateConfig, getReadinessReport } from './lib/config.js'
import { pingDatabase, pingRedis } from './lib/health.js'
import { parseTrustProxy } from './lib/trustProxy.js'
import { captureError } from './lib/observability.js'
import { getRuntimeMetadata } from '@acaos/backend-core/lib/release.js'
import { logLifecycleEvent } from '@acaos/backend-core/lib/lifecycle.js'
import { logger } from '@acaos/backend-core/lib/logger.js'
import { getRedis } from './lib/redis.js'
import { initErrorReporting } from './lib/errorReporting.js'
import { setProviderCallObserver } from '@acaos/backend-core/lib/observability.js'
import { incProviderCall } from './lib/metrics.js'
import { attachBreakerStore } from './lib/circuit.js'
import { createRedisBreakerStore } from '@acaos/backend-core/lib/breakerStore.js'

validateConfig()

// Constant-time bearer-token check. Hashing both sides to a fixed-length digest
// before comparing means timingSafeEqual never sees a length mismatch (it throws
// on unequal lengths) and the comparison leaks neither the token's length nor a
// matching prefix via timing. Matches the timingSafeEqual style used for TOTP.
function timingSafeBearerMatch(authorization: string | undefined, token: string): boolean {
  const presented = createHash('sha256').update(authorization ?? '').digest()
  const expected = createHash('sha256').update(`Bearer ${token}`).digest()
  return timingSafeEqual(presented, expected)
}

const SERVICE = 'acaos-api'
const metadata = getRuntimeMetadata(SERVICE)
const app = express()

app.disable('x-powered-by')
// Env-driven so the trusted-proxy depth matches the actual topology (default: 1
// managed hop). Too broad a value lets clients spoof X-Forwarded-For and dodge
// the per-IP rate limits — see lib/trustProxy.ts.
app.set('trust proxy', parseTrustProxy(process.env.TRUST_PROXY))
app.use((_req, res, next) => {
  res.setHeader('X-Acaos-Release-Id', metadata.releaseId)
  next()
})
app.use(compression())
app.use(securityHeaders)
app.use(requestContext)
app.use(metricsMiddleware)

app.use(cors({
  origin: isProduction()
    ? (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => cb(null, isOriginAllowed(origin))
    : true,
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Protection']
}))

app.use('/api/billing/webhook', express.raw({ type: 'application/json', limit: '1mb' }))
app.use(express.json({ limit: '1mb' }))

app.get('/metrics', (req, res) => {
  const token = process.env.METRICS_TOKEN?.trim()
  if (!token) {
    // No token configured: in production, refuse rather than exposing build and
    // runtime info unauthenticated (404, not 401, so the endpoint isn't probeable).
    if (isProduction()) {
      res.status(404).json({ error: 'Not found' })
      return
    }
  } else if (!timingSafeBearerMatch(req.headers.authorization, token)) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }
  res.setHeader('Content-Type', METRICS_CONTENT_TYPE)
  res.send(renderMetrics())
})

app.use(generalRateLimit)

app.get('/api/live', (_req, res) => {
  res.json({
    ok: true,
    service: SERVICE,
    releaseId: metadata.releaseId,
    version: metadata.version,
    commit: metadata.commit,
    timestamp: new Date().toISOString(),
  })
})

app.get('/api/ready', async (_req, res) => {
  const report = getReadinessReport()
  const [dbOk, redisOk] = await Promise.all([pingDatabase(), pingRedis()])
  setDependencyUp('postgres', dbOk)
  setDependencyUp('redis', redisOk)
  // Redis is a required production dependency (the queue-backed flows — outreach,
  // campaign send, mailbox sync — can't run without it), so it gates readiness in
  // production: a Redis outage pulls the instance from rotation. Liveness
  // (/api/live) is independent, so the container isn't killed during a blip; it's
  // re-added when Redis recovers. Dev/test (no Redis) are not gated.
  const ok = report.ready && dbOk && (!isProduction() || redisOk)

  res.status(ok ? 200 : 503).json({
    ok,
    ready: ok,
    db: dbOk,
    redis: redisOk,
    config: report,
    service: SERVICE,
    releaseId: metadata.releaseId,
    version: metadata.version,
    commit: metadata.commit,
    timestamp: new Date().toISOString(),
  })
})

// Strict readiness: like /api/ready, but ALSO requires Redis. Point a load
// balancer's readiness probe here for deployments whose critical flows are
// Redis/BullMQ-backed (job enqueue, queue-driven features), where serving
// traffic with Redis down is worse than briefly shedding it. /api/ready stays
// lenient (Redis optional) for deployments that tolerate degraded rate limiting
// during a transient Redis blip.
app.get('/api/ready/strict', async (_req, res) => {
  const report = getReadinessReport()
  const [dbOk, redisOk] = await Promise.all([pingDatabase(), pingRedis()])
  setDependencyUp('postgres', dbOk)
  setDependencyUp('redis', redisOk)
  const ok = report.ready && dbOk && redisOk

  res.status(ok ? 200 : 503).json({
    ok,
    ready: ok,
    db: dbOk,
    redis: redisOk,
    config: report,
    service: SERVICE,
    releaseId: metadata.releaseId,
    version: metadata.version,
    commit: metadata.commit,
    timestamp: new Date().toISOString(),
  })
})

app.get('/api/health', async (_req, res) => {
  const [dbOk, redisOk] = await Promise.all([pingDatabase(), pingRedis()])
  setDependencyUp('postgres', dbOk)
  setDependencyUp('redis', redisOk)
  const ok = dbOk
  res.status(ok ? 200 : 503).json({
    ok,
    db: dbOk,
    redis: redisOk,
    service: SERVICE,
    releaseId: metadata.releaseId,
    version: metadata.version,
    commit: metadata.commit,
    buildTime: metadata.buildTime,
    env: metadata.environment,
    timestamp: new Date().toISOString(),
  })
})

app.use('/api/auth', authRouter)
app.use('/api/billing', billingRouter)
app.use('/api/ai', aiRouter)
app.use('/api/mailbox', mailboxRouter)
app.use('/api/workspaces', workspaceRouter)
app.use('/api/campaigns', campaignsRouter)
app.use('/api/missions', missionsRouter)
app.use('/api/leads', leadsRouter)
app.use('/api/stats', statsRouter)
app.use('/api/inbox', inboxRouter)
app.use('/api/sends', sendsRouter)
app.use('/api/webhooks', webhooksRouter)
app.use('/api/jobs', jobsRouter)
app.use('/api/ingest', ingestRouter)
app.use('/api/outcomes', outcomesRouter)
app.use('/api/prospects', prospectsRouter)
app.use('/api/packs', packsRouter)
app.use('/api/signals', signalsRouter)
app.use('/api/intelligence', intelligenceRouter)
app.use('/api/admin', adminRouter)
app.use('/api/unsubscribe', unsubscribeRouter)
app.use('/api/legal', legalRouter)

app.use(notFoundHandler)
app.use(errorHandler)

getRedis().connect().catch((err: Error) => {
  logger.warn('api redis initial connection failed', { service: SERVICE, err: err.message, releaseId: metadata.releaseId })
})

void initErrorReporting()

// Route provider-call outcomes from backend-core (providerClient) into the API's
// prometheus counter. backend-core stays metrics-agnostic via this seam.
setProviderCallObserver(incProviderCall)

if (process.env.REDIS_URL) {
  attachBreakerStore(createRedisBreakerStore(getRedis()))
}

const port = Number(process.env.PORT || 4000)
const server = app.listen(port, () => {
  logLifecycleEvent(SERVICE, 'deploy', { port, url: `http://localhost:${port}` })
  logLifecycleEvent(SERVICE, 'startup', { port, url: `http://localhost:${port}` })
})

let shuttingDown = false

async function shutdown(signal: string) {
  if (shuttingDown) return
  shuttingDown = true
  logLifecycleEvent(SERVICE, 'shutdown', { signal, phase: 'begin' })

  server.close(async () => {
    await prisma.$disconnect()
    logLifecycleEvent(SERVICE, 'shutdown', { signal, phase: 'complete' })
    process.exit(0)
  })

  setTimeout(() => {
    logLifecycleEvent(SERVICE, 'crash', { signal, reason: 'forced-exit-after-timeout' })
    process.exit(1)
  }, 10_000).unref()
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))

// Deliberate asymmetry: a single unhandled promise rejection is logged/captured
// but does NOT kill the server (one bad promise shouldn't take down all in-flight
// requests). An uncaughtException, by contrast, leaves the process in an
// undefined state, so we stop accepting connections and exit non-zero for the
// orchestrator to restart a clean instance.
process.on('unhandledRejection', (reason) => {
  logLifecycleEvent(SERVICE, 'crash', { source: 'unhandledRejection', reason: reason instanceof Error ? reason.message : String(reason) })
  captureError(reason, { source: 'unhandledRejection' })
})
process.on('uncaughtException', (err) => {
  logLifecycleEvent(SERVICE, 'crash', { source: 'uncaughtException', err: err.message })
  captureError(err, { source: 'uncaughtException' })
  if (shuttingDown) { process.exit(1); return }
  shuttingDown = true
  server.close(() => process.exit(1))
  setTimeout(() => process.exit(1), 5_000).unref()
})
