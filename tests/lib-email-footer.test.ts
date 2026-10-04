import test from 'node:test'
import assert from 'node:assert/strict'
import { buildOutreachEmail, resolveUnsubscribeBaseUrl } from '../packages/backend-core/src/lib/emailFooter.ts'

// The unsubscribe link must never point at localhost in production: a worker
// deployed without API_URL used to mail http://localhost:4000 links.
test('unsubscribe base URL comes from API_URL, without a trailing slash', () => {
  assert.equal(resolveUnsubscribeBaseUrl({ API_URL: 'https://api.acaos.test/', NODE_ENV: 'production' }), 'https://api.acaos.test')
})

test('unsubscribe base URL is null in production when API_URL is missing or blank', () => {
  assert.equal(resolveUnsubscribeBaseUrl({ NODE_ENV: 'production' }), null)
  assert.equal(resolveUnsubscribeBaseUrl({ API_URL: '  ', NODE_ENV: 'production' }), null)
})

test('unsubscribe base URL falls back to the local API outside production', () => {
  assert.equal(resolveUnsubscribeBaseUrl({ NODE_ENV: 'development' }), 'http://localhost:4000')
  assert.equal(resolveUnsubscribeBaseUrl({}), 'http://localhost:4000')
})

const base = { body: 'Hi there,\nQuick question about scheduling.', appUrl: 'https://api.acaos.test/', unsubscribeToken: 'tok123' }

test('includes sender business name AND physical address (CAN-SPAM) in html + text', () => {
  const r = buildOutreachEmail({ ...base, senderBusinessName: 'Acme Co', senderPostalAddress: '1 Main St, Springfield' })
  assert.ok(r.htmlBody.includes('Acme Co'))
  assert.ok(r.htmlBody.includes('1 Main St, Springfield'))
  assert.ok(r.textBody.includes('Acme Co'))
  assert.ok(r.textBody.includes('1 Main St, Springfield'))
})

test('always includes the unsubscribe link (html + text + returned url)', () => {
  const r = buildOutreachEmail(base)
  assert.equal(r.unsubscribeUrl, 'https://api.acaos.test/api/unsubscribe/tok123')
  assert.ok(r.htmlBody.includes('/api/unsubscribe/tok123'))
  assert.ok(r.textBody.includes('/api/unsubscribe/tok123'))
})

test('omits the sender line cleanly when business name is absent (no stray comma)', () => {
  const r = buildOutreachEmail({ ...base, senderPostalAddress: '1 Main St' })
  assert.ok(!r.htmlBody.includes('1 Main St'), 'address without a name should not appear')
  assert.ok(!r.textBody.includes('1 Main St'))
})

test('escapes the single-quote in sender identity (attribute-safe)', () => {
  const r = buildOutreachEmail({ ...base, senderBusinessName: "O'Brien & Sons" })
  assert.ok(r.htmlBody.includes('O&#39;Brien &amp; Sons'))
  assert.ok(!r.htmlBody.includes("O'Brien & Sons"), 'raw single-quote/ampersand must not survive into html')
})

test('trailing slash on appUrl is normalized (no double slash)', () => {
  const r = buildOutreachEmail({ ...base, appUrl: 'https://api.acaos.test///' })
  assert.ok(!r.unsubscribeUrl.includes('///'))
  assert.equal(r.unsubscribeUrl, 'https://api.acaos.test/api/unsubscribe/tok123')
})
