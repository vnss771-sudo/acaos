import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, requireVerifiedForMutation } from '../middleware/auth.js'
import { asyncHandler, ApiError, requireUser } from '../lib/http.js'
import { prisma } from '@acaos/backend-core/lib/prisma.js'
import { userBelongsToWorkspace } from '../lib/workspaces.js'
import { assertWorkspacePermission } from '../lib/permissions.js'
import { parseQuery, parseBody, workspaceIdField } from '../lib/validate.js'
import { generateWebhookSecret, WEBHOOK_EVENT_TYPES, isWebhookEventType } from '@acaos/backend-core/lib/webhooks.js'
import { resolvePublicMailHost } from '@acaos/backend-core/lib/ssrf.js'
import { encryptSecret, decryptSecret, isEncrypted } from '@acaos/backend-core/lib/encrypt.js'
import { recordAudit } from '@acaos/backend-core/lib/audit.js'

// Outbound-webhook endpoint management. Customers register a URL + the events they
// want; ACAOS POSTs signed payloads to it. Managing endpoints is an admin-level
// integration action (workspace:update); listing is member-readable. The signing
// secret is returned in FULL exactly once (on create) and masked everywhere after.
export const webhooksRouter = Router()
webhooksRouter.use(requireAuth)
webhooksRouter.use(requireVerifiedForMutation)

const listQuerySchema = z.object({ workspaceId: workspaceIdField })

const createSchema = z.object({
  workspaceId: workspaceIdField,
  url: z.string().url().max(2048),
  eventTypes: z.array(z.string()).min(1).max(WEBHOOK_EVENT_TYPES.length),
})

const idParamsSchema = z.object({ id: z.string().min(1) })

// Never leak the full secret after creation — show only a recognizable prefix.
function maskSecret(secret: string): string {
  return `${secret.slice(0, 11)}…`
}
// Stored secrets are encrypted at rest (see POST below); decrypt only for display
// masking. Falls back to the raw value for any pre-encryption row still in the DB.
function displaySecret(stored: string): string {
  return isEncrypted(stored) ? decryptSecret(stored) : stored
}
function publicEndpoint(e: { id: string; url: string; secret: string; eventTypes: string[]; enabled: boolean; failureCount: number; lastDeliveryAt: Date | null; lastStatus: number | null; createdAt: Date }) {
  return {
    id: e.id, url: e.url, secretMasked: maskSecret(displaySecret(e.secret)), eventTypes: e.eventTypes,
    enabled: e.enabled, failureCount: e.failureCount, lastDeliveryAt: e.lastDeliveryAt, lastStatus: e.lastStatus, createdAt: e.createdAt,
  }
}

// GET /api/webhooks?workspaceId= — list the workspace's endpoints (secrets masked).
webhooksRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const user = requireUser(req)
    const { workspaceId } = parseQuery(listQuerySchema, req)
    if (!(await userBelongsToWorkspace(user.id, workspaceId))) throw new ApiError(403, 'Access denied')
    const endpoints = await prisma.webhookEndpoint.findMany({ where: { workspaceId }, orderBy: { createdAt: 'desc' } })
    res.json({ endpoints: endpoints.map(publicEndpoint), supportedEvents: WEBHOOK_EVENT_TYPES })
  })
)

// POST /api/webhooks — register an endpoint. Returns the signing secret in FULL,
// once. Admin-level (workspace:update).
webhooksRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const user = requireUser(req)
    const { workspaceId, url, eventTypes } = parseBody(createSchema, req)
    await assertWorkspacePermission(user.id, workspaceId, 'workspace:update')

    const invalid = eventTypes.filter((t) => !isWebhookEventType(t))
    if (invalid.length) throw new ApiError(400, `Unsupported event type(s): ${invalid.join(', ')}`)
    const unique = [...new Set(eventTypes)]

    // Reject anything that isn't a plain HTTPS endpoint on the default port, and
    // resolve the hostname now so a self-serve admin can't register an internal or
    // metadata address (delivery re-resolves immediately before every connect, so
    // this is a fast-fail for the obvious case, not the only check).
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') throw new ApiError(400, 'url must use https')
    if (parsed.port && parsed.port !== '443') throw new ApiError(400, 'url must use the default https port (443)')
    await resolvePublicMailHost(parsed.hostname, 'url')

    const secret = generateWebhookSecret()
    // Stored encrypted — a DB-only leak must not hand out a live signing secret.
    const endpoint = await prisma.webhookEndpoint.create({ data: { workspaceId, url, eventTypes: unique, secret: encryptSecret(secret) } })
    void recordAudit({ workspaceId, actorUserId: user.id, type: 'webhook.created', entityType: 'WebhookEndpoint', entityId: endpoint.id, metadata: { url, eventTypes: unique } })

    // The ONLY time the full secret is returned — the caller must store it now.
    res.status(201).json({ endpoint: publicEndpoint(endpoint), secret })
  })
)

// DELETE /api/webhooks/:id — remove an endpoint. Admin-level, workspace-scoped.
webhooksRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const user = requireUser(req)
    const { id } = idParamsSchema.parse(req.params)
    const endpoint = await prisma.webhookEndpoint.findUnique({ where: { id } })
    if (!endpoint) throw new ApiError(404, 'Webhook endpoint not found')
    await assertWorkspacePermission(user.id, endpoint.workspaceId, 'workspace:update')
    await prisma.webhookEndpoint.delete({ where: { id } })
    void recordAudit({ workspaceId: endpoint.workspaceId, actorUserId: user.id, type: 'webhook.deleted', entityType: 'WebhookEndpoint', entityId: id })
    res.json({ deleted: true, id })
  })
)
