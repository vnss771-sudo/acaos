import type { IndustryPack } from './types.js'

// FieldOps: the first vertical pack — contractors, trades, field service,
// fabrication, and commercial maintenance operators. Gives ACAOS a beachhead
// instead of trying to serve everyone generically.
export const fieldOpsPack: IndustryPack = {
  id: 'fieldops',
  label: 'FieldOps — Trades & Field Service',
  description:
    'Contractors, trades, industrial service providers, fabrication shops, and commercial maintenance businesses. Targets operators showing growth/expansion signals and frames outreach around reducing admin load and winning more commercial work.',
  icp: {
    targetIndustries: [
      'construction',
      'electrical',
      'plumbing',
      'hvac',
      'industrial services',
      'fabrication',
      'commercial maintenance',
      'logistics',
    ],
    minEmployees: 5,
    maxEmployees: 200,
    targetGeos: [],
    businessType: 'field-service',
    outreachTone: 'direct',
    excludedIndustries: ['software', 'finance', 'media'],
  },
  signals: [
    { type: 'HIRING', why: 'Hiring technicians, apprentices, or service coordinators signals growth and an admin/ops bottleneck.' },
    { type: 'PROCUREMENT', why: 'Tender wins / new commercial contracts mean more work to coordinate and follow up.' },
    { type: 'EXPANSION', why: 'New branch, depot, or fleet expansion indicates scaling pains and budget.' },
    { type: 'WEBSITE_CHANGE', why: 'A new commercial-maintenance or services page signals a move into higher-value work.' },
    { type: 'BUSINESS_REGISTRATION', why: 'New entity/permit activity flags a growing operator setting up systems.' },
  ],
  templates: [
    {
      id: 'fieldops-hiring-coordinator',
      name: 'Hiring → admin load relief',
      subject: 'Scaling the {{company}} service team?',
      body:
        "Hi {{firstName}},\n\n{{evidence}} — usually a sign the admin and follow-up load is climbing faster than the team.\n\nACAOS helps field-service operators cut that admin load and respond to commercial opportunities faster, so growth doesn't get bottlenecked at the office.\n\nWorth a quick look?",
      angle: 'Reduce admin load created by growth',
      evidenceSignals: ['HIRING', 'EXPANSION'],
    },
    {
      id: 'fieldops-tender-win',
      name: 'Tender / contract win → coordination',
      subject: 'Congrats on the new contract',
      body:
        "Hi {{firstName}},\n\n{{evidence}}. New commercial work is great, but it's where scheduling, follow-up, and compliance reporting tend to slip.\n\nACAOS helps trades and field-service teams stay on top of commercial opportunities and respond faster — without adding headcount.\n\nOpen to a 10-minute chat?",
      angle: 'Help coordinate newly-won commercial work',
      evidenceSignals: ['PROCUREMENT'],
    },
    {
      id: 'fieldops-commercial-page',
      name: 'New commercial-maintenance page',
      subject: 'Winning more commercial maintenance work',
      body:
        "Hi {{firstName}},\n\n{{evidence}} — looks like {{company}} is leaning into commercial maintenance.\n\nThat market rewards fast response and tight follow-up. ACAOS surfaces likely commercial opportunities in your area and preps the outreach so you can approve and send in minutes.\n\nWant me to show you what it finds for {{company}}?",
      angle: 'Win more commercial maintenance work',
      evidenceSignals: ['WEBSITE_CHANGE', 'EXPANSION'],
    },
  ],
}
