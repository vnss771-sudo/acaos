// Industry pack registry. Add new verticals here.
import type { IndustryPack } from './types.js'
import { fieldOpsPack } from './fieldops.js'

export type { IndustryPack, IcpPreset, PackSignal, PackTemplate } from './types.js'

const PACKS: IndustryPack[] = [fieldOpsPack]

/** Lightweight summaries for listing (no templates/signals payload). */
export function listPacks(): Array<{ id: string; label: string; description: string }> {
  return PACKS.map((p) => ({ id: p.id, label: p.label, description: p.description }))
}

export function getPack(id: string): IndustryPack | undefined {
  return PACKS.find((p) => p.id === id)
}
