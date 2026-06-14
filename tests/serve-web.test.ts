import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import type { Server } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { mountWebApp, resolveWebDistDir } from '../apps/api/src/middleware/serveWeb.ts'
import { securityHeaders } from '../apps/api/src/middleware/securityHeaders.ts'
import { notFoundHandler } from '../apps/api/src/lib/http.ts'

function makeDist(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'acaos-web-'))
  writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>ACAOS</title>')
  mkdirSync(path.join(dir, 'assets'))
  writeFileSync(path.join(dir, 'assets', 'app.abc123.js'), 'console.log(1)')
  return dir
}

/** Start an app that mimics server.ts: security headers, a stub API router, the
 *  SPA mount, then the JSON 404 handler. */
async function startApp(distDir: string): Promise<{ base: string; close: () => Promise<void> }> {
  const app = express()
  app.use(securityHeaders)
  app.get('/api/health', (_req, res) => res.json({ ok: true }))
  mountWebApp(app, distDir)
  app.use(notFoundHandler)
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s))
  })
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}

test('resolveWebDistDir honors explicit arg and env over the default', () => {
  assert.equal(resolveWebDistDir('/tmp/x'), path.resolve('/tmp/x'))
  const prev = process.env.WEB_DIST_DIR
  process.env.WEB_DIST_DIR = '/tmp/from-env'
  try {
    assert.equal(resolveWebDistDir(), path.resolve('/tmp/from-env'))
  } finally {
    if (prev === undefined) delete process.env.WEB_DIST_DIR
    else process.env.WEB_DIST_DIR = prev
  }
})

test('mountWebApp returns false when no build is present', () => {
  const app = express()
  assert.equal(mountWebApp(app, path.join(tmpdir(), 'acaos-does-not-exist-xyz')), false)
})

test('SPA deep links resolve to index.html while /api still 404s as JSON', async () => {
  const dist = makeDist()
  const { base, close } = await startApp(dist)
  try {
    // Deep link → app shell.
    const deep = await fetch(`${base}/dashboard/leads`)
    assert.equal(deep.status, 200)
    assert.match(deep.headers.get('content-type') || '', /text\/html/)
    assert.match(await deep.text(), /ACAOS/)

    // Known API route still works.
    const health = await fetch(`${base}/api/health`)
    assert.equal(health.status, 200)
    assert.deepEqual(await health.json(), { ok: true })

    // Unknown API route is a JSON 404, NOT the SPA shell.
    const missing = await fetch(`${base}/api/nope`)
    assert.equal(missing.status, 404)
    assert.match(missing.headers.get('content-type') || '', /application\/json/)
  } finally {
    await close()
    rmSync(dist, { recursive: true, force: true })
  }
})

test('fingerprinted assets are cached immutably; index.html is not', async () => {
  const dist = makeDist()
  const { base, close } = await startApp(dist)
  try {
    const asset = await fetch(`${base}/assets/app.abc123.js`)
    assert.equal(asset.status, 200)
    assert.match(asset.headers.get('cache-control') || '', /immutable/)

    const shell = await fetch(`${base}/`)
    assert.equal(shell.headers.get('cache-control'), 'no-cache')
  } finally {
    await close()
    rmSync(dist, { recursive: true, force: true })
  }
})

test('CSP is strict for /api and SPA-friendly for web routes', async () => {
  const dist = makeDist()
  const { base, close } = await startApp(dist)
  try {
    const api = await fetch(`${base}/api/health`)
    assert.equal(api.headers.get('content-security-policy'), "default-src 'none'; frame-ancestors 'none'")

    const web = await fetch(`${base}/dashboard`)
    const csp = web.headers.get('content-security-policy') || ''
    assert.match(csp, /default-src 'self'/)
    assert.match(csp, /script-src 'self'/)
    assert.match(csp, /connect-src 'self'/)
  } finally {
    await close()
    rmSync(dist, { recursive: true, force: true })
  }
})
