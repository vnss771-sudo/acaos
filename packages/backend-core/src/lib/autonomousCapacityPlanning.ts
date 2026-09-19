// Phase 11: Autonomous capacity planning and predictive infrastructure management.
// Predicts capacity needs and autonomously provisions resources to avoid bottlenecks.

import { logger } from './logger.js'

export interface CapacityForecast {
  id: string
  organizationId: string
  agentId: string
  resourceType: 'cpu' | 'memory' | 'storage' | 'bandwidth' | 'connections'
  metricName: string
  forecastPeriod: 'day' | 'week' | 'month' | 'quarter'
  forecastDate: Date
  currentUtilization: number
  forecastedUtilization: number
  peakUtilization: number // 95th percentile
  capacityThreshold: number // SLA-driven target (e.g., 80%)
  bottleneckRiskScore: number // 0-1, probability of exceeding capacity
  recommendedCapacity: number
  estRiskIfUnprovisioned: string // 'low' | 'medium' | 'high' | 'critical'
  confidenceLevel: number // 0-1
  forecastAccuracy?: number // historical accuracy on past forecasts
}

export interface ProvisioningPlan {
  id: string
  organizationId: string
  agentId: string
  forecastId: string
  resourceType: string
  currentCapacity: number
  targetCapacity: number
  requiredIncrease: number
  provisioningStrategy: 'reserved_instances' | 'spot_instances' | 'auto_scaling' | 'manual_provisioning'
  estimatedCost: number
  estimatedProvisioningTime: number // minutes
  implementationSteps: Array<{
    step: number
    action: string
    duration: number // minutes
    riskLevel: 'low' | 'medium' | 'high'
  }>
  status: 'proposed' | 'approved' | 'scheduled' | 'in_progress' | 'completed' | 'failed'
  approvalRequiredReason?: string
  scheduledFor?: Date
  startedAt?: Date
  completedAt?: Date
  actualCost?: number
  bottlenecksPrevented?: string[]
}

export interface ResourceUtilizationTrend {
  id: string
  organizationId: string
  agentId: string
  resourceType: string
  metricName: string
  period: 'hourly' | 'daily' | 'weekly'
  date: Date
  minUtilization: number
  avgUtilization: number
  maxUtilization: number
  p50: number // median
  p95: number // 95th percentile
  p99: number // 99th percentile
  trend: 'increasing' | 'decreasing' | 'stable'
  trendRate: number // % per day
  seasonalPattern?: string // 'daily_peak_morning' | 'weekly_peak_monday' etc
  anomalyDetected: boolean
}

export interface CapacityAllocation {
  id: string
  organizationId: string
  agentId: string
  workspaceId?: string
  departmentId?: string
  resourceType: string
  allocatedCapacity: number
  reservedCapacity: number
  currentUsage: number
  utilizationRate: number // 0-1
  fairShareScore: number // 0-1, whether within fair share allocation
  autoScalingGroup?: string
  minInstances: number
  maxInstances: number
  currentInstances: number
  targetInstances: number
  lastAdjustmentAt?: Date
  nextAdjustmentAt?: Date
}

export interface BottleneckDetection {
  id: string
  organizationId: string
  agentId: string
  resourceType: string
  metricName: string
  currentUtilization: number
  capacityThreshold: number
  riskScore: number // 0-1
  timeToBottleneck: number // minutes until threshold reached (if trend continues)
  affectedServices: string[]
  affectedUsers: number
  estimatedSLAImpact: string // 'none' | 'minor' | 'major' | 'critical'
  urgencyLevel: 'low' | 'medium' | 'high' | 'critical'
  suggestedActions: Array<{
    action: string
    estimatedReliefMs: number
    cost: number
    timeToImplement: number // minutes
  }>
  detectedAt: Date
  resolvedAt?: Date
}

export interface CapacityOptimization {
  id: string
  organizationId: string
  agentId: string
  optimizationType: 'consolidation' | 'deprovisioning' | 'rightsizing' | 'rebalancing'
  currentAllocation: number
  proposedAllocation: number
  estimatedSavings: number
  riskOfUnderprovisioning: number // 0-1
  confidence: number // 0-1
  implementationComplexity: 'low' | 'medium' | 'high'
  status: 'proposed' | 'approved' | 'rejected' | 'executing' | 'completed'
  approvalReason?: string
  executedAt?: Date
  actualSavings?: number
}

// Storage
const forecasts = new Map<string, CapacityForecast[]>()
const plans = new Map<string, ProvisioningPlan[]>()
const trends = new Map<string, ResourceUtilizationTrend[]>()
const allocations = new Map<string, CapacityAllocation[]>()
const bottlenecks = new Map<string, BottleneckDetection[]>()
const optimizations = new Map<string, CapacityOptimization[]>()

/**
 * Create capacity forecast.
 */
export function createCapacityForecast(
  organizationId: string,
  agentId: string,
  resourceType: CapacityForecast['resourceType'],
  metricName: string,
  forecastPeriod: CapacityForecast['forecastPeriod'],
  currentUtilization: number,
  forecastedUtilization: number,
  peakUtilization: number,
  capacityThreshold: number,
  recommendedCapacity: number,
  confidenceLevel: number,
  forecastAccuracy?: number
): CapacityForecast {
  const bottleneckRiskScore = Math.max(0, (forecastedUtilization - capacityThreshold) / (100 - capacityThreshold))

  const forecast: CapacityForecast = {
    id: `forecast-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    organizationId,
    agentId,
    resourceType,
    metricName,
    forecastPeriod,
    forecastDate: new Date(),
    currentUtilization,
    forecastedUtilization,
    peakUtilization,
    capacityThreshold,
    bottleneckRiskScore: Math.min(1, bottleneckRiskScore),
    recommendedCapacity,
    estRiskIfUnprovisioned:
      bottleneckRiskScore > 0.8 ? 'critical' : bottleneckRiskScore > 0.6 ? 'high' : bottleneckRiskScore > 0.3 ? 'medium' : 'low',
    confidenceLevel,
    forecastAccuracy,
  }

  const key = `${organizationId}:forecasts`
  const list = forecasts.get(key) || []
  list.push(forecast)

  // Keep last 2000
  const filtered = list.slice(-2000)
  forecasts.set(key, filtered)

  logger.info('capacity forecast created', {
    organizationId,
    agentId,
    resourceType,
    bottleneckRisk: forecast.bottleneckRiskScore.toFixed(2),
    confidenceLevel,
  })

  return forecast
}

/**
 * Get capacity forecasts.
 */
export function getCapacityForecasts(organizationId: string, agentId?: string, resourceType?: string): CapacityForecast[] {
  const key = `${organizationId}:forecasts`
  let list = forecasts.get(key) || []

  if (agentId) {
    list = list.filter((f) => f.agentId === agentId)
  }
  if (resourceType) {
    list = list.filter((f) => f.resourceType === resourceType)
  }

  return list
}

/**
 * Create provisioning plan.
 */
export function createProvisioningPlan(
  organizationId: string,
  agentId: string,
  forecastId: string,
  resourceType: string,
  currentCapacity: number,
  targetCapacity: number,
  provisioningStrategy: ProvisioningPlan['provisioningStrategy'],
  estimatedCost: number,
  estimatedProvisioningTime: number,
  implementationSteps: ProvisioningPlan['implementationSteps']
): ProvisioningPlan {
  const requiredIncrease = Math.max(0, targetCapacity - currentCapacity)

  const plan: ProvisioningPlan = {
    id: `plan-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    organizationId,
    agentId,
    forecastId,
    resourceType,
    currentCapacity,
    targetCapacity,
    requiredIncrease,
    provisioningStrategy,
    estimatedCost,
    estimatedProvisioningTime,
    implementationSteps,
    status: estimatedCost < 10000 && estimatedProvisioningTime < 30 ? 'approved' : 'proposed',
    approvalRequiredReason:
      estimatedCost >= 10000 || estimatedProvisioningTime >= 30
        ? 'Requires verification of cost/timeline or high-risk provisioning'
        : undefined,
  }

  const key = `${organizationId}:plans`
  const list = plans.get(key) || []
  list.push(plan)

  // Keep last 1000
  const filtered = list.slice(-1000)
  plans.set(key, filtered)

  logger.info('provisioning plan created', {
    organizationId,
    agentId,
    resourceType,
    requiredIncrease,
    estimatedCost,
  })

  return plan
}

/**
 * Get provisioning plans.
 */
export function getProvisioningPlans(organizationId: string, agentId?: string, status?: string): ProvisioningPlan[] {
  const key = `${organizationId}:plans`
  let list = plans.get(key) || []

  if (agentId) {
    list = list.filter((p) => p.agentId === agentId)
  }
  if (status) {
    list = list.filter((p) => p.status === status)
  }

  return list
}

/**
 * Execute provisioning plan.
 */
export function executeProvisioningPlan(
  organizationId: string,
  planId: string,
  actualCost: number,
  bottlenecksPrevented: string[]
): boolean {
  const key = `${organizationId}:plans`
  const list = plans.get(key) || []
  const plan = list.find((p) => p.id === planId)

  if (!plan) return false

  plan.status = 'completed'
  plan.startedAt = plan.scheduledFor || new Date()
  plan.completedAt = new Date()
  plan.actualCost = actualCost
  plan.bottlenecksPrevented = bottlenecksPrevented

  logger.info('provisioning plan executed', {
    organizationId,
    planId,
    actualCost,
    bottlenecksPrevented: bottlenecksPrevented.length,
  })

  return true
}

/**
 * Record resource utilization trend.
 */
export function recordUtilizationTrend(
  organizationId: string,
  agentId: string,
  resourceType: string,
  metricName: string,
  period: ResourceUtilizationTrend['period'],
  minUtilization: number,
  avgUtilization: number,
  maxUtilization: number,
  p95: number,
  p99: number,
  trend: ResourceUtilizationTrend['trend'],
  trendRate: number,
  anomalyDetected: boolean,
  seasonalPattern?: string
): ResourceUtilizationTrend {
  const trendRecord: ResourceUtilizationTrend = {
    id: `trend-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    organizationId,
    agentId,
    resourceType,
    metricName,
    period,
    date: new Date(),
    minUtilization,
    avgUtilization,
    maxUtilization,
    p50: (minUtilization + maxUtilization) / 2,
    p95,
    p99,
    trend,
    trendRate,
    seasonalPattern,
    anomalyDetected,
  }

  const key = `${organizationId}:trends`
  const list = trends.get(key) || []
  list.push(trendRecord)

  // Keep last 5000
  const filtered = list.slice(-5000)
  trends.set(key, filtered)

  return trendRecord
}

/**
 * Get utilization trends.
 */
export function getUtilizationTrends(organizationId: string, agentId?: string, resourceType?: string, days: number = 30): ResourceUtilizationTrend[] {
  const key = `${organizationId}:trends`
  const list = trends.get(key) || []
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  let filtered = list.filter((t) => t.date >= cutoff)
  if (agentId) {
    filtered = filtered.filter((t) => t.agentId === agentId)
  }
  if (resourceType) {
    filtered = filtered.filter((t) => t.resourceType === resourceType)
  }

  return filtered
}

/**
 * Create capacity allocation.
 */
export function createCapacityAllocation(
  organizationId: string,
  agentId: string,
  resourceType: string,
  allocatedCapacity: number,
  reservedCapacity: number,
  currentUsage: number,
  minInstances: number,
  maxInstances: number,
  currentInstances: number,
  workspaceId?: string,
  departmentId?: string,
  autoScalingGroup?: string
): CapacityAllocation {
  const utilizationRate = allocatedCapacity > 0 ? currentUsage / allocatedCapacity : 0
  const fairShareScore = utilizationRate <= 0.8 ? 1.0 : Math.max(0, 2.0 - utilizationRate * 2)

  const allocation: CapacityAllocation = {
    id: `alloc-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    organizationId,
    agentId,
    workspaceId,
    departmentId,
    resourceType,
    allocatedCapacity,
    reservedCapacity,
    currentUsage,
    utilizationRate,
    fairShareScore,
    autoScalingGroup,
    minInstances,
    maxInstances,
    currentInstances,
    targetInstances: Math.ceil((currentUsage / allocatedCapacity) * currentInstances) || currentInstances,
  }

  const key = `${organizationId}:allocations`
  const list = allocations.get(key) || []
  list.push(allocation)

  // Keep last 2000
  const filtered = list.slice(-2000)
  allocations.set(key, filtered)

  return allocation
}

/**
 * Get capacity allocations.
 */
export function getCapacityAllocations(organizationId: string, resourceType?: string): CapacityAllocation[] {
  const key = `${organizationId}:allocations`
  let list = allocations.get(key) || []

  if (resourceType) {
    list = list.filter((a) => a.resourceType === resourceType)
  }

  return list
}

/**
 * Update capacity allocation.
 */
export function updateCapacityAllocation(organizationId: string, allocationId: string, currentUsage: number, currentInstances: number): boolean {
  const key = `${organizationId}:allocations`
  const list = allocations.get(key) || []
  const allocation = list.find((a) => a.id === allocationId)

  if (!allocation) return false

  allocation.currentUsage = currentUsage
  allocation.currentInstances = currentInstances
  allocation.utilizationRate = allocation.allocatedCapacity > 0 ? currentUsage / allocation.allocatedCapacity : 0
  allocation.targetInstances = Math.ceil((currentUsage / allocation.allocatedCapacity) * currentInstances) || currentInstances
  allocation.lastAdjustmentAt = new Date()
  allocation.nextAdjustmentAt = new Date(Date.now() + 3600000) // 1 hour

  return true
}

/**
 * Detect bottleneck.
 */
export function detectBottleneck(
  organizationId: string,
  agentId: string,
  resourceType: string,
  metricName: string,
  currentUtilization: number,
  capacityThreshold: number,
  affectedServices: string[],
  affectedUsers: number
): BottleneckDetection {
  const riskScore = Math.max(0, (currentUtilization - capacityThreshold) / (100 - capacityThreshold))
  const timeToBottleneck = riskScore > 0 ? Math.ceil((100 - currentUtilization) / 5) : 999 // minutes at 5% per min
  const urgencyLevel =
    riskScore > 0.9
      ? 'critical'
      : riskScore > 0.7
        ? 'high'
        : riskScore > 0.4
          ? 'medium'
          : 'low'

  const bottleneck: BottleneckDetection = {
    id: `bn-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    organizationId,
    agentId,
    resourceType,
    metricName,
    currentUtilization,
    capacityThreshold,
    riskScore: Math.min(1, riskScore),
    timeToBottleneck,
    affectedServices,
    affectedUsers,
    estimatedSLAImpact: riskScore > 0.9 ? 'critical' : riskScore > 0.7 ? 'major' : riskScore > 0.4 ? 'minor' : 'none',
    urgencyLevel,
    suggestedActions: generateSuggestedActions(resourceType, currentUtilization, capacityThreshold),
    detectedAt: new Date(),
  }

  const key = `${organizationId}:bottlenecks`
  const list = bottlenecks.get(key) || []
  list.push(bottleneck)

  // Keep last 1000
  const filtered = list.slice(-1000)
  bottlenecks.set(key, filtered)

  logger.info('bottleneck detected', {
    organizationId,
    agentId,
    resourceType,
    riskScore: bottleneck.riskScore.toFixed(2),
    urgencyLevel,
    affectedUsers,
  })

  return bottleneck
}

/**
 * Get detected bottlenecks.
 */
export function getBottlenecks(organizationId: string, agentId?: string, urgencyLevel?: string): BottleneckDetection[] {
  const key = `${organizationId}:bottlenecks`
  let list = bottlenecks.get(key) || []

  if (agentId) {
    list = list.filter((b) => b.agentId === agentId)
  }
  if (urgencyLevel) {
    list = list.filter((b) => b.urgencyLevel === urgencyLevel)
  }

  return list
}

/**
 * Resolve bottleneck.
 */
export function resolveBottleneck(organizationId: string, bottleneckId: string): boolean {
  const key = `${organizationId}:bottlenecks`
  const list = bottlenecks.get(key) || []
  const bottleneck = list.find((b) => b.id === bottleneckId)

  if (!bottleneck) return false

  bottleneck.resolvedAt = new Date()
  return true
}

/**
 * Propose capacity optimization.
 */
export function proposeCapacityOptimization(
  organizationId: string,
  agentId: string,
  optimizationType: CapacityOptimization['optimizationType'],
  currentAllocation: number,
  proposedAllocation: number,
  estimatedSavings: number,
  riskOfUnderprovisioning: number,
  confidence: number,
  implementationComplexity: CapacityOptimization['implementationComplexity']
): CapacityOptimization {
  const optimization: CapacityOptimization = {
    id: `optim-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    organizationId,
    agentId,
    optimizationType,
    currentAllocation,
    proposedAllocation,
    estimatedSavings,
    riskOfUnderprovisioning,
    confidence,
    implementationComplexity,
    status: confidence > 0.85 && riskOfUnderprovisioning < 0.15 ? 'approved' : 'proposed',
    approvalReason:
      confidence <= 0.85 || riskOfUnderprovisioning >= 0.15
        ? 'Requires verification of confidence level or risk assessment'
        : undefined,
  }

  const key = `${organizationId}:optimizations`
  const list = optimizations.get(key) || []
  list.push(optimization)

  // Keep last 1000
  const filtered = list.slice(-1000)
  optimizations.set(key, filtered)

  return optimization
}

/**
 * Get capacity optimizations.
 */
export function getCapacityOptimizations(organizationId: string, status?: string): CapacityOptimization[] {
  const key = `${organizationId}:optimizations`
  let list = optimizations.get(key) || []

  if (status) {
    list = list.filter((o) => o.status === status)
  }

  return list
}

/**
 * Execute capacity optimization.
 */
export function executeCapacityOptimization(organizationId: string, optimizationId: string, actualSavings: number): boolean {
  const key = `${organizationId}:optimizations`
  const list = optimizations.get(key) || []
  const optimization = list.find((o) => o.id === optimizationId)

  if (!optimization) return false

  optimization.status = 'completed'
  optimization.executedAt = new Date()
  optimization.actualSavings = actualSavings

  return true
}

/**
 * Helper: Generate suggested actions for bottleneck.
 */
function generateSuggestedActions(
  resourceType: string,
  currentUtilization: number,
  capacityThreshold: number
): Array<{ action: string; estimatedReliefMs: number; cost: number; timeToImplement: number }> {
  const actions: Array<{ action: string; estimatedReliefMs: number; cost: number; timeToImplement: number }> = []

  if (resourceType === 'cpu') {
    actions.push({
      action: 'Add 2 instances to auto-scaling group',
      estimatedReliefMs: 300000, // 5 min
      cost: 500,
      timeToImplement: 2,
    })
    actions.push({
      action: 'Optimize query plans and add database indexes',
      estimatedReliefMs: 600000, // 10 min
      cost: 100,
      timeToImplement: 30,
    })
  } else if (resourceType === 'memory') {
    actions.push({
      action: 'Increase memory allocation per instance',
      estimatedReliefMs: 180000, // 3 min
      cost: 800,
      timeToImplement: 5,
    })
    actions.push({
      action: 'Implement object pool caching and memory optimization',
      estimatedReliefMs: 900000, // 15 min
      cost: 200,
      timeToImplement: 60,
    })
  } else if (resourceType === 'storage') {
    actions.push({
      action: 'Archive cold data to cheaper tier',
      estimatedReliefMs: 600000, // 10 min
      cost: 0,
      timeToImplement: 15,
    })
    actions.push({
      action: 'Expand storage volume',
      estimatedReliefMs: 120000, // 2 min
      cost: 300,
      timeToImplement: 10,
    })
  } else if (resourceType === 'bandwidth') {
    actions.push({
      action: 'Enable content caching and compression',
      estimatedReliefMs: 300000, // 5 min
      cost: 50,
      timeToImplement: 20,
    })
    actions.push({
      action: 'Add edge location/CDN',
      estimatedReliefMs: 900000, // 15 min
      cost: 1500,
      timeToImplement: 30,
    })
  }

  return actions
}

/**
 * Clear capacity planning data (for testing).
 */
export function clearCapacityPlanning(): void {
  forecasts.clear()
  plans.clear()
  trends.clear()
  allocations.clear()
  bottlenecks.clear()
  optimizations.clear()
}
