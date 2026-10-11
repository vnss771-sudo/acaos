import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeReferralCode, resolveReferralPartnerId, summariseReferrals } from '../packages/backend-core/src/lib/referrals.ts'

test('normalizeReferralCode uppercases valid codes and rejects malformed ones', () => {
  assert.equal(normalizeReferralCode('  accounts-adv '), 'ACCOUNTS-ADV')
  for (const bad of ['', 'ab', '-lead', 'has space', 'x'.repeat(40), 42, null, undefined]) {
    assert.equal(normalizeReferralCode(bad), null)
  }
})

test('resolveReferralPartnerId only attributes active partners and never throws on a typo', async () => {
  const partners: Record<string, { id: string; status: string }> = {
    GOOD: { id: 'p1', status: 'active' },
    HELD: { id: 'p2', status: 'paused' },
  }
  const db = { referralPartner: { findUnique: async ({ where }: { where: { code: string } }) => partners[where.code] ?? null } }
  assert.equal(await resolveReferralPartnerId(db as never, 'good'), 'p1')
  assert.equal(await resolveReferralPartnerId(db as never, 'held'), null)
  assert.equal(await resolveReferralPartnerId(db as never, 'nope'), null)
  assert.equal(await resolveReferralPartnerId(db as never, undefined), null)
})

test('summariseReferrals counts only active/trialing paid plans toward commission', () => {
  const s = summariseReferrals([
    { plan: 'starter', subscriptionStatus: 'active' },
    { plan: 'growth', subscriptionStatus: 'trialing' },
    { plan: 'growth', subscriptionStatus: 'canceled' },
    { plan: 'free', subscriptionStatus: null },
  ], 20)
  assert.deepEqual(s, { referred: 4, paying: 2, monthlyRecurringCents: 39800, estimatedMonthlyCommissionCents: 7960 })
})
