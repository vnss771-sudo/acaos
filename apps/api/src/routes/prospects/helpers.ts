import { ApiError } from '../../lib/http.js'
import { prisma } from '../../lib/prisma.js'
import { assertMinimumWorkspaceRole } from '../../lib/workspaces.js'
import { centsToDollars } from '../../lib/money.js'
import { workspaceIdField } from '../../lib/validate.js'
import { z } from 'zod'
import type { ICPConfig, SignalType } from '../../lib/signalEngine.js'
import type { Assert, Extends, DiscoverProspectsRequest } from '@acaos/shared'

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
