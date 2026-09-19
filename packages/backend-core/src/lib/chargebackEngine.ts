// Phase 7: Chargeback and internal billing system for cost allocation and invoicing.
// Enables showback statements, chargeback allocation, and departmental billing workflows.

import { logger } from './logger.js'

export interface AllocationRule {
  id: string
  organizationId: string
  name: string
  enabled: boolean
  costCenterId: string
  allocation: Record<string, number> // department/team ID -> percentage
  markupFactor: number // 1.0 = no markup, 1.2 = 20% markup for overhead
  createdAt: Date
  updatedAt: Date
}

export interface ShowbackStatement {
  id: string
  organizationId: string
  departmentId: string
  period: string // YYYY-MM
  totalCost: number
  breakdown: Record<string, number> // by service/project/team
  trend: number // % change from previous month
  generatedAt: Date
}

export interface ChargebackStatement {
  id: string
  organizationId: string
  departmentId: string
  period: string // YYYY-MM
  baseCost: number
  markupAmount: number
  totalCharge: number
  breakdown: Record<string, number> // by service/cost-center
  dueDate: Date
  status: 'draft' | 'issued' | 'paid' | 'overdue'
  issuedAt?: Date
  paidAt?: Date
  generatedAt: Date
}

export interface ChargebackAllocation {
  id: string
  organizationId: string
  costId: string
  sourceDepartmentId: string
  targetDepartmentId: string
  allocationType: 'direct' | 'shared' | 'overhead'
  amount: number
  allocationBasis: string // 'headcount', 'usage', 'equal_split', etc.
  appliedAt: Date
}

export interface InternalInvoice {
  id: string
  organizationId: string
  departmentId: string
  invoiceNumber: string
  period: string // YYYY-MM
  issueDate: Date
  dueDate: Date
  items: Array<{
    description: string
    quantity: number
    unitCost: number
    amount: number
  }>
  subtotal: number
  tax: number
  markup: number
  total: number
  status: 'draft' | 'sent' | 'paid' | 'cancelled'
  sentAt?: Date
  paidAt?: Date
  paidAmount?: number
  notes?: string
}

export interface ChargeReconciliation {
  id: string
  organizationId: string
  period: string // YYYY-MM
  totalBudgeted: number
  totalAllocated: number
  totalCharged: number
  variance: number // allocated - charged
  variancePercent: number
  departmentReconciliations: Array<{
    departmentId: string
    budgeted: number
    allocated: number
    charged: number
    variance: number
  }>
  reconciliationDate: Date
}

// Storage
const allocationRules = new Map<string, AllocationRule[]>()
const showbackStatements = new Map<string, ShowbackStatement[]>()
const chargebackStatements = new Map<string, ChargebackStatement[]>()
const chargebackAllocations = new Map<string, ChargebackAllocation[]>()
const internalInvoices = new Map<string, InternalInvoice[]>()
const chargeReconciliations = new Map<string, ChargeReconciliation[]>()

/**
 * Create allocation rule.
 */
export function createAllocationRule(
  organizationId: string,
  name: string,
  costCenterId: string,
  allocation: Record<string, number>,
  markupFactor: number = 1.0
): AllocationRule {
  // Validate allocation sums to 100%
  const total = Object.values(allocation).reduce((sum, pct) => sum + pct, 0)
  if (Math.abs(total - 100) > 0.1) {
    logger.error('allocation does not sum to 100%', { total, allocation })
    throw new Error('Allocation percentages must sum to 100%')
  }

  const rule: AllocationRule = {
    id: `rule-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    organizationId,
    name,
    enabled: true,
    costCenterId,
    allocation,
    markupFactor,
    createdAt: new Date(),
    updatedAt: new Date(),
  }

  const list = allocationRules.get(organizationId) || []
  list.push(rule)
  allocationRules.set(organizationId, list)

  logger.info('allocation rule created', {
    organizationId,
    name,
    costCenterId,
    markupFactor,
  })

  return rule
}

/**
 * Get allocation rules for organization.
 */
export function getAllocationRules(organizationId: string, enabled?: boolean): AllocationRule[] {
  const list = allocationRules.get(organizationId) || []
  return enabled !== undefined ? list.filter((r) => r.enabled === enabled) : list
}

/**
 * Update allocation rule.
 */
export function updateAllocationRule(
  organizationId: string,
  ruleId: string,
  updates: Partial<AllocationRule>
): boolean {
  const list = allocationRules.get(organizationId) || []
  const rule = list.find((r) => r.id === ruleId)

  if (!rule) return false

  Object.assign(rule, { ...updates, updatedAt: new Date() })

  return true
}

/**
 * Generate showback statement (informational, no cost attribution).
 */
export function generateShowbackStatement(
  organizationId: string,
  departmentId: string,
  period: string,
  totalCost: number,
  breakdown: Record<string, number>,
  trend: number = 0
): ShowbackStatement {
  const statement: ShowbackStatement = {
    id: `showback-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    organizationId,
    departmentId,
    period,
    totalCost,
    breakdown,
    trend,
    generatedAt: new Date(),
  }

  const key = `${organizationId}:showback`
  const list = showbackStatements.get(key) || []
  list.push(statement)
  showbackStatements.set(key, list)

  logger.info('showback statement generated', {
    organizationId,
    departmentId,
    period,
    totalCost,
  })

  return statement
}

/**
 * Get showback statements.
 */
export function getShowbackStatements(
  organizationId: string,
  departmentId?: string,
  months: number = 12
): ShowbackStatement[] {
  const key = `${organizationId}:showback`
  const list = showbackStatements.get(key) || []

  let filtered = list.slice(-months)
  if (departmentId) {
    filtered = filtered.filter((s) => s.departmentId === departmentId)
  }

  return filtered
}

/**
 * Generate chargeback statement.
 */
export function generateChargebackStatement(
  organizationId: string,
  departmentId: string,
  period: string,
  baseCost: number,
  breakdown: Record<string, number>,
  markupFactor: number = 1.0
): ChargebackStatement {
  const markupAmount = baseCost * (markupFactor - 1)
  const totalCharge = baseCost + markupAmount

  const statement: ChargebackStatement = {
    id: `chargeback-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    organizationId,
    departmentId,
    period,
    baseCost,
    markupAmount,
    totalCharge,
    breakdown,
    dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
    status: 'draft',
    generatedAt: new Date(),
  }

  const key = `${organizationId}:chargeback`
  const list = chargebackStatements.get(key) || []
  list.push(statement)
  chargebackStatements.set(key, list)

  logger.info('chargeback statement generated', {
    organizationId,
    departmentId,
    period,
    totalCharge,
  })

  return statement
}

/**
 * Get chargeback statements.
 */
export function getChargebackStatements(
  organizationId: string,
  departmentId?: string,
  status?: string
): ChargebackStatement[] {
  const key = `${organizationId}:chargeback`
  const list = chargebackStatements.get(key) || []

  let filtered = list
  if (departmentId) {
    filtered = filtered.filter((s) => s.departmentId === departmentId)
  }
  if (status) {
    filtered = filtered.filter((s) => s.status === status)
  }

  return filtered
}

/**
 * Issue chargeback statement.
 */
export function issueChargebackStatement(organizationId: string, statementId: string): boolean {
  const key = `${organizationId}:chargeback`
  const list = chargebackStatements.get(key) || []
  const statement = list.find((s) => s.id === statementId)

  if (!statement || statement.status !== 'draft') return false

  statement.status = 'issued'
  statement.issuedAt = new Date()

  return true
}

/**
 * Mark chargeback as paid.
 */
export function markChargebackPaid(organizationId: string, statementId: string): boolean {
  const key = `${organizationId}:chargeback`
  const list = chargebackStatements.get(key) || []
  const statement = list.find((s) => s.id === statementId)

  if (!statement) return false

  statement.status = 'paid'
  statement.paidAt = new Date()

  return true
}

/**
 * Record chargeback allocation.
 */
export function recordChargebackAllocation(
  organizationId: string,
  costId: string,
  sourceDepartmentId: string,
  targetDepartmentId: string,
  allocationType: 'direct' | 'shared' | 'overhead',
  amount: number,
  allocationBasis: string
): ChargebackAllocation {
  const allocation: ChargebackAllocation = {
    id: `alloc-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    organizationId,
    costId,
    sourceDepartmentId,
    targetDepartmentId,
    allocationType,
    amount,
    allocationBasis,
    appliedAt: new Date(),
  }

  const key = `${organizationId}:allocations`
  const list = chargebackAllocations.get(key) || []
  list.push(allocation)
  chargebackAllocations.set(key, list)

  return allocation
}

/**
 * Get allocations for organization.
 */
export function getChargebackAllocations(
  organizationId: string,
  departmentId?: string
): ChargebackAllocation[] {
  const key = `${organizationId}:allocations`
  const list = chargebackAllocations.get(key) || []

  if (!departmentId) return list

  return list.filter((a) => a.targetDepartmentId === departmentId)
}

/**
 * Create internal invoice.
 */
export function createInternalInvoice(
  organizationId: string,
  departmentId: string,
  period: string,
  items: Array<{ description: string; quantity: number; unitCost: number }>,
  markupFactor: number = 1.0
): InternalInvoice {
  const subtotal = items.reduce((sum, item) => sum + item.quantity * item.unitCost, 0)
  const tax = subtotal * 0.1 // 10% tax
  const markup = subtotal * (markupFactor - 1)
  const total = subtotal + tax + markup

  const invoiceNumber = `INV-${Date.now()}-${Math.random().toString(36).slice(2).toUpperCase()}`

  const invoice: InternalInvoice = {
    id: `invoice-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    organizationId,
    departmentId,
    invoiceNumber,
    period,
    issueDate: new Date(),
    dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    items: items.map((item) => ({
      ...item,
      amount: item.quantity * item.unitCost,
    })),
    subtotal,
    tax,
    markup,
    total,
    status: 'draft',
  }

  const key = `${organizationId}:invoices`
  const list = internalInvoices.get(key) || []
  list.push(invoice)
  internalInvoices.set(key, list)

  logger.info('internal invoice created', {
    organizationId,
    departmentId,
    invoiceNumber,
    total,
  })

  return invoice
}

/**
 * Get invoices for organization.
 */
export function getInternalInvoices(
  organizationId: string,
  departmentId?: string,
  status?: string
): InternalInvoice[] {
  const key = `${organizationId}:invoices`
  const list = internalInvoices.get(key) || []

  let filtered = list
  if (departmentId) {
    filtered = filtered.filter((i) => i.departmentId === departmentId)
  }
  if (status) {
    filtered = filtered.filter((i) => i.status === status)
  }

  return filtered
}

/**
 * Send invoice.
 */
export function sendInvoice(organizationId: string, invoiceId: string): boolean {
  const key = `${organizationId}:invoices`
  const list = internalInvoices.get(key) || []
  const invoice = list.find((i) => i.id === invoiceId)

  if (!invoice || invoice.status !== 'draft') return false

  invoice.status = 'sent'
  invoice.sentAt = new Date()

  logger.info('invoice sent', {
    organizationId,
    invoiceId,
    invoiceNumber: invoice.invoiceNumber,
  })

  return true
}

/**
 * Record invoice payment.
 */
export function recordPayment(
  organizationId: string,
  invoiceId: string,
  paidAmount: number
): boolean {
  const key = `${organizationId}:invoices`
  const list = internalInvoices.get(key) || []
  const invoice = list.find((i) => i.id === invoiceId)

  if (!invoice) return false

  invoice.paidAmount = (invoice.paidAmount || 0) + paidAmount

  if (invoice.paidAmount >= invoice.total) {
    invoice.status = 'paid'
    invoice.paidAt = new Date()
  }

  return true
}

/**
 * Generate charge reconciliation report.
 */
export function generateChargeReconciliation(
  organizationId: string,
  period: string,
  departmentBudgets: Record<string, number>
): ChargeReconciliation {
  const statements = getChargebackStatements(organizationId)
  const periodStatements = statements.filter((s) => s.period === period)

  let totalBudgeted = 0
  let totalAllocated = 0
  let totalCharged = 0

  const departmentReconciliations = []

  for (const [deptId, budget] of Object.entries(departmentBudgets)) {
    const deptStatements = periodStatements.filter((s) => s.departmentId === deptId)
    const allocated = deptStatements.reduce((sum, s) => sum + s.baseCost, 0)
    const charged = deptStatements.reduce((sum, s) => sum + s.totalCharge, 0)
    const variance = allocated - charged

    totalBudgeted += budget
    totalAllocated += allocated
    totalCharged += charged

    departmentReconciliations.push({
      departmentId: deptId,
      budgeted: budget,
      allocated,
      charged,
      variance,
    })
  }

  const variance = totalAllocated - totalCharged
  const variancePercent = totalAllocated > 0 ? (variance / totalAllocated) * 100 : 0

  const reconciliation: ChargeReconciliation = {
    id: `recon-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    organizationId,
    period,
    totalBudgeted,
    totalAllocated,
    totalCharged,
    variance,
    variancePercent,
    departmentReconciliations,
    reconciliationDate: new Date(),
  }

  const key = `${organizationId}:reconciliation`
  const list = chargeReconciliations.get(key) || []
  list.push(reconciliation)
  chargeReconciliations.set(key, list)

  logger.info('charge reconciliation generated', {
    organizationId,
    period,
    totalCharged,
    variance,
  })

  return reconciliation
}

/**
 * Get charge reconciliations.
 */
export function getChargeReconciliations(organizationId: string, months: number = 12): ChargeReconciliation[] {
  const key = `${organizationId}:reconciliation`
  const list = chargeReconciliations.get(key) || []
  return list.slice(-months)
}

/**
 * Clear chargeback data (for testing).
 */
export function clearChargeback(): void {
  allocationRules.clear()
  showbackStatements.clear()
  chargebackStatements.clear()
  chargebackAllocations.clear()
  internalInvoices.clear()
  chargeReconciliations.clear()
}
