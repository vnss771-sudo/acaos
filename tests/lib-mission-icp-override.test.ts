// Unit tests for resolveEffectiveTargeting — the mission-override > workspace
// ICP > playbook-pack fallback chain used by both GET /api/missions/:id/icp
// and POST /api/prospects/discover.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveEffectiveTargeting } from '../apps/api/src/routes/prospects/helpers.ts'
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
