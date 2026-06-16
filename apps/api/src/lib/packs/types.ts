// Industry packs: pre-built ICP presets, the signals that matter for that
// vertical, and evidence-mapped outreach templates. A pack lets an operator
// onboard without inventing their own targeting/strategy from scratch.
import type { SignalType } from '../signalEngine.js'

export type IcpPreset = {
  targetIndustries: string[]
  minEmployees?: number
  maxEmployees?: number
  targetGeos: string[]
  businessType?: string
  outreachTone?: 'professional' | 'casual' | 'direct'
  excludedIndustries?: string[]
}

export type PackSignal = {
  type: SignalType
  // Why this signal matters for this vertical (shown in the UI).
  why: string
}

export type PackTemplate = {
  id: string
  name: string
  subject: string
  // Body may reference {{evidence}} — the draft generator substitutes the
  // concrete signal/evidence summary so personalization is grounded, not faked.
  body: string
  angle: string
  // The signals this template is appropriate for (template ⇄ evidence mapping).
  evidenceSignals: SignalType[]
}

export type IndustryPack = {
  id: string
  label: string
  description: string
  icp: IcpPreset
  signals: PackSignal[]
  templates: PackTemplate[]
}
