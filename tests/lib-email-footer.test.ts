import test from 'node:test'
import assert from 'node:assert/strict'
import { buildOutreachEmail } from '../packages/backend-core/src/lib/emailFooter.ts'

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
