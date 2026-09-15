// Outbound webhooks: signed event delivery to customer-registered endpoints.
//
// The ecosystem/embeddability surface (and the foundation CRM sync will build on):
// ACAOS POSTs a signed JSON envelope to a customer URL whenever a subscribed event
// occurs. Signing mirrors the Stripe scheme (an `Acaos-Signature: t=<ts>,v1=<hmac>`
// header over `<ts>.<body>`), so customers can verify authenticity + guard against
// replay. The pure pieces (envelope, signing, retry policy) are unit-testable; only
// the final HTTP hop needs a live endpoint.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { request as httpsRequest } from 'node:https'
import { prisma } from './prisma.js'
import { logger } from './logger.js'
import { isProduction } from './config.js'
import { resolvePublicMailHost } from './ssrf.js'
import { decryptSecret, isEncrypted } from './encrypt.js'
import type { PrismaClient, Prisma } from '@prisma/client'

type Db = PrismaClient | Prisma.TransactionClient

// The event types a customer can subscribe an endpoint to. Keep in sync with the
// emit sites; a closed set keeps validation simple and documents the contract.
export const WEBHOOK_EVENT_TYPES = ['reply.received', 'campaign.sent', 'meeting.booked'] as const
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number]

export function isWebhookEventType(v: unknown): v is WebhookEventType {
  return typeof v === 'string' && (WEBHOOK_EVENT_TYPES as readonly string[]).includes(v)
}

export type WebhookEnvelope = {
  id: string
  type: string
  occurredAt: string
  data: Record<string, unknown>
}

/** Build the delivery envelope. Pure given id + occurredAt. */
export function buildWebhookEnvelope(type: string, data: Record<string, unknown>, id: string, occurredAt: Date): WebhookEnvelope {
  return { id, type, occurredAt: occurredAt.toISOString(), data }
}

/** A fresh signing secret for a new endpoint. */
export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString('hex')}`
}

// HMAC-SHA256 over `<timestamp>.<body>` — the timestamp is signed too so a captured
// delivery can't be replayed with a stale body. Pure/deterministic.
export function signWebhookBody(secret: string, timestampSeconds: number, body: string): string {
  return createHmac('sha256', secret).update(`${timestampSeconds}.${body}`).digest('hex')
}

/** The `Acaos-Signature` header value for a body. */
export function webhookSignatureHeader(secret: string, timestampSeconds: number, body: string): string {
  return `t=${timestampSeconds},v1=${signWebhookBody(secret, timestampSeconds, body)}`
}

// Customer-side verification helper (also used in tests): constant-time compare of
// the expected signature, with a tolerance window to bound replay. Exported so a
// consumer SDK / our own tests can reuse the exact scheme.
export function verifyWebhookSignature(secret: string, header: string, body: string, nowSeconds: number, toleranceSeconds = 300): boolean {
  const parts = Object.fromEntries(header.split(',').map((kv) => kv.split('=')))
  const t = Number(parts.t)
  if (!Number.isFinite(t) || Math.abs(nowSeconds - t) > toleranceSeconds) return false
  const expected = signWebhookBody(secret, t, body)
  const a = Buffer.from(expected)
  const b = Buffer.from(parts.v1 ?? '')
  return a.length === b.length && timingSafeEqual(a, b)
}

// Exponential backoff with a cap, for the (future) durable retry queue. Pure.
export function nextRetryDelaySeconds(attempt: number): number {
  return Math.min(60 * 60, 30 * 2 ** Math.max(0, attempt)) // 30s, 60s, 120s, … capped at 1h
}

// Consecutive failures after which an endpoint auto-disables (a dead URL must not be
// retried forever).
export const WEBHOOK_FAILURE_DISABLE_THRESHOLD = 15

export type DeliveryResult = { ok: boolean; status: number | null }
export type DeliverDeps = { fetch?: typeof fetch; now?: () => number; timeoutMs?: number }

/**
 * Deliver one webhook through a DNS-pinned HTTPS connection.
 *
 * Production never uses the global fetch() transport: resolving a hostname for
 * validation and then asking fetch() to resolve it again leaves a DNS-rebinding
 * window between the check and the connect. Here the pinned IP is dialled
 * directly (port 443 only) while TLS SNI/certificate verification still uses the
 * customer's original hostname via `servername`. `agent: false` opts out of any
 * proxy/env-mediated routing so the socket only ever reaches the validated address.
 */
async function deliverPinnedHttps(
  url: URL,
  secret: string,
  envelope: WebhookEnvelope,
  nowSec: number,
  timeoutMs: number,
): Promise<DeliveryResult> {
  const pinned = await resolvePublicMailHost(url.hostname, 'webhook url')
  const body = JSON.stringify(envelope)
  return await new Promise<DeliveryResult>((resolve) => {
    const req = httpsRequest({
      protocol: 'https:',
      hostname: pinned.host,
      port: 443,
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      servername: pinned.servername,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Acaos-Signature': webhookSignatureHeader(secret, nowSec, body),
        'Acaos-Event': envelope.type,
        'Acaos-Delivery': envelope.id,
      },
      timeout: timeoutMs,
      agent: false,
    }, (res) => {
      res.resume()
      resolve({ ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300, status: res.statusCode ?? null })
    })
    req.once('timeout', () => req.destroy(new Error('webhook timeout')))
    req.once('error', () => resolve({ ok: false, status: null }))
    req.end(body)
  })
}

// Sign + POST one envelope to one endpoint. NEVER throws on a bad customer URL — a
// broken endpoint must not break the action that triggered the event. HTTPS on the
// default port is required and redirects are never followed, closing redirect- and
// DNS-rebinding-based SSRF against internal services.
//
// `deps.fetch` is a test-only transport seam; supplying it in production would
// silently bypass the pinned transport below, so that combination throws instead
// of failing open.
export async function deliverWebhook(
  endpoint: { url: string; secret: string },
  envelope: WebhookEnvelope,
  deps: DeliverDeps = {},
): Promise<DeliveryResult> {
  if (deps.fetch && isProduction()) {
    throw new Error('deliverWebhook: deps.fetch is a test-only transport and must never be supplied in production')
  }
  const nowSec = Math.floor((deps.now ? deps.now() : Date.now()) / 1000)
  try {
    const url = new URL(endpoint.url)
    if (url.protocol !== 'https:') return { ok: false, status: null }
    if (url.port && url.port !== '443') return { ok: false, status: null }

    if (deps.fetch) {
      const body = JSON.stringify(envelope)
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? 5000)
      try {
        const res = await deps.fetch(endpoint.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Acaos-Signature': webhookSignatureHeader(endpoint.secret, nowSec, body),
            'Acaos-Event': envelope.type,
            'Acaos-Delivery': envelope.id,
          },
          body,
          signal: controller.signal,
        })
        return { ok: res.status >= 200 && res.status < 300, status: res.status }
      } finally {
        clearTimeout(timer)
      }
    }

    return await deliverPinnedHttps(url, endpoint.secret, envelope, nowSec, deps.timeoutMs ?? 5000)
  } catch {
    return { ok: false, status: null }
  }
}

// Persist the outcome of a delivery: bump or reset failureCount, stamp last-status,
// and auto-disable an endpoint that has failed too many times in a row.
export async function recordDeliveryOutcome(client: Db, endpointId: string, result: DeliveryResult, currentFailures: number): Promise<void> {
  const failureCount = result.ok ? 0 : currentFailures + 1
  await client.webhookEndpoint.update({
    where: { id: endpointId },
    data: {
      lastDeliveryAt: new Date(),
      lastStatus: result.status,
      failureCount,
      ...(failureCount >= WEBHOOK_FAILURE_DISABLE_THRESHOLD ? { enabled: false } : {}),
    },
  })
}

// Emit an event to every enabled endpoint in the workspace subscribed to it.
// Best-effort and fully isolated: a failing endpoint is recorded and skipped, never
// thrown. (Durable retry via a delivery queue is the documented next step; today a
// transient failure is counted toward auto-disable but not re-queued.)
export async function emitWebhookEvent(
  workspaceId: string,
  type: WebhookEventType,
  data: Record<string, unknown>,
  client: Db = prisma,
  deps: DeliverDeps = {},
): Promise<void> {
  try {
    const endpoints = await client.webhookEndpoint.findMany({
      where: { workspaceId, enabled: true, eventTypes: { has: type } },
    })
    if (endpoints.length === 0) return
    const occurredAt = new Date()
    await Promise.all(
      endpoints.map(async (ep: { id: string; url: string; secret: string; failureCount: number }) => {
        // Isolated per-endpoint: an unreadable secret (e.g. a stale key version) on
        // one endpoint must not abort delivery to the workspace's other endpoints.
        try {
          const envelope = buildWebhookEnvelope(type, data, `evt_${randomBytes(12).toString('hex')}`, occurredAt)
          const secret = isEncrypted(ep.secret) ? decryptSecret(ep.secret) : ep.secret
          const result = await deliverWebhook({ ...ep, secret }, envelope, deps)
          await recordDeliveryOutcome(client, ep.id, result, ep.failureCount).catch(() => {})
        } catch (err) {
          logger.warn('webhook delivery failed', { endpointId: ep.id, error: (err as Error).message })
        }
      }),
    )
  } catch (err) {
    logger.warn('webhook emit failed', { type, error: (err as Error).message })
  }
}
