import 'dotenv/config'
import { Worker } from 'bullmq'
import { connection, defaultJobOptions } from './lib/queue.js'
import { generateLeadResearch, generateOutreach, analyzeReply } from '../../api/src/services/openai.js'
import { prisma } from '../../api/src/lib/prisma.js'

function log(queue: string, msg: string) {
  console.log(`[${queue}] ${new Date().toISOString()} ${msg}`)
}

function parseJson<T>(raw: string, fallback: T): T {
  try { return JSON.parse(raw) } catch { return fallback }
}

// ── research-lead ─────────────────────────────────────────────────────────────
const researchWorker = new Worker(
  'research-lead',
  async (job) => {
    const { leadId } = job.data as { leadId: string }
    log('research-lead', `Processing leadId=${leadId}`)

    const lead = await prisma.lead.findUnique({ where: { id: leadId } })
    if (!lead) throw new Error(`Lead ${leadId} not found`)

    await job.updateProgress(10)

    const raw = await generateLeadResearch({
      businessName: lead.businessName,
      website: lead.website ?? undefined,
      notes: lead.notes ?? undefined
    })

    await job.updateProgress(80)

    const parsed = parseJson<{ aiSummary?: string; outreachAngle?: string; qualificationSignals?: string[] }>(raw, {})

    await prisma.lead.update({
      where: { id: leadId },
      data: {
        aiSummary: parsed.aiSummary ?? null,
        outreachAngle: parsed.outreachAngle ?? null,
        stage: 'RESEARCHED'
      }
    })

    await job.updateProgress(100)
    log('research-lead', `Done leadId=${leadId} stage=RESEARCHED`)
    return { leadId, aiSummary: parsed.aiSummary, outreachAngle: parsed.outreachAngle }
  },
  {
    connection,
    concurrency: 3,
    ...defaultJobOptions
  }
)

// ── generate-outreach ─────────────────────────────────────────────────────────
const outreachWorker = new Worker(
  'generate-outreach',
  async (job) => {
    const { leadId } = job.data as { leadId: string }
    log('generate-outreach', `Processing leadId=${leadId}`)

    const lead = await prisma.lead.findUnique({ where: { id: leadId } })
    if (!lead) throw new Error(`Lead ${leadId} not found`)

    await job.updateProgress(10)

    const raw = await generateOutreach({
      businessName: lead.businessName,
      category: lead.category ?? undefined,
      aiSummary: lead.aiSummary ?? undefined,
      outreachAngle: lead.outreachAngle ?? undefined
    })

    await job.updateProgress(80)

    const parsed = parseJson<{ subject?: string; email?: string; followup?: string }>(raw, {})

    if (parsed.subject && parsed.email) {
      await prisma.outreachDraft.create({
        data: {
          leadId: lead.id,
          workspaceId: lead.workspaceId,
          subject: parsed.subject,
          emailBody: parsed.email,
          followup: parsed.followup ?? null
        }
      })
    }

    await job.updateProgress(100)
    log('generate-outreach', `Done leadId=${leadId}`)
    return { leadId, subject: parsed.subject, email: parsed.email, followup: parsed.followup }
  },
  {
    connection,
    concurrency: 3,
    ...defaultJobOptions
  }
)

// ── analyze-reply ─────────────────────────────────────────────────────────────
const replyWorker = new Worker(
  'analyze-reply',
  async (job) => {
    const { replyBody, leadId } = job.data as { replyBody: string; leadId?: string }
    log('analyze-reply', `Processing${leadId ? ` leadId=${leadId}` : ''}`)

    await job.updateProgress(10)
    const raw = await analyzeReply(replyBody)
    await job.updateProgress(80)

    const parsed = parseJson<{
      classification?: string
      summary?: string
      suggestedAction?: string
    }>(raw, {})

    if (leadId && parsed.classification) {
      const stageMap: Record<string, string> = {
        INTERESTED: 'REPLIED',
        NOT_INTERESTED: 'DEAD',
        NEEDS_MORE_INFO: 'REPLIED'
      }
      const newStage = stageMap[parsed.classification]
      if (newStage) {
        await prisma.lead.update({ where: { id: leadId }, data: { stage: newStage } })
      }
    }

    await job.updateProgress(100)
    log('analyze-reply', `Done classification=${parsed.classification}`)
    return parsed
  },
  {
    connection,
    concurrency: 5,
    ...defaultJobOptions
  }
)

// ── sync-mailbox ──────────────────────────────────────────────────────────────
const mailboxWorker = new Worker(
  'sync-mailbox',
  async (job) => {
    const { workspaceId } = job.data as { workspaceId?: string }
    log('sync-mailbox', `Processing workspaceId=${workspaceId}`)

    await job.updateProgress(10)
    const { syncMailboxOnce } = await import('../../api/src/services/mail.js')
    const result = await syncMailboxOnce()
    await job.updateProgress(100)

    log('sync-mailbox', `Done workspaceId=${workspaceId} inspected=${result.inspected}`)
    return result
  },
  {
    connection,
    concurrency: 1,
    attempts: 2,
    backoff: { type: 'exponential', delay: 10_000 }
  }
)

// Attach error handlers
for (const [name, worker] of [
  ['research-lead', researchWorker],
  ['generate-outreach', outreachWorker],
  ['analyze-reply', replyWorker],
  ['sync-mailbox', mailboxWorker]
] as [string, Worker][]) {
  worker.on('failed', (job, err) => {
    log(name, `Job ${job?.id} failed (attempt ${job?.attemptsMade}): ${err.message}`)
  })
  worker.on('error', (err) => {
    log(name, `Worker error: ${err.message}`)
  })
}

// Graceful shutdown
async function shutdown(signal: string) {
  console.log(`[worker] ${signal} received — shutting down`)
  await Promise.all([
    researchWorker.close(),
    outreachWorker.close(),
    replyWorker.close(),
    mailboxWorker.close()
  ])
  await prisma.$disconnect()
  console.log('[worker] Shutdown complete')
  process.exit(0)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

console.log('[worker] Started — listening on 4 queues (research-lead, generate-outreach, analyze-reply, sync-mailbox)')
