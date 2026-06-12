import { createHmac } from 'node:crypto'
import { cfg } from './env.js'

// Sign a click-tracking URL so it cannot be used as an open redirect.
// The signature covers both the outcome ID and the destination URL.
export function signTrackingUrl(apiBase: string, outcomeId: string, destinationUrl: string): string {
  const sig = hmacSign(outcomeId, destinationUrl)
  const params = new URLSearchParams({ url: destinationUrl, sig })
  return `${apiBase}/api/track/click/${outcomeId}?${params}`
}

export function verifyTrackingUrl(outcomeId: string, destinationUrl: string, sig: string): boolean {
  const expected = hmacSign(outcomeId, destinationUrl)
  // Constant-time comparison
  if (expected.length !== sig.length) return false
  let mismatch = 0
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ sig.charCodeAt(i)
  }
  return mismatch === 0
}

function hmacSign(outcomeId: string, destinationUrl: string): string {
  return createHmac('sha256', cfg.trackingSecret)
    .update(`${outcomeId}:${destinationUrl}`)
    .digest('hex')
}
