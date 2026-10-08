#!/usr/bin/env node
// Serve the production web build (apps/web/dist) with the exact server-level
// security headers from nginx.conf, proxying /api to the local API. Used by the
// strict-CSP Playwright spec so the browser enforces the real production policy,
// which the Vite dev server (inline <style> injection for HMR) cannot do.
//
//   node scripts/serve-web-csp.mjs [--port 4173] [--api http://localhost:4000]

import { createServer, request as httpRequest } from 'node:http'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { resolve, join, extname, normalize, sep } from 'node:path'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const port = Number(arg('port', process.env.CSP_WEB_PORT || '4173'))
const api = new URL(arg('api', process.env.CSP_API_URL || 'http://localhost:4000'))
const dist = resolve('apps/web/dist')

if (!existsSync(join(dist, 'index.html'))) {
  console.error('[serve-web-csp] apps/web/dist/index.html missing; run `npm run build -w @acaos/web` first')
  process.exit(1)
}

/** Server-level `add_header Name "value" always;` directives, i.e. those before the first location block. */
function nginxServerHeaders(conf) {
  const serverLevel = conf.split(/\n\s*location\s/)[0]
  const headers = {}
  for (const m of serverLevel.matchAll(/^\s*add_header\s+([A-Za-z-]+)\s+"([^"]*)"/gm)) headers[m[1]] = m[2]
  return headers
}

const securityHeaders = nginxServerHeaders(readFileSync(resolve('nginx.conf'), 'utf8'))
if (!securityHeaders['Content-Security-Policy']) {
  console.error('[serve-web-csp] nginx.conf has no server-level Content-Security-Policy')
  process.exit(1)
}

const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.webmanifest': 'application/manifest+json',
}

function proxy(req, res) {
  const upstream = httpRequest({
    hostname: api.hostname, port: api.port, path: req.url, method: req.method,
    headers: { ...req.headers, host: api.host },
  }, (up) => {
    res.writeHead(up.statusCode ?? 502, up.headers)
    up.pipe(res)
  })
  upstream.on('error', () => { res.writeHead(502); res.end('api unavailable') })
  req.pipe(upstream)
}

createServer((req, res) => {
  if (req.url?.startsWith('/api/') || req.url === '/api') return proxy(req, res)

  const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)
  let file = normalize(join(dist, path))
  if (!file.startsWith(dist + sep) && file !== dist) { res.writeHead(400); return res.end() }
  // SPA fallback, mirroring nginx `try_files $uri $uri/ /index.html`.
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(dist, 'index.html')

  res.writeHead(200, { ...securityHeaders, 'Content-Type': types[extname(file)] ?? 'application/octet-stream' })
  res.end(readFileSync(file))
}).listen(port, () => console.log(`[serve-web-csp] http://localhost:${port} (api ${api.origin})`))
