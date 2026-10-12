// ABN Lookup (Australian Business Register) verification of a workspace's sender entity.
//
// ACMA guidance: identify the sender by legal name, or name plus ABN. This verifies an ABN
// against the ABR JSON web service and returns the registered entity and ABN status.
//
// Safety:
//  - The ABR GUID is a secret that travels as a `guid=` query parameter. It is never put in an
//    error message, log or stored field: errors are built from fixed strings, run through
//    scrubSecrets, and fetchWithTimeout strips query strings from timeouts (see D1).
//  - The ABN checksum is validated locally first, so malformed input never spends a request.
//  - The lookup is a GET (idempotent), so callProvider's retry/backoff/Retry-After apply.
//  - ABR terms (rate/display) must be accepted before enabling: see docs/DESIGN_au_spam_act_consent.md.
//
// Response contract, verified against ABR's official JSON sample code
// (https://abr.business.gov.au/json/ + Script/abnlookup-sample.js, v9.1): request
// `AbnDetails.aspx?abn=&guid=&callback=`; JSONP response whose callback receives an object with
// Acn, EntityName, AbnStatus, AbnStatusEffectiveFrom, EntityTypeName, EntityTypeCode, Gst,
// AddressState, AddressPostcode, BusinessName[] and Message. The sample reads `Message` as the error
// text. The sample never reads an `Abn` key, so it is optional here: when present it must match the
// ABN asked for, when absent the match is implied by the request. Everything else is ignored.

import { z } from 'zod'
import { callProvider, ProviderError, type BreakerLike } from './providerClient.js'
import { abrBreaker } from './circuit.js'
import { scrubSecrets } from './fetchWithTimeout.js'

const ABR_ENDPOINT = 'https://abr.business.gov.au/json/AbnDetails.aspx'
const ABN_WEIGHTS = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19]

/** Digits only, or null unless exactly 11 digits. */
export function normalizeAbn(input: string | null | undefined): string | null {
  const d = (input ?? '').replace(/[\s-]/g, '')
  return /^\d{11}$/.test(d) ? d : null
}

/** ATO ABN checksum: subtract 1 from the first digit, weight, sum divisible by 89. */
export function isValidAbnChecksum(abn: string): boolean {
  const d = normalizeAbn(abn)
  if (!d) return false
  const digits = d.split('').map(Number)
  digits[0] = digits[0]! - 1
  const sum = digits.reduce((acc, n, i) => acc + n * ABN_WEIGHTS[i]!, 0)
  return sum % 89 === 0
}

export type AbnStatus = 'active' | 'cancelled'

export type AbnLookupResult = {
  abn: string
  status: AbnStatus
  entityName: string
  entityType: string | null
}

const abrPayload = z.object({
  Abn: z.string().optional().default(''),
  AbnStatus: z.string().optional().default(''),
  EntityName: z.string().optional().default(''),
  EntityTypeName: z.string().optional().default(''),
  Message: z.string().optional().default(''),
})

/** The service answers JSONP (`cb({...})`) unless told otherwise; accept either. */
export function parseAbrBody(text: string): z.infer<typeof abrPayload> {
  const trimmed = text.trim()
  const m = trimmed.match(/^[\w$.]*\(([\s\S]*)\)\s*;?$/)
  const json = JSON.parse(m ? m[1]! : trimmed)
  return abrPayload.parse(json)
}

export type LookupOptions = {
  guid?: string
  fetchImpl?: (url: string | URL, init: RequestInit, timeoutMs: number) => Promise<Response>
  sleepImpl?: (ms: number) => Promise<void>
  /** Test seam; defaults to the shared ABR circuit breaker. */
  breaker?: BreakerLike
}

export class AbnLookupNotConfiguredError extends Error {
  constructor() { super('ABN verification is not configured (ABR_GUID is not set)'); this.name = 'AbnLookupNotConfiguredError' }
}

/**
 * Verify an ABN. Returns null when the ABR has no such ABN (or the checksum fails — no request is
 * made). Throws AbnLookupNotConfiguredError without a GUID; ProviderError on provider failure.
 */
export async function lookupAbn(abnInput: string, opts: LookupOptions = {}): Promise<AbnLookupResult | null> {
  const abn = normalizeAbn(abnInput)
  if (!abn || !isValidAbnChecksum(abn)) return null
  const guid = (opts.guid ?? process.env.ABR_GUID ?? '').trim()
  if (!guid) throw new AbnLookupNotConfiguredError()

  // Test seam: lets the browser E2E point the server at a local stub. Honoured only outside
  // production, so a stray env var can never redirect real lookups (or the GUID) elsewhere.
  const endpoint = process.env.NODE_ENV !== 'production' && process.env.ABR_ENDPOINT ? process.env.ABR_ENDPOINT : ABR_ENDPOINT
  const url = new URL(endpoint)
  url.searchParams.set('abn', abn)
  url.searchParams.set('guid', guid)

  try {
    return await callProvider<AbnLookupResult | null>({
      provider: 'abr',
      operation: 'AbnDetails',
      url,
      init: { method: 'GET', headers: { Accept: 'application/json' } },
      timeoutMs: 10_000,
      breaker: opts.breaker ?? abrBreaker,
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl, sleepImpl: opts.sleepImpl ?? (async () => {}) } : {}),
      onSuccess: async (res) => {
        let body: z.infer<typeof abrPayload>
        try {
          body = parseAbrBody(await res.text())
        } catch {
          throw new ProviderError('abr', 'AbnDetails', 'server_error', null, 'abr AbnDetails: unreadable response')
        }
        if (body.Message) {
          // A rejected GUID is a configuration fault, not "no such business".
          if (/guid/i.test(body.Message)) {
            throw new ProviderError('abr', 'AbnDetails', 'client_error', null, 'abr AbnDetails: the ABR rejected the configured GUID')
          }
          return null
        }
        if (body.Abn && body.Abn.replace(/\s/g, '') !== abn) return null
        const status = body.AbnStatus.toLowerCase()
        if (status !== 'active' && status !== 'cancelled') return null
        if (!body.EntityName.trim()) return null
        return { abn, status, entityName: body.EntityName.trim().slice(0, 200), entityType: body.EntityTypeName.trim().slice(0, 100) || null }
      },
    })
  } catch (err) {
    if (err instanceof ProviderError) {
      // Rebuild with a scrubbed message so no variant of the URL can survive.
      throw new ProviderError(err.provider, err.operation, err.kind, err.providerStatus, scrubSecrets(err.message))
    }
    throw err
  }
}

/** The ABN to print in a footer: only a verified, active one. */
export function verifiedAbn(ws: { senderAbn?: string | null; senderAbnStatus?: string | null } | null | undefined): string | null {
  return ws?.senderAbnStatus === 'active' ? normalizeAbn(ws.senderAbn) : null
}
