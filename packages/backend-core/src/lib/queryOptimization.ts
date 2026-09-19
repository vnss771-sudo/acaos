// Phase 4.2: Query optimization strategies and best practices.
// Detects common inefficiencies and provides specific fixes:
// - N+1 queries (load parent, then loop children)
// - Unnecessary full-table scans (missing WHERE)
// - Inefficient joins (not using select projections)
// - Unindexed sort/filter operations

import { getSlowestQueries } from './queryInstrumentation.js'
import { logger } from './logger.js'

export interface OptimizationOpportunity {
  type: 'n-plus-one' | 'full-scan' | 'no-projection' | 'multiple-sorts' | 'missing-index'
  model: string
  operation: string
  description: string
  currentImpact: string
  recommendation: string
  estimatedSavings: string
}

/**
 * Detect N+1 query patterns: a query followed by multiple queries in a loop.
 * Signature: main query + (N children queries) where N is variable per result.
 */
export function detectN1Queries(): OptimizationOpportunity[] {
  const slowQueries = getSlowestQueries(100)
  const opportunities: OptimizationOpportunity[] = []

  // Models with typical N+1 patterns
  const commonN1Patterns = [
    { parent: 'Campaign', child: 'Lead', relationship: 'campaignId' },
    { parent: 'Lead', child: 'Prospect', relationship: 'leadId' },
    { parent: 'Mission', child: 'Outcome', relationship: 'missionId' },
    { parent: 'Campaign', child: 'OutreachSent', relationship: 'campaignId' },
  ]

  for (const pattern of commonN1Patterns) {
    const parentQuery = slowQueries.find((q) => q.model === pattern.parent && q.operation === 'findMany')
    const childQuery = slowQueries.find((q) => q.model === pattern.child && q.operation === 'findMany')

    if (parentQuery && childQuery && childQuery.avgDurationMs > 100) {
      opportunities.push({
        type: 'n-plus-one',
        model: pattern.parent,
        operation: 'findMany',
        description: `Loading ${pattern.parent}s then fetching ${pattern.child} for each (N+1 pattern)`,
        currentImpact: `1 parent query + ${childQuery.count} child queries = ${parentQuery.avgDurationMs + childQuery.avgDurationMs * 10}ms`,
        recommendation: `Use findMany().include() or take() to fetch ${pattern.child}s in one batch, or use Prisma count to limit loops`,
        estimatedSavings: `60-80% (eliminate ${childQuery.count - 1} round-trips)`,
      })
    }
  }

  return opportunities
}

/**
 * Detect inefficient full-table scans: queries without workspace/tenant filtering.
 */
export function detectFullScans(): OptimizationOpportunity[] {
  const slowQueries = getSlowestQueries(50)
  const opportunities: OptimizationOpportunity[] = []

  const tenantModels = ['Lead', 'Campaign', 'Prospect', 'Mission', 'Task']

  for (const query of slowQueries) {
    if (tenantModels.includes(query.model) && query.operation === 'count') {
      // count() without workspaceId is a red flag
      opportunities.push({
        type: 'full-scan',
        model: query.model,
        operation: 'count',
        description: `Count query on ${query.model} may not be filtered by workspace`,
        currentImpact: `Scans all rows: ${query.maxDurationMs}ms for ${query.count} executions`,
        recommendation: `Ensure count() includes where: { workspaceId } filter; consider caching total per workspace`,
        estimatedSavings: '70-90% (workspace isolation reduces working set)',
      })
    }
  }

  return opportunities
}

/**
 * Detect queries without result projection: fetching all columns when only a few are used.
 */
export function detectMissingProjections(): OptimizationOpportunity[] {
  const slowQueries = getSlowestQueries(50)
  const opportunities: OptimizationOpportunity[] = []

  // Large models that benefit from projection
  const largeModels = ['Lead', 'Prospect', 'Campaign', 'Outcome']

  for (const query of slowQueries) {
    if (largeModels.includes(query.model) && query.maxDurationMs > 200) {
      opportunities.push({
        type: 'no-projection',
        model: query.model,
        operation: query.operation,
        description: `${query.model}.${query.operation} may be fetching unnecessary columns`,
        currentImpact: `Transferring all fields: ${query.maxDurationMs}ms per query (${query.count}x)`,
        recommendation: `Use select: { id, name, status } to fetch only needed columns; reduces network + parsing`,
        estimatedSavings: '20-40% (especially for JSON fields)',
      })
    }
  }

  return opportunities
}

/**
 * Detect multiple sorts on unindexed fields.
 */
export function detectMultipleSorts(): OptimizationOpportunity[] {
  const slowQueries = getSlowestQueries(30)
  const opportunities: OptimizationOpportunity[] = []

  // Common multi-column sorts
  const commonSorts = [
    { model: 'Lead', fields: ['status', 'createdAt'] },
    { model: 'Campaign', fields: ['status', 'endDate'] },
    { model: 'Task', fields: ['dueAt', 'priority'] },
  ]

  for (const sort of commonSorts) {
    const query = slowQueries.find((q) => q.model === sort.model && q.maxDurationMs > 500)
    if (query) {
      opportunities.push({
        type: 'multiple-sorts',
        model: query.model,
        operation: query.operation,
        description: `Sorting by multiple fields without composite index`,
        currentImpact: `${query.maxDurationMs}ms (uses filesort for each of ${query.count} queries)`,
        recommendation: `Add composite index on [${sort.fields.join(', ')}] to make sort in-index`,
        estimatedSavings: '30-50% (eliminates out-of-index sort)',
      })
    }
  }

  return opportunities
}

/**
 * Get all optimization opportunities ranked by impact.
 */
export function getAllOptimizations(): OptimizationOpportunity[] {
  const n1 = detectN1Queries()
  const fullScans = detectFullScans()
  const noProjection = detectMissingProjections()
  const multipleSorts = detectMultipleSorts()

  const all = [...n1, ...fullScans, ...noProjection, ...multipleSorts]

  // Score by estimated savings
  const scoredByImpact = all.map((opp) => {
    const savingsScore =
      opp.estimatedSavings.includes('60-80%') ? 7 :
      opp.estimatedSavings.includes('70-90%') ? 8 :
      opp.estimatedSavings.includes('80%') ? 8 :
      opp.estimatedSavings.includes('30-50%') ? 5 :
      opp.estimatedSavings.includes('20-40%') ? 3 :
      1

    return { opp, score: savingsScore }
  })

  return scoredByImpact.sort((a, b) => b.score - a.score).map((x) => x.opp)
}

/**
 * Get specific code recommendations for common patterns.
 */
export function getCodeExamples(): {
  pattern: string
  inefficient: string
  optimized: string
  savings: string
}[] {
  return [
    {
      pattern: 'N+1 Query Pattern',
      inefficient: `
const campaigns = await prisma.campaign.findMany({ where: { workspaceId } });
for (const campaign of campaigns) {
  const leads = await prisma.lead.findMany({ where: { campaignId: campaign.id } });
  // Process leads
}
      `.trim(),
      optimized: `
const campaigns = await prisma.campaign.findMany({
  where: { workspaceId },
  include: { leads: true }, // Fetch all leads in one query
});
for (const campaign of campaigns) {
  // Process campaign.leads
}
      `.trim(),
      savings: '60-80%',
    },
    {
      pattern: 'Full Result Fetch',
      inefficient: `
const leads = await prisma.lead.findMany({
  where: { workspaceId, status: 'active' },
});
// Only use: id, name, status
      `.trim(),
      optimized: `
const leads = await prisma.lead.findMany({
  where: { workspaceId, status: 'active' },
  select: { id: true, name: true, status: true },
});
      `.trim(),
      savings: '20-40%',
    },
    {
      pattern: 'Tenant Scoping',
      inefficient: `
const count = await prisma.lead.count();
// Counts ALL leads across all workspaces!
      `.trim(),
      optimized: `
const count = await prisma.lead.count({
  where: { workspaceId },
});
// Counts only this workspace's leads
      `.trim(),
      savings: '70-90%',
    },
    {
      pattern: 'Batch Operations',
      inefficient: `
for (const id of leadIds) {
  await prisma.lead.update({ where: { id }, data: { status } });
}
// N separate database round-trips
      `.trim(),
      optimized: `
await prisma.lead.updateMany({
  where: { id: { in: leadIds } },
  data: { status },
});
// Single batch operation
      `.trim(),
      savings: '90%+',
    },
  ]
}
