import http from 'node:http'

// Minimal liveness/health HTTP server for the worker so orchestrators can probe
// it (a wedged worker otherwise looks "up"). Dependency-free; responds 200 on
// /health and /live, 404 otherwise.
export function startHealthServer(port: number): http.Server {
  const server = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/live') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, service: 'acaos-worker', timestamp: new Date().toISOString() }))
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
