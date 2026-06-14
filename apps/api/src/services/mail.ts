import nodemailer from 'nodemailer'
import { ApiError } from '../lib/http.js'
import { prisma } from '../lib/prisma.js'
import { enqueueAnalyzeReply } from '../lib/queues.js'
import { decryptSecret, isEncrypted } from '../lib/encrypt.js'

function getRequiredEnv(key: string) {
  const value = process.env[key]?.trim()
  if (!value) throw new ApiError(503, `${key} is not configured`)
  return value
}

export type SmtpConfig = {
  smtpHost?: string | null
  smtpPort?: number | null
  smtpSecure?: boolean | null
  smtpUser?: string | null
  smtpPass?: string | null
  smtpFrom?: string | null
}

export type ImapConfig = {
  imapHost?: string | null
  imapPort?: number | null
  imapSecure?: boolean | null
  imapUser?: string | null
  imapPass?: string | null
}

export function isMailConfigured(cfg?: SmtpConfig | null) {
  return Boolean((cfg?.smtpHost || process.env.SMTP_HOST) && (cfg?.smtpFrom || process.env.SMTP_FROM))
}

export function isMailboxConfigured(cfg?: ImapConfig | null) {
  return Boolean(
    (cfg?.imapHost || process.env.IMAP_HOST) &&
    (cfg?.imapUser || process.env.IMAP_USER) &&
    (cfg?.imapPass || process.env.IMAP_PASS)
  )
}

function maybeDecrypt(s: string | null | undefined): string | undefined {
  if (!s) return undefined
  return isEncrypted(s) ? decryptSecret(s) : s
}

export function buildTransport(cfg?: SmtpConfig | null) {
  const host = cfg?.smtpHost || getRequiredEnv('SMTP_HOST')
  const port = cfg?.smtpPort ?? Number(process.env.SMTP_PORT || 587)
  const secure = cfg?.smtpSecure ?? (process.env.SMTP_SECURE === 'true' || port === 465)
  const user = cfg?.smtpUser || process.env.SMTP_USER
  const pass = maybeDecrypt(cfg?.smtpPass) || process.env.SMTP_PASS
  return nodemailer.createTransport({
    host, port, secure,
    auth: user ? { user, pass } : undefined,
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  })
}

export async function sendMail(to: string, subject: string, html: string, cfg?: SmtpConfig | null) {
  const transporter = buildTransport(cfg)
  const from = cfg?.smtpFrom || getRequiredEnv('SMTP_FROM')
  return transporter.sendMail({ from, to, subject, html })
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

/**
 * Atomically record a processed inbound email and, when it maps to a non-
 * terminal lead, advance that lead to REPLIED. Extracted from syncMailboxOnce so
 * the integrity-critical persistence is testable without an IMAP server.
 * Idempotent on `uid` (re-running is a no-op for the processed row).
 */
export async function recordProcessedReply(params: {
  uid: number
  messageId: string | null
  fromAddress: string
  workspaceId: string
  lead: { id: string; stage: string } | null
}): Promise<{ advanced: boolean }> {
  const { uid, messageId, fromAddress, workspaceId, lead } = params
  const advance = Boolean(lead) && !['BOOKED', 'CLOSED', 'DEAD'].includes(lead!.stage)

  await prisma.$transaction(async (tx: typeof prisma) => {
    await tx.processedEmail.upsert({
      where: { workspaceId_uid: { workspaceId, uid } },
      create: { workspaceId, uid, messageId: messageId ?? undefined, fromAddress },
      update: {},
    })
    if (advance) {
      await tx.lead.update({
        where: { id: lead!.id },
        data: { stage: 'REPLIED', lastContactedAt: new Date() },
      })
    }
    // Always close the outreach loop regardless of lead stage — a BOOKED or
    // CLOSED lead that replies still deserves an accurate outreach record.
    if (lead) {
      await tx.outreachSent.updateMany({
        where: { leadId: lead.id, status: 'SENT' },
        data: { status: 'REPLIED', repliedAt: new Date() },
      })
    }
  })

  return { advanced: advance }
}

export async function syncMailboxOnce(cfg?: ImapConfig | null, workspaceId?: string): Promise<{
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

  const host = cfg?.imapHost || getRequiredEnv('IMAP_HOST')
  const port = cfg?.imapPort ?? Number(process.env.IMAP_PORT || 993)
  const secure = cfg?.imapSecure ?? (String(process.env.IMAP_SECURE || 'true') === 'true')
  const user = cfg?.imapUser || getRequiredEnv('IMAP_USER')
  const pass = maybeDecrypt(cfg?.imapPass) || getRequiredEnv('IMAP_PASS')

  const client = new ImapFlow({
    host, port, secure,
    auth: { user, pass },
    logger: false,
    socketTimeout: Number(process.env.IMAP_SOCKET_TIMEOUT_MS || 30_000),
    greetingTimeout: 10_000,
  })

  try {
    await client.connect()
    await client.mailboxOpen('INBOX')

    // Load already-processed records within the fetch window, scoped to this
    // workspace — IMAP UIDs are only unique per-mailbox, not globally.
    const windowStart = Math.max(1, (client.mailbox?.exists ?? 200) - 199)
    if (!workspaceId) throw new Error('workspaceId required for mailbox sync')
    const existing = await prisma.processedEmail.findMany({
      where: { workspaceId, uid: { gte: windowStart } },
      select: { uid: true, messageId: true }
    })
    type ProcessedEmailRow = { uid: number; messageId: string | null }
    const processedRows = existing as ProcessedEmailRow[]
    const seenUids = new Set(processedRows.map((e: ProcessedEmailRow) => e.uid))
    const seenMsgIds = new Set(processedRows.map((e: ProcessedEmailRow) => e.messageId).filter(Boolean))

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

    // Find leads matching any of the sender addresses, scoped to the workspace
    // when known so replies can never bleed across tenant boundaries.
    const addresses = [...new Set(toProcess.map(m => m.fromAddress))]
    const matchedLeads = await prisma.lead.findMany({
      where: { email: { in: addresses }, ...(workspaceId ? { workspaceId } : {}) },
      select: { id: true, email: true, workspaceId: true, stage: true, score: true }
    })
    type MatchedLead = { id: string; email: string | null; workspaceId: string; stage: string; score: number }
    const typedMatchedLeads = matchedLeads as MatchedLead[]
    const emailToLead = new Map(typedMatchedLeads.map((l: MatchedLead) => [l.email!.toLowerCase(), l]))

    let matched = 0
    let queued = 0
    const processedUids: number[] = []

    for (const msg of toProcess) {
      const lead = emailToLead.get(msg.fromAddress) ?? null
      if (lead) matched++

      // Record the processed email and advance the lead in one transaction, so a
      // crash can never leave a lead advanced without its processed-row (which
      // would reprocess the same email and double-spend AI on the next sync).
      const { advanced } = await recordProcessedReply({
        uid: msg.uid,
        messageId: msg.messageId,
        fromAddress: msg.fromAddress,
        workspaceId: workspaceId,
        lead,
      })
      processedUids.push(msg.uid)

      if (advanced) {
        // Enqueue only after the DB commit so a failed enqueue doesn't strand a
        // lead in REPLIED with no processed-row.
        await enqueueAnalyzeReply(msg.body, lead!.id)
        queued++
      }
    }

    // Mark processed messages as SEEN in IMAP (non-fatal — already persisted).
    if (processedUids.length > 0) {
      try {
        await client.messageFlagsAdd(processedUids, ['\\Seen'], { uid: true })
      } catch {
        // Non-fatal — we already stored the UIDs
      }
    }

    return { inspected, matched, queued, skipped: toProcess.length - matched }
  } finally {
    try { await client.logout() } catch { client.close() }
  }
}
