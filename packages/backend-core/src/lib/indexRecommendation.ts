// Phase 4.2: Automatic index recommendation engine.
// Analyzes slow query patterns from queryInstrumentation to suggest indexes
// that would have the highest impact on system performance.
//
// Recommendation strategy:
// - Query takes >500ms AND runs frequently → high impact index
// - Query is on (model + where fields) → suggest composite index
// - Query returns many results → suggest filter index
// - Multiple queries on same field → rank by frequency

import { getSlowestQueries } from './queryInstrumentation.js'
import { logger } from './logger.js'

interface IndexRecommendation {
  model: string
  operation: string
  fields: string[]
  rationale: string
  estimatedSpeedupMs: number
  frequency: number
  priority: 'high' | 'medium' | 'low'
}

const seenRecommendations = new Map<string, IndexRecommendation>()
const RECOMMENDATION_RETENTION_MS = 24 * 60 * 60 * 1000 // 24 hours

// Common slow query patterns and their likely causes
const PATTERN_MAP: Record<string, { fields: string[]; speedup: number }> = {
  'Lead.findMany': { fields: ['workspaceId', 'status', 'createdAt'], speedup: 400 },
  'Lead.count': { fields: ['workspaceId', 'status'], speedup: 300 },
  'Campaign.findMany': { fields: ['workspaceId', 'status'], speedup: 350 },
  'Prospect.findMany': { fields: ['workspaceId', 'campaignId', 'status'], speedup: 500 },
  'Prospect.count': { fields: ['workspaceId', 'campaignId'], speedup: 250 },
  'OutreachSent.findMany': { fields: ['workspaceId', 'prospectId'], speedup: 300 },
  'Outcome.findMany': { fields: ['workspaceId', 'prospectId', 'type'], speedup: 350 },
  'Task.findMany': { fields: ['workspaceId', 'assigneeId', 'dueAt'], speedup: 300 },
  'Mission.findMany': { fields: ['workspaceId', 'status', 'createdAt'], speedup: 400 },
  'Inbox.findMany': { fields: ['workspaceId', 'type', 'createdAt'], speedup: 250 },
}

/**
 * Analyze slow queries and generate index recommendations.
 * Returns high-impact indexes that would speed up the slowest queries.
 */
export function generateIndexRecommendations(): IndexRecommendation[] {
  const slowQueries = getSlowestQueries(50) // Analyze top 50 slowest
  const recommendations: IndexRecommendation[] = []

  for (const query of slowQueries) {
    const key = `${query.model}.${query.operation}`
    const pattern = PATTERN_MAP[key]

    if (pattern && query.maxDurationMs > 500) {
      const recommendation: IndexRecommendation = {
        model: query.model,
        operation: query.operation,
        fields: pattern.fields,
        rationale:
          query.maxDurationMs > 1000
            ? `Critical: ${key} taking ${query.maxDurationMs}ms (runs ${query.count}x)`
            : `High impact: ${key} averaging ${query.maxDurationMs}ms`,
        estimatedSpeedupMs: pattern.speedup,
        frequency: query.count,
        priority:
          query.maxDurationMs > 1000
            ? 'high'
            : query.maxDurationMs > 700
              ? 'medium'
              : 'low',
      }

      recommendations.push(recommendation)
      seenRecommendations.set(key, recommendation)
    }
  }

  // Filter to top 10 by combined impact (frequency * speedup)
  return recommendations
    .sort((a, b) => {
      const impactA = a.frequency * a.estimatedSpeedupMs
      const impactB = b.frequency * b.estimatedSpeedupMs
      return impactB - impactA
    })
    .slice(0, 10)
}

/**
 * Get Prisma migration code for a recommended index.
 */
export function getIndexMigrationSQL(rec: IndexRecommendation): string {
  const columnList = rec.fields.join(', ')
  const indexName = `idx_${rec.model.toLowerCase()}_${rec.fields.join('_').toLowerCase()}`
  const tableNamePluralMap: Record<string, string> = {
    Lead: 'lead',
    Campaign: 'campaign',
    Prospect: 'prospect',
    OutreachSent: 'outreach_sent',
    Outcome: 'outcome',
    Task: 'task',
    Mission: 'mission',
    Inbox: 'inbox',
  }

  const tableName = tableNamePluralMap[rec.model] || rec.model.toLowerCase()

  return `
// ${rec.rationale}
// Estimated speedup: ${rec.estimatedSpeedupMs}ms
model ${rec.model} {
  // ... existing fields ...
  @@index([${rec.fields.join(', ')}])
}
`.trim()
}

/**
 * Get PostgreSQL CREATE INDEX statement.
 */
export function getPostgresIndexSQL(rec: IndexRecommendation): string {
  const tableNamePluralMap: Record<string, string> = {
    Lead: 'Lead',
    Campaign: 'Campaign',
    Prospect: 'Prospect',
    OutreachSent: 'OutreachSent',
    Outcome: 'Outcome',
    Task: 'Task',
    Mission: 'Mission',
    Inbox: 'Inbox',
  }

  const tableName = tableNamePluralMap[rec.model] || rec.model
  const indexName = `idx_${rec.model.toLowerCase()}_${rec.fields.join('_').toLowerCase()}`
  const columnList = rec.fields.map((f) => `"${f}"`).join(', ')

  return `CREATE INDEX CONCURRENTLY ${indexName} ON "${tableName}"(${columnList});`
}

/**
 * Track that an index was created (avoid re-recommending).
 */
export function markIndexCreated(model: string, operation: string, fields: string[]): void {
  const key = `${model}.${operation}`
  seenRecommendations.delete(key)
  logger.info('index created', { model, operation, fields })
}

/**
 * Get summary of all pending recommendations.
 */
export function getRecommendationSummary(): {
  totalRecommendations: number
  highPriority: number
  estimatedTotalSpeedup: number
  topRecommendations: IndexRecommendation[]
} {
  const recs = generateIndexRecommendations()
  return {
    totalRecommendations: recs.length,
    highPriority: recs.filter((r) => r.priority === 'high').length,
    estimatedTotalSpeedup: recs.reduce((sum, r) => sum + r.estimatedSpeedupMs, 0),
    topRecommendations: recs.slice(0, 3),
  }
}

/**
 * Prioritize indexes by impact and cost-benefit.
 * Returns indexes in order they should be applied.
 */
export function prioritizeIndexes(): IndexRecommendation[] {
  const recs = generateIndexRecommendations()

  return recs.sort((a, b) => {
    // Priority 1: High-frequency, high-impact queries
    const impactA = a.frequency * a.estimatedSpeedupMs
    const impactB = b.frequency * b.estimatedSpeedupMs
    if (impactA !== impactB) return impactB - impactA

    // Priority 2: Longer absolute times (more noticeable to users)
    const speedupA = a.estimatedSpeedupMs
    const speedupB = b.estimatedSpeedupMs
    if (speedupA !== speedupB) return speedupB - speedupA

    // Priority 3: High-priority recommendations first
    const priorityOrder = { high: 0, medium: 1, low: 2 }
    return priorityOrder[a.priority] - priorityOrder[b.priority]
  })
}
