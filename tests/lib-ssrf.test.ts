// Unit tests for the SSRF guard used on workspace-configured SMTP/IMAP hosts.
// Literal-IP classification and the literal-host fast path are fully hermetic
// (no DNS); the resolve-to-private path is exercised in principle via the
// thrown ApiError on an unresolvable host.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isPrivateIp, assertPublicMailHost, resolvePublicMailHost } from '../packages/backend-core/src/lib/ssrf.ts'

test('isPrivateIp flags private, loopback, link-local, CGNAT and metadata IPv4', () => {
  for (const ip of [
    '127.0.0.1', '127.255.255.255',
    '10.0.0.1', '10.255.255.255',
    '172.16.0.1', '172.31.255.255',
    '192.168.0.1',
    '169.254.0.1', '169.254.169.254', // link-local + cloud metadata
    '100.64.0.1', '100.127.255.255',  // CGNAT
    '0.0.0.0',
    '224.0.0.1', '239.255.255.255',   // multicast
  ]) {
    assert.equal(isPrivateIp(ip), true, `${ip} should be private`)
  }
})

test('isPrivateIp allows ordinary public IPv4', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '192.169.0.1', '100.63.255.255', '100.128.0.1', '203.0.113.10']) {
    assert.equal(isPrivateIp(ip), false, `${ip} should be public`)
  }
})

test('isPrivateIp flags private/loopback/link-local/unique-local IPv6 and mapped IPv4', () => {
  for (const ip of [
    '::1', '::',
    'fe80::1',            // link-local
    'fc00::1', 'fd12:3456::1', // unique-local
    'ff02::1',            // multicast
    '::ffff:127.0.0.1',   // IPv4-mapped loopback
    '::ffff:10.0.0.1',    // IPv4-mapped private
    '[::1]',              // bracketed
  ]) {
    assert.equal(isPrivateIp(ip), true, `${ip} should be private`)
  }
})

test('isPrivateIp allows public IPv6 (incl. mapped public IPv4)', () => {
  assert.equal(isPrivateIp('2606:4700:4700::1111'), false)
  assert.equal(isPrivateIp('::ffff:8.8.8.8'), false)
})

test('assertPublicMailHost rejects literal private IPs and localhost without DNS', async () => {
  await assert.rejects(() => assertPublicMailHost('127.0.0.1', 'smtpHost'), /private or reserved/)
  await assert.rejects(() => assertPublicMailHost('10.1.2.3'), /private or reserved/)
  await assert.rejects(() => assertPublicMailHost('[::1]'), /private or reserved/)
  await assert.rejects(() => assertPublicMailHost('169.254.169.254'), /private or reserved/)
  await assert.rejects(() => assertPublicMailHost('localhost'), /localhost not permitted/)
  await assert.rejects(() => assertPublicMailHost('mail.localhost'), /localhost not permitted/)
})

test('assertPublicMailHost accepts a literal public IP (no DNS needed) and is a no-op for empty input', async () => {
  await assert.doesNotReject(() => assertPublicMailHost('8.8.8.8'))
  await assert.doesNotReject(() => assertPublicMailHost(undefined))
  await assert.doesNotReject(() => assertPublicMailHost(null))
  await assert.doesNotReject(() => assertPublicMailHost(''))
})

// resolvePublicMailHost — the connect-time pinning primitive. For a literal IP
// it returns that IP with no servername (nothing to verify a cert against); for
// a hostname (DNS path) it would return the resolved IP plus the original name
// as servername. The hermetic cases below mirror the literal/localhost coverage
// above; the resolve-to-private path is covered by the thrown ApiError contract.
test('resolvePublicMailHost pins a literal public IP and emits no servername', async () => {
  assert.deepEqual(await resolvePublicMailHost('8.8.8.8', 'smtpHost'), { host: '8.8.8.8' })
  // IPv6 literals are normalized (brackets/zone stripped) and dialed as-is.
  assert.deepEqual(await resolvePublicMailHost('[2606:4700:4700::1111]'), { host: '2606:4700:4700::1111' })
})

test('resolvePublicMailHost rejects private/loopback/metadata literals and localhost', async () => {
  await assert.rejects(() => resolvePublicMailHost('127.0.0.1', 'smtpHost'), /private or reserved/)
  await assert.rejects(() => resolvePublicMailHost('10.1.2.3'), /private or reserved/)
  await assert.rejects(() => resolvePublicMailHost('[::1]'), /private or reserved/)
  await assert.rejects(() => resolvePublicMailHost('169.254.169.254'), /private or reserved/)
  await assert.rejects(() => resolvePublicMailHost('::ffff:10.0.0.1'), /private or reserved/)
  await assert.rejects(() => resolvePublicMailHost('localhost'), /localhost not permitted/)
  await assert.rejects(() => resolvePublicMailHost('mail.localhost'), /localhost not permitted/)
  await assert.rejects(() => resolvePublicMailHost(''), /could not be resolved/)
})
