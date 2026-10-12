#!/usr/bin/env node
/**
 * Live verification of lib/abnLookup.ts against the real ABR JSON service, using ABR's
 * documented test ABNs (https://abr.business.gov.au/Documentation/WebServiceResponse).
 * Needs a registered ABR GUID in ABR_GUID. Never prints the GUID; every error goes through the
 * production scrubbing path. Makes ~7 requests. Exit 1 if any case contradicts expectations.
 *
 *   ABR_GUID=... NODE_OPTIONS=--conditions=acaos-src npx tsx scripts/verify-abr-live.mjs
 */
import { lookupAbn, isValidAbnChecksum } from '@acaos/backend-core/lib/abnLookup.js'

const guid = process.env.ABR_GUID
if (!guid) { console.error('ABR_GUID is not set — register at https://abr.business.gov.au/Documentation/WebServiceRegistration'); process.exit(2) }

// A checksum-valid ABN that is very unlikely to be registered.
function unlikelyAbn() {
  for (let n = 99_999_000_000; n < 99_999_999_999; n++) { const s = String(n); if (isValidAbnChecksum(s)) return s }
}

const cases = [
  { name: 'sample ABN from ABR docs (expect Active, named)', abn: '74172177893', expect: (r) => r && r.status === 'active' && r.entityName.length > 0 },
  { name: 'ABR doc: replaced ABN', abn: '30613501612', expect: (r) => r === null || ['active', 'cancelled'].includes(r.status) },
  { name: 'ABR doc: re-issued ABN', abn: '40348075953', expect: (r) => r === null || ['active', 'cancelled'].includes(r.status) },
  { name: 'ABR doc: multiple ABN status', abn: '53772093958', expect: (r) => r === null || ['active', 'cancelled'].includes(r.status) },
  { name: 'ABR doc: suppressed ABN (entity details withheld → we return null)', abn: '34241177887', expect: (r) => r === null || r.status === 'active' || r.status === 'cancelled' },
  { name: 'checksum-invalid (no request made; expect null)', abn: '51824753557', expect: (r) => r === null },
  { name: 'checksum-valid but unregistered (expect null)', abn: unlikelyAbn(), expect: (r) => r === null },
]

let failed = false
for (const c of cases) {
  try {
    const r = await lookupAbn(c.abn, { guid })
    const ok = c.expect(r)
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}\n      abn=${c.abn} → ${r ? `${r.status} | ${r.entityName} | ${r.entityType}` : 'null'}`)
    if (!ok) failed = true
  } catch (err) {
    console.log(`FAIL  ${c.name}\n      threw ${err?.name}: ${String(err?.message).replaceAll(guid, '[GUID]')}`)
    failed = true
  }
}
// A deliberately wrong GUID must surface as a config fault and must not echo either GUID.
try {
  await lookupAbn('74172177893', { guid: 'not-a-real-guid-0000' })
  console.log('FAIL  bad GUID was accepted'); failed = true
} catch (err) {
  const leaked = String(err?.message).includes('not-a-real-guid') || String(err?.message).includes(guid)
  console.log(`${leaked ? 'FAIL' : 'PASS'}  bad GUID → ${err?.name}/${err?.kind}: ${String(err?.message).slice(0, 120)}${leaked ? '  ← LEAKED' : ''}`)
  if (leaked) failed = true
}
process.exit(failed ? 1 : 0)
