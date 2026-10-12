import test from 'node:test'
import assert from 'node:assert/strict'
import { collectWebsiteDocument, WebsiteFetchError } from '../packages/backend-core/src/lib/websiteEvidenceFetch.js'

const ips = async () => [{ address: '8.8.8.8', family: 4 }]
const page = async () => ({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: Buffer.from('<h1>Evidence</h1>') })

test('collects bounded HTTPS HTML with provenance', async () => {
  const r = await collectWebsiteDocument('https://contractor.example.com/jobs', { resolve: ips, transport: page, now: () => new Date('2026-10-12T00:00:00Z') })
  assert.equal(r.sourceUrl, 'https://contractor.example.com/jobs')
  assert.equal(r.retrievedAt, '2026-10-12T00:00:00.000Z')
  assert.equal(r.bytes, Buffer.byteLength('<h1>Evidence</h1>'))
})

test('rejects unsafe URLs before DNS', async () => {
  for (const url of ['http://example.com', 'https://127.0.0.1/', 'https://localhost/', 'https://a.local/', 'https://user:pass@example.com/', 'https://example.com/?token=secret', 'https://example.com:8443/']) {
    await assert.rejects(collectWebsiteDocument(url, { resolve: ips, transport: page }), WebsiteFetchError)
  }
})

test('rejects private or mixed DNS answer sets', async () => {
  for (const address of ['127.0.0.1', '169.254.169.254', '10.0.0.7', '192.0.2.1', '198.18.0.1']) {
    await assert.rejects(collectWebsiteDocument('https://example.com/', { resolve: async () => [{ address, family: 4 }], transport: page }), /non_public_address/)
  }
  await assert.rejects(collectWebsiteDocument('https://example.com/', { resolve: async () => [...await ips(), { address: '10.1.1.1', family: 4 }], transport: page }), /non_public_address/)
})

test('rechecks every redirect destination and rejects non-HTTPS redirects', async () => {
  let calls = 0
  await assert.rejects(collectWebsiteDocument('https://example.com/', {
    resolve: async () => { calls++; return calls === 1 ? await ips() : [{ address: '127.0.0.1', family: 4 }] },
    transport: async () => ({ status: 302, headers: { location: 'https://other.com/' }, body: Buffer.alloc(0) }),
  }), /non_public_address/)
  assert.equal(calls, 2)
  await assert.rejects(collectWebsiteDocument('https://example.com/', { resolve: ips, transport: async () => ({ status: 302, headers: { location: 'http://other.com/' }, body: Buffer.alloc(0) }) }), /url_not_permitted/)
})

test('fails closed for large, binary or non-HTML responses', async () => {
  for (const response of [
    { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.alloc(512 * 1024 + 1) },
    { status: 200, headers: { 'content-type': 'image/jpeg' }, body: Buffer.from('image') },
    { status: 200, headers: { 'content-type': 'text/plain' }, body: Buffer.from([0, 1]) },
  ]) {
    await assert.rejects(collectWebsiteDocument('https://example.com/', { resolve: ips, transport: async () => response }), WebsiteFetchError)
  }
})
