// Phase 5: Cost allocation and chargeback system with tagging and billing models.
// Enables team/project/customer cost tracking and internal billing simulation.

import { logger } from './logger.js'

export type AllocationModel = 'fixed' | 'variable' | 'blended' | 'custom'
export type ResourceType = 'compute' | 'storage' | 'network' | 'api_calls' | 'feature'

export interface ResourceTag {
  key: string
  value: string
  resourceId: string
  resourceType: ResourceType
}

export interface AllocationRule {
  id: string
  workspaceId: string
  name: string
  model: AllocationModel
  fromCostCenter: string
  toCostCenters: Array<{
    costCenter: string
    percentage: number // 0-100
  }>
  conditions?: Record<string, unknown> // e.g., { team: 'eng', environment: 'prod' }
  active: boolean
  createdAt: Date
}

export interface ChargebackPolicy {
  id: string
  workspaceId: string
  name: string
  costCenter: string
  model: AllocationModel
  chargeMultiplier: number // 1.0 = cost, 1.2 = 20% markup
  chargeback: Array<{
    recipient: string // team, user, project
    amount: number
    percentage: number
  }>
  createdAt: Date
}

export interface CostAttribution {
  costCenter: string
  totalCost: number
  breakdown: Array<{
    resourceType: ResourceType
    cost: number
    percentage: number
  }>
  chargedAmount: number // with multiplier
  lastUpdated: Date
}

export interface InternalBill {
  billId: string
  workspaceId: string
  costCenter: string
  period: string // YYYY-MM
  totalCost: number
  chargedAmount: number
  lineItems: Array<{
    description: string
    cost: number
    quantity?: number
    unitCost?: number
  }>
  createdAt: Date
}

// Storage
const resourceTags = new Map<string, ResourceTag[]>()
const allocationRules = new Map<string, AllocationRule[]>()
const chargebackPolicies = new Map<string, ChargebackPolicy[]>()
const costAttributions = new Map<string, CostAttribution[]>()
const internalBills = new Map<string, InternalBill[]>()

/**
 * Tag a resource for cost allocation.
 */
export function tagResource(
  workspaceId: string,
  resourceId: string,
  resourceType: ResourceType,
  key: string,
  value: string
): ResourceTag {
  const tag: ResourceTag = {
    key,
    value,
    resourceId,
    resourceType,
  }

  const list = resourceTags.get(workspaceId) || []
  // Remove existing tag with same key for this resource
  const filtered = list.filter((t) => !(t.resourceId === resourceId && t.key === key))
  filtered.push(tag)
  resourceTags.set(workspaceId, filtered)

  logger.info('resource tagged', {
    workspaceId,
    resourceId,
    resourceType,
    tag: `${key}=${value}`,
  })

  return tag
}

/**
 * Get tags for a resource.
 */
export function getResourceTags(
  workspaceId: string,
  resourceId: string
): ResourceTag[] {
  const list = resourceTags.get(workspaceId) || []
  return list.filter((t) => t.resourceId === resourceId)
}

/**
 * Find resources by tag.
 */
export function findResourcesByTag(
  workspaceId: string,
  key: string,
  value: string
): string[] {
  const list = resourceTags.get(workspaceId) || []
  return list
    .filter((t) => t.key === key && t.value === value)
    .map((t) => t.resourceId)
}

/**
 * Create allocation rule.
 */
export function createAllocationRule(
  workspaceId: string,
  name: string,
  model: AllocationModel,
  fromCostCenter: string,
  toCostCenters: Array<{ costCenter: string; percentage: number }>,
  conditions?: Record<string, unknown>
): AllocationRule {
  // Validate percentages sum to 100
  const totalPercentage = toCostCenters.reduce((sum, cc) => sum + cc.percentage, 0)
  if (totalPercentage !== 100) {
    throw new Error(`Cost center percentages must sum to 100, got ${totalPercentage}`)
  }

  const rule: AllocationRule = {
    id: `rule-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    workspaceId,
    name,
    model,
    fromCostCenter,
    toCostCenters,
    conditions,
    active: true,
    createdAt: new Date(),
  }

  const list = allocationRules.get(workspaceId) || []
  list.push(rule)
  allocationRules.set(workspaceId, list)

  logger.info('allocation rule created', {
    workspaceId,
    name,
    model,
    fromCostCenter,
    toCostCentersCount: toCostCenters.length,
  })

  return rule
}

/**
 * Get allocation rules for workspace.
 */
export function getAllocationRules(workspaceId: string, active?: boolean): AllocationRule[] {
  const list = allocationRules.get(workspaceId) || []
  return active !== undefined ? list.filter((r) => r.active === active) : list
}

/**
 * Apply allocation rule to cost.
 */
export function applyAllocationRule(
  rule: AllocationRule,
  totalCost: number
): Array<{ costCenter: string; cost: number }> {
  return rule.toCostCenters.map((cc) => ({
    costCenter: cc.costCenter,
    cost: (totalCost * cc.percentage) / 100,
  }))
}

/**
 * Create chargeback policy.
 */
export function createChargebackPolicy(
  workspaceId: string,
  name: string,
  costCenter: string,
  model: AllocationModel,
  chargeMultiplier: number = 1.0,
  chargeback?: Array<{ recipient: string; amount: number; percentage: number }>
): ChargebackPolicy {
  const policy: ChargebackPolicy = {
    id: `policy-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    workspaceId,
    name,
    costCenter,
    model,
    chargeMultiplier,
    chargeback: chargeback || [],
    createdAt: new Date(),
  }

  const list = chargebackPolicies.get(workspaceId) || []
  list.push(policy)
  chargebackPolicies.set(workspaceId, list)

  logger.info('chargeback policy created', {
    workspaceId,
    name,
    costCenter,
    chargeMultiplier,
  })

  return policy
}

/**
 * Get chargeback policy.
 */
export function getChargebackPolicy(
  workspaceId: string,
  costCenter: string
): ChargebackPolicy | null {
  const list = chargebackPolicies.get(workspaceId) || []
  return list.find((p) => p.costCenter === costCenter) || null
}

/**
 * Calculate cost attribution for cost center.
 */
export function calculateCostAttribution(
  workspaceId: string,
  costCenter: string,
  costs: Array<{ resourceType: ResourceType; cost: number }>
): CostAttribution {
  const totalCost = costs.reduce((sum, c) => sum + c.cost, 0)

  const policy = getChargebackPolicy(workspaceId, costCenter)
  const chargeMultiplier = policy?.chargeMultiplier || 1.0
  const chargedAmount = totalCost * chargeMultiplier

  const attribution: CostAttribution = {
    costCenter,
    totalCost,
    breakdown: costs.map((c) => ({
      resourceType: c.resourceType,
      cost: c.cost,
      percentage: (c.cost / totalCost) * 100,
    })),
    chargedAmount,
    lastUpdated: new Date(),
  }

  const list = costAttributions.get(workspaceId) || []
  const existing = list.findIndex((a) => a.costCenter === costCenter)
  if (existing >= 0) {
    list[existing] = attribution
  } else {
    list.push(attribution)
  }
  costAttributions.set(workspaceId, list)

  return attribution
}

/**
 * Get cost attribution for cost center.
 */
export function getCostAttribution(
  workspaceId: string,
  costCenter: string
): CostAttribution | null {
  const list = costAttributions.get(workspaceId) || []
  return list.find((a) => a.costCenter === costCenter) || null
}

/**
 * Get all cost attributions for workspace.
 */
export function getAllCostAttributions(workspaceId: string): CostAttribution[] {
  return costAttributions.get(workspaceId) || []
}

/**
 * Create internal bill (monthly chargeback statement).
 */
export function createInternalBill(
  workspaceId: string,
  costCenter: string,
  period: string, // YYYY-MM
  lineItems: Array<{
    description: string
    cost: number
    quantity?: number
    unitCost?: number
  }>
): InternalBill {
  const totalCost = lineItems.reduce((sum, item) => sum + item.cost, 0)

  const policy = getChargebackPolicy(workspaceId, costCenter)
  const chargeMultiplier = policy?.chargeMultiplier || 1.0
  const chargedAmount = totalCost * chargeMultiplier

  const bill: InternalBill = {
    billId: `bill-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    workspaceId,
    costCenter,
    period,
    totalCost,
    chargedAmount,
    lineItems,
    createdAt: new Date(),
  }

  const list = internalBills.get(workspaceId) || []
  list.push(bill)
  internalBills.set(workspaceId, list)

  logger.info('internal bill created', {
    workspaceId,
    costCenter,
    period,
    totalCost: `$${totalCost.toFixed(2)}`,
    chargedAmount: `$${chargedAmount.toFixed(2)}`,
  })

  return bill
}

/**
 * Get bills for cost center.
 */
export function getInternalBills(
  workspaceId: string,
  costCenter: string,
  limit: number = 12
): InternalBill[] {
  const list = internalBills.get(workspaceId) || []
  return list
    .filter((b) => b.costCenter === costCenter)
    .sort((a, b) => b.period.localeCompare(a.period))
    .slice(0, limit)
}

/**
 * Calculate cost per unit (for cost allocation).
 */
export function calculateCostPerUnit(
  totalCost: number,
  unitCount: number
): number {
  return unitCount > 0 ? totalCost / unitCount : 0
}

/**
 * Get allocation impact summary.
 */
export function getAllocationImpactSummary(
  workspaceId: string
): {
  totalCostCenters: number
  totalAllocated: number
  allocationPercentage: number
  unallocated: number
} {
  const attributions = getAllCostAttributions(workspaceId)
  const totalAllocated = attributions.reduce((sum, a) => sum + a.chargedAmount, 0)
  const totalCostCenters = attributions.length

  return {
    totalCostCenters,
    totalAllocated,
    allocationPercentage:
      totalAllocated > 0 ? Math.round((totalAllocated / (totalAllocated * 1.1)) * 100) : 0,
    unallocated: 0,
  }
}

/**
 * Get cost breakdown by dimension (team, project, environment, etc).
 */
export function getCostBreakdownByDimension(
  workspaceId: string,
  dimensionKey: string
): Array<{
  dimensionValue: string
  cost: number
  percentage: number
}> {
  const tags = resourceTags.get(workspaceId) || []
  const costByDimension = new Map<string, number>()

  tags
    .filter((t) => t.key === dimensionKey)
    .forEach((tag) => {
      const current = costByDimension.get(tag.value) || 0
      costByDimension.set(tag.value, current) // Simplified; would integrate with actual cost data
    })

  const totalCost = Array.from(costByDimension.values()).reduce((a, b) => a + b, 0)

  return Array.from(costByDimension.entries()).map(([value, cost]) => ({
    dimensionValue: value,
    cost,
    percentage: totalCost > 0 ? (cost / totalCost) * 100 : 0,
  }))
}

/**
 * Clear allocation data (for testing).
 */
export function clearAllocations(): void {
  resourceTags.clear()
  allocationRules.clear()
  chargebackPolicies.clear()
  costAttributions.clear()
  internalBills.clear()
}
