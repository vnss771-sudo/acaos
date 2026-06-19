import type { Prisma } from '@prisma/client'
import nodemailer from 'nodemailer'
import { ApiError } from '../lib/errors.js'
import { prisma } from '../lib/prisma.js'
import { enqueueAnalyzeReply } from '../lib/queues.js'
import { decryptSecret, isEncrypted } from '../lib/encrypt.js'
import { resolvePublicMailHost, type PinnedHost } from '../lib/ssrf.js'
import { suppress } from '../lib/suppressions.js'
import { recordAudit } from '../lib/audit.js'

const BOUNCE_SENDER = /(mailer-daemon|postmaster|mail delivery|maild?(a|ae)mon)/i
const BOUNCE_SUBJECT = /(undeliverable|delivery status notification|mail delivery (failed|subsystem)|returned mail|failure notice|delivery has failed|message not delivered|delivery incomplete)/i

// Extract candidate failed-recipient addresses from a message that looks like a
// bounce/NDR. Detection is intentionally permissive (sender OR subject); SAFETY
// comes from the caller, which only acts on returned addresses that we actually
// sent outreach to — so a stray address in the DSN body can never be suppressed.
export function detectBounceRecipients(subject: string, fromAddress: string, body: string): string[] {
  const looksLikeBounce = BOUNCE_SENDER.test(fromAddress) || BOUNCE_SUBJECT.test(subject || '')
  if (!looksLikeBounce) return []
  const recips = new Set<string>()
  for (const m of body.matchAll(/(?:final|original)-recipient:\s*(?:rfc822;)?\s*([^\s;<>]+@[^\s;<>]+)/gi)) {
    recips.add(m[1].toLowerCase().replace(/[>.,;]+$/, ''))
  }
  if (recips.size === 0) {
    for (const m of body.matchAll(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi)) {
      recips.add(m[0].toLowerCase())
    }
  }
  return [...recips]
}

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

export function buildTransport(cfg?: SmtpConfig | null, pin?: PinnedHost) {
  // `pin` (set for workspace-supplied hosts) carries the SSRF-validated IP to
  // dial plus the original hostname for TLS SNI/cert verification, so nodemailer
  // performs no second DNS lookup that could rebind to a private address.
  const host = pin?.host || cfg?.smtpHost || getRequiredEnv('SMTP_HOST')
  const port = cfg?.smtpPort ?? Number(process.env.SMTP_PORT || 587)
  const secure = cfg?.smtpSecure ?? (process.env.SMTP_SECURE === 'true' || port === 465)
  const user = cfg?.smtpUser || process.env.SMTP_USER
  const pass = maybeDecrypt(cfg?.smtpPass) || process.env.SMTP_PASS
  return nodemailer.createTransport({
    host, port, secure,
    auth: user ? { user, pass } : undefined,
    ...(pin?.servername ? { tls: { servername: pin.servername } } : {}),
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  })
}

export async function sendMail(to: string, subject: string, html: string, cfg?: SmtpConfig | null) {
  // Workspace-supplied SMTP hosts are an SSRF surface: resolve and reject
  // private/loopback/metadata targets, then dial the resolved IP directly so the
  // check and the connect can't disagree (DNS-rebinding TOCTOU). Env-configured
  // system hosts are trusted and skipped.
  const pin = cfg?.smtpHost ? await resolvePublicMailHost(cfg.smtpHost, 'smtpHost') : undefined
  const transporter = buildTransport(cfg, pin)
  const from = cfg?.smtpFrom || getRequiredEnv('SMTP_FROM')
  return transporter.sendMail({ from, to, subject, html })
}

// Strips quoted text and signatures to get the fresh reply content
export function extractReplyBody(raw: string): string {
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
export function extractPlainText(source: Buffer): string {
  const raw = source.toString('utf-8', 0, 20_000)

  // Try to find Content-Type: text/plain part
  const plainMatch = raw.match(/Content-Type: text\/plain[^\n]*\n(?:.*\n)*?\n([\s\S]*?)(?:\n--|\n\nContent-Type:|$)/i)
  if (plainMatch?.[1]) return plainMatch[1].trim()

  // If no structured MIME, strip headers and return body
  const headerEnd = raw.indexOf('\n\n')
  if (headerEnd !== -1) return raw.slice(headerEnd + 2).trim()

  return raw.trim()
}

/** True for a Prisma unique-constraint violation (P2002). */
function isUniqueConstraintError(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === 'P2002')
}

/**
 * Atomically record a processed inbound email and, when it maps to a non-
 * terminal lead, advance that lead to REPLIED. Extracted from syncMailboxOnce so
 * the integrity-critical persistence is testable without an IMAP server.
 *
 * Idempotent on `uid`: the processed-email insert is the gate. If this message
 * was already recorded (e.g. two mailbox syncs race past the caller's seen-uid
 * pre-filter), the unique constraint fires, the transaction rolls back, and we
 * return `{ advanced: false }` WITHOUT re-advancing the lead or signalling the
 * caller to re-enqueue reply analysis (which would double-spend AI).
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

  try {
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      // create (not upsert) so a duplicate uid throws P2002 and aborts the whole
      // transaction — the lead/outreach mutations below must not run twice.
      await tx.processedEmail.create({
        data: { workspaceId, uid, messageId: messageId ?? undefined, fromAddress },
      })
      if (advance) {
        // Scope writes by workspaceId (in scope here) as defense-in-depth so a
        // mis-attributed lead id can never mutate another tenant's row.
        await tx.lead.updateMany({
          where: { id: lead!.id, workspaceId },
          data: { stage: 'REPLIED', lastContactedAt: new Date() },
        })
      }
      // Always close the outreach loop regardless of lead stage — a BOOKED or
      // CLOSED lead that replies still deserves an accurate outreach record.
      if (lead) {
        await tx.outreachSent.updateMany({
          where: { leadId: lead.id, workspaceId, status: 'SENT' },
          data: { status: 'REPLIED', repliedAt: new Date() },
        })
      }
    })
  } catch (err) {
    // Already processed (unique violation on workspaceId+uid) — a no-op replay.
    if (isUniqueConstraintError(err)) return { advanced: false }
    throw err
  }

  return { advanced: advance }
}

export async function syncMailboxOnce(cfg?: ImapConfig | null, workspaceId?: string): Promise<{
  inspected: number
  matched: number
  queued: number
  skipped: number
  bounced: number
}> {
  let ImapFlow: any
  try {
    const mod = await import('imapflow')
    ImapFlow = mod.ImapFlow
  } catch {
    throw new ApiError(503, 'IMAP support is not installed in this environment')
  }

  // Workspace-supplied IMAP hosts are an SSRF surface — resolve, reject private
  // targets, and pin the validated IP so imapflow's connect can't re-resolve to
  // a rebind. Env-configured system hosts are trusted and dialed by name.
  const pin = cfg?.imapHost ? await resolvePublicMailHost(cfg.imapHost, 'imapHost') : undefined
  const host = pin?.host || cfg?.imapHost || getRequiredEnv('IMAP_HOST')
  const port = cfg?.imapPort ?? Number(process.env.IMAP_PORT || 993)
  const secure = cfg?.imapSecure ?? (String(process.env.IMAP_SECURE || 'true') === 'true')
  const user = cfg?.imapUser || getRequiredEnv('IMAP_USER')
  const pass = maybeDecrypt(cfg?.imapPass) || getRequiredEnv('IMAP_PASS')

  const client = new ImapFlow({
    host, port, secure,
    ...(pin?.servername ? { servername: pin.servername } : {}),
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
      subject: string
      body: string
      bounceRecipients: string[]
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

      const subject: string = msg.envelope?.subject ?? ''
      const body = msg.source ? extractPlainText(msg.source) : ''
      const bounceRecipients = detectBounceRecipients(subject, fromAddress, body)
      const replyBody = extractReplyBody(body)

      // Keep bounces even if their reply text is trivial; otherwise skip empties.
      if (bounceRecipients.length === 0 && replyBody.length < 5) continue

      toProcess.push({ uid, messageId, fromAddress, subject, body: replyBody, bounceRecipients })
    }

    if (toProcess.length === 0) {
      return { inspected, matched: 0, queued: 0, skipped: 0, bounced: 0 }
    }

    // ── Bounce handling ────────────────────────────────────────────────────────
    // NDR/bounce messages: suppress the failed recipient(s) and mark their
    // OutreachSent rows BOUNCED. Safety invariant — only addresses we ACTUALLY
    // sent outreach to (present in OutreachSent) are ever suppressed, so a stray
    // address in a DSN body can't poison the suppression list.
    const handleBounces = Boolean(workspaceId)
    const bounceMsgs = handleBounces ? toProcess.filter(m => m.bounceRecipients.length > 0) : []
    let bounced = 0
    const processedUids: number[] = []
    if (bounceMsgs.length > 0) {
      const candidates = [...new Set(bounceMsgs.flatMap(m => m.bounceRecipients))]
      const sentRows = await prisma.outreachSent.findMany({
        where: { workspaceId, toEmail: { in: candidates } },
        select: { toEmail: true },
      })
      const sentSet = new Set((sentRows as Array<{ toEmail: string }>).map(r => r.toEmail.toLowerCase()))
      for (const addr of candidates.filter(a => sentSet.has(a))) {
        await suppress(workspaceId!, addr, 'BOUNCED')
        await prisma.outreachSent.updateMany({
          where: { workspaceId, toEmail: addr, status: { in: ['SENT', 'SENDING'] } },
          data: { status: 'BOUNCED' },
        })
        bounced++
        void recordAudit({ workspaceId, type: 'email.bounced', entityType: 'suppression', metadata: { email: addr } })
      }
      for (const m of bounceMsgs) {
        await recordProcessedReply({ uid: m.uid, messageId: m.messageId, fromAddress: m.fromAddress, workspaceId, lead: null })
        processedUids.push(m.uid)
      }
    }

    // Replies = everything that isn't a handled bounce.
    const replyMsgs = handleBounces ? toProcess.filter(m => m.bounceRecipients.length === 0) : toProcess

    // Find leads matching any of the sender addresses, scoped to the workspace
    // when known so replies can never bleed across tenant boundaries.
    const addresses = [...new Set(replyMsgs.map(m => m.fromAddress))]
    const matchedLeads = await prisma.lead.findMany({
      where: { email: { in: addresses }, ...(workspaceId ? { workspaceId } : {}) },
      select: { id: true, email: true, workspaceId: true, stage: true, score: true }
    })
    type MatchedLead = { id: string; email: string | null; workspaceId: string; stage: string; score: number }
    const typedMatchedLeads = matchedLeads as MatchedLead[]
    const emailToLead = new Map(typedMatchedLeads.map((l: MatchedLead) => [l.email!.toLowerCase(), l]))

    let matched = 0
    let queued = 0

    for (const msg of replyMsgs) {
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
        await enqueueAnalyzeReply({ replyBody: msg.body, workspaceId, leadId: lead!.id })
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

    return { inspected, matched, queued, skipped: replyMsgs.length - matched, bounced }
  } finally {
    try { await client.logout() } catch { client.close() }
  }
}
