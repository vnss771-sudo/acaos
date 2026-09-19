// Phase 8: Data export system for cost analysis, reports, and scheduled exports.
// Supports CSV, JSON, and Parquet formats with templates and scheduling.

import { logger } from './logger.js'

export type ExportFormat = 'csv' | 'json' | 'parquet'

export type ExportTemplateType =
  | 'executive_summary'
  | 'detailed_cost_analysis'
  | 'budget_variance'
  | 'team_breakdown'
  | 'service_breakdown'
  | 'department_allocation'
  | 'compliance_report'
  | 'custom'

export interface ExportJob {
  id: string
  organizationId: string
  name: string
  type: 'cost_data' | 'report' | 'chargeback' | 'custom'
  format: ExportFormat
  status: 'pending' | 'in_progress' | 'completed' | 'failed'
  startDate: Date
  endDate: Date
  filters: Record<string, unknown>
  fileSize?: number
  downloadUrl?: string
  expiresAt: Date
  error?: string
  createdAt: Date
  completedAt?: Date
}

export interface ExportTemplate {
  id: string
  organizationId: string
  name: string
  type: ExportTemplateType
  description: string
  format: ExportFormat
  dimensions: string[] // ['team', 'service', 'region']
  metrics: string[] // ['cost', 'percentage', 'trend']
  filters: Record<string, unknown>
  schedule?: {
    enabled: boolean
    frequency: 'daily' | 'weekly' | 'monthly'
    dayOfWeek?: number // 0-6 for weekly
    dayOfMonth?: number // 1-31 for monthly
    hour: number // 0-23
  }
  lastExecuted?: Date
  nextExecution?: Date
  createdAt: Date
  updatedAt: Date
}

export interface ExportHistory {
  id: string
  organizationId: string
  jobId: string
  templateId?: string
  format: ExportFormat
  type: string
  fileSize: number
  downloadUrl: string
  downloadCount: number
  expiresAt: Date
  createdAt: Date
}

export interface DataRow {
  [key: string]: string | number | boolean | Date | null
}

// Storage
const exportJobs = new Map<string, ExportJob[]>()
const exportTemplates = new Map<string, ExportTemplate[]>()
const exportHistory = new Map<string, ExportHistory[]>()
const exportData = new Map<string, DataRow[]>()

/**
 * Create export job.
 */
export function createExportJob(
  organizationId: string,
  name: string,
  type: 'cost_data' | 'report' | 'chargeback' | 'custom',
  format: ExportFormat,
  startDate: Date,
  endDate: Date,
  filters: Record<string, unknown> = {}
): ExportJob {
  const job: ExportJob = {
    id: `export-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    organizationId,
    name,
    type,
    format,
    status: 'pending',
    startDate,
    endDate,
    filters,
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
    createdAt: new Date(),
  }

  const key = `${organizationId}:jobs`
  const list = exportJobs.get(key) || []
  list.push(job)
  exportJobs.set(key, list)

  logger.info('export job created', {
    organizationId,
    jobId: job.id,
    type,
    format,
  })

  return job
}

/**
 * Get export jobs.
 */
export function getExportJobs(
  organizationId: string,
  status?: string,
  type?: string,
  days: number = 30
): ExportJob[] {
  const key = `${organizationId}:jobs`
  const list = exportJobs.get(key) || []
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  let filtered = list.filter((j) => j.createdAt >= cutoff)
  if (status) {
    filtered = filtered.filter((j) => j.status === status)
  }
  if (type) {
    filtered = filtered.filter((j) => j.type === type)
  }

  return filtered
}

/**
 * Get export job.
 */
export function getExportJob(organizationId: string, jobId: string): ExportJob | null {
  const key = `${organizationId}:jobs`
  const list = exportJobs.get(key) || []
  return list.find((j) => j.id === jobId) || null
}

/**
 * Update export job status.
 */
export function updateExportJobStatus(
  organizationId: string,
  jobId: string,
  status: string,
  fileSize?: number,
  downloadUrl?: string,
  error?: string
): boolean {
  const job = getExportJob(organizationId, jobId)
  if (!job) return false

  job.status = status as any
  if (fileSize !== undefined) job.fileSize = fileSize
  if (downloadUrl !== undefined) job.downloadUrl = downloadUrl
  if (error !== undefined) job.error = error
  if (status === 'completed' || status === 'failed') {
    job.completedAt = new Date()
  }

  return true
}

/**
 * Create export template.
 */
export function createExportTemplate(
  organizationId: string,
  name: string,
  type: ExportTemplateType,
  description: string,
  format: ExportFormat,
  dimensions: string[],
  metrics: string[],
  filters: Record<string, unknown> = {}
): ExportTemplate {
  const template: ExportTemplate = {
    id: `tmpl-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    organizationId,
    name,
    type,
    description,
    format,
    dimensions,
    metrics,
    filters,
    createdAt: new Date(),
    updatedAt: new Date(),
  }

  const key = `${organizationId}:templates`
  const list = exportTemplates.get(key) || []
  list.push(template)
  exportTemplates.set(key, list)

  logger.info('export template created', {
    organizationId,
    templateId: template.id,
    type,
    format,
  })

  return template
}

/**
 * Get export templates.
 */
export function getExportTemplates(organizationId: string, type?: ExportTemplateType): ExportTemplate[] {
  const key = `${organizationId}:templates`
  const list = exportTemplates.get(key) || []
  return type ? list.filter((t) => t.type === type) : list
}

/**
 * Get export template.
 */
export function getExportTemplate(organizationId: string, templateId: string): ExportTemplate | null {
  const key = `${organizationId}:templates`
  const list = exportTemplates.get(key) || []
  return list.find((t) => t.id === templateId) || null
}

/**
 * Update export template.
 */
export function updateExportTemplate(
  organizationId: string,
  templateId: string,
  updates: Partial<ExportTemplate>
): boolean {
  const template = getExportTemplate(organizationId, templateId)
  if (!template) return false

  Object.assign(template, { ...updates, updatedAt: new Date() })

  return true
}

/**
 * Delete export template.
 */
export function deleteExportTemplate(organizationId: string, templateId: string): boolean {
  const key = `${organizationId}:templates`
  const list = exportTemplates.get(key) || []
  const filtered = list.filter((t) => t.id !== templateId)
  exportTemplates.set(key, filtered)

  return filtered.length < list.length
}

/**
 * Enable scheduled export.
 */
export function enableScheduledExport(
  organizationId: string,
  templateId: string,
  frequency: 'daily' | 'weekly' | 'monthly',
  hour: number,
  dayOfWeek?: number,
  dayOfMonth?: number
): boolean {
  const template = getExportTemplate(organizationId, templateId)
  if (!template) return false

  template.schedule = {
    enabled: true,
    frequency,
    hour,
    dayOfWeek,
    dayOfMonth,
  }

  // Set next execution
  const now = new Date()
  const next = new Date(now)
  next.setHours(hour, 0, 0, 0)

  if (next <= now) {
    if (frequency === 'daily') {
      next.setDate(next.getDate() + 1)
    } else if (frequency === 'weekly' && dayOfWeek !== undefined) {
      const daysToAdd = (dayOfWeek - next.getDay() + 7) % 7
      next.setDate(next.getDate() + (daysToAdd === 0 ? 7 : daysToAdd))
    } else if (frequency === 'monthly' && dayOfMonth !== undefined) {
      next.setMonth(next.getMonth() + 1)
      next.setDate(dayOfMonth)
    }
  }

  template.nextExecution = next

  return true
}

/**
 * Disable scheduled export.
 */
export function disableScheduledExport(organizationId: string, templateId: string): boolean {
  const template = getExportTemplate(organizationId, templateId)
  if (!template || !template.schedule) return false

  template.schedule.enabled = false
  template.nextExecution = undefined

  return true
}

/**
 * Convert data to CSV.
 */
function dataToCSV(rows: DataRow[]): string {
  if (rows.length === 0) return ''

  const headers = Object.keys(rows[0])
  const csvLines: string[] = [headers.map((h) => `"${h}"`).join(',')]

  rows.forEach((row) => {
    const values = headers.map((h) => {
      const val = row[h]
      if (val === null || val === undefined) return ''
      if (typeof val === 'string') return `"${val.replace(/"/g, '""')}"`
      return String(val)
    })
    csvLines.push(values.join(','))
  })

  return csvLines.join('\n')
}

/**
 * Convert data to JSON.
 */
function dataToJSON(rows: DataRow[]): string {
  return JSON.stringify(rows, null, 2)
}

/**
 * Export cost data.
 */
export function exportCostData(
  organizationId: string,
  format: ExportFormat,
  startDate: Date,
  endDate: Date,
  filters: Record<string, unknown> = {}
): ExportJob {
  const job = createExportJob(organizationId, 'Cost Data Export', 'cost_data', format, startDate, endDate, filters)

  // Simulate data generation
  const mockData: DataRow[] = [
    {
      date: startDate.toISOString().split('T')[0],
      team: 'Engineering',
      service: 'Compute',
      cost: 1250.5,
      percentage: 25.5,
    },
    {
      date: startDate.toISOString().split('T')[0],
      team: 'Marketing',
      service: 'Storage',
      cost: 850.25,
      percentage: 17.3,
    },
    {
      date: startDate.toISOString().split('T')[0],
      team: 'Finance',
      service: 'Network',
      cost: 450.1,
      percentage: 9.2,
    },
  ]

  let output = ''
  if (format === 'csv') {
    output = dataToCSV(mockData)
  } else if (format === 'json') {
    output = dataToJSON(mockData)
  } else if (format === 'parquet') {
    // Parquet would require external library, simulating here
    output = JSON.stringify({ format: 'parquet', rows: mockData })
  }

  const fileSize = output.length
  const downloadUrl = `/api/exports/download/${job.id}`

  updateExportJobStatus(organizationId, job.id, 'completed', fileSize, downloadUrl)

  // Record in history
  const history: ExportHistory = {
    id: `hist-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    organizationId,
    jobId: job.id,
    format,
    type: 'cost_data',
    fileSize,
    downloadUrl,
    downloadCount: 0,
    expiresAt: job.expiresAt,
    createdAt: new Date(),
  }

  const hkey = `${organizationId}:history`
  const hlist = exportHistory.get(hkey) || []
  hlist.push(history)
  exportHistory.set(hkey, hlist)

  logger.info('cost data exported', {
    organizationId,
    jobId: job.id,
    format,
    fileSize,
  })

  return job
}

/**
 * Get export history.
 */
export function getExportHistory(organizationId: string, days: number = 30): ExportHistory[] {
  const key = `${organizationId}:history`
  const list = exportHistory.get(key) || []
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  return list.filter((h) => h.createdAt >= cutoff)
}

/**
 * Record export download.
 */
export function recordExportDownload(organizationId: string, jobId: string): boolean {
  const key = `${organizationId}:history`
  const list = exportHistory.get(key) || []
  const history = list.find((h) => h.jobId === jobId)

  if (!history) return false

  history.downloadCount++

  return true
}

/**
 * Get export statistics.
 */
export function getExportStats(organizationId: string): {
  totalExports: number
  exportsByFormat: Record<string, number>
  totalDataExported: number
  averageFileSize: number
  recentDownloads: number
} {
  const jkey = `${organizationId}:jobs`
  const jobs = exportJobs.get(jkey) || []
  const completedJobs = jobs.filter((j) => j.status === 'completed')

  const exportsByFormat: Record<string, number> = {}
  let totalDataExported = 0
  completedJobs.forEach((j) => {
    exportsByFormat[j.format] = (exportsByFormat[j.format] ?? 0) + 1
    totalDataExported += j.fileSize ?? 0
  })

  const hkey = `${organizationId}:history`
  const history = exportHistory.get(hkey) || []
  const recentDownloads = history.reduce((sum, h) => sum + h.downloadCount, 0)

  return {
    totalExports: completedJobs.length,
    exportsByFormat,
    totalDataExported,
    averageFileSize: completedJobs.length > 0 ? totalDataExported / completedJobs.length : 0,
    recentDownloads,
  }
}

/**
 * Clear export data (for testing).
 */
export function clearExports(): void {
  exportJobs.clear()
  exportTemplates.clear()
  exportHistory.clear()
  exportData.clear()
}
