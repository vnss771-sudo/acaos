import http from 'node:http'
import { renderWorkerMetrics, METRICS_CONTENT_TYPE, type QueueDepth } from './lib/metrics.js'

type HealthOptions = {
  // Returns live BullMQ queue depths for the /metrics gauge. Optional so the
  // health server still works (just without queue gauges) if not supplied.
  collectQueueDepths?: () => Promise<QueueDepth[]>
}

// Minimal liveness/health + metrics HTTP server for the worker so orchestrators
// can probe it (a wedged worker otherwise looks "up") and Prometheus can scrape
// background-job metrics. Dependency-free; 200 on /health|/live, Prometheus text
// on /metrics, 404 otherwise.
export function startHealthServer(port: number, opts: HealthOptions = {}): http.Server {
  const server = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/live') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, service: 'acaos-worker', timestamp: new Date().toISOString() }))
      return
    }
    if (req.url === '/metrics') {
      // Same optional bearer-token gate as the API's /metrics.
      const token = process.env.METRICS_TOKEN?.trim()
      if (token && req.headers.authorization !== `Bearer ${token}`) {
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
        .catch(() => finish([])) // never fail a scrape over a Redis hiccup
      return
    }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Not found' }))
  })
  server.listen(port, () => {
    console.log(`[worker] health server listening on :${port}`)
  })
  // Don't let the health server keep the process alive on its own.
  server.unref()
  return server
}
