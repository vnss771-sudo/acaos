// Outbound webhooks: signed event delivery to customer-registered endpoints.
//
// The ecosystem/embeddability surface (and the foundation CRM sync will build on):
// ACAOS POSTs a signed JSON envelope to a customer URL whenever a subscribed event
// occurs. Signing mirrors the Stripe scheme (an `Acaos-Signature: t=<ts>,v1=<hmac>`
// header over `<ts>.<body>`), so customers can verify authenticity + guard against
// replay. The pure pieces (envelope, signing, retry policy) are unit-testable; only
// the final HTTP hop needs a live endpoint.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { prisma } from './prisma.js'
import { logger } from './logger.js'
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

// Sign + POST one envelope to one endpoint. NEVER throws — a customer's broken URL
// must not break the action that triggered the event. Returns the outcome so the
// caller can update delivery health.
export async function deliverWebhook(
  endpoint: { url: string; secret: string },
  envelope: WebhookEnvelope,
  deps: DeliverDeps = {},
): Promise<DeliveryResult> {
  const doFetch = deps.fetch ?? fetch
  const nowSec = Math.floor((deps.now ? deps.now() : Date.now()) / 1000)
  const body = JSON.stringify(envelope)
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? 5000)
    try {
      const res = await doFetch(endpoint.url, {
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
        const envelope = buildWebhookEnvelope(type, data, `evt_${randomBytes(12).toString('hex')}`, occurredAt)
        const result = await deliverWebhook(ep, envelope, deps)
        await recordDeliveryOutcome(client, ep.id, result, ep.failureCount).catch(() => {})
      }),
    )
  } catch (err) {
    logger.warn('webhook emit failed', { type, error: (err as Error).message })
  }
}
