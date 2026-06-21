import { describe, test, expect } from 'vitest'
import { makeDemoApi, DEMO_USER, DEMO_WORKSPACES } from './demoApi.js'

describe('demoApi', () => {
  const api = makeDemoApi()

  test('seeds a believable founder user and workspace', () => {
    expect(DEMO_USER.email).toMatch(/@/)
    expect(DEMO_WORKSPACES[0].role).toBe('owner')
    expect(DEMO_WORKSPACES[0].onboardingCompleted).toBe(true)
  })

  test('returns rich stats for the dashboard', async () => {
    const stats = await api<{ totalLeads: number; funnel: Record<string, number> }>('/api/stats?workspaceId=demo-ws')
    expect(stats.totalLeads).toBeGreaterThan(0)
    expect(stats.funnel.REPLIED).toBeGreaterThan(0)
  })

  test('returns hot opportunities and pending drafts', async () => {
    const opps = await api<{ hot: unknown[] }>('/api/intelligence/opportunities?workspaceId=demo-ws')
    expect(opps.hot.length).toBeGreaterThan(0)
    const pending = await api<{ drafts: unknown[] }>('/api/leads/approvals/pending?workspaceId=demo-ws')
    expect(pending.drafts.length).toBeGreaterThan(0)
  })

  test('unknown reads fall back to a permissive empty shape', async () => {
    const res = await api<{ prospects: unknown[]; total: number; ready: boolean }>('/api/something/unknown')
    expect(res.prospects).toEqual([])
    expect(res.total).toBe(0)
    expect(res.ready).toBe(true)
  })

  test('mutations resolve as no-op successes', async () => {
    const res = await api('/api/prospects/dp1/rescore', { method: 'POST' })
    expect(res).toEqual({})
  })
})
