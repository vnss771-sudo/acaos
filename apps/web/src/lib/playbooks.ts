export type SeedCompany = {
  companyName: string
  industry: string
  location: string
  employeeCount: number
  description: string
  contactName: string
  contactTitle: string
}

export type Playbook = {
  id: string
  label: string
  description: string
  icon: string
  icp: {
    targetIndustries: string[]
    targetGeos: string[]
    minEmployees: number | null
    maxEmployees: number | null
    mustHaveEmail: boolean
    excludedIndustries: string[]
    outreachTone: string
    dailySendLimit: number
  }
  signalPriorities: string[]
  outreachAngle: string
  buyingTriggers: string[]
  sampleCompanies: SeedCompany[]
}

export const PLAYBOOKS: Playbook[] = [
  {
    id: 'industrial',
    label: 'Industrial Services',
    description: 'Target manufacturing, mining, and construction companies actively growing or hiring.',
    icon: '🏗️',
    icp: {
      targetIndustries: ['Manufacturing', 'Mining', 'Construction', 'Engineering', 'Civil Works'],
      targetGeos: ['Brisbane', 'Queensland', 'Australia'],
      minEmployees: 10,
      maxEmployees: 500,
      mustHaveEmail: false,
      excludedIndustries: ['Retail', 'Hospitality'],
      outreachTone: 'direct',
      dailySendLimit: 50
    },
    signalPriorities: ['HIRING', 'EXPANSION', 'PROCUREMENT'],
    outreachAngle: 'Lead with operational efficiency gains and cost savings relevant to their current growth phase.',
    buyingTriggers: [
      'Hiring multiple tradespeople',
      'Won new council contract',
      'Expanding into new site',
      'Posted for a project manager or site supervisor',
      'Awarded government infrastructure tender'
    ],
    sampleCompanies: [
      {
        companyName: 'Ironclad Engineering Pty Ltd',
        industry: 'Engineering',
        location: 'Brisbane, QLD',
        employeeCount: 42,
        description: 'Structural steel fabrication and site installation for commercial and industrial projects across SE Queensland.',
        contactName: 'Brett Callahan',
        contactTitle: 'Operations Manager'
      },
      {
        companyName: 'Summit Plant & Equipment',
        industry: 'Construction',
        location: 'Ipswich, QLD',
        employeeCount: 28,
        description: 'Heavy plant hire and civil earthworks specialist servicing infrastructure and mining sectors in Queensland.',
        contactName: 'Gavin Marsh',
        contactTitle: 'General Manager'
      },
      {
        companyName: 'Apex Fabrication Group',
        industry: 'Manufacturing',
        location: 'Acacia Ridge, QLD',
        employeeCount: 65,
        description: 'Custom metal fabrication and pressure vessel manufacture for industrial and resources clients nationally.',
        contactName: 'Sandra Ouwens',
        contactTitle: 'Business Development Manager'
      }
    ]
  },
  {
    id: 'recruitment',
    label: 'Recruitment & Labour Hire',
    description: 'Target HR, staffing, and labour hire agencies scaling their operations.',
    icon: '👥',
    icp: {
      targetIndustries: ['Staffing', 'Human Resources', 'Labour Hire', 'Workforce Solutions', 'Recruitment'],
      targetGeos: ['Australia'],
      minEmployees: 5,
      maxEmployees: 300,
      mustHaveEmail: true,
      excludedIndustries: ['Manufacturing', 'Mining'],
      outreachTone: 'professional',
      dailySendLimit: 50
    },
    signalPriorities: ['HIRING', 'EXPANSION', 'BUSINESS_REGISTRATION'],
    outreachAngle: 'Lead with how your solution accelerates candidate placement speed or reduces time-to-fill for their clients.',
    buyingTriggers: [
      'Opening a new branch office',
      'Expanding into new vertical or sector',
      'Hiring internal recruiters at scale',
      'Recently registered as a new agency',
      'Winning a large volume labour contract'
    ],
    sampleCompanies: [
      {
        companyName: 'Bridgepoint Workforce Solutions',
        industry: 'Staffing',
        location: 'Sydney, NSW',
        employeeCount: 34,
        description: 'White-collar and technical recruitment agency specialising in engineering, finance, and technology roles across Australia.',
        contactName: 'Rachel Dunmore',
        contactTitle: 'Managing Director'
      },
      {
        companyName: 'Frontline Labour Group',
        industry: 'Labour Hire',
        location: 'Melbourne, VIC',
        employeeCount: 18,
        description: 'Blue-collar labour hire provider supplying casual and contract workers to construction and logistics clients.',
        contactName: 'Tim Vickers',
        contactTitle: 'Operations Director'
      },
      {
        companyName: 'Clearpath Talent Partners',
        industry: 'Human Resources',
        location: 'Perth, WA',
        employeeCount: 11,
        description: 'Boutique recruitment consultancy focused on executive and mid-level placements in resources and professional services.',
        contactName: 'Alicia Ngo',
        contactTitle: 'Principal Consultant'
      }
    ]
  },
  {
    id: 'equipment',
    label: 'Equipment Supplier',
    description: 'Target construction and mining companies procuring or upgrading equipment.',
    icon: '⚙️',
    icp: {
      targetIndustries: ['Construction', 'Mining', 'Civil Engineering', 'Quarrying', 'Agriculture'],
      targetGeos: ['Australia'],
      minEmployees: 10,
      maxEmployees: 1000,
      mustHaveEmail: false,
      excludedIndustries: ['Retail', 'Finance'],
      outreachTone: 'direct',
      dailySendLimit: 40
    },
    signalPriorities: ['EXPANSION', 'PROCUREMENT', 'HIRING'],
    outreachAngle: 'Lead with total cost of ownership and uptime guarantees relevant to their current project pipeline.',
    buyingTriggers: [
      'Expanding fleet or site capacity',
      'Issued a procurement tender for equipment',
      'Hiring machine operators or mechanics',
      'Won a large infrastructure project',
      'Replacing ageing equipment fleet'
    ],
    sampleCompanies: [
      {
        companyName: 'Redstone Civil Contractors',
        industry: 'Civil Engineering',
        location: 'Mackay, QLD',
        employeeCount: 87,
        description: 'Civil contracting firm delivering road, pipeline, and drainage projects for resource and government clients in regional Queensland.',
        contactName: 'Dean Faulkner',
        contactTitle: 'Project Director'
      },
      {
        companyName: 'Goldfields Drilling Services',
        industry: 'Mining',
        location: 'Kalgoorlie, WA',
        employeeCount: 55,
        description: 'Contract drilling company operating across gold and nickel projects in the Goldfields region of Western Australia.',
        contactName: 'Peter Simons',
        contactTitle: 'Fleet Manager'
      },
      {
        companyName: 'Harwood Quarries Pty Ltd',
        industry: 'Quarrying',
        location: 'Hunter Valley, NSW',
        employeeCount: 32,
        description: 'Aggregate and crushed stone producer supplying road construction and building materials across NSW.',
        contactName: 'Carol Whitfield',
        contactTitle: 'Operations Manager'
      }
    ]
  },
  {
    id: 'agency',
    label: 'Marketing & Web Agency',
    description: 'Target businesses refreshing their brand, launching new sites, or changing leadership.',
    icon: '🎨',
    icp: {
      targetIndustries: ['Professional Services', 'Retail', 'Healthcare', 'Hospitality', 'Finance', 'Real Estate'],
      targetGeos: ['Australia'],
      minEmployees: 5,
      maxEmployees: 200,
      mustHaveEmail: true,
      excludedIndustries: ['Mining', 'Agriculture'],
      outreachTone: 'casual',
      dailySendLimit: 60
    },
    signalPriorities: ['WEBSITE_CHANGE', 'EXPANSION', 'LEADERSHIP_CHANGE'],
    outreachAngle: 'Lead with a specific observation about their current online presence or a recent business change.',
    buyingTriggers: [
      'Website not updated in 2+ years',
      'New CEO or marketing manager appointed',
      'Opened a second location',
      'Rebranding after acquisition',
      'Competitors recently launched new sites'
    ],
    sampleCompanies: [
      {
        companyName: 'Meridian Wealth Advisors',
        industry: 'Finance',
        location: 'Adelaide, SA',
        employeeCount: 14,
        description: 'Boutique financial planning firm providing retirement, investment, and estate planning services to private clients.',
        contactName: 'James Holbrook',
        contactTitle: 'Principal Advisor'
      },
      {
        companyName: 'Coastal Dental Group',
        industry: 'Healthcare',
        location: 'Gold Coast, QLD',
        employeeCount: 22,
        description: 'Multi-chair dental practice offering general and cosmetic dentistry across two clinics on the Gold Coast.',
        contactName: 'Dr. Priya Sharma',
        contactTitle: 'Practice Owner'
      },
      {
        companyName: 'Highgate Property Group',
        industry: 'Real Estate',
        location: 'Melbourne, VIC',
        employeeCount: 19,
        description: 'Independent real estate agency specialising in residential sales and property management in Melbourne\'s inner east.',
        contactName: 'Marcus Tran',
        contactTitle: 'Director'
      }
    ]
  },
  {
    id: 'b2b_services',
    label: 'B2B Professional Services',
    description: 'Target accounting, legal, and consulting firms growing or adopting new technology.',
    icon: '💼',
    icp: {
      targetIndustries: ['Accounting', 'Legal', 'Management Consulting', 'IT Consulting', 'Business Advisory'],
      targetGeos: ['Australia'],
      minEmployees: 5,
      maxEmployees: 250,
      mustHaveEmail: true,
      excludedIndustries: ['Mining', 'Construction', 'Manufacturing'],
      outreachTone: 'professional',
      dailySendLimit: 40
    },
    signalPriorities: ['FUNDING', 'EXPANSION', 'TECH_ADOPTION'],
    outreachAngle: 'Lead with peer benchmarking or a compliance/efficiency risk relevant to their growth stage.',
    buyingTriggers: [
      'Raised funding or capital round',
      'Hiring additional fee earners or consultants',
      'Migrating to new practice management software',
      'Opening interstate office',
      'Winning a major corporate client'
    ],
    sampleCompanies: [
      {
        companyName: 'Langford & Associates CPA',
        industry: 'Accounting',
        location: 'Brisbane, QLD',
        employeeCount: 17,
        description: 'Mid-tier accounting firm providing tax, audit, and business advisory services to SMEs and high-net-worth individuals.',
        contactName: 'Helen Langford',
        contactTitle: 'Managing Partner'
      },
      {
        companyName: 'Axiom Strategy Group',
        industry: 'Management Consulting',
        location: 'Sydney, NSW',
        employeeCount: 23,
        description: 'Strategy and transformation consultancy working with ASX-listed and private equity-backed businesses across Australia.',
        contactName: 'Chris Okafor',
        contactTitle: 'Managing Director'
      },
      {
        companyName: 'Steele Harrison Legal',
        industry: 'Legal',
        location: 'Canberra, ACT',
        employeeCount: 12,
        description: 'Commercial law firm specialising in government contracting, procurement, and corporate advisory for growth-stage businesses.',
        contactName: 'Natasha Steele',
        contactTitle: 'Senior Partner'
      }
    ]
  }
]

export function getPlaybook(id: string): Playbook | undefined {
  return PLAYBOOKS.find(p => p.id === id)
}
