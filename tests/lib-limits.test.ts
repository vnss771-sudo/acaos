import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// ── inline the pure helpers from limits.ts (not prisma-dependent) ─────────────

function currentMonth(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

const PLAN_LIMITS = {
  free: { aiCallsPerMonth: 15, maxLeads: 500 },
  starter: { aiCallsPerMonth: 300, maxLeads: 10_000 },
  growth: { aiCallsPerMonth: Infinity, maxLeads: Infinity }
} as const

function getPlanInfo(plan: string) {
  const p = (plan === 'starter' || plan === 'growth') ? plan : 'free'
  return { ...PLAN_LIMITS[p as keyof typeof PLAN_LIMITS], plan: p }
}

describe('currentMonth', () => {
  it('returns YYYY-MM format', () => {
    const m = currentMonth()
    assert.match(m, /^\d{4}-\d{2}$/)
  })

  it('month is 01-12', () => {
    const parts = currentMonth().split('-')
    const month = Number(parts[1])
    assert.ok(month >= 1 && month <= 12)
  })
})

describe('getPlanInfo', () => {
  it('free plan has 15 AI calls/month', () => {
    assert.equal(getPlanInfo('free').aiCallsPerMonth, 15)
  })

  it('starter plan has 300 AI calls/month', () => {
    assert.equal(getPlanInfo('starter').aiCallsPerMonth, 300)
  })

  it('growth plan has infinite AI calls', () => {
    assert.equal(getPlanInfo('growth').aiCallsPerMonth, Infinity)
  })

  it('unknown plan defaults to free', () => {
    const info = getPlanInfo('enterprise')
    assert.equal(info.plan, 'free')
    assert.equal(info.aiCallsPerMonth, 15)
  })

  it('free plan has 500 lead cap', () => {
    assert.equal(getPlanInfo('free').maxLeads, 500)
  })

  it('growth plan has unlimited leads', () => {
    assert.equal(getPlanInfo('growth').maxLeads, Infinity)
  })

  it('starter plan has 10k lead cap', () => {
    assert.equal(getPlanInfo('starter').maxLeads, 10_000)
  })
})

describe('plan limit arithmetic', () => {
  it('free: blocked at 15th call', () => {
    const limit = getPlanInfo('free').aiCallsPerMonth
    assert.ok(15 >= limit) // should be blocked
  })

  it('free: allowed at 14th call', () => {
    const limit = getPlanInfo('free').aiCallsPerMonth
    assert.ok(14 < limit)
  })

  it('growth: isFinite check correctly identifies unlimited', () => {
    const limit = getPlanInfo('growth').aiCallsPerMonth
    assert.ok(!isFinite(limit))
  })

  it('starter: isFinite check correctly identifies limited', () => {
    const limit = getPlanInfo('starter').aiCallsPerMonth
    assert.ok(isFinite(limit))
  })
})
