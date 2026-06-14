// Unit tests for the HTML-escaping helper used on untrusted values in emails.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { escapeHtml } from '../apps/api/src/lib/html.ts'

test('escapeHtml neutralizes markup-significant characters', () => {
  assert.equal(escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;')
  assert.equal(escapeHtml(`"&'`), '&quot;&amp;&#39;')
  assert.equal(escapeHtml('Acme & Co <b>'), 'Acme &amp; Co &lt;b&gt;')
})

test('escapeHtml leaves ordinary text untouched and handles nullish input', () => {
  assert.equal(escapeHtml('Northwind Traders'), 'Northwind Traders')
  assert.equal(escapeHtml(null), '')
  assert.equal(escapeHtml(undefined), '')
})

test('escapeHtml escapes a name crafted to break out of an attribute or tag', () => {
  const injected = `"><img src=x onerror=alert(1)>`
  const out = escapeHtml(injected)
  assert.ok(!out.includes('<img'), 'tag must be escaped')
  assert.ok(!out.includes('">'), 'attribute breakout must be escaped')
})
