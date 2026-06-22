// Unit tests for the workspace RBAC permission matrix. These pin down EXACTLY
// which role holds which capability, so any accidental widening/narrowing of an
// authorization boundary fails loudly here.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { roleCan, ROLE_PERMISSIONS, type Permission } from '../apps/api/src/lib/permissions.ts'

const ADMIN_CAPS: Permission[] = [
  'workspace:update',
  'workspace:seed',
  'members:manage',
  'billing:manage',
  'email_config:manage',
  'api_keys:manage',
  'icp:update',
  'mail:send_test',
  'campaign:create',
  'campaign:send',
  'campaign:delete',
  'campaign:approve_draft',
  'leads:import',
  'prospects:discover',
  'prospects:import',
]
const OWNER_ONLY_CAPS: Permission[] = ['members:grant_admin', 'members:remove', 'model:reset']
const ALL_CAPS: Permission[] = [...ADMIN_CAPS, ...OWNER_ONLY_CAPS]

test('owner holds every capability', () => {
  for (const cap of ALL_CAPS) assert.equal(roleCan('owner', cap), true, `owner should have ${cap}`)
})

test('admin holds the admin+ capabilities but NOT the owner-only ones', () => {
  for (const cap of ADMIN_CAPS) assert.equal(roleCan('admin', cap), true, `admin should have ${cap}`)
  for (const cap of OWNER_ONLY_CAPS) assert.equal(roleCan('admin', cap), false, `admin must NOT have ${cap}`)
})

test('member holds no named capability', () => {
  for (const cap of ALL_CAPS) assert.equal(roleCan('member', cap), false, `member must NOT have ${cap}`)
})

test('a null/undefined role (non-member) holds nothing', () => {
  for (const cap of ALL_CAPS) {
    assert.equal(roleCan(null, cap), false)
    assert.equal(roleCan(undefined, cap), false)
  }
})

test('the matrix is strictly additive: member ⊂ admin ⊂ owner', () => {
  for (const cap of ROLE_PERMISSIONS.member) assert.ok(ROLE_PERMISSIONS.admin.has(cap), `admin missing inherited ${cap}`)
  for (const cap of ROLE_PERMISSIONS.admin) assert.ok(ROLE_PERMISSIONS.owner.has(cap), `owner missing inherited ${cap}`)
})

test('owner-only capabilities are exactly the ones admin lacks', () => {
  const ownerExtra = [...ROLE_PERMISSIONS.owner].filter((c) => !ROLE_PERMISSIONS.admin.has(c)).sort()
  assert.deepEqual(ownerExtra, [...OWNER_ONLY_CAPS].sort())
})
