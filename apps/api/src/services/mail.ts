import nodemailer from 'nodemailer'
import { ApiError } from '../lib/http.js'

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

export async function sendMail(to: string, subject: string, html: string) {
  const transporter = buildTransport()
  return transporter.sendMail({ from: getRequiredEnv('SMTP_FROM'), to, subject, html })
}

export async function syncMailboxOnce() {
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
    auth: { user: getRequiredEnv('IMAP_USER'), pass: getRequiredEnv('IMAP_PASS') }
  })

  try {
    await client.connect()
    let count = 0
    await client.mailboxOpen('INBOX')
    for await (const _msg of client.fetch('1:*', { envelope: true }, { uid: true })) {
      count += 1
      if (count > 10) break
    }
    return { inspected: count }
  } finally {
    try { await client.logout() } catch { client.close() }
  }
}
