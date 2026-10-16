// Grounding drafts: does the existing draft-grounding check catch a claim the
// evidence does not support? `unsupported` was labelled from the text, before
// running the checker. SYNTHETIC (see types.ts).
import type { GroundingDraft } from './types.ts'

const AWARD = {
  claim: 'Contract awarded: Construction of Northgate Community Centre to Alder Ridge Constructions Pty Ltd ($4.2M), including electrical and plumbing services. Buyer: Northgate Regional Council',
  source: 'austender', sourceUrl: 'https://example.invalid/notice/CN-A1', ageDays: 48, quality: 90,
}
const OLD_AWARD = { ...AWARD, ageDays: 200 }
const DA = {
  claim: 'Development application lodged: warehouse extension, 14 Smith Street (Harbourside City Council)',
  source: 'planningalerts', sourceUrl: 'https://example.invalid/da/DA-D2', ageDays: 30, quality: 70,
}

export const DRAFTS: readonly GroundingDraft[] = [
  { id: 'G01', facts: [AWARD], subject: 'Northgate Community Centre', unsupported: 'none',
    body: 'Saw that Alder Ridge Constructions won the Northgate Community Centre contract ($4.2M). We supply electrical and plumbing subcontractors. Worth a chat?' },
  { id: 'G02', facts: [AWARD], subject: 'Northgate Community Centre', unsupported: 'none',
    body: 'Congratulations on the Northgate Community Centre award, which includes electrical and plumbing services. Happy to quote the electrical package.' },
  { id: 'G03', facts: [AWARD], subject: 'Northgate Community Centre', unsupported: 'number',
    body: 'Congratulations on the $6.5M Northgate Community Centre contract. We supply electrical subcontractors. Worth a chat?' },
  { id: 'G04', facts: [AWARD], subject: 'Northgate Community Centre', unsupported: 'misattributed_party',
    body: 'Congratulations to Cobalt Civil & Building on winning the Northgate Community Centre contract ($4.2M). We supply electrical subcontractors.' },
  { id: 'G05', facts: [OLD_AWARD], subject: 'Northgate Community Centre', unsupported: 'recency',
    body: 'You recently won the Northgate Community Centre contract, which includes electrical and plumbing services. Worth a chat?' },
  { id: 'G06', facts: [DA], subject: 'Warehouse extension', unsupported: 'unstated_requirement',
    body: 'Your warehouse extension at 14 Smith Street will need a licensed electrical subcontractor. We can quote it this week.' },
  { id: 'G07', facts: [DA], subject: 'Warehouse extension', unsupported: 'qualitative',
    body: 'Saw your major project, the warehouse extension at 14 Smith Street. Happy to talk electrical.' },
  { id: 'G08', facts: [DA], subject: 'Warehouse extension', unsupported: 'none',
    body: 'Noticed the warehouse extension application lodged at 14 Smith Street with Harbourside City Council. We quote electrical for industrial extensions.' },
  { id: 'G09', facts: [AWARD], subject: 'Northgate Community Centre', unsupported: 'misattributed_party',
    body: 'As the developer behind the Northgate Community Centre, Alder Ridge Constructions will want electrical and plumbing covered. We can help.' },
  { id: 'G10', facts: [AWARD], subject: 'Northgate Community Centre', unsupported: 'none',
    body: 'Northgate Community Centre: congratulations on the award including electrical and plumbing services.' },
]
