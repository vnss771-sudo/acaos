import 'dotenv/config'
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
import { jobsRouter } from './routes/jobs.js'
import { ingestRouter } from './routes/ingest.js'
import { outcomesRouter } from './routes/outcomes.js'
import { prospectsRouter } from './routes/prospects.js'
import { signalsRouter } from './routes/signals.js'
import { intelligenceRouter } from './routes/intelligence.js'
import { adminRouter } from './routes/admin.js'
import { unsubscribeRouter } from './routes/unsubscribe.js'
import { errorHandler, notFoundHandler } from './lib/http.js'
import { securityHeaders } from './middleware/securityHeaders.js'
import { requestContext } from './middleware/requestContext.js'
import { generalRateLimit } from './middleware/rateLimit.js'
import { prisma } from './lib/prisma.js'
import { isProduction, isOriginAllowed, validateConfig, getReadinessReport } from './lib/config.js'
import { pingDatabase, pingRedis } from './lib/health.js'

// Fail fast on a misconfigured deploy rather than surfacing it as a runtime 503.
validateConfig()

const app = express()

app.disable('x-powered-by')
app.set('trust proxy', 1)
app.use(compression())
app.use(securityHeaders)
app.use(requestContext)

app.use(cors({
  // In production, allow only explicitly configured origins. In dev, reflect
  // the request origin for convenience.
  origin: isProduction()
    ? (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => cb(null, isOriginAllowed(origin))
    : true,
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Protection']
}))

app.use('/api/billing/webhook', express.raw({ type: 'application/json', limit: '1mb' }))
app.use(express.json({ limit: '1mb' }))
app.use(generalRateLimit)

// Liveness: cheap, never touches the database — safe for frequent probes.
app.get('/api/live', (_req, res) => {
  res.json({ ok: true, service: 'acaos-api', timestamp: new Date().toISOString() })
})

// Readiness: checks required config + DB connectivity. Suitable for deployment
// gates (e.g. Kubernetes readinessProbe or Render healthcheck). Redis is probed
// and reported for operator visibility, but is non-fatal: the rate limiter
// degrades to an in-process fallback, so a cache blip must not pull a serving
// pod out of rotation.
app.get('/api/ready', async (_req, res) => {
  const report = getReadinessReport()
  const [dbOk, redisOk] = await Promise.all([pingDatabase(), pingRedis()])

  const ok = report.ready && dbOk
  res.status(ok ? 200 : 503).json({ ok, db: dbOk, redis: redisOk, config: report })
})

// Readiness / health: verifies the database is reachable; reports Redis too.
app.get('/api/health', async (_req, res) => {
  const [dbOk, redisOk] = await Promise.all([pingDatabase(), pingRedis()])

  const status = dbOk ? 200 : 503
  res.status(status).json({
    ok: dbOk,
    db: dbOk,
    redis: redisOk,
    service: 'acaos-api',
    version: process.env.npm_package_version || '1.3.0',
    env: process.env.NODE_ENV || 'development',
    timestamp: new Date().toISOString()
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
app.use('/api/jobs', jobsRouter)
app.use('/api/ingest', ingestRouter)
app.use('/api/outcomes', outcomesRouter)
app.use('/api/prospects', prospectsRouter)
app.use('/api/signals', signalsRouter)
app.use('/api/intelligence', intelligenceRouter)
app.use('/api/admin', adminRouter)
app.use('/api/unsubscribe', unsubscribeRouter)

app.use(notFoundHandler)
app.use(errorHandler)

// Eagerly connect Redis so rate limiting and SSE tickets use the real store
// from the first request rather than falling back to the per-process Map.
import { getRedis } from './lib/redis.js'
getRedis().connect().catch((err: Error) => {
  console.warn('[redis] Initial connection failed — rate limiting will use in-process fallback:', err.message)
})

const port = Number(process.env.PORT || 4000)
const server = app.listen(port, () => {
  console.log(`[api] Running on http://localhost:${port} (${process.env.NODE_ENV || 'development'})`)
})

async function shutdown(signal: string) {
  console.log(`[api] ${signal} received — shutting down gracefully`)
  server.close(async () => {
    await prisma.$disconnect()
    console.log('[api] Shutdown complete')
    process.exit(0)
  })
  setTimeout(() => {
    console.error('[api] Forced exit after timeout')
    process.exit(1)
  }, 10_000).unref()
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

// Never let an escaped promise rejection silently terminate the process
// (Node aborts on unhandled rejections). Log it; a crashed request is handled
// by the error middleware, so this is a last-resort safety net.
process.on('unhandledRejection', (reason) => {
  console.error('[api] Unhandled promise rejection:', reason)
})
process.on('uncaughtException', (err) => {
  console.error('[api] Uncaught exception:', err)
})
