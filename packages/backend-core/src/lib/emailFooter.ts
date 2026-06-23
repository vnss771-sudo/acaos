// Single source of truth for rendering an outbound outreach email's HTML/text
// body + compliance footer. BOTH the initial campaign send and follow-up sequence
// steps must use this so they can't diverge — previously each path inlined its own
// footer and the follow-up path silently omitted the sender's physical address,
// which CAN-SPAM §5(a)(5) and CASL §6(2) require on EVERY commercial message.
import { escapeHtml } from './html.js'

export interface OutreachEmailParams {
  /** The generated/templated message body (plain text with newlines). */
  body: string
  /** API base URL the unsubscribe link points at (trailing slash tolerated). */
  appUrl: string
  /** Per-send unsubscribe token (already persisted on the OutreachSent row). */
  unsubscribeToken: string
  /** Sender identity for the legally-required physical-address line. */
  senderBusinessName?: string | null
  senderPostalAddress?: string | null
}

export interface RenderedOutreachEmail {
  htmlBody: string
  textBody: string
  unsubscribeUrl: string
}

const FOOTER_NOTICE = 'You received this email because you matched our outreach criteria. To stop receiving emails,'

/**
 * Render the HTML + text bodies for an outreach email, including the unsubscribe
 * link and (when configured) the sender business name + physical postal address.
 * Pure and dependency-free so it's exhaustively unit-testable.
 */
export function buildOutreachEmail(p: OutreachEmailParams): RenderedOutreachEmail {
  const appUrl = p.appUrl.replace(/\/+$/, '')
  const unsubscribeUrl = `${escapeHtml(appUrl)}/api/unsubscribe/${p.unsubscribeToken}`

  const name = p.senderBusinessName?.trim()
  const addr = p.senderPostalAddress?.trim()
  const senderHtml = name ? `<br>${escapeHtml(name)}${addr ? `, ${escapeHtml(addr)}` : ''}` : ''
  const senderText = name ? `\n${name}${addr ? `, ${addr}` : ''}` : ''

  const footer = `<br><br><hr style="border:none;border-top:1px solid #eee;margin:24px 0"><p style="font-size:12px;color:#999">${FOOTER_NOTICE} <a href="${unsubscribeUrl}" style="color:#999">unsubscribe here</a>.${senderHtml}</p>`
  const htmlBody = `<p>${escapeHtml(p.body).replace(/\n/g, '<br>')}</p>${footer}`
  const textBody = `${p.body}\n\n${FOOTER_NOTICE} unsubscribe: ${unsubscribeUrl}${senderText}`

  return { htmlBody, textBody, unsubscribeUrl }
}
