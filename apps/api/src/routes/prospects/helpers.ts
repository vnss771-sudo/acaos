import { ApiError } from '../../lib/http.js'
import { prisma } from '@acaos/backend-core/lib/prisma.js'
import { assertMinimumWorkspaceRole } from '../../lib/workspaces.js'
import { centsToDollars } from '../../lib/money.js'
import { workspaceIdField } from '../../lib/validate.js'
import { z } from 'zod'
import type { ICPConfig, SignalType } from '@acaos/backend-core/lib/signalEngine.js'
import type { Assert, Extends, DiscoverProspectsRequest, MissionIcpOverrideFields } from '@acaos/shared'
import type { IndustryPack } from '../../lib/packs/types.js'

// Request contract for POST /discover, pinned to the shared type so they can't drift.
export const discoverSchema = z.object({
  workspaceId: workspaceIdField,
  source: z.string().optional(),
  missionId: z.string().nullish(),
  industries: z.array(z.string()).optional(),
  locations: z.array(z.string()).optional(),
  keywords: z.array(z.string()).optional(),
  minEmployees: z.number().int().optional(),
  maxEmployees: z.number().int().optional(),
  // Bounded at the schema so a negative/zero/oversized value is a clean 400
  // rather than reaching the discovery provider with a surprising page size.
  limit: z.number().int().min(1).max(50).optional(),
})
type _DiscoverConforms = Assert<Extends<z.infer<typeof discoverSchema>, DiscoverProspectsRequest>>

/** An array, or undefined when it's missing/empty — for layered ICP fallbacks. */
export function nonEmpty<T>(arr: T[] | null | undefined): T[] | undefined {
  return arr && arr.length > 0 ? arr : undefined
}

// Canonical normalizers live in backend-core so the API and worker share one
// implementation. Re-exported here so existing import sites keep working.
export { normalizeDomain, normalizeCompanyNameKey, normalizeEmailKey } from '@acaos/backend-core/lib/normalize.js'

// Load an OutreachIntent for a write action: verifies the prospect exists, the
// caller has workspace access, and the intent belongs to that prospect.
export async function loadIntentForWrite(prospectId: string, intentId: string, userId: string) {
  const prospect = await prisma.prospect.findUnique({ where: { id: prospectId }, select: { id: true, workspaceId: true } })
  if (!prospect) throw new ApiError(404, 'Prospect not found')
  await assertMinimumWorkspaceRole(userId, prospect.workspaceId, 'admin')
  const intent = await prisma.outreachIntent.findUnique({ where: { id: intentId } })
  if (!intent || intent.prospectId !== prospect.id) throw new ApiError(404, 'Outreach intent not found')
  return intent
}


// Money is stored as integer cents; expose whole-unit amounts at the API edge.
export function withDollars<T extends Record<string, unknown>>(p: T): T {
  const out: Record<string, unknown> = { ...p }
  if ('expectedDealValue' in out) out.expectedDealValue = centsToDollars(out.expectedDealValue as number | null)
  if ('estimatedRevenue' in out) out.estimatedRevenue = centsToDollars(out.estimatedRevenue as number | null)
  return out as T
}

// Effective targeting for a mission: an explicit per-mission override takes
// priority over the workspace ICP, which takes priority over the mission's
// playbook preset (if any) — mirroring the request-time layering already used
// in POST /prospects/discover (explicit request > workspace ICP > pack), just
// with the mission override slotted in ahead of the workspace ICP. Any field
// left unset/empty at one layer falls through to the next.
export function resolveEffectiveTargeting(
  override: MissionIcpOverrideFields | null | undefined,
  icp: ICPConfig | undefined,
  pack: IndustryPack | undefined,
): { targetIndustries: string[]; targetGeos: string[]; minEmployees?: number; maxEmployees?: number } {
  return {
    targetIndustries: nonEmpty(override?.targetIndustries) ?? nonEmpty(icp?.targetIndustries) ?? pack?.icp.targetIndustries ?? [],
    targetGeos: nonEmpty(override?.targetGeos) ?? nonEmpty(icp?.targetGeos) ?? pack?.icp.targetGeos ?? [],
    minEmployees: override?.minEmployees ?? icp?.minEmployees ?? pack?.icp.minEmployees,
    maxEmployees: override?.maxEmployees ?? icp?.maxEmployees ?? pack?.icp.maxEmployees,
  }
}

export type DiscoveryQuery = {
  industries: string[]
  locations: string[]
  keywords: string[]
  minEmployees: number | undefined
  maxEmployees: number | undefined
  limit: number
}

/**
 * Merge an explicit POST /discover request field over the resolved ICP
 * fallback chain (resolveEffectiveTargeting's mission override > workspace ICP
 * > pack preset) — the request's own value always wins when present, so a
 * one-off "search smaller companies just this once" request actually takes
 * effect instead of being silently overridden by the workspace/mission's own
 * range. Extracted as its own function (rather than left inline in the route)
 * specifically so this precedence contract has a direct unit test: the route
 * itself can't be tested to this depth without a real Redis connection for its
 * enqueueDiscoverProspects call.
 */
export function buildDiscoveryQuery(
  body: { industries?: string[]; locations?: string[]; keywords?: string[]; minEmployees?: number; maxEmployees?: number; limit?: number },
  effective: { targetIndustries: string[]; targetGeos: string[]; minEmployees?: number; maxEmployees?: number },
): DiscoveryQuery {
  return {
    industries: body.industries ?? nonEmpty(effective.targetIndustries) ?? [],
    locations: body.locations ?? nonEmpty(effective.targetGeos) ?? [],
    keywords: body.keywords ?? [],
    minEmployees: body.minEmployees ?? effective.minEmployees,
    maxEmployees: body.maxEmployees ?? effective.maxEmployees,
    limit: body.limit ?? 25,
  }
}

// Single canonical ICP loader — returns shaped ICPConfig or undefined
export async function getICP(workspaceId: string): Promise<ICPConfig | undefined> {
  const icp = await prisma.workspaceICP.findUnique({ where: { workspaceId } })
  if (!icp) return undefined
  return {
    targetIndustries: icp.targetIndustries,
    minEmployees:     icp.minEmployees  ?? undefined,
    maxEmployees:     icp.maxEmployees  ?? undefined,
    targetGeos:       icp.targetGeos,
    mustHaveEmail:    icp.mustHaveEmail,
  }
}

// Allowed signal types for POST /import-signals — the evidence-first front door.
export const IMPORT_SIGNAL_TYPES = new Set<SignalType>([
  'HIRING', 'FUNDING', 'EXPANSION', 'TECH_ADOPTION', 'LEADERSHIP_CHANGE',
  'NEWS_MENTION', 'PROCUREMENT', 'BUSINESS_REGISTRATION', 'WEBSITE_CHANGE',
])
