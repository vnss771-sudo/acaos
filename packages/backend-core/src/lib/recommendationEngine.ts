// Phase 9: Recommendation engine for cost optimization and FinOps best practices.
// Generates actionable recommendations with impact estimates and implementation tracking.

import { logger } from './logger.js'

export interface Recommendation {
  id: string
  organizationId: string
  type: 'resource_optimization' | 'purchasing' | 'scheduling' | 'architecture' | 'governance' | 'automation'
  title: string
  description: string
  category: string // 'compute', 'storage', 'network', 'database', 'multi'
  severity: 'low' | 'medium' | 'high' | 'critical'
  priority: number // 1-10
  estimatedMonthlySavings: number
  estimatedImplementationCost: number
  paybackPeriodMonths: number
  difficulty: 'easy' | 'medium' | 'hard'
  timeToImplementDays: number
  affectedServices: string[]
  affectedTeams: string[]
  riskLevel: 'low' | 'medium' | 'high'
  riskDescription?: string
  implementationSteps: string[]
  prerequisitesMet: boolean
  prerequisites?: string[]
  alternatives?: string[]
  status: 'generated' | 'reviewed' | 'approved' | 'in_progress' | 'completed' | 'rejected' | 'archived'
  approvalStatus?: 'pending' | 'approved' | 'rejected'
  approvedBy?: string
  approvalDate?: Date
  startDate?: Date
  completionDate?: Date
  actualSavings?: number
  notes?: string
  createdAt: Date
  updatedAt: Date
}

export interface RecommendationCategory {
  name: string
  description: string
  count: number
  totalSavings: number
  avgPriority: number
}

export interface RecommendationGroup {
  id: string
  organizationId: string
  name: string
  description: string
  recommendations: string[] // Recommendation IDs
  combinedSavings: number
  totalImplementationCost: number
  combinedRisk: 'low' | 'medium' | 'high'
  suggestedExecutionOrder: string[]
  createdAt: Date
}

export interface RiskAssessment {
  id: string
  organizationId: string
  recommendationId: string
  riskType: 'service_disruption' | 'performance_degradation' | 'data_loss' | 'compliance_violation' | 'unknown'
  probability: number // 0-1
  impact: 'low' | 'medium' | 'high' | 'critical'
  mitigation: string
  rollbackPlan: string
  testingPlan: string
  createdAt: Date
}

export interface ImpactAnalysis {
  id: string
  organizationId: string
  recommendationId: string
  metric: string
  currentValue: number
  projectedValue: number
  percentChange: number
  confidenceLevel: number // 0-1
  affectedUsers?: number
  affectedServices?: string[]
  createdAt: Date
}

export interface RecommendationROI {
  id: string
  organizationId: string
  recommendationId: string
  monthlyBenefit: number
  monthlyMaintenance: number
  netMonthlyBenefit: number
  paybackMonths: number
  roi12Months: number // Percentage
  breakEvenDate: Date
  nPV: number // Net present value
  createdAt: Date
}

// Storage
const recommendations = new Map<string, Recommendation[]>()
const recommendationGroups = new Map<string, RecommendationGroup[]>()
const riskAssessments = new Map<string, RiskAssessment[]>()
const impactAnalyses = new Map<string, ImpactAnalysis[]>()
const recommendationROIs = new Map<string, RecommendationROI[]>()

/**
 * Generate cost optimization recommendation.
 */
export function generateRecommendation(
  organizationId: string,
  type: 'resource_optimization' | 'purchasing' | 'scheduling' | 'architecture' | 'governance' | 'automation',
  title: string,
  description: string,
  category: string,
  severity: 'low' | 'medium' | 'high' | 'critical',
  estimatedMonthlySavings: number,
  estimatedImplementationCost: number,
  affectedServices: string[] = [],
  affectedTeams: string[] = []
): Recommendation {
  const paybackPeriodMonths = estimatedImplementationCost / Math.max(estimatedMonthlySavings, 1)

  const recommendation: Recommendation = {
    id: `rec-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    organizationId,
    type,
    title,
    description,
    category,
    severity,
    priority: calculatePriority(estimatedMonthlySavings, paybackPeriodMonths, severity),
    estimatedMonthlySavings,
    estimatedImplementationCost,
    paybackPeriodMonths,
    difficulty: estimateDifficulty(type, category),
    timeToImplementDays: estimateImplementationTime(type),
    affectedServices,
    affectedTeams,
    riskLevel: 'medium',
    implementationSteps: generateImplementationSteps(type, category),
    prerequisitesMet: true,
    status: 'generated',
    createdAt: new Date(),
    updatedAt: new Date(),
  }

  const key = `${organizationId}:recommendations`
  const list = recommendations.get(key) || []
  list.push(recommendation)

  // Keep last 10000
  const filtered = list.slice(-10000)
  recommendations.set(key, filtered)

  logger.info('recommendation generated', {
    organizationId,
    recommendationId: recommendation.id,
    type,
    estimatedSavings: estimatedMonthlySavings,
    payback: paybackPeriodMonths,
  })

  return recommendation
}

/**
 * Get recommendations.
 */
export function getRecommendations(
  organizationId: string,
  status?: string,
  type?: string,
  minPriority: number = 1
): Recommendation[] {
  const key = `${organizationId}:recommendations`
  const list = recommendations.get(key) || []

  let filtered = list.filter((r) => r.priority >= minPriority)
  if (status) {
    filtered = filtered.filter((r) => r.status === status)
  }
  if (type) {
    filtered = filtered.filter((r) => r.type === type)
  }

  return filtered.sort((a, b) => b.priority - a.priority)
}

/**
 * Get recommendation by ID.
 */
export function getRecommendation(organizationId: string, recommendationId: string): Recommendation | null {
  const key = `${organizationId}:recommendations`
  const list = recommendations.get(key) || []
  return list.find((r) => r.id === recommendationId) || null
}

/**
 * Update recommendation status.
 */
export function updateRecommendationStatus(
  organizationId: string,
  recommendationId: string,
  status: Recommendation['status'],
  notes?: string
): boolean {
  const rec = getRecommendation(organizationId, recommendationId)
  if (!rec) return false

  rec.status = status
  rec.updatedAt = new Date()
  if (notes) rec.notes = notes

  if (status === 'in_progress') {
    rec.startDate = new Date()
  } else if (status === 'completed') {
    rec.completionDate = new Date()
  }

  return true
}

/**
 * Approve recommendation.
 */
export function approveRecommendation(organizationId: string, recommendationId: string, userId: string): boolean {
  const rec = getRecommendation(organizationId, recommendationId)
  if (!rec) return false

  rec.approvalStatus = 'approved'
  rec.approvedBy = userId
  rec.approvalDate = new Date()
  rec.status = 'approved'
  rec.updatedAt = new Date()

  return true
}

/**
 * Reject recommendation.
 */
export function rejectRecommendation(
  organizationId: string,
  recommendationId: string,
  reason: string
): boolean {
  const rec = getRecommendation(organizationId, recommendationId)
  if (!rec) return false

  rec.approvalStatus = 'rejected'
  rec.status = 'rejected'
  rec.notes = reason
  rec.updatedAt = new Date()

  return true
}

/**
 * Create risk assessment.
 */
export function assessRisk(
  organizationId: string,
  recommendationId: string,
  riskType: 'service_disruption' | 'performance_degradation' | 'data_loss' | 'compliance_violation' | 'unknown',
  probability: number,
  impact: 'low' | 'medium' | 'high' | 'critical',
  mitigation: string,
  rollbackPlan: string,
  testingPlan: string
): RiskAssessment {
  const assessment: RiskAssessment = {
    id: `risk-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    organizationId,
    recommendationId,
    riskType,
    probability: Math.max(0, Math.min(1, probability)),
    impact,
    mitigation,
    rollbackPlan,
    testingPlan,
    createdAt: new Date(),
  }

  const key = `${organizationId}:risks`
  const list = riskAssessments.get(key) || []
  list.push(assessment)

  // Keep last 1000
  const filtered = list.slice(-1000)
  riskAssessments.set(key, filtered)

  // Update recommendation risk level
  const rec = getRecommendation(organizationId, recommendationId)
  if (rec) {
    rec.riskLevel = impact === 'critical' ? 'high' : impact === 'high' ? 'high' : 'medium'
    rec.riskDescription = `${riskType}: ${impact} impact (${(probability * 100).toFixed(0)}% probability)`
  }

  return assessment
}

/**
 * Get risk assessments.
 */
export function getRiskAssessments(organizationId: string, recommendationId?: string): RiskAssessment[] {
  const key = `${organizationId}:risks`
  const list = riskAssessments.get(key) || []
  return recommendationId ? list.filter((r) => r.recommendationId === recommendationId) : list
}

/**
 * Create impact analysis.
 */
export function analyzeImpact(
  organizationId: string,
  recommendationId: string,
  metric: string,
  currentValue: number,
  projectedValue: number,
  confidenceLevel: number = 0.85
): ImpactAnalysis {
  const percentChange = ((projectedValue - currentValue) / currentValue) * 100

  const analysis: ImpactAnalysis = {
    id: `impact-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    organizationId,
    recommendationId,
    metric,
    currentValue,
    projectedValue,
    percentChange,
    confidenceLevel: Math.max(0, Math.min(1, confidenceLevel)),
    createdAt: new Date(),
  }

  const key = `${organizationId}:impacts`
  const list = impactAnalyses.get(key) || []
  list.push(analysis)

  // Keep last 5000
  const filtered = list.slice(-5000)
  impactAnalyses.set(key, filtered)

  return analysis
}

/**
 * Get impact analyses.
 */
export function getImpactAnalyses(organizationId: string, recommendationId?: string): ImpactAnalysis[] {
  const key = `${organizationId}:impacts`
  const list = impactAnalyses.get(key) || []
  return recommendationId ? list.filter((i) => i.recommendationId === recommendationId) : list
}

/**
 * Calculate ROI for recommendation.
 */
export function calculateROI(
  organizationId: string,
  recommendationId: string,
  monthlySavings: number,
  implementationCost: number,
  monthlyMaintenance: number = 0,
  discountRate: number = 0.1
): RecommendationROI {
  const netMonthlyBenefit = monthlySavings - monthlyMaintenance
  const paybackMonths = implementationCost / Math.max(netMonthlyBenefit, 1)
  const roi12Months = ((netMonthlyBenefit * 12 - implementationCost) / implementationCost) * 100

  const breakEvenDate = new Date()
  breakEvenDate.setMonth(breakEvenDate.getMonth() + Math.ceil(paybackMonths))

  // Simple NPV calculation (5-year horizon)
  let npv = -implementationCost
  for (let month = 1; month <= 60; month++) {
    const pv = netMonthlyBenefit / Math.pow(1 + discountRate / 12, month)
    npv += pv
  }

  const roi: RecommendationROI = {
    id: `roi-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    organizationId,
    recommendationId,
    monthlyBenefit: monthlySavings,
    monthlyMaintenance,
    netMonthlyBenefit,
    paybackMonths,
    roi12Months,
    breakEvenDate,
    nPV: npv,
    createdAt: new Date(),
  }

  const key = `${organizationId}:roi`
  const list = recommendationROIs.get(key) || []
  list.push(roi)

  // Keep last 1000
  const filtered = list.slice(-1000)
  recommendationROIs.set(key, filtered)

  return roi
}

/**
 * Get ROI calculations.
 */
export function getROICalculations(organizationId: string, recommendationId?: string): RecommendationROI[] {
  const key = `${organizationId}:roi`
  const list = recommendationROIs.get(key) || []
  return recommendationId ? list.filter((r) => r.recommendationId === recommendationId) : list
}

/**
 * Group recommendations by synergy.
 */
export function groupRecommendations(
  organizationId: string,
  recommendationIds: string[],
  name: string,
  description: string
): RecommendationGroup {
  const recs = recommendationIds
    .map((id) => getRecommendation(organizationId, id))
    .filter((r) => r !== null) as Recommendation[]

  const totalSavings = recs.reduce((sum, r) => sum + r.estimatedMonthlySavings, 0)
  const totalCost = recs.reduce((sum, r) => sum + r.estimatedImplementationCost, 0)
  const avgRisk = recs.every((r) => r.riskLevel === 'low') ? 'low' : recs.every((r) => r.riskLevel !== 'high') ? 'medium' : 'high'

  const group: RecommendationGroup = {
    id: `group-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    organizationId,
    name,
    description,
    recommendations: recommendationIds,
    combinedSavings: totalSavings,
    totalImplementationCost: totalCost,
    combinedRisk: avgRisk,
    suggestedExecutionOrder: recs.sort((a, b) => a.paybackPeriodMonths - b.paybackPeriodMonths).map((r) => r.id),
    createdAt: new Date(),
  }

  const key = `${organizationId}:groups`
  const list = recommendationGroups.get(key) || []
  list.push(group)

  // Keep last 500
  const filtered = list.slice(-500)
  recommendationGroups.set(key, filtered)

  logger.info('recommendation group created', {
    organizationId,
    groupId: group.id,
    recommendations: recommendationIds.length,
    combinedSavings: totalSavings,
  })

  return group
}

/**
 * Get recommendation groups.
 */
export function getRecommendationGroups(organizationId: string): RecommendationGroup[] {
  const key = `${organizationId}:groups`
  return recommendationGroups.get(key) || []
}

/**
 * Get recommendations summary.
 */
export function getRecommendationsSummary(organizationId: string): {
  total: number
  byStatus: Record<string, number>
  byCategory: RecommendationCategory[]
  totalPotentialSavings: number
  totalImplementationCost: number
  avgPaybackMonths: number
} {
  const recs = getRecommendations(organizationId)

  const byStatus: Record<string, number> = {}
  recs.forEach((r) => {
    byStatus[r.status] = (byStatus[r.status] || 0) + 1
  })

  const byCategory: Record<string, RecommendationCategory> = {}
  recs.forEach((r) => {
    if (!byCategory[r.category]) {
      byCategory[r.category] = {
        name: r.category,
        description: '',
        count: 0,
        totalSavings: 0,
        avgPriority: 0,
      }
    }
    byCategory[r.category].count++
    byCategory[r.category].totalSavings += r.estimatedMonthlySavings
    byCategory[r.category].avgPriority += r.priority
  })

  Object.values(byCategory).forEach((cat) => {
    cat.avgPriority /= cat.count
  })

  return {
    total: recs.length,
    byStatus,
    byCategory: Object.values(byCategory),
    totalPotentialSavings: recs.reduce((sum, r) => sum + r.estimatedMonthlySavings, 0),
    totalImplementationCost: recs.reduce((sum, r) => sum + r.estimatedImplementationCost, 0),
    avgPaybackMonths: recs.length > 0 ? recs.reduce((sum, r) => sum + r.paybackPeriodMonths, 0) / recs.length : 0,
  }
}

/**
 * Calculate priority score.
 */
function calculatePriority(monthlySavings: number, paybackMonths: number, severity: string): number {
  const severityScore = { low: 1, medium: 2, high: 3, critical: 4 }[severity] || 1
  const savingsScore = Math.min(monthlySavings / 1000, 3) // Cap at 3
  const paybackScore = Math.max(0, 3 - paybackMonths / 6) // Faster payback = higher score

  return Math.round((severityScore * savingsScore * paybackScore) / 10 * 10)
}

/**
 * Estimate difficulty.
 */
function estimateDifficulty(type: string, category: string): 'easy' | 'medium' | 'hard' {
  if (type === 'automation' || category === 'governance') return 'easy'
  if (type === 'purchasing' || type === 'scheduling') return 'medium'
  return 'hard'
}

/**
 * Estimate implementation time.
 */
function estimateImplementationTime(type: string): number {
  const estimates: Record<string, number> = {
    automation: 7,
    purchasing: 14,
    scheduling: 10,
    resource_optimization: 21,
    architecture: 60,
    governance: 5,
  }
  return estimates[type] || 14
}

/**
 * Generate implementation steps.
 */
function generateImplementationSteps(type: string, category: string): string[] {
  const steps: Record<string, string[]> = {
    automation: [
      'Identify automation targets',
      'Design automation workflow',
      'Implement and test',
      'Monitor and optimize',
    ],
    purchasing: [
      'Review current contracts',
      'Analyze savings opportunities',
      'Negotiate with vendors',
      'Implement and verify',
    ],
    scheduling: [
      'Analyze usage patterns',
      'Design scheduling policy',
      'Configure automation',
      'Monitor compliance',
    ],
    architecture: [
      'Design architecture changes',
      'Create test environment',
      'Migrate workloads',
      'Verify performance',
      'Decommission old resources',
    ],
    resource_optimization: [
      'Profile resource usage',
      'Identify oversized resources',
      'Right-size resources',
      'Monitor performance',
    ],
    governance: [
      'Define policies',
      'Implement controls',
      'Train teams',
      'Monitor compliance',
    ],
  }

  return steps[type] || ['Plan', 'Implement', 'Test', 'Deploy', 'Monitor']
}

/**
 * Clear recommendations (for testing).
 */
export function clearRecommendations(): void {
  recommendations.clear()
  recommendationGroups.clear()
  riskAssessments.clear()
  impactAnalyses.clear()
  recommendationROIs.clear()
}
