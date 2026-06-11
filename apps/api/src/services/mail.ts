import nodemailer from 'nodemailer'
import { ApiError } from '../lib/http.js'
import { prisma } from '../lib/prisma.js'
import { enqueueAnalyzeReply } from '../lib/queues.js'

function getRequiredEnv(key: string) {
  const value = process.env[key]?.trim()
  if (!value) throw new ApiError(503, `${key} is not configured`)
  return value
}

export function isMailConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_FROM)
}

export function isMailboxConfigured() {
  return Boolean(process.env.IMAP_HOST && process.env.IMAP_USER && process.env.IMAP_PASS)
}

export function buildTransport() {
  return nodemailer.createTransport({
    host: getRequiredEnv('SMTP_HOST'),
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true' || Number(process.env.SMTP_PORT || 587) === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
  })
}

export async function sendMail(
  to: string, subject: string, html: string,
  messageOutcomeId?: string
) {
  const { injectTracking } = await import('../lib/emailTracker.js')
  const trackedHtml = messageOutcomeId ? injectTracking(html, messageOutcomeId) : html
  const transporter = buildTransport()
  return transporter.sendMail({ from: getRequiredEnv('SMTP_FROM'), to, subject, html: trackedHtml })
}

// Strips quoted text and signatures to get the fresh reply content
function extractReplyBody(raw: string): string {
  const lines = raw.split('\n')
  const cleaned: string[] = []

  for (const line of lines) {
    const trimmed = line.trim()
    // Stop at common reply-quote markers
    if (trimmed.startsWith('>') || /^On .+wrote:/.test(trimmed) || trimmed === '--') break
    cleaned.push(line)
  }

  return cleaned.join('\n').trim()
}

// Parse plain text from a raw MIME message Buffer
function extractPlainText(source: Buffer): string {
  const raw = source.toString('utf-8', 0, 20_000)

  // Try to find Content-Type: text/plain part
  const plainMatch = raw.match(/Content-Type: text\/plain[^\n]*\n(?:.*\n)*?\n([\s\S]*?)(?:\n--|\n\nContent-Type:|$)/i)
  if (plainMatch?.[1]) return plainMatch[1].trim()

  // If no structured MIME, strip headers and return body
  const headerEnd = raw.indexOf('\n\n')
  if (headerEnd !== -1) return raw.slice(headerEnd + 2).trim()

  return raw.trim()
}

export async function syncMailboxOnce(): Promise<{
  inspected: number
  matched: number
  queued: number
  skipped: number
}> {
  let ImapFlow: any
  try {
    const mod = await import('imapflow')
    ImapFlow = mod.ImapFlow
  } catch {
    throw new ApiError(503, 'IMAP support is not installed in this environment')
  }

  const client = new ImapFlow({
    host: getRequiredEnv('IMAP_HOST'),
    port: Number(process.env.IMAP_PORT || 993),
    secure: String(process.env.IMAP_SECURE || 'true') === 'true',
    auth: { user: getRequiredEnv('IMAP_USER'), pass: getRequiredEnv('IMAP_PASS') },
    logger: false
  })

  try {
    await client.connect()
    await client.mailboxOpen('INBOX')

    // Load already-processed UIDs to skip them
    const existing = await prisma.processedEmail.findMany({ select: { uid: true, messageId: true } })
    const seenUids = new Set(existing.map(e => e.uid))
    const seenMsgIds = new Set(existing.map(e => e.messageId).filter(Boolean))

    type ParsedMsg = {
      uid: number
      messageId: string | null
      fromAddress: string
      body: string
    }

    const toProcess: ParsedMsg[] = []
    let inspected = 0

    // Fetch recent messages (last 200) with source for body extraction
    for await (const msg of client.fetch('*:' + Math.max(1, (client.mailbox?.exists ?? 200) - 199), {
      envelope: true,
      uid: true,
      source: true
    }, { uid: true })) {
      inspected++

      const uid: number = msg.uid
      const messageId: string | null = msg.envelope?.messageId ?? null
      const fromAddress: string = msg.envelope?.from?.[0]?.address?.toLowerCase()?.trim() ?? ''

      if (!fromAddress) continue
      if (seenUids.has(uid)) continue
      if (messageId && seenMsgIds.has(messageId)) continue

      const body = msg.source ? extractPlainText(msg.source) : ''
      const replyBody = extractReplyBody(body)

      if (replyBody.length < 5) continue // skip empty / trivial

      toProcess.push({ uid, messageId, fromAddress, body: replyBody })
    }

    if (toProcess.length === 0) {
      return { inspected, matched: 0, queued: 0, skipped: 0 }
    }

    // Find leads AND prospects matching any of the sender addresses
    const addresses = [...new Set(toProcess.map(m => m.fromAddress))]
    const [matchedLeads, matchedProspects] = await Promise.all([
      prisma.lead.findMany({
        where: { email: { in: addresses } },
        select: { id: true, email: true, workspaceId: true, stage: true, score: true }
      }),
      prisma.prospect.findMany({
        where: { contactEmail: { in: addresses } },
        select: { id: true, contactEmail: true, workspaceId: true, outcomeStage: true }
      }),
    ])
    const emailToLead     = new Map(matchedLeads.map(l => [l.email!.toLowerCase(), l]))
    const emailToProspect = new Map(matchedProspects.map(p => [p.contactEmail!.toLowerCase(), p]))

    let matched = 0
    let queued = 0
    const processedRows: { uid: number; messageId: string | null; fromAddress: string }[] = []

    for (const msg of toProcess) {
      processedRows.push({ uid: msg.uid, messageId: msg.messageId, fromAddress: msg.fromAddress })

      const lead     = emailToLead.get(msg.fromAddress)
      const prospect = emailToProspect.get(msg.fromAddress)

      if (!lead && !prospect) continue
      matched++

      if (lead && !['BOOKED', 'CLOSED', 'DEAD'].includes(lead.stage)) {
        await prisma.lead.update({
          where: { id: lead.id },
          data: { stage: 'REPLIED', lastContactedAt: new Date() }
        })
        await enqueueAnalyzeReply(msg.body, lead.id)
        queued++
      }

      if (prospect && !['WON', 'LOST'].includes(prospect.outcomeStage)) {
        // Advance prospect stage and pause any active cadence enrollments
        await prisma.$transaction([
          prisma.prospect.update({
            where: { id: prospect.id },
            data:  { outcomeStage: 'MEETING', lastContactedAt: new Date() }
          }),
          // Pause cadence — they replied, stop the sequence
          prisma.$executeRaw`
            UPDATE "CadenceEnrollment"
            SET "status" = 'REPLIED', "updatedAt" = NOW()
            WHERE "prospectId" = ${prospect.id} AND "status" = 'ACTIVE'
          `,
        ])
        await enqueueAnalyzeReply(msg.body, undefined, undefined, prospect.id)
        queued++
      }
    }

    // Persist processed email records atomically
    if (processedRows.length > 0) {
      await prisma.processedEmail.createMany({
        data: processedRows.map(r => ({
          uid: r.uid,
          messageId: r.messageId ?? undefined,
          fromAddress: r.fromAddress
        })),
        skipDuplicates: true
      })

      // Mark processed messages as SEEN in IMAP
      const uids = processedRows.map(r => r.uid)
      try {
        await client.messageFlagsAdd(uids, ['\\Seen'], { uid: true })
      } catch {
        // Non-fatal — we already stored the UIDs
      }
    }

    return { inspected, matched, queued, skipped: toProcess.length - matched }
  } finally {
    try { await client.logout() } catch { client.close() }
  }
}
