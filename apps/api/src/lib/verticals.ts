// Vertical signal packs — opinionated, evidence-based intelligence per industry
// Each pack defines: signal importance overrides, likely problems, owner roles, offer angles

export type VerticalConfig = {
  id: string
  label: string
  signalBoosts: Record<string, number>   // signal type → weight override (adds to base)
  likelyProblems: string[]
  ownerRoles: string[]
  offerAngles: string[]
  triggerKeywords: string[]              // words in company description/industry that match this vertical
}

export const VERTICAL_CONFIGS: VerticalConfig[] = [
  {
    id: 'industrial',
    label: 'Industrial / Field-Service / Trades',
    signalBoosts: {
      CONTRACT_AWARDED:      +25,
      TENDER_PUBLISHED:      +25,
      JOB_POSTING_SPIKE:     +20,
      PERMIT_APPROVED:       +20,
      PROJECT_START_DETECTED:+18,
      OFFICE_OPENING:        +15,
      GOV_GRANT_RECEIVED:    +12,
      HIRING:                +10,
      EXPANSION:             +8,
    },
    likelyProblems: [
      'Labour capacity pressure from rapid project growth',
      'Field reporting and job-costing admin burden',
      'Scheduling and crew coordination across multiple sites',
      'Compliance and safety documentation overhead',
      'Subcontractor management and payment delays',
      'Equipment tracking and maintenance scheduling',
      'Quote-to-invoice cycle taking too long',
    ],
    ownerRoles: [
      'Operations Manager',
      'Project Manager',
      'General Manager',
      'Director',
      'Fleet Manager',
      'Site Manager',
      'Construction Manager',
    ],
    offerAngles: [
      'Reduce admin overhead so field teams focus on work not paperwork',
      'Help manage increased project load without adding office headcount',
      'Improve field reporting and job costing accuracy in real time',
      'Support compliance and safety documentation automatically',
      'Streamline quote-to-invoice cycle to improve cash flow',
    ],
    triggerKeywords: [
      'electrical', 'plumbing', 'hvac', 'construction', 'civil', 'mechanical',
      'maintenance', 'facilities', 'field service', 'trades', 'contractor',
      'subcontract', 'infrastructure', 'building', 'engineering services',
      'solar installation', 'fleet', 'logistics', 'transport',
    ],
  },
  {
    id: 'recruitment',
    label: 'Recruitment / Staffing Agencies',
    signalBoosts: {
      HIRING:                +20,
      JOB_POSTING_SPIKE:     +22,
      EXPANSION:             +15,
      LEADERSHIP_CHANGE:     +12,
      CONTRACT_AWARDED:      +10,
    },
    likelyProblems: [
      'Lead generation and new client acquisition cost too high',
      'Candidate pipeline drying up in specialist verticals',
      'Business development time squeezed by delivery demands',
      'Consultant productivity and activity tracking gaps',
    ],
    ownerRoles: [
      'Managing Director',
      'Business Development Manager',
      'Director',
      'Partner',
      'Head of Growth',
    ],
    offerAngles: [
      'Generate warm outbound leads so consultants spend time closing not prospecting',
      'Identify companies actively hiring before they engage a competitor agency',
      'Automate client outreach sequencing to increase BD touchpoints',
    ],
    triggerKeywords: [
      'recruitment', 'staffing', 'talent acquisition', 'executive search',
      'headhunting', 'labour hire', 'workforce solutions', 'temp agency',
    ],
  },
  {
    id: 'managed-it',
    label: 'Managed IT / MSP',
    signalBoosts: {
      TECH_ADOPTION:         +20,
      TECH_STACK_CHANGED:    +22,
      HIRING:                +15,
      EXPANSION:             +12,
      LEADERSHIP_CHANGE:     +18,
      PRICING_PAGE_CHANGED:  +10,
    },
    likelyProblems: [
      'IT infrastructure outgrowing in-house team capability',
      'Security and compliance obligations after rapid growth',
      'Technology stack fragmentation across departments',
      'Rising Microsoft/cloud licensing costs with poor visibility',
    ],
    ownerRoles: [
      'IT Manager',
      'Head of Technology',
      'CTO',
      'Operations Director',
      'Finance Director',
    ],
    offerAngles: [
      'Reduce IT support burden as the team scales without adding headcount',
      'Handle compliance and security obligations before they become a liability',
      'Consolidate technology costs and improve visibility across the business',
    ],
    triggerKeywords: [
      'managed it', 'msp', 'it services', 'technology services', 'cyber',
      'cloud services', 'it support', 'microsoft partner', 'network',
    ],
  },
]

export function detectVertical(
  industry: string | null | undefined,
  description: string | null | undefined
): VerticalConfig | null {
  if (!industry && !description) return null
  const haystack = `${industry ?? ''} ${description ?? ''}`.toLowerCase()
  for (const v of VERTICAL_CONFIGS) {
    if (v.triggerKeywords.some(kw => haystack.includes(kw))) return v
  }
  return null
}

export function getVerticalSignalBoosts(
  industry: string | null | undefined,
  description: string | null | undefined
): Record<string, number> {
  return detectVertical(industry, description)?.signalBoosts ?? {}
}
