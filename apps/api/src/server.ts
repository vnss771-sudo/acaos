import 'dotenv/config'
import { validateEnv } from './lib/env.js'
validateEnv()
import express from 'express'
import cors from 'cors'
import { createBullBoard } from '@bull-board/api'
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter'
import { ExpressAdapter } from '@bull-board/express'
import { authRouter } from './routes/auth.js'
import { billingRouter } from './routes/billing.js'
import { aiRouter } from './routes/ai.js'
import { mailboxRouter } from './routes/mailbox.js'
import { workspaceRouter } from './routes/workspaces.js'
import { campaignsRouter } from './routes/campaigns.js'
import { leadsRouter } from './routes/leads.js'
import { statsRouter } from './routes/stats.js'
import { jobsRouter } from './routes/jobs.js'
import { ingestRouter } from './routes/ingest.js'
import { outcomesRouter } from './routes/outcomes.js'
import { prospectsRouter } from './routes/prospects.js'
import { signalsRouter } from './routes/signals.js'
import { intelligenceRouter } from './routes/intelligence.js'
import { trackingRouter } from './routes/tracking.js'
import { publicRouter } from './routes/public.js'
import { errorHandler, notFoundHandler } from './lib/http.js'
import { generalRateLimit } from './middleware/rateLimit.js'
import { prisma } from './lib/prisma.js'
import { getQueue } from './lib/queues.js'
import { cfg } from './lib/env.js'

const app = express()

app.disable('x-powered-by')
app.set('trust proxy', 1)

function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return false
  if (cfg.webUrl && origin === cfg.webUrl) return true
  if (origin.endsWith('.railway.app')) return true
  if (origin.endsWith('.vercel.app')) return true
  return false
}

app.use(cors({
  origin: cfg.nodeEnv === 'production' ? isAllowedOrigin : true,
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}))

app.use('/api/billing/webhook', express.raw({ type: 'application/json', limit: '1mb' }))
app.use(express.json({ limit: '1mb' }))
app.use(generalRateLimit)

app.get('/api/health', async (_req, res) => {
  let dbOk = false
  try {
    await prisma.$queryRaw`SELECT 1`
    dbOk = true
  } catch { /* leave false */ }

  const status = dbOk ? 200 : 503
  res.status(status).json({
    ok: dbOk,
    service: 'acaos-api',
    version: process.env.npm_package_version || '1.3.0',
    env: cfg.nodeEnv,
    timestamp: new Date().toISOString()
  })
})

app.use('/api/auth', authRouter)
app.use('/api/billing', billingRouter)
app.use('/api/ai', aiRouter)
app.use('/api/mailbox', mailboxRouter)
app.use('/api/workspaces', workspaceRouter)
app.use('/api/campaigns', campaignsRouter)
app.use('/api/leads', leadsRouter)
app.use('/api/stats', statsRouter)
app.use('/api/jobs', jobsRouter)
app.use('/api/ingest', ingestRouter)
app.use('/api/outcomes', outcomesRouter)
app.use('/api/prospects', prospectsRouter)
app.use('/api/signals', signalsRouter)
app.use('/api/intelligence', intelligenceRouter)
app.use('/api/track', trackingRouter)
app.use('/api/pub', publicRouter)

// ── Bull Board — queue dashboard (auth-gated in production via BULL_BOARD_USER/PASS) ──
const boardAdapter = new ExpressAdapter()
boardAdapter.setBasePath('/api/queues')
const QUEUE_NAMES = [
  'research-lead', 'generate-outreach', 'analyze-reply', 'sync-mailbox',
  'score-prospects', 'generate-recommendations', 'calibrate-scoring',
  'generate-strategy-cards', 'advance-cadence', 'harvest-signals', 're-engage',
  'generate-opportunity-brief', 'retrain-signal-weights', 'maintenance',
]
createBullBoard({
  queues: QUEUE_NAMES.map(name => new BullMQAdapter(getQueue(name))),
  serverAdapter: boardAdapter,
})
// In production the dashboard requires BULL_BOARD_USER to be set — fail closed if forgotten
if (cfg.nodeEnv === 'production' && !cfg.bullBoardUser) {
  app.use('/api/queues', (_req, res) => res.status(404).end())
} else {
  if (cfg.bullBoardUser) {
    app.use('/api/queues', (req, res, next) => {
      const b64 = (req.headers.authorization ?? '').replace('Basic ', '')
      const [user, pass] = Buffer.from(b64, 'base64').toString().split(':')
      if (user === cfg.bullBoardUser && pass === cfg.bullBoardPass) return next()
      res.setHeader('WWW-Authenticate', 'Basic realm="Queue Dashboard"')
      res.status(401).end('Unauthorized')
    })
  }
  app.use('/api/queues', boardAdapter.getRouter())
}

app.use(notFoundHandler)
app.use(errorHandler)

const port = cfg.port
const server = app.listen(port, () => {
  console.log(`[api] Running on http://localhost:${port} (${cfg.nodeEnv})`)
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
