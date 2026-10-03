// Demo seed: "Sparky & Co Electrical", a Brisbane electrical contractor, for the
// demo in docs/DEMO_SCRIPT.md. Discovery-sweep and opportunity-engine output is
// written directly (as those jobs would); every user action — quotes, jobs, crew,
// shifts, closeouts — goes through the real API, so the demo exercises the app.
//
// Local only. Needs the API on :4000 against a throwaway database, and the owner
// account created first:
//   curl -X POST localhost:4000/api/auth/signup -H 'Content-Type: application/json' \
//     -d '{"email":"owner@sparkyco.example","password":"Sup3rStrongPass!","name":"Jordan Reid"}'
//   NODE_OPTIONS=--conditions=acaos-src npx tsx scripts/demo/seed-contractor.mts
import { PrismaClient } from '@prisma/client'

if (process.env.NODE_ENV === 'production') throw new Error('demo seed refuses to run with NODE_ENV=production')

const prisma = new PrismaClient()
const API = 'http://localhost:4000'
const EMAIL = 'owner@sparkyco.example'
const PASSWORD = 'Sup3rStrongPass!'
const DAY = 86_400_000
const now = Date.now()
const ago = (d: number) => new Date(now - d * DAY)

async function api(token: string, method: string, path: string, body?: unknown) {
  const r = await fetch(API + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(j)}`)
  return j as any
}

const user = await prisma.user.update({ where: { email: EMAIL }, data: { emailVerified: true } })
const ws = (await prisma.membership.findFirst({ where: { userId: user.id } }))!.workspaceId
await prisma.workspace.update({ where: { id: ws }, data: { name: 'Sparky & Co Electrical', onboardingCompleted: true } })
const login = await (await fetch(API + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) })).json() as any
const T = login.token as string

// ── Work discovery (what the sweep finds) ──
let n = 0
const opp = (o: Record<string, unknown>) => prisma.opportunity.create({ data: {
  workspaceId: ws, source: 'planningalerts', externalId: `DA-${++n}`, kind: 'DEVELOPMENT_APPLICATION', score: 70,
  matchedTrades: ['electrical'], reasons: ['Classified as electrical work'], contentHash: `h${n}`, region: 'QLD', ...o,
} as any })

const fresh = await opp({
  title: 'Childcare centre fit-out — 14 Banksia St, Nundah', locality: 'Nundah', address: '14 Banksia St, Nundah QLD 4012', score: 86, valueAmount: 380000, publishedAt: ago(1),
  reasons: ['Development application lodged 1 day ago', 'Commercial fit-out: switchboards, lighting, data', 'Value ~$380k, 7 km from base'],
  recommendedAction: 'Call the builder before the electrical package goes to tender.', counterpartyName: 'Hutchins Build Pty Ltd', counterpartyPhone: '07 3555 0141', sourceUrl: 'https://www.planningalerts.org.au/applications/1',
})
await opp({
  source: 'austender', kind: 'CONTRACT_AWARD', title: 'Lighting upgrade — Brisbane Magistrates Court', locality: 'Brisbane City', score: 79, valueAmount: 1250000, publishedAt: ago(3),
  reasons: ['Head contract awarded 3 days ago', 'LED retrofit across 9 floors', 'Contract value $1.25M'], recommendedAction: 'Contact Ardent Construct — they won the head contract and will need an electrical subcontractor.',
  counterpartyName: 'Ardent Construct', counterpartyEmail: 'tenders@ardent.example', sourceUrl: 'https://www.tenders.gov.au/Cn/Show/1',
})
const pursuing = await opp({
  title: 'Cold store expansion — 7 Export St, Eagle Farm', locality: 'Eagle Farm', score: 81, valueAmount: 640000, publishedAt: ago(9), status: 'PURSUING',
  reasons: ['DA approved 9 days ago', '3-phase supply upgrade and refrigeration circuits'], recommendedAction: 'Quote the switchboard and sub-mains package.', counterpartyName: 'Coldline Logistics',
})
await api(T, 'PUT', '/api/opportunities/profile', { workspaceId: ws, trades: ['electrical'], keywords: ['switchboard', 'fit-out'], regions: ['QLD'], sources: ['austender', 'planningalerts'] })

// The DA that this business is pursuing gets a submitted quote — the capture moment.
await api(T, 'POST', '/api/delivery/quotes', { workspaceId: ws, opportunityId: pursuing.id, amountCents: 8_650_000, estimatedHours: 420, submit: true })

// ── Crew ──
const crew: Record<string, string> = {}
for (const [code, name, role, rate] of [['E01', 'Mia Tran', 'Electrician', 62], ['E02', 'Liam Ortiz', 'Electrician', 58], ['A01', 'Noah Kelly', 'Apprentice', 34], ['E03', 'Ava Singh', 'Electrician', null]] as const) {
  const c = await api(T, 'POST', '/api/ops/crew', { workspaceId: ws, employeeCode: code, fullName: name, role, ...(rate != null ? { baseRate: rate } : {}) })
  crew[code] = c.crew.id
}

async function shifts(siteId: string, plan: Array<[string, number, number]>) {
  // [crewCode, days, hoursPerDay]
  for (const [code, days, hours] of plan) {
    for (let d = 0; d < days; d++) {
      const day = new Date(Date.UTC(2026, 6, 1 + d))
      const start = new Date(day.getTime() + 6 * 3_600_000)
      await api(T, 'POST', '/api/ops/shifts', { workspaceId: ws, crewMemberId: crew[code], jobSiteId: siteId, shiftDate: day.toISOString(), startTime: start.toISOString(), endTime: new Date(start.getTime() + hours * 3_600_000).toISOString() })
    }
  }
}

// ── Three finished jobs from development applications (so the report has n = 3) ──
const history: Array<{ title: string; quote: number; est: number; plan: Array<[string, number, number]>; invoiced: number; other: number }> = [
  { title: 'Medical suites — 22 Grey St, South Brisbane', quote: 5_200_000, est: 300, plan: [['E01', 18, 9], ['A01', 18, 9]], invoiced: 5_480_000, other: 1_650_000 },
  { title: 'Café and bakery fit-out — Paddington', quote: 2_400_000, est: 140, plan: [['E02', 10, 8], ['A01', 9, 8]], invoiced: 2_400_000, other: 820_000 },
  { title: 'Warehouse LED retrofit — Rocklea', quote: 3_900_000, est: 220, plan: [['E01', 15, 9], ['E02', 14, 9]], invoiced: 4_150_000, other: 1_380_000 },
]
for (const h of history) {
  const o = await opp({ title: h.title, status: 'PURSUING', publishedAt: ago(120) })
  const q = await api(T, 'POST', '/api/delivery/quotes', { workspaceId: ws, opportunityId: o.id, amountCents: h.quote, estimatedHours: h.est, submit: true })
  await api(T, 'PATCH', `/api/delivery/quotes/${q.quote.id}/status`, { workspaceId: ws, status: 'ACCEPTED' })
  const job = await api(T, 'POST', `/api/delivery/quotes/${q.quote.id}/job`, { workspaceId: ws })
  await shifts(job.job.opsJobSiteId, h.plan)
  await api(T, 'POST', `/api/delivery/jobs/${job.job.id}/closeout`, { workspaceId: ws, invoicedRevenueCents: h.invoiced, otherCostCents: h.other, onCostPct: 25 })
}

// ── One job in progress, with a crew member who has no rate yet (an honest gap) ──
{
  const o = await opp({ title: 'Gym fit-out — 210 Logan Rd, Woolloongabba', status: 'PURSUING', publishedAt: ago(40) })
  const q = await api(T, 'POST', '/api/delivery/quotes', { workspaceId: ws, opportunityId: o.id, amountCents: 4_700_000, estimatedHours: 260, submit: true })
  await api(T, 'PATCH', `/api/delivery/quotes/${q.quote.id}/status`, { workspaceId: ws, status: 'ACCEPTED' })
  const job = await api(T, 'POST', `/api/delivery/quotes/${q.quote.id}/job`, { workspaceId: ws, jobCode: 'GYM-210' })
  await shifts(job.job.opsJobSiteId, [['E01', 12, 9], ['E03', 8, 8]])
}

// ── Commercial opportunities (what the opportunity engine produces) ──
async function commercial(company: string, contact: [string, string, string], o: Record<string, unknown>, citations: Array<[string, string, string, number]>) {
  const p = await prisma.prospect.create({ data: { workspaceId: ws, companyName: company, contactName: contact[0], contactTitle: contact[1], contactEmail: contact[2] } })
  const cites = citations.map(([claim, source, url, age]) => ({ signalId: null, claim, source, sourceUrl: url, eventDate: ago(age).toISOString(), ageDays: age, quality: 82 }))
  return prisma.commercialOpportunity.create({ data: {
    workspaceId: ws, prospectId: p.id, offerKey: 'offer:crews', evidenceConfidence: 80, trustworthySignals: 2, offerFit: 78, intentScore: 74, timingScore: 80, contactability: 70,
    blockers: [], reasons: [], evidence: cites, velocity: [], firstDetectedAt: ago(2),
    recommendation: { kind: 'CONTACT_NOW', label: 'Contact now', headline: o.headline, why: o.why, citations: cites, outreach: true, urgency: o.urgency, priority: o.priority, waitDays: null, revisitAt: null, proofPoint: null, nextSteps: [], basis: { buyingStage: o.buyingStage, stance: 'ACT', nextBestAction: 'CONTACT' } },
    ...Object.fromEntries(Object.entries(o).filter(([k]) => !['headline', 'why'].includes(k))),
  } as any })
}
await commercial('Northside Builders', ['Sam Lee', 'Operations Manager', 'sam@northside.example'], {
  eventType: 'CAPACITY_EXPANSION', eventFamily: 'GROWTH', eventTitle: 'Opening a second depot in Brendale', whyNow: 'New depot opens next month and they are hiring 17 site staff — electrical fit-out is not yet awarded.',
  confidence: 84, independentSources: 3, expectedValueCents: 2_160_000, estimatedValueMinCents: 5_000_000, estimatedValueMaxCents: 9_000_000, probability: 0.31, urgency: 'HIGH', priority: 88,
  buyingStage: 'ACTIVE_REQUIREMENT', recommendedAction: 'CONTACT_NOW', actionLabel: 'Call Sam Lee this week', actionReason: 'Three independent sources, fit-out not yet awarded', recommendationKind: 'CONTACT_NOW', intelligenceGate: true, status: 'OPEN',
  headline: 'Call now: the Brendale depot fit-out is unawarded and opens next month', why: ['Three independent sources confirm the expansion', 'Hiring 17 site staff signals an imminent start', 'Electrical package not yet tendered'],
}, [['Hiring 17 site staff for the new Brendale depot', 'seek.com.au', 'https://www.seek.com.au/job/1', 2], ['Council approved the Brendale depot DA', 'planningalerts.org.au', 'https://www.planningalerts.org.au/applications/2', 6], ['Northside Builders announces second depot', 'news.example.org', 'https://news.example.org/northside', 4]])
await commercial('Harbour Civil', ['Priya Nair', 'Project Director', 'priya@harbourcivil.example'], {
  eventType: 'TENDER_OPPORTUNITY', eventFamily: 'ACTIVE_PROCUREMENT', eventTitle: 'Won the Port of Brisbane amenities contract', whyNow: 'Head contract awarded last week; subcontract packages are being let now.',
  confidence: 78, independentSources: 2, expectedValueCents: 1_420_000, probability: 0.24, urgency: 'HIGH', priority: 81, buyingStage: 'BUYING_DECISION', recommendedAction: 'CONTACT_NOW',
  actionLabel: 'Email Priya with your switchboard capability', actionReason: 'Subcontract packages are being let this month', recommendationKind: 'CONTACT_NOW', intelligenceGate: true, status: 'PURSUING',
  headline: 'Send capability now: subcontract packages close this month', why: ['Head contract award confirmed on AusTender', 'Packages typically let within 3 weeks of award'],
}, [['Contract awarded: Port of Brisbane amenities upgrade, $5.9M', 'tenders.gov.au', 'https://www.tenders.gov.au/Cn/Show/2', 8], ['Harbour Civil hiring a site electrician supervisor', 'seek.com.au', 'https://www.seek.com.au/job/2', 5]])
await commercial('Ridge Property Group', ['Tom Burke', 'Development Manager', 'tom@ridge.example'], {
  eventType: 'HIRING_SURGE', eventFamily: 'GROWTH', eventTitle: 'Hiring for a 40-lot townhouse estate', whyNow: 'Early signals only — no DA lodged yet.',
  confidence: 52, independentSources: 1, expectedValueCents: null, probability: 0.08, urgency: 'LOW', priority: 34, buyingStage: 'EARLY_SIGNAL', recommendedAction: 'MONITOR',
  actionLabel: 'Watch for the DA', actionReason: 'Single source; confirm before outreach', recommendationKind: 'MONITOR', intelligenceGate: false, status: 'OPEN',
  headline: 'Wait for the DA before reaching out', why: ['Only one source so far'],
}, [['Ridge Property Group hiring a site manager for "Ridge Gardens"', 'linkedin.com', 'https://www.linkedin.com/jobs/1', 3]])
const won = await commercial('Apex Aged Care', ['Grace Wu', 'Facilities Lead', 'grace@apex.example'], {
  eventType: 'CAPACITY_EXPANSION', eventFamily: 'GROWTH', eventTitle: 'New 60-bed wing', whyNow: 'Won.', confidence: 81, independentSources: 2, expectedValueCents: 1_900_000, probability: 0.4, urgency: 'MEDIUM', priority: 60,
  buyingStage: 'BUYING_DECISION', recommendedAction: 'CONTACT_NOW', actionLabel: '—', actionReason: '—', recommendationKind: 'CONTACT_NOW', intelligenceGate: true, status: 'PURSUING', headline: '—', why: ['—'],
}, [['Apex Aged Care approved for a 60-bed wing', 'health.qld.gov.au', 'https://www.health.qld.gov.au/1', 30]])
await prisma.commercialOpportunity.update({ where: { id: won.id }, data: { firstDetectedAt: ago(45) } })
const wq = await api(T, 'POST', '/api/delivery/quotes', { workspaceId: ws, commercialOpportunityId: won.id, amountCents: 6_800_000, estimatedHours: 380, submit: true })
await api(T, 'PATCH', `/api/delivery/quotes/${wq.quote.id}/status`, { workspaceId: ws, status: 'ACCEPTED' })

console.log(JSON.stringify({ ws, fresh: fresh.id, ok: true }))
await prisma.$disconnect()
