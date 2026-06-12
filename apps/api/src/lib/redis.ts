import IORedis from 'ioredis'

// Shared Redis client for non-queue API uses (e.g. one-time SSE tickets).
// Lazily connected so importing this module never opens a socket on its own.
let client: IORedis | null = null

export function getRedis(): IORedis {
  if (!client) {
    client = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      lazyConnect: true,
    })
    client.on('error', (err) => console.warn('[redis] connection error:', err.message))
  }
  return client
}
