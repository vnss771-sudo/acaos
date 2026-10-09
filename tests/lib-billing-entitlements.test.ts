// Billing entitlement policy (UQ-26): which plan's limits apply for a given
// Stripe state, and the grace / event-ordering rules behind it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BILLING_GRACE_DAYS,
  billingEntitlement,
  graceUntilAfterPastDue,
  isStaleStripeEvent,
} from '../packages/backend-core/src/lib/billingEntitlements.ts'

const now = new Date('2026-10-09T12:00:00Z')
const later = new Date(now.getTime() + 86_400_000)
const earlier = new Date(now.getTime() - 86_400_000)

test('active and trialing subscriptions get the purchased plan', () => {
  for (const s of ['active', 'trialing']) {
    const e = billingEntitlement({ plan: 'growth', subscriptionStatus: s, billingGraceUntil: null }, now)
    assert.deepEqual(e, { status: 'active', effectivePlan: 'growth', graceUntil: null })
  }
})

test('past_due keeps the plan only until the grace deadline', () => {
  assert.equal(billingEntitlement({ plan: 'starter', subscriptionStatus: 'past_due', billingGraceUntil: later }, now).effectivePlan, 'starter')
  assert.equal(billingEntitlement({ plan: 'starter', subscriptionStatus: 'past_due', billingGraceUntil: later }, now).status, 'grace')
  assert.equal(billingEntitlement({ plan: 'starter', subscriptionStatus: 'past_due', billingGraceUntil: earlier }, now).effectivePlan, 'free')
})

test('past_due with no recorded grace deadline fails closed', () => {
  const e = billingEntitlement({ plan: 'growth', subscriptionStatus: 'past_due', billingGraceUntil: null }, now)
  assert.equal(e.status, 'lapsed')
  assert.equal(e.effectivePlan, 'free')
})

test('canceled, unpaid and unknown statuses fall to free', () => {
  for (const s of ['canceled', 'unpaid', 'incomplete_expired', 'something_new']) {
    assert.equal(billingEntitlement({ plan: 'growth', subscriptionStatus: s, billingGraceUntil: later }, now).effectivePlan, 'free')
  }
})

test('no subscription status keeps the stored plan (comped workspaces)', () => {
  assert.equal(billingEntitlement({ plan: 'growth', subscriptionStatus: null, billingGraceUntil: null }, now).effectivePlan, 'growth')
  assert.equal(billingEntitlement({ plan: 'bogus', subscriptionStatus: null, billingGraceUntil: null }, now).effectivePlan, 'free')
})

test('the grace deadline is set once and never extended', () => {
  assert.equal(graceUntilAfterPastDue(null, now).getTime(), now.getTime() + BILLING_GRACE_DAYS * 86_400_000)
  assert.equal(graceUntilAfterPastDue(later, now), later)
})

test('only events older than the last applied one are stale', () => {
  const sec = Math.floor(now.getTime() / 1000)
  assert.equal(isStaleStripeEvent(sec - 1, now), true)
  assert.equal(isStaleStripeEvent(sec, now), false)
  assert.equal(isStaleStripeEvent(sec + 1, now), false)
  assert.equal(isStaleStripeEvent(undefined, now), false)
  assert.equal(isStaleStripeEvent(sec, null), false)
})
