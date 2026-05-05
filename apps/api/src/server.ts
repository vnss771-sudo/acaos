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
import { errorHandler, notFoundHandler } from './lib/http.js'

const app = express()

app.disable('x-powered-by')
app.use(cors({ origin: process.env.WEB_URL || true }))
app.use('/api/billing/webhook', express.raw({ type: 'application/json', limit: '1mb' }))
app.use(express.json({ limit: '1mb' }))

app.get('/api/health', (_req, res) =>
  res.json({
    ok: true,
    service: 'acaos-api',
    timestamp: new Date().toISOString()
  })
)

app.use('/api/auth', authRouter)
app.use('/api/billing', billingRouter)
app.use('/api/ai', aiRouter)
app.use('/api/mailbox', mailboxRouter)
app.use('/api/workspaces', workspaceRouter)
app.use('/api/campaigns', campaignsRouter)
app.use('/api/leads', leadsRouter)

app.use(notFoundHandler)
app.use(errorHandler)

const port = Number(process.env.PORT || 4000)
app.listen(port, () => {
  console.log(`API running on http://localhost:${port}`)
})
