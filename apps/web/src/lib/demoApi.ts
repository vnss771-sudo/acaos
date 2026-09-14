import type { User, Workspace } from '../types.js'
import type { ApiHook } from '../hooks/useApi.js'

// Seeded data + a drop-in ApiHook for investor/demo mode. The real views render
// unchanged; this just answers their requests from fixtures so the product looks
// fully populated with no backend. Mutations resolve as no-op successes.

export const DEMO_USER: User = {
  id: 'demo-user',
  email: 'founder@northwind.example',
  name: 'Demo Founder',
  emailVerified: true,
  isPlatformAdmin: false,
  totpEnabled: false,
}

export const DEMO_WORKSPACES: Workspace[] = [
  {
    id: 'demo-ws',
    name: 'Northwind Field Services',
    slug: 'northwind',
    plan: 'growth',
    subscriptionStatus: 'active',
    onboardingCompleted: true,
    senderBusinessName: 'Northwind Field Services',
    senderPostalAddress: '100 Market St, Austin, TX',
    role: 'owner',
    _count: { leads: 248, campaigns: 4 },
  },
]

const DEMO_STATS = {
  totalLeads: 248,
  campaignCount: 4,
  funnel: { NEW: 86, RESEARCHED: 64, OUTREACH_SENT: 58, REPLIED: 22, BOOKED: 11, CLOSED: 7, DEAD: 9 },
  metrics: { replyRate: 21.4, bookingRate: 12.1, closeRate: 6.3, contacted: 103, replied: 22, booked: 11, closed: 7 },
  recentLeads: [
    { id: 'dl1', businessName: 'Meridian Roofing', stage: 'REPLIED', score: 84, category: 'Roofing', createdAt: new Date().toISOString() },
    { id: 'dl2', businessName: 'Apex Plumbing', stage: 'OUTREACH_SENT', score: 79, category: 'Plumbing', createdAt: new Date().toISOString() },
    { id: 'dl3', businessName: 'Lone Star HVAC', stage: 'BOOKED', score: 88, category: 'HVAC', createdAt: new Date().toISOString() },
  ],
  topLeads: [
    { id: 'dt1', businessName: 'Lone Star HVAC', stage: 'BOOKED', score: 88, category: 'HVAC' },
    { id: 'dt2', businessName: 'Meridian Roofing', stage: 'REPLIED', score: 84, category: 'Roofing' },
    { id: 'dt3', businessName: 'Apex Plumbing', stage: 'OUTREACH_SENT', score: 79, category: 'Plumbing' },
  ],
  scoreDistribution: { HOT: 34, WARM: 92, COLD: 122 },
  scoringModel: null,
  usage: { month: '2026-06', totals: { AI_RESEARCH: 142, AI_OUTREACH: 96, AI_REPLY: 38 }, total: 276, limit: -1, plan: 'growth', maxLeads: -1 },
}

const DEMO_HOT = [
  { id: 'dp1', companyName: 'Lone Star HVAC', industry: 'HVAC', location: 'Austin, TX', opportunityScore: 88, winProbability: 0.42, signalCount: 4, buyingStage: 'PURCHASING', outcomeStage: 'IN_PROGRESS', intentScore: 86, fitScore: 81, timingScore: 90, confidenceScore: 78, latestSignal: { type: 'HIRING', title: 'Hiring 6 field techs' }, topRecommendation: { actionText: 'Reach out re: scheduling software' } },
  { id: 'dp2', companyName: 'Meridian Roofing', industry: 'Roofing', location: 'Dallas, TX', opportunityScore: 84, winProbability: 0.37, signalCount: 3, buyingStage: 'EVALUATING', outcomeStage: 'IN_PROGRESS', intentScore: 80, fitScore: 79, timingScore: 82, confidenceScore: 74, latestSignal: { type: 'EXPANSION', title: 'Opened a second branch' } },
]

const DEMO_SIGNALS = [
  { id: 'ds1', type: 'HIRING', strength: 82, title: 'Hiring 6 field techs', detectedAt: new Date(Date.now() - 3_600_000).toISOString(), prospect: { id: 'dp1', companyName: 'Lone Star HVAC' } },
  { id: 'ds2', type: 'EXPANSION', strength: 71, title: 'Opened a second branch', detectedAt: new Date(Date.now() - 90_000_000).toISOString(), prospect: { id: 'dp2', companyName: 'Meridian Roofing' } },
  { id: 'ds3', type: 'FUNDING', strength: 64, title: 'Raised a growth round', detectedAt: new Date(Date.now() - 180_000_000).toISOString(), prospect: { id: 'dp3', companyName: 'Apex Plumbing' } },
]

const DEMO_PROSPECTS = [
  ...DEMO_HOT,
  { id: 'dp3', companyName: 'Apex Plumbing', industry: 'Plumbing', location: 'Houston, TX', opportunityScore: 79, winProbability: 0.31, signalCount: 2, buyingStage: 'AWARE', outcomeStage: 'NEW', intentScore: 72, fitScore: 77, timingScore: 70, confidenceScore: 69 },
  { id: 'dp4', companyName: 'Bluebonnet Electric', industry: 'Electrical', location: 'San Antonio, TX', opportunityScore: 61, winProbability: 0.2, signalCount: 1, buyingStage: 'AWARE', outcomeStage: 'NEW', intentScore: 58, fitScore: 64, timingScore: 55, confidenceScore: 60 },
]

const DEMO_DRAFTS = [
  { id: 'dd1', subject: 'Helping Lone Star HVAC book more jobs', emailBody: 'Hi — saw you are hiring field techs. We help HVAC teams schedule and dispatch faster so new hires ramp quickly. Worth a quick chat next week? Reply STOP to unsubscribe.', status: 'PENDING', createdAt: new Date().toISOString(), lead: { id: 'dl3', businessName: 'Lone Star HVAC', email: 'ops@lonestarhvac.example' } },
  { id: 'dd2', subject: 'Quick idea for Meridian Roofing', emailBody: 'Congrats on the second branch. We help multi-location roofers keep response times tight. Open to a 15-minute look? Reply STOP to unsubscribe.', status: 'PENDING', createdAt: new Date().toISOString(), lead: { id: 'dl1', businessName: 'Meridian Roofing', email: 'hello@meridianroofing.example' } },
]

const DEMO_MISSIONS = [
  {
    id: 'dm1', name: 'Texas HVAC Q3 Push', status: 'ACTIVE', goalType: 'BOOK_CALL',
    targetCustomer: 'HVAC contractors, 10-50 employees, Central Texas',
    offer: 'Free scheduling audit for the first 20 bookings',
    campaign: { id: 'dc1', _count: { leads: 62 } },
    stats: { sent: 58, replied: 13, failed: 2, bounced: 1, pendingDrafts: 3 },
  },
  {
    id: 'dm2', name: 'Roofing Multi-Location Expansion', status: 'ACTIVE', goalType: 'BOOK_DEMO',
    targetCustomer: 'Multi-branch roofing companies',
    offer: null,
    campaign: { id: 'dc2', _count: { leads: 41 } },
    stats: { sent: 34, replied: 9, failed: 0, bounced: 0, pendingDrafts: 1 },
  },
]

const DEMO_LEADS = [
  { id: 'dl1', businessName: 'Meridian Roofing', contactName: 'Dana Reyes', email: 'hello@meridianroofing.example', category: 'Roofing', stage: 'REPLIED', score: 84 },
  { id: 'dl2', businessName: 'Apex Plumbing', contactName: 'Marcus Cole', email: 'contact@apexplumbing.example', category: 'Plumbing', stage: 'OUTREACH_SENT', score: 79 },
  { id: 'dl3', businessName: 'Lone Star HVAC', contactName: 'Priya Shah', email: 'ops@lonestarhvac.example', category: 'HVAC', stage: 'BOOKED', score: 88 },
  { id: 'dl4', businessName: 'Bluebonnet Electric', contactName: 'Tom Alvarez', email: 'info@bluebonnet.example', category: 'Electrical', stage: 'REPLIED', score: 61 },
  { id: 'dl5', businessName: 'Hill Country Landscaping', contactName: null, email: 'jobs@hillcountryls.example', category: 'Landscaping', stage: 'RESEARCHED', score: 55 },
  { id: 'dl6', businessName: 'Capitol Pest Solutions', contactName: 'Anne Kim', email: null, category: 'Pest Control', stage: 'NEW', score: 41 },
]

// Same shape a real /api/intelligence/forecast response returns — see
// apps/web/src/types.ts's ForecastData.
const DEMO_FORECAST = {
  summary: {
    totalProspects: 4, totalPipelineValue: 186_000, weightedForecast: 71_400,
    wonRevenue: 24_000, wonCount: 2, avgDealValue: 46_500, avgWinRate: 0.34,
  },
  stageBreakdown: {
    AWARE: { count: 2, forecast: 18_000 },
    EVALUATING: { count: 1, forecast: 22_400 },
    PURCHASING: { count: 1, forecast: 31_000 },
  },
  pipeline: [],
}

// Same shape a real /api/billing/status and /api/billing/plans response returns.
const DEMO_BILLING_STATUS = {
  plan: 'growth', status: 'active', hasSubscription: true,
  usage: {
    month: '2026-06', totals: { AI_RESEARCH: 142, AI_OUTREACH: 96, AI_REPLY: 38 },
    total: 276, limit: -1, plan: 'growth',
    discovery: { used: 18, limit: -1, estimatedCostCents: 940 },
    ai: { estimatedCostCents: 2180 },
    leads: { used: 248, limit: -1 },
  },
}
const DEMO_BILLING_PLANS = {
  free: { maxLeads: 500, aiCallsPerMonth: 15, discoveriesPerMonth: 25 },
  starter: { maxLeads: 10_000, aiCallsPerMonth: 300, discoveriesPerMonth: 500 },
  growth: { maxLeads: null, aiCallsPerMonth: null, discoveriesPerMonth: null },
}

// Same shape a real /api/workspaces/:id/compliance response returns — matches
// the fixture used in Settings.test.tsx for the same reason (CompliancePanel
// destructures data.posture with no guard, so an unseeded/shapeless response
// crashes the whole Settings page, not just the compliance section).
const DEMO_COMPLIANCE = {
  posture: {
    lawfulBasis: 'legitimate_interest', liaAcknowledgedAt: new Date(Date.now() - 30 * 86_400_000).toISOString(),
    termsAcceptedAt: new Date(Date.now() - 30 * 86_400_000).toISOString(), termsVersion: 'v1',
    subprocessorsAckAt: new Date(Date.now() - 30 * 86_400_000).toISOString(), subprocessorsAckVersion: 'v1',
    targetsCanada: false,
  },
  consentCount: 0,
  currentTermsVersion: 'v1',
  subprocessors: { version: 'v1', subprocessors: [] },
}

const DEMO_INBOX = {
  replies: [
    { id: 'dr1', toEmail: 'ops@lonestarhvac.example', subject: 'Helping Lone Star HVAC book more jobs', sentAt: new Date(Date.now() - 172_800_000).toISOString(), repliedAt: new Date(Date.now() - 3_600_000).toISOString(), replyIntent: 'INTERESTED', replySummary: 'Wants to see how scheduling would work for their crew — open to a call.', replyKeyQuote: 'This is timely, can you send some times?', replySuggestedAction: 'Propose three call slots this week.', replyUrgency: 'this_week', replyConfidence: 91, replyIsAutoReply: false, lead: { id: 'dl3', businessName: 'Lone Star HVAC', stage: 'REPLIED' } },
    { id: 'dr2', toEmail: 'hello@meridianroofing.example', subject: 'Quick idea for Meridian Roofing', sentAt: new Date(Date.now() - 259_200_000).toISOString(), repliedAt: new Date(Date.now() - 90_000_000).toISOString(), replyIntent: 'NEEDS_MORE_INFO', replySummary: 'Curious but wants pricing before committing to a call.', replyKeyQuote: 'What does this cost for a team our size?', replySuggestedAction: 'Share the Growth plan pricing and a one-line ROI.', replyUrgency: 'this_week', replyConfidence: 76, replyIsAutoReply: false, lead: { id: 'dl1', businessName: 'Meridian Roofing', stage: 'REPLIED' } },
    { id: 'dr3', toEmail: 'info@bluebonnet.example', subject: 'Bluebonnet Electric — scheduling', sentAt: new Date(Date.now() - 345_600_000).toISOString(), repliedAt: new Date(Date.now() - 200_000_000).toISOString(), replyIntent: 'NOT_NOW', replySummary: 'Revisiting tools next quarter; asked to follow up later.', replyKeyQuote: 'Reach back out in Q4.', replySuggestedAction: 'Set a Q4 reminder and nurture.', replyUrgency: 'nurture', replyConfidence: 82, replyIsAutoReply: false, lead: { id: 'dl4', businessName: 'Bluebonnet Electric', stage: 'REPLIED' } },
  ],
  counts: { INTERESTED: 1, NEEDS_MORE_INFO: 1, NOT_NOW: 1 },
  total: 3,
}

// One permissive shape that satisfies the destructuring of the many list-style
// endpoints we don't bother seeding individually — so untouched views fall back
// to clean, valid empties instead of crashing.
const PERMISSIVE_EMPTY = {
  prospects: [], total: 0, drafts: [], missions: [], runs: [], sources: [],
  signals: [], hot: [], warm: [], cold: [], checks: [], ready: true,
  items: [], leads: [], members: [], events: [],
}

export function makeDemoApi(): ApiHook {
  return (async <T = unknown>(path: string, init?: { method?: string }): Promise<T> => {
    // Mutations: pretend success.
    if (init?.method && init.method.toUpperCase() !== 'GET') return {} as T

    if (path.startsWith('/api/stats')) return DEMO_STATS as T
    if (path.includes('/intelligence/opportunities')) return { hot: DEMO_HOT, warm: [], cold: [] } as T
    if (path.includes('/intelligence/forecast')) return DEMO_FORECAST as T
    if (path.includes('/api/signals')) return { signals: DEMO_SIGNALS } as T
    if (path.includes('/approvals/pending')) return { drafts: DEMO_DRAFTS } as T
    if (path.includes('/api/prospects?')) return { prospects: DEMO_PROSPECTS, total: DEMO_PROSPECTS.length } as T
    // Single-prospect detail fetch (e.g. `/api/prospects/dp1`) — matched AFTER the
    // list/query routes above so it doesn't shadow them. Without this, the detail
    // panel's own fetch falls through to PERMISSIVE_EMPTY (a list-shaped object)
    // and overwrites the perfectly good row data it was opened with, rendering a
    // blank detail view.
    {
      const prospectDetailMatch = /\/api\/prospects\/([^/?]+)$/.exec(path)
      if (prospectDetailMatch) {
        const found = DEMO_PROSPECTS.find(p => p.id === prospectDetailMatch[1])
        if (found) return { ...found, signals: [], recommendations: [], outcomes: [] } as T
      }
    }
    if (path.includes('/api/missions')) return { missions: DEMO_MISSIONS } as T
    if (path.includes('/api/leads?')) return { leads: DEMO_LEADS, total: DEMO_STATS.totalLeads } as T
    if (path.includes('/api/inbox')) return DEMO_INBOX as T
    if (path.includes('/api/sends/summary')) return { total: 103, delivered: 103, sent: 78, replied: 22, bounced: 3, failed: 0, sending: 0, last24hSent: 12, replyRate: 21.4 } as T
    if (path.includes('/send-readiness')) return { ready: true, checks: [] } as T
    if (path.includes('/billing/plans')) return { plans: DEMO_BILLING_PLANS } as T
    if (path.includes('/billing/status')) return DEMO_BILLING_STATUS as T
    if (path.includes('/compliance')) return DEMO_COMPLIANCE as T

    return PERMISSIVE_EMPTY as T
  }) as ApiHook
}
