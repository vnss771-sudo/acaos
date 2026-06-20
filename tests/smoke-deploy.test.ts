import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const script = path.resolve('scripts/smoke-deploy.mjs')
const servers = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })))
})

async function listen(handler) {
  const server = http.createServer(handler)
  servers.push(server)
  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', (error) => (error ? reject(error) : resolve()))
  })
  const address = server.address()
  assert(address && typeof address === 'object')
  return `http://127.0.0.1:${address.port}`
}

async function run(args, env = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ status: code ?? 1, stdout, stderr }))
  })
}

test('smoke-deploy accepts manifest expectations and checks metrics', async () => {
  const metricsToken = 'secret-token'
  const manifestPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'acaos-smoke-')), 'release-manifest.json')
  const manifest = {
    version: '1.2.3',
    commit: 'abcdef1234567890',
    releaseId: '1.2.3+abcdef123456',
  }
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`)

  const apiBase = await listen((req, res) => {
    if (req.url === '/api/ready') {
      res.writeHead(200, { 'content-type': 'application/json', 'X-Acaos-Release-Id': manifest.releaseId })
      res.end(JSON.stringify({ ok: true, version: manifest.version, commit: manifest.commit, releaseId: manifest.releaseId }))
      return
    }
    if (req.url === '/metrics') {
      assert.equal(req.headers.authorization, `Bearer ${metricsToken}`)
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('# HELP acaos_build_info Build info\nacaos_build_info{version="1.2.3"} 1\n')
      return
    }
    res.writeHead(404)
    res.end('not found')
  })

  const workerBase = await listen((req, res) => {
    if (req.url === '/ready') {
      res.writeHead(200, { 'content-type': 'application/json', 'X-Acaos-Release-Id': manifest.releaseId })
      res.end(JSON.stringify({ ok: true, version: manifest.version, commit: manifest.commit, releaseId: manifest.releaseId }))
      return
    }
    if (req.url === '/metrics') {
      assert.equal(req.headers.authorization, `Bearer ${metricsToken}`)
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('acaos_build_info{service="worker"} 1\n')
      return
    }
    res.writeHead(404)
    res.end('not found')
  })

  const result = await run([
    '--api-url', apiBase,
    '--worker-url', workerBase,
    '--manifest', manifestPath,
    '--metrics-token', metricsToken,
  ])

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /\[smoke\] ok/)
})

test('smoke-deploy fails on release drift across targets', async () => {
  const apiBase = await listen((req, res) => {
    if (req.url === '/api/ready') {
      res.writeHead(200, { 'content-type': 'application/json', 'X-Acaos-Release-Id': '1.0.0+aaaa' })
      res.end(JSON.stringify({ ok: true, version: '1.0.0', commit: 'aaaaaaaaaaaa', releaseId: '1.0.0+aaaa' }))
      return
    }
    res.writeHead(200)
    res.end('acaos_build_info 1\n')
  })

  const workerBase = await listen((req, res) => {
    if (req.url === '/ready') {
      res.writeHead(200, { 'content-type': 'application/json', 'X-Acaos-Release-Id': '1.0.0+bbbb' })
      res.end(JSON.stringify({ ok: true, version: '1.0.0', commit: 'bbbbbbbbbbbb', releaseId: '1.0.0+bbbb' }))
      return
    }
    res.writeHead(200)
    res.end('acaos_build_info 1\n')
  })

  const result = await run([
    '--api-url', apiBase,
    '--worker-url', workerBase,
  ])

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /release drift detected/)
})
