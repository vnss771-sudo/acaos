// E2: ABN Lookup verification (unit tier — no network; fetch is injected).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { normalizeAbn, isValidAbnChecksum, parseAbrBody, lookupAbn, verifiedAbn, AbnLookupNotConfiguredError } from '../packages/backend-core/src/lib/abnLookup.ts'
import { ProviderError } from '../packages/backend-core/src/lib/providerClient.ts'
import { FetchTimeoutError } from '../packages/backend-core/src/lib/fetchWithTimeout.ts'
import { buildOutreachEmail } from '../packages/backend-core/src/lib/emailFooter.ts'

const passthrough = { call: <R>(fn: () => Promise<R>) => fn() }
const GUID = 'abcdef12-guid-SECRET-0000'
const ABN = '51824753556' // ATO's published example ABN (valid checksum)
const body = (o: Record<string, unknown>, jsonp = true) => {
  const json = JSON.stringify({ Abn: ABN, AbnStatus: 'Active', EntityName: 'ACME PTY LTD', EntityTypeName: 'Australian Private Company', Message: '', ...o })
  return jsonp ? `callback(${json})` : json
}
const ok = (text: string) => async () => new Response(text, { status: 200 })

test('normalizeAbn / checksum', () => {
  assert.equal(normalizeAbn('51 824 753 556'), ABN)
  assert.equal(normalizeAbn('51-824-753-556'), ABN)
  assert.equal(normalizeAbn('5182475355'), null)
  assert.equal(normalizeAbn('abc'), null)
  assert.equal(isValidAbnChecksum(ABN), true)
  assert.equal(isValidAbnChecksum('34241177887'), true, 'ABR suppressed-ABN test case')
  assert.equal(isValidAbnChecksum('51824753557'), false)
  assert.equal(isValidAbnChecksum('00000000000'), false)
})

test('parseAbrBody accepts JSONP and plain JSON', () => {
  assert.equal(parseAbrBody(body({})).EntityName, 'ACME PTY LTD')
  assert.equal(parseAbrBody(body({}, false)).AbnStatus, 'Active')
  assert.throws(() => parseAbrBody('<html>nope</html>'))
})

test('lookupAbn: active, cancelled, unknown', async () => {
  const active = await lookupAbn(ABN, { guid: GUID, breaker: passthrough, fetchImpl: ok(body({})) })
  assert.deepEqual(active, { abn: ABN, status: 'active', entityName: 'ACME PTY LTD', entityType: 'Australian Private Company' })
  const cancelled = await lookupAbn(ABN, { guid: GUID, breaker: passthrough, fetchImpl: ok(body({ AbnStatus: 'Cancelled' })) })
  assert.equal(cancelled?.status, 'cancelled')
  assert.equal(await lookupAbn(ABN, { guid: GUID, breaker: passthrough, fetchImpl: ok(body({ Abn: '', EntityName: '', Message: 'Search text is not a valid ABN or ACN' })) }), null)
  assert.equal(await lookupAbn(ABN, { guid: GUID, breaker: passthrough, fetchImpl: ok(body({ Abn: '34241177887' })) }), null, 'a different ABN than asked is never accepted')
  assert.equal(await lookupAbn(ABN, { guid: GUID, breaker: passthrough, fetchImpl: ok(body({ AbnStatus: 'Weird' })) }), null)
})

test('lookupAbn: bad checksum makes no request; missing GUID is a config error', async () => {
  let calls = 0
  const f = async () => { calls++; return new Response(body({})) }
  assert.equal(await lookupAbn('51824753557', { guid: GUID, breaker: passthrough, fetchImpl: f }), null)
  assert.equal(calls, 0)
  const saved = process.env.ABR_GUID
  delete process.env.ABR_GUID
  try { await assert.rejects(lookupAbn(ABN, { fetchImpl: f }), AbnLookupNotConfiguredError) } finally { if (saved !== undefined) process.env.ABR_GUID = saved }
  assert.equal(calls, 0)
})

test('lookupAbn: sends the GUID only as a query parameter, as a GET', async () => {
  let seen: { url: string; method?: string } | undefined
  await lookupAbn(ABN, { guid: GUID, breaker: passthrough, fetchImpl: async (url, init) => { seen = { url: String(url), method: init.method }; return new Response(body({})) } })
  assert.equal(seen!.method, 'GET')
  const u = new URL(seen!.url)
  assert.equal(u.origin + u.pathname, 'https://abr.business.gov.au/json/AbnDetails.aspx')
  assert.equal(u.searchParams.get('abn'), ABN)
  assert.equal(u.searchParams.get('guid'), GUID)
})

test('lookupAbn: the GUID never appears in any error (rejected GUID, 5xx, timeout, garbage)', async () => {
  const cases: Array<() => Promise<Response>> = [
    ok(body({ Abn: '', Message: `The GUID entered is not recognised as a valid GUID` })),
    async () => new Response(`upstream error at /json/AbnDetails.aspx?abn=${ABN}&guid=${GUID}`, { status: 500 }),
    async () => new Response(`bad request ?guid=${GUID}`, { status: 400 }),
    async () => { throw new FetchTimeoutError(`https://abr.business.gov.au/json/AbnDetails.aspx?abn=${ABN}&guid=${GUID}`, 10_000) },
    ok('<html>maintenance</html>'),
  ]
  for (const fetchImpl of cases) {
    const err = await lookupAbn(ABN, { guid: GUID, breaker: passthrough, fetchImpl }).then(() => null, (e) => e)
    assert.ok(err instanceof ProviderError, String(err))
    assert.ok(!String(err.message).includes(GUID) && !String(err.message).includes('SECRET'), err.message)
  }
})

test('lookupAbn: a rejected GUID is a configuration fault, not "no such business"', async () => {
  const err = await lookupAbn(ABN, { guid: GUID, breaker: passthrough, fetchImpl: ok(body({ Abn: '', Message: 'The GUID entered is not recognised as a valid GUID' })) }).then(() => null, (e) => e)
  assert.ok(err instanceof ProviderError)
  assert.equal(err.kind, 'client_error')
})

test('lookupAbn: GET retries a transient 503 (idempotent)', async () => {
  const r = [new Response('x', { status: 503 }), new Response(body({}))]
  const out = await lookupAbn(ABN, { guid: GUID, breaker: passthrough, fetchImpl: async () => r.shift()! })
  assert.equal(out?.status, 'active')
})

// ── footer ───────────────────────────────────────────────────────────────────
test('footer: ABN line only when a verified ABN is supplied; unchanged otherwise', () => {
  const base = { body: 'Hi', appUrl: 'https://api.test', unsubscribeToken: 't', senderBusinessName: 'Acme', senderPostalAddress: '1 St' }
  const without = buildOutreachEmail(base)
  assert.ok(!without.textBody.includes('ABN'))
  const withAbn = buildOutreachEmail({ ...base, senderAbn: ABN })
  assert.match(withAbn.textBody, /Acme, 1 St\nABN 51 824 753 556/)
  assert.match(withAbn.htmlBody, /<br>ABN 51 824 753 556/)
  assert.ok(!buildOutreachEmail({ ...base, senderAbn: '123' }).textBody.includes('ABN'), 'malformed values are dropped, never printed')
  assert.ok(!buildOutreachEmail({ ...base, senderAbn: '<script>' }).htmlBody.includes('script'))
})

test('verifiedAbn: only an active ABN is printed', () => {
  assert.equal(verifiedAbn({ senderAbn: ABN, senderAbnStatus: 'active' }), ABN)
  assert.equal(verifiedAbn({ senderAbn: ABN, senderAbnStatus: null }), null)
  assert.equal(verifiedAbn({ senderAbn: ABN, senderAbnStatus: 'cancelled' }), null)
  assert.equal(verifiedAbn(null), null)
})

// ── E5 workflow hygiene ──────────────────────────────────────────────────────
test('E5: the discovery smoke workflow carries no secrets and checks AusTender only', () => {
  const y = readFileSync(new URL('../.github/workflows/discovery-smoke.yml', import.meta.url), 'utf8')
  assert.ok(!/\$\{\{\s*secrets\./.test(y), 'no repository secrets in a public workflow')
  assert.match(y, /--source=austender/)
  assert.match(y, /schedule:/)
  assert.match(y, /permissions:\n\s+contents: read/)
  assert.match(y, /issues: write/, 'only the alert job may write issues')
})

// ── contract per ABR's official JSON sample (Phase 1 verification) ───────────
test('lookupAbn: a payload without an `Abn` key (as in ABR\'s sample) is accepted; Message means no result', async () => {
  const noAbnKey = JSON.stringify({ Acn: '', EntityName: 'DEPT OF INDUSTRY', AbnStatus: 'Active', AbnStatusEffectiveFrom: '2000-01-01', EntityTypeName: 'Commonwealth Government Entity', EntityTypeCode: 'CGE', Gst: '2000-07-01', AddressState: 'ACT', AddressPostcode: '2601', BusinessName: [], Message: '' })
  const out = await lookupAbn(ABN, { guid: GUID, breaker: passthrough, fetchImpl: ok(`callback(${noAbnKey})`) })
  assert.equal(out?.status, 'active'); assert.equal(out?.entityName, 'DEPT OF INDUSTRY')
  const withMsg = JSON.stringify({ EntityName: '', AbnStatus: '', Message: 'Search text is not a valid ABN or ACN', BusinessName: [] })
  assert.equal(await lookupAbn(ABN, { guid: GUID, breaker: passthrough, fetchImpl: ok(`callback(${withMsg})`) }), null)
  const suppressed = JSON.stringify({ EntityName: '', AbnStatus: 'Active', Message: '', BusinessName: [] })
  assert.equal(await lookupAbn(ABN, { guid: GUID, breaker: passthrough, fetchImpl: ok(`callback(${suppressed})`) }), null, 'suppressed (nameless) entities cannot be verified')
})
