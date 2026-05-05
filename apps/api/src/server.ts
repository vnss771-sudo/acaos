import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { authRouter } from './routes/auth.js'
import { billingRouter } from './routes/billing.js'
import { aiRouter } from './routes/ai.js'
import { mailboxRouter } from './routes/mailbox.js'
import { workspaceRouter } from './routes/workspaces.js'
import { campaignsRouter } from './routes/campaigns.js'
import { leadsRouter } from './routes/leads.js'
import { statsRouter } from './routes/stats.js'
import { jobsRouter } from './routes/jobs.js'
import { errorHandler, notFoundHandler } from './lib/http.js'
import { generalRateLimit } from './middleware/rateLimit.js'
import { prisma } from './lib/prisma.js'

const app = express()

app.disable('x-powered-by')
app.set('trust proxy', 1)

function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return false
  if (process.env.WEB_URL && origin === process.env.WEB_URL) return true
  if (origin.endsWith('.railway.app')) return true
  if (origin.endsWith('.vercel.app')) return true
  return false
}

app.use(cors({
  origin: process.env.NODE_ENV === 'production' ? isAllowedOrigin : true,
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
app.use('/api/leads', leadsRouter)
app.use('/api/stats', statsRouter)
app.use('/api/jobs', jobsRouter)

app.use(notFoundHandler)
app.use(errorHandler)

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
