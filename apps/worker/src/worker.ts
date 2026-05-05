import 'dotenv/config'
import { Worker } from 'bullmq'
import { connection } from './lib/queue.js'
import { generateLeadResearch, generateOutreach, analyzeReply } from '../../api/src/services/openai.js'
import { prisma } from '../../api/src/lib/prisma.js'

// research-lead: fetch AI summary + outreach angle, write back to lead row
new Worker(
  'research-lead',
  async (job) => {
    const { leadId } = job.data as { leadId: string }
    const lead = await prisma.lead.findUnique({ where: { id: leadId } })
    if (!lead) throw new Error(`Lead ${leadId} not found`)

    const raw = await generateLeadResearch({
      businessName: lead.businessName,
      website: lead.website ?? undefined,
      notes: lead.notes ?? undefined
    })

    let parsed: { aiSummary?: string; outreachAngle?: string } = {}
    try { parsed = JSON.parse(raw) } catch { /* leave empty */ }

    await prisma.lead.update({
      where: { id: leadId },
      data: {
        aiSummary: parsed.aiSummary ?? null,
        outreachAngle: parsed.outreachAngle ?? null,
        stage: 'RESEARCHED'
      }
    })

    console.log(`research-lead done: ${leadId}`)
    return parsed
  },
  { connection }
)

// generate-outreach: create subject/email/followup copy for a lead
new Worker(
  'generate-outreach',
  async (job) => {
    const { leadId } = job.data as { leadId: string }
    const lead = await prisma.lead.findUnique({ where: { id: leadId } })
    if (!lead) throw new Error(`Lead ${leadId} not found`)

    const raw = await generateOutreach({
      businessName: lead.businessName,
      category: lead.category ?? undefined,
      aiSummary: lead.aiSummary ?? undefined,
      outreachAngle: lead.outreachAngle ?? undefined
    })

    console.log(`generate-outreach done: ${leadId}`)
    return JSON.parse(raw)
  },
  { connection }
)

// analyze-reply: classify an incoming reply body
new Worker(
  'analyze-reply',
  async (job) => {
    const { replyBody, leadId } = job.data as { replyBody: string; leadId?: string }
    const raw = await analyzeReply(replyBody)
    const parsed = JSON.parse(raw)

    // If a leadId is provided, update the lead stage
    if (leadId && parsed.classification === 'INTERESTED') {
      await prisma.lead.update({ where: { id: leadId }, data: { stage: 'REPLIED' } })
    }

    console.log(`analyze-reply done: classification=${parsed.classification}`)
    return parsed
  },
  { connection }
)

// sync-mailbox: placeholder — calls would invoke IMAP sync
new Worker(
  'sync-mailbox',
  async (job) => {
    const { workspaceId } = job.data as { workspaceId?: string }
    // Dynamically import to avoid IMAP connection at boot
    const { syncMailboxOnce } = await import('../../api/src/services/mail.js')
    const result = await syncMailboxOnce()
    console.log(`sync-mailbox done: workspaceId=${workspaceId}`, result)
    return result
  },
  { connection }
)

console.log('ACAOS worker runtime started — listening on 4 queues')
