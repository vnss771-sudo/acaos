// Unit tests for resolveEffectiveTargeting — the mission-override > workspace
// ICP > playbook-pack fallback chain used by both GET /api/missions/:id/icp
// and POST /api/prospects/discover — and buildDiscoveryQuery, which layers an
// explicit POST /discover request field on top of that resolved chain.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveEffectiveTargeting, buildDiscoveryQuery } from '../apps/api/src/routes/prospects/helpers.ts'
import type { IndustryPack } from '../apps/api/src/lib/packs/types.ts'

const PACK: IndustryPack = {
  id: 'fieldops',
  label: 'FieldOps',
  description: 'Trades & field service',
  icp: { targetIndustries: ['Plumbing', 'HVAC'], targetGeos: ['Brisbane'], minEmployees: 5, maxEmployees: 50 },
  signals: [],
  templates: [],
}

test('with no override, no ICP, no pack: everything falls through to empty/undefined', () => {
  const r = resolveEffectiveTargeting(null, undefined, undefined)
  assert.deepEqual(r, { targetIndustries: [], targetGeos: [], minEmployees: undefined, maxEmployees: undefined })
})

test('with only a pack: the pack preset is used', () => {
  const r = resolveEffectiveTargeting(null, undefined, PACK)
  assert.deepEqual(r.targetIndustries, ['Plumbing', 'HVAC'])
  assert.deepEqual(r.targetGeos, ['Brisbane'])
  assert.equal(r.minEmployees, 5)
  assert.equal(r.maxEmployees, 50)
})

test('the workspace ICP beats the pack preset', () => {
  const icp = { targetIndustries: ['SaaS'], targetGeos: ['Remote'], minEmployees: 10, maxEmployees: 200, mustHaveEmail: false }
  const r = resolveEffectiveTargeting(null, icp, PACK)
  assert.deepEqual(r.targetIndustries, ['SaaS'])
  assert.deepEqual(r.targetGeos, ['Remote'])
  assert.equal(r.minEmployees, 10)
  assert.equal(r.maxEmployees, 200)
})

test('the mission override beats the workspace ICP and the pack preset', () => {
  const icp = { targetIndustries: ['SaaS'], targetGeos: ['Remote'], minEmployees: 10, maxEmployees: 200, mustHaveEmail: false }
  const r = resolveEffectiveTargeting({ targetIndustries: ['Manufacturing'], minEmployees: 100 }, icp, PACK)
  assert.deepEqual(r.targetIndustries, ['Manufacturing'], 'override wins for the field it sets')
  assert.deepEqual(r.targetGeos, ['Remote'], 'falls through to the workspace ICP for a field the override does not set')
  assert.equal(r.minEmployees, 100, 'override wins for the field it sets')
  assert.equal(r.maxEmployees, 200, 'falls through to the workspace ICP for a field the override does not set')
})

test('an empty-array override field is treated as unset (falls through), not as "target nothing"', () => {
  const icp = { targetIndustries: ['SaaS'], targetGeos: ['Remote'], minEmployees: 10, maxEmployees: 200, mustHaveEmail: false }
  const r = resolveEffectiveTargeting({ targetIndustries: [] }, icp, PACK)
  assert.deepEqual(r.targetIndustries, ['SaaS'], 'empty override array is not a real value — falls through to the ICP')
})

test('override alone, with no workspace ICP, falls through to the pack for unset fields', () => {
  const r = resolveEffectiveTargeting({ targetIndustries: ['Manufacturing'] }, undefined, PACK)
  assert.deepEqual(r.targetIndustries, ['Manufacturing'])
  assert.deepEqual(r.targetGeos, ['Brisbane'], 'falls all the way through to the pack')
  assert.equal(r.minEmployees, 5)
})

// --- buildDiscoveryQuery: an explicit POST /discover request field must beat
// the already-resolved effective targeting, for every field, not just some.

const EFFECTIVE = { targetIndustries: ['SaaS'], targetGeos: ['Remote'], minEmployees: 50, maxEmployees: 500 }

test('an explicit request field wins over the resolved ICP/mission targeting', () => {
  const q = buildDiscoveryQuery({ minEmployees: 5, maxEmployees: 20 }, EFFECTIVE)
  assert.equal(q.minEmployees, 5, 'the request explicitly asked for smaller companies — it must not be silently overridden')
  assert.equal(q.maxEmployees, 20)
})

test('a request field left unset falls through to the resolved targeting', () => {
  const q = buildDiscoveryQuery({}, EFFECTIVE)
  assert.equal(q.minEmployees, 50)
  assert.equal(q.maxEmployees, 500)
  assert.deepEqual(q.industries, ['SaaS'])
  assert.deepEqual(q.locations, ['Remote'])
})

test('industries/locations/minEmployees/maxEmployees all use the same request-wins precedence', () => {
  const q = buildDiscoveryQuery(
    { industries: ['Manufacturing'], locations: ['Austin'], minEmployees: 1, maxEmployees: 10 },
    EFFECTIVE,
  )
  assert.deepEqual(q.industries, ['Manufacturing'])
  assert.deepEqual(q.locations, ['Austin'])
  assert.equal(q.minEmployees, 1)
  assert.equal(q.maxEmployees, 10)
})

test('limit defaults to 25 and keywords defaults to [] when the request omits them', () => {
  const q = buildDiscoveryQuery({}, EFFECTIVE)
  assert.equal(q.limit, 25)
  assert.deepEqual(q.keywords, [])
})

test('an explicit limit and keywords list from the request are used as-is', () => {
  const q = buildDiscoveryQuery({ limit: 10, keywords: ['crm'] }, EFFECTIVE)
  assert.equal(q.limit, 10)
  assert.deepEqual(q.keywords, ['crm'])
})
