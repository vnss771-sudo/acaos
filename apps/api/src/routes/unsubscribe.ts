import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { prisma } from '../lib/prisma.js'
import { asyncHandler, ApiError } from '../lib/http.js'
import { suppress } from '../lib/suppressions.js'
import { userHasWorkspaceAccess } from '../lib/workspaces.js'
import { unsubscribeRateLimit } from '../middleware/rateLimit.js'
import { escapeHtml } from '../lib/html.js'
import type { AuthedRequest } from '../types/auth.js'

export const unsubscribeRouter = Router()

async function lookupToken(token: string) {
  if (!token) throw new ApiError(400, 'Token required')
  const record = await prisma.outreachSent.findUnique({
    where: { unsubscribeToken: token },
    select: { id: true, toEmail: true, workspaceId: true }
  })
  if (!record) throw new ApiError(404, 'Unsubscribe link not found')
  return record
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="robots" content="noindex">` +
    `<title>${escapeHtml(title)}</title>` +
    `<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#222}` +
    `button{font-size:1rem;padding:.6rem 1.2rem;border:0;border-radius:6px;background:#1d4ed8;color:#fff;cursor:pointer}</style>` +
    `</head><body>${body}</body></html>`
}

// Public — no auth. Linked from every outreach email footer.
//
// GET is a SAFE confirmation page only: it must not change state, because mail
// clients and link scanners pre-fetch (GET) links and would otherwise
// unsubscribe a real prospect by accident. The actual suppression happens on
// POST (the confirm button below, or an RFC 8058 one-click client). Both are
// throttled per IP.
unsubscribeRouter.get(
  '/:token',
  unsubscribeRateLimit,
  asyncHandler(async (req, res) => {
    const token = String(req.params.token || '').trim()
    const record = await lookupToken(token)
    const html = page('Unsubscribe', (
      `<h1>Unsubscribe</h1>` +
      `<p>Confirm that <strong>${escapeHtml(record.toEmail)}</strong> should stop receiving outreach from this sender.</p>` +
      `<form method="POST" action="/api/unsubscribe/${encodeURIComponent(token)}">` +
      `<button type="submit">Unsubscribe me</button></form>`
    ))
    res.type('html').send(html)
  })
)

unsubscribeRouter.post(
  '/:token',
  unsubscribeRateLimit,
  asyncHandler(async (req, res) => {
    const record = await lookupToken(String(req.params.token || '').trim())
    await suppress(record.workspaceId, record.toEmail, 'UNSUBSCRIBED')

    // Respond in kind: JSON for API/one-click clients, an HTML confirmation for
    // a browser that submitted the form.
    if (req.accepts(['html', 'json']) === 'html') {
      res.type('html').send(page('Unsubscribed', (
        `<h1>You're unsubscribed</h1>` +
        `<p><strong>${escapeHtml(record.toEmail)}</strong> will not receive further outreach from this workspace.</p>`
      )))
      return
    }
    res.json({
      ok: true,
      message: `${record.toEmail} has been unsubscribed and will not receive further outreach from this workspace.`
    })
  })
)

// Authenticated owners only — suppression list management
unsubscribeRouter.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const workspaceId = String(req.query.workspaceId || '').trim()
    if (!workspaceId) throw new ApiError(400, 'workspaceId required')

    const userId = (req as AuthedRequest).user.id
    if (!await userHasWorkspaceAccess(userId, workspaceId)) throw new ApiError(403, 'Access denied')

    const suppressions = await prisma.suppression.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' }
    })
    res.json({ suppressions })
  })
)
