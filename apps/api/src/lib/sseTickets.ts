import { randomBytes } from 'node:crypto'
import { getRedis } from './redis.js'

// Short-lived, single-use tickets for authenticating an EventSource (SSE)
// stream. EventSource can't send an Authorization header, and putting a JWT in
// the query string leaks it into logs/history. Instead the client exchanges its
// normal credentials for a ticket, then opens the stream with ?ticket=. The
// ticket is bound to a user, expires quickly, and is consumed atomically so it
// can only be used once.

const TTL_SECONDS = 60
const PREFIX = 'sse:ticket:'

export async function issueSseTicket(userId: string): Promise<string> {
  const ticket = randomBytes(32).toString('hex')
  await getRedis().set(PREFIX + ticket, userId, 'EX', TTL_SECONDS)
  return ticket
}

/** Atomically redeem a ticket, returning the bound userId, or null if invalid. */
export async function consumeSseTicket(ticket: string): Promise<string | null> {
  if (!ticket) return null
  return getRedis().getdel(PREFIX + ticket)
}
