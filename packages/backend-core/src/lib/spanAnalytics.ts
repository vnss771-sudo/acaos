// Phase 4.3: Span collection and latency analytics.
// Aggregates distributed traces to identify bottlenecks, slow paths, and
// service dependency patterns.
//
// Collects:
// - Request latency distribution (P50, P95, P99)
// - Database operation latency by model/operation
// - External service call patterns
// - Cache hit rates and effectiveness
// - Request path hotspots (which endpoints are slow)
// - Service dependency graph

export interface SpanRecord {
  traceId: string
  spanId: string
  parentSpanId?: string
  spanName: string
  serviceName: string
  startTimeMs: number
  durationMs: number
  attributes: Record<string, unknown>
  status: 'ok' | 'error'
  errorMessage?: string
}

export interface LatencyPercentiles {
  p50: number
  p75: number
  p90: number
  p95: number
  p99: number
  count: number
}

const spanBuffer: SpanRecord[] = []
const SPAN_BUFFER_MAX = 5000
const spanStats = new Map<string, LatencyPercentiles>()
const serviceGraph = new Map<string, Set<string>>() // service -> [downstream services]

/**
 * Record a completed span into analytics.
 */
export function recordSpan(span: SpanRecord): void {
  // Add to buffer
  spanBuffer.push(span)
  if (spanBuffer.length > SPAN_BUFFER_MAX) {
    spanBuffer.shift()
  }

  // Update statistics
  const key = span.spanName
  const existing = spanStats.get(key) || {
    p50: 0,
    p75: 0,
    p90: 0,
    p95: 0,
    p99: 0,
    count: 0,
  }

  spanStats.set(key, {
    ...existing,
    count: existing.count + 1,
  })

  // Update service dependency graph
  if (span.parentSpanId) {
    const parentSpan = spanBuffer.find((s) => s.spanId === span.parentSpanId)
    if (parentSpan) {
      const downstream = serviceGraph.get(parentSpan.serviceName) || new Set()
      downstream.add(span.serviceName)
      serviceGraph.set(parentSpan.serviceName, downstream)
    }
  }
}

/**
 * Get latency percentiles for a specific span type.
 */
export function getSpanPercentiles(spanName: string): LatencyPercentiles | null {
  const spans = spanBuffer.filter((s) => s.spanName === spanName)
  if (spans.length === 0) return null

  const durations = spans.map((s) => s.durationMs).sort((a, b) => a - b)
  const getPercentile = (p: number) => {
    const idx = Math.ceil((durations.length * p) / 100) - 1
    return durations[Math.max(0, idx)]
  }

  return {
    p50: getPercentile(50),
    p75: getPercentile(75),
    p90: getPercentile(90),
    p95: getPercentile(95),
    p99: getPercentile(99),
    count: durations.length,
  }
}

/**
 * Get slowest request paths (endpoints with highest P95 latency).
 */
export function getSlowestPaths(limit = 10): Array<{
  path: string
  p95Ms: number
  p99Ms: number
  count: number
}> {
  const pathStats = new Map<string, number[]>()

  for (const span of spanBuffer) {
    if (!span.spanName.startsWith('http.request')) continue

    const path = (span.attributes['http.url.path'] as string) || 'unknown'
    if (!pathStats.has(path)) {
      pathStats.set(path, [])
    }
    pathStats.get(path)!.push(span.durationMs)
  }

  const result = Array.from(pathStats.entries())
    .map(([path, durations]) => {
      const sorted = durations.sort((a, b) => a - b)
      const p95 = sorted[Math.ceil((sorted.length * 95) / 100) - 1]
      const p99 = sorted[Math.ceil((sorted.length * 99) / 100) - 1]
      return { path, p95Ms: p95, p99Ms: p99, count: durations.length }
    })
    .sort((a, b) => b.p95Ms - a.p95Ms)
    .slice(0, limit)

  return result
}

/**
 * Get slowest database operations.
 */
export function getSlowestDatabaseOps(limit = 10): Array<{
  model: string
  operation: string
  p95Ms: number
  avgMs: number
  count: number
  cacheHitRate: number
}> {
  const opStats = new Map<string, { durations: number[]; hits: number }>();

  for (const span of spanBuffer) {
    if (!span.spanName.startsWith('db.')) continue

    const model = (span.attributes['db.model'] as string) || 'unknown'
    const op = (span.attributes['db.operation'] as string) || 'unknown'
    const key = `${model}.${op}`
    const isCacheHit = span.attributes['db.cache_hit'] === true

    if (!opStats.has(key)) {
      opStats.set(key, { durations: [], hits: 0 })
    }

    const stat = opStats.get(key)!
    stat.durations.push(span.durationMs)
    if (isCacheHit) stat.hits++
  }

  const result = Array.from(opStats.entries())
    .map(([key, stat]) => {
      const [model, operation] = key.split('.')
      const sorted = stat.durations.sort((a, b) => a - b)
      const p95 = sorted[Math.ceil((sorted.length * 95) / 100) - 1]
      const avg = stat.durations.reduce((a, b) => a + b, 0) / stat.durations.length
      return {
        model,
        operation,
        p95Ms: p95,
        avgMs: Math.round(avg),
        count: stat.durations.length,
        cacheHitRate: stat.durations.length > 0 ? (stat.hits / stat.durations.length) : 0,
      }
    })
    .sort((a, b) => b.p95Ms - a.p95Ms)
    .slice(0, limit)

  return result
}

/**
 * Get external service call patterns.
 */
export function getExternalServiceStats(limit = 10): Array<{
  service: string
  operation: string
  avgMs: number
  p95Ms: number
  errorRate: number
  count: number
}> {
  const serviceStats = new Map<string, { durations: number[]; errors: number }>();

  for (const span of spanBuffer) {
    if (!span.spanName.startsWith('external.')) continue

    const service = (span.attributes['external.service'] as string) || 'unknown'
    const op = (span.attributes['external.operation'] as string) || 'unknown'
    const key = `${service}.${op}`

    if (!serviceStats.has(key)) {
      serviceStats.set(key, { durations: [], errors: 0 })
    }

    const stat = serviceStats.get(key)!
    stat.durations.push(span.durationMs)
    if (span.status === 'error') stat.errors++
  }

  const result = Array.from(serviceStats.entries())
    .map(([key, stat]) => {
      const [service, operation] = key.split('.')
      const sorted = stat.durations.sort((a, b) => a - b)
      const p95 = sorted[Math.ceil((sorted.length * 95) / 100) - 1]
      const avg = stat.durations.reduce((a, b) => a + b, 0) / stat.durations.length
      return {
        service,
        operation,
        avgMs: Math.round(avg),
        p95Ms: p95,
        errorRate: stat.durations.length > 0 ? (stat.errors / stat.durations.length) : 0,
        count: stat.durations.length,
      }
    })
    .sort((a, b) => b.p95Ms - a.p95Ms)
    .slice(0, limit)

  return result
}

/**
 * Get service dependency graph (which services call which).
 */
export function getServiceDependencies(): Array<{
  service: string
  downstreamServices: string[]
  totalCalls: number
}> {
  const result = Array.from(serviceGraph.entries()).map(([service, downstream]) => ({
    service,
    downstreamServices: Array.from(downstream),
    totalCalls: spanBuffer.filter((s) => s.serviceName === service).length,
  }))

  return result.sort((a, b) => b.totalCalls - a.totalCalls)
}

/**
 * Get bottleneck analysis: identify the longest-running operations in request paths.
 */
export function identifyBottlenecks(limit = 5): Array<{
  spanName: string
  avgDurationMs: number
  impactScore: number
  recommendation: string
}> {
  const bottlenecks = Array.from(spanStats.entries())
    .map(([spanName, stats]) => {
      const relevantSpans = spanBuffer.filter((s) => s.spanName === spanName)
      const avgDuration = relevantSpans.reduce((sum, s) => sum + s.durationMs, 0) / relevantSpans.length
      const impactScore = avgDuration * relevantSpans.length // duration × frequency

      let recommendation = ''
      if (spanName.startsWith('db.')) {
        recommendation = 'Consider adding indexes or optimizing query'
      } else if (spanName.startsWith('external.')) {
        recommendation = 'Consider caching or implementing circuit breaker'
      } else if (spanName.startsWith('cache.')) {
        recommendation = 'Increase cache TTL or pre-warm cache'
      }

      return { spanName, avgDurationMs: Math.round(avgDuration), impactScore, recommendation }
    })
    .sort((a, b) => b.impactScore - a.impactScore)
    .slice(0, limit)

  return bottlenecks
}

/**
 * Clear span buffer and statistics (call periodically).
 */
export function resetSpanAnalytics(): void {
  spanBuffer.length = 0
  spanStats.clear()
  serviceGraph.clear()
}

/**
 * Get overall analytics summary.
 */
export function getAnalyticsSummary() {
  const requestSpans = spanBuffer.filter((s) => s.spanName.startsWith('http.request'))
  const dbSpans = spanBuffer.filter((s) => s.spanName.startsWith('db.'))
  const externalSpans = spanBuffer.filter((s) => s.spanName.startsWith('external.'))

  const avgRequestDuration = requestSpans.length > 0
    ? Math.round(requestSpans.reduce((sum, s) => sum + s.durationMs, 0) / requestSpans.length)
    : 0

  const errorCount = spanBuffer.filter((s) => s.status === 'error').length

  return {
    totalSpans: spanBuffer.length,
    requestSpans: requestSpans.length,
    databaseOperations: dbSpans.length,
    externalServiceCalls: externalSpans.length,
    averageRequestDurationMs: avgRequestDuration,
    errorCount,
    errorRate: spanBuffer.length > 0 ? (errorCount / spanBuffer.length) : 0,
    uniqueServices: serviceGraph.size,
  }
}
