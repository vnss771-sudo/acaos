import { randomBytes, createHash } from 'node:crypto'

// Workspace ingest API keys. The raw key is shown to the user exactly once on
// rotation; only its SHA-256 hash is stored, so a database read/leak does not
// expose live keys (mirrors how refresh tokens are handled).

export function generateApiKey(): string {
  return randomBytes(32).toString('hex')
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}
