import http from 'node:http'
import { getRuntimeMetadata } from '@acaos/backend-core/lib/release.js'
import { isProduction } from '@acaos/backend-core/lib/config.js'
import { renderWorkerMetrics, METRICS_CONTENT_TYPE, type QueueDepth } from './lib/metrics.js'

type HealthOptions = {
  collectQueueDepths?: () => Promise<QueueDepth[]>
  isReady?: () => boolean | Promise<boolean>
}

const SERVICE = 'acaos-worker'

export function startHealthServer(port: number, opts: HealthOptions = {}): http.Server {
  const server = http.createServer((req, res) => {
    const metadata = getRuntimeMetadata(SERVICE)
    res.setHeader('X-Acaos-Release-Id', metadata.releaseId)

    if (req.url === '/health' || req.url === '/live') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, service: SERVICE, releaseId: metadata.releaseId, version: metadata.version, commit: metadata.commit, timestamp: new Date().toISOString() }))
      return
    }

    if (req.url === '/ready') {
      Promise.resolve(opts.isReady ? opts.isReady() : true)
        .then((ready) => {
          res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            ok: ready,
            service: SERVICE,
            ready,
            releaseId: metadata.releaseId,
            version: metadata.version,
            commit: metadata.commit,
            timestamp: new Date().toISOString(),
          }))
        })
        .catch(() => {
          res.writeHead(503, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            ok: false,
            service: SERVICE,
            ready: false,
            releaseId: metadata.releaseId,
            version: metadata.version,
            commit: metadata.commit,
            timestamp: new Date().toISOString(),
          }))
        })
      return
    }

    if (req.url === '/metrics') {
      const token = process.env.METRICS_TOKEN?.trim()
      if (!token) {
        // No token configured: refuse in production rather than exposing metrics
        // unauthenticated (404, not 401, so the endpoint isn't probeable).
        if (isProduction()) {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Not found' }))
          return
        }
      } else if (req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Unauthorized' }))
        return
      }
      const finish = (depths: QueueDepth[]) => {
        res.writeHead(200, { 'Content-Type': METRICS_CONTENT_TYPE })
        res.end(renderWorkerMetrics(depths))
      }
      const collect = opts.collectQueueDepths
      if (!collect) { finish([]); return }
      collect()
        .then(finish)
        .catch(() => finish([]))
      return
    }

    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Not found' }))
  })
  server.listen(port, () => {
    console.log(`[worker] health server listening on :${port}`)
  })
  server.unref()
  return server
}
