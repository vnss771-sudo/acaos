import { ApiError } from '../../lib/http.js'
import type { SignalType } from '../../lib/signalEngine.js'

// ── F-04: SSRF protection helpers ────────────────────────────────────────────
// Host validation lives in lib/ssrf.ts (`assertPublicMailHost`), which resolves
// the hostname and rejects every address that points at private/reserved space —
// closing the DNS-resolves-to-private and IPv6/mapped bypasses that a literal
// string-prefix check cannot. Only port allow-listing remains local here.

export function validateMailPort(port: number | undefined | null, allowed: number[], field: string): void {
  if (!port) return
  if (!allowed.includes(port)) {
    throw new ApiError(400, `${field}: port ${port} not permitted. Allowed: ${allowed.join(', ')}`)
  }
}

// Deterministic per-company pseudo-score so demos look identical run-to-run and
// any test that depends on seeded data is stable. (Previously Math.random(),
// which made the dashboard and seed-dependent tests non-deterministic.)
export function seededScore(companyName: string, salt: number, range: number, base: number): number {
  let h = salt >>> 0
  for (let i = 0; i < companyName.length; i++) {
    h = (Math.imul(h, 31) + companyName.charCodeAt(i)) >>> 0
  }
  return (h % range) + base
}

// Hardcoded seed companies per playbook (fictional, clearly marked)
export const SEED_COMPANIES: Record<string, Array<{
  companyName: string; industry: string; location: string; employeeCount: number;
  description: string; contactName: string; contactTitle: string
}>> = {
  industrial: [
    { companyName: 'Ironclad Engineering Pty Ltd', industry: 'Industrial Engineering', location: 'Brisbane, QLD', employeeCount: 28, description: 'Structural fabrication and site works for mining and civil projects', contactName: 'Gary Malone', contactTitle: 'Operations Manager' },
    { companyName: 'Summit Plant & Equipment', industry: 'Construction', location: 'Ipswich, QLD', employeeCount: 15, description: 'Plant hire and civil earthworks across South-East Queensland', contactName: 'Kerry Walsh', contactTitle: 'General Manager' },
    { companyName: 'Apex Fabrication Group', industry: 'Manufacturing', location: 'Acacia Ridge, QLD', employeeCount: 42, description: 'Custom steel fabrication for industrial and resource sector clients', contactName: 'Dan Prescott', contactTitle: 'Managing Director' },
  ],
  recruitment: [
    { companyName: 'Bridgeway Labour Solutions', industry: 'Recruitment', location: 'Brisbane, QLD', employeeCount: 12, description: 'Specialised trade and industrial labour hire across QLD', contactName: 'Alicia Park', contactTitle: 'Director' },
    { companyName: 'Crestfield Workforce Group', industry: 'Staffing', location: 'Gold Coast, QLD', employeeCount: 20, description: 'Mining, civil and construction workforce supply', contactName: 'Tom Briers', contactTitle: 'Managing Director' },
    { companyName: 'Pinnacle People Pty Ltd', industry: 'HR & Recruitment', location: 'Townsville, QLD', employeeCount: 9, description: 'Regional labour hire focusing on Northern Queensland trades', contactName: 'Sarah Nguyen', contactTitle: 'Operations Lead' },
  ],
  equipment: [
    { companyName: 'TerraMax Equipment Group', industry: 'Equipment Supply', location: 'Yatala, QLD', employeeCount: 35, description: 'Heavy equipment sales, hire and servicing for construction sector', contactName: 'Phil Donovan', contactTitle: 'Sales Director' },
    { companyName: 'ProFleet Machinery', industry: 'Equipment Rental', location: 'Wacol, QLD', employeeCount: 18, description: 'Short and long-term plant hire with on-site maintenance', contactName: 'Craig Ellison', contactTitle: 'Operations Manager' },
    { companyName: 'BlueLine Attachments', industry: 'Manufacturing', location: 'Archerfield, QLD', employeeCount: 11, description: 'Custom excavator attachments and bucket rebuilds', contactName: 'Mark Sutton', contactTitle: 'Owner' },
  ],
  agency: [
    { companyName: 'Meridian Digital Studio', industry: 'Marketing Agency', location: 'Brisbane, QLD', employeeCount: 8, description: 'Web design, SEO and digital campaigns for SMEs', contactName: 'Jessica Holt', contactTitle: 'Creative Director' },
    { companyName: 'Clearpath Marketing Group', industry: 'Advertising', location: 'Fortitude Valley, QLD', employeeCount: 14, description: 'Brand strategy and digital advertising for B2B clients', contactName: 'Leo Vance', contactTitle: 'CEO' },
    { companyName: 'Vantage Content Co.', industry: 'Content Marketing', location: 'Newstead, QLD', employeeCount: 6, description: 'Content strategy, copywriting and social media management', contactName: 'Amy Foster', contactTitle: 'Managing Editor' },
  ],
  b2b_services: [
    { companyName: 'Highbridge Advisory Pty Ltd', industry: 'Business Consulting', location: 'Brisbane CBD, QLD', employeeCount: 7, description: 'Strategic advisory for growth-stage SMEs and family businesses', contactName: 'Neil Crawford', contactTitle: 'Principal' },
    { companyName: 'Focal Accounting Solutions', industry: 'Accounting', location: 'Milton, QLD', employeeCount: 11, description: 'Cloud accounting, tax and CFO-as-a-service for SMEs', contactName: 'Priya Sharma', contactTitle: 'Managing Partner' },
    { companyName: 'Sentinel Legal Group', industry: 'Legal Services', location: 'Spring Hill, QLD', employeeCount: 9, description: 'Commercial law, contracts and business dispute resolution', contactName: 'David Kwan', contactTitle: 'Principal Solicitor' },
  ],
}

export type ExampleSignalRow = {
  type: SignalType; strength: number; sourceReliability: number; industryRelevance: number;
  title: string; description: string | null; source: string; daysAgo: number
}

// Fictional buying signals for each example prospect — seeds the evidence panel
export const EXAMPLE_SIGNALS: Record<string, ExampleSignalRow[]> = {
  'Ironclad Engineering Pty Ltd': [
    { type: 'HIRING', strength: 78, sourceReliability: 80, industryRelevance: 85, title: '6 open positions on Seek', description: 'Hiring boilermakers, riggers and a site supervisor', source: 'example', daysAgo: 3 },
    { type: 'EXPANSION', strength: 72, sourceReliability: 70, industryRelevance: 80, title: 'Team grew 18% in 6 months', description: null, source: 'example', daysAgo: 14 },
  ],
  'Summit Plant & Equipment': [
    { type: 'PROCUREMENT', strength: 80, sourceReliability: 75, industryRelevance: 90, title: 'Tendered on 2 civil contracts', description: 'Active bids on SEQ infrastructure projects', source: 'example', daysAgo: 5 },
    { type: 'HIRING', strength: 65, sourceReliability: 80, industryRelevance: 75, title: '3 open positions', description: 'Seeking operators and a fleet coordinator', source: 'example', daysAgo: 9 },
  ],
  'Apex Fabrication Group': [
    { type: 'FUNDING', strength: 85, sourceReliability: 90, industryRelevance: 80, title: 'Series A · $4.2M total funding', description: 'Last round 4 months ago', source: 'example', daysAgo: 120 },
    { type: 'EXPANSION', strength: 75, sourceReliability: 75, industryRelevance: 85, title: 'Opened second facility in Rocklea', description: null, source: 'example', daysAgo: 21 },
    { type: 'HIRING', strength: 70, sourceReliability: 80, industryRelevance: 78, title: '8 open positions', description: 'Major recruiting push across fabrication and QA roles', source: 'example', daysAgo: 2 },
  ],
  'Bridgeway Labour Solutions': [
    { type: 'EXPANSION', strength: 70, sourceReliability: 72, industryRelevance: 80, title: 'New branch in Mackay', description: null, source: 'example', daysAgo: 30 },
    { type: 'HIRING', strength: 68, sourceReliability: 80, industryRelevance: 75, title: '4 open positions', description: null, source: 'example', daysAgo: 7 },
  ],
  'Crestfield Workforce Group': [
    { type: 'PROCUREMENT', strength: 82, sourceReliability: 78, industryRelevance: 88, title: 'Won 2 mining site contracts', description: 'Expanding workforce supply to Bowen Basin', source: 'example', daysAgo: 11 },
  ],
  'TerraMax Equipment Group': [
    { type: 'HIRING', strength: 75, sourceReliability: 80, industryRelevance: 82, title: '5 open positions', description: 'Sales reps and service technicians', source: 'example', daysAgo: 4 },
    { type: 'FUNDING', strength: 80, sourceReliability: 85, industryRelevance: 78, title: 'Seed · $1.8M raised', description: null, source: 'example', daysAgo: 90 },
  ],
  'Meridian Digital Studio': [
    { type: 'HIRING', strength: 72, sourceReliability: 80, industryRelevance: 70, title: '3 open positions', description: 'Developer, designer and a new account manager', source: 'example', daysAgo: 6 },
    { type: 'WEBSITE_CHANGE', strength: 60, sourceReliability: 65, industryRelevance: 65, title: 'Launched new service page', description: 'Added lead generation service offering', source: 'example', daysAgo: 18 },
  ],
  'Highbridge Advisory Pty Ltd': [
    { type: 'EXPANSION', strength: 73, sourceReliability: 70, industryRelevance: 78, title: 'Added 3 new advisory partners', description: null, source: 'example', daysAgo: 25 },
    { type: 'HIRING', strength: 67, sourceReliability: 80, industryRelevance: 72, title: '2 open positions', description: null, source: 'example', daysAgo: 12 },
  ],
  '__default__': [
    { type: 'HIRING', strength: 70, sourceReliability: 75, industryRelevance: 75, title: '4 open positions detected', description: null, source: 'example', daysAgo: 5 },
    { type: 'EXPANSION', strength: 68, sourceReliability: 70, industryRelevance: 72, title: 'Team headcount growing', description: null, source: 'example', daysAgo: 20 },
  ],
}
