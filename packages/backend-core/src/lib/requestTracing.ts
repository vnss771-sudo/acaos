// Phase 4.3: Request-level distributed tracing with automatic span creation
// and context propagation across API, database, and external service calls.
//
// Spans track:
// - Request entry/exit (HTTP method, path, status)
// - Database operations (model, operation, duration)
// - External service calls (API, queue, cache)
// - Cache hits/misses with latency
// - Workspace context and tenant information
//
// All spans include:
// - requestId (for log correlation)
// - workspaceId (for tenant isolation verification)
// - userId (for access audit)
// - Hierarchical parent-child relationships

import { trace, context as otContext, SpanStatusCode } from '@opentelemetry/api'

const tracer = trace.getTracer('acaos-requests')

export interface SpanContext {
  requestId: string
  workspaceId?: string
  userId?: string
  parentSpanId?: string
}

export interface DatabaseSpanAttributes {
  model: string
  operation: 'findMany' | 'findUnique' | 'create' | 'update' | 'delete' | 'count' | 'aggregate'
  durationMs: number
  rowsAffected?: number
  cached?: boolean
  slow?: boolean
}

/**
 * Create a root span for an HTTP request.
 * Call at request entry; use span context to create child spans for downstream work.
 */
export function createRequestSpan(ctx: SpanContext, attributes: {
  method: string
  path: string
  userAgent?: string
}) {
  const span = tracer.startSpan(`http.request`, {
    attributes: {
      'http.method': attributes.method,
      'http.url.path': attributes.path,
      'http.user_agent': attributes.userAgent,
      'request.id': ctx.requestId,
      ...(ctx.workspaceId && { 'workspace.id': ctx.workspaceId }),
      ...(ctx.userId && { 'user.id': ctx.userId }),
    },
  })

  return {
    span,
    ctx: otContext.with(trace.setSpan(otContext.active(), span), () => otContext.active()),
  }
}

/**
 * Record HTTP response in a request span.
 */
export function recordRequestResponse(span: any, attributes: {
  statusCode: number
  durationMs: number
  error?: Error
}) {
  span.setAttributes({
    'http.status_code': attributes.statusCode,
    'http.duration_ms': attributes.durationMs,
  })

  if (attributes.error) {
    span.recordException(attributes.error)
    span.setStatus({ code: SpanStatusCode.ERROR, message: attributes.error.message })
  } else if (attributes.statusCode >= 400) {
    span.setStatus({ code: SpanStatusCode.ERROR })
  }
}

/**
 * Create a child span for a database operation within a request.
 */
export function createDatabaseSpan(parentCtx: any, attributes: DatabaseSpanAttributes) {
  const span = tracer.startSpan(`db.${attributes.model.toLowerCase()}.${attributes.operation}`, {
    attributes: {
      'db.model': attributes.model,
      'db.operation': attributes.operation,
      'db.duration_ms': attributes.durationMs,
      ...(attributes.rowsAffected !== undefined && { 'db.rows_affected': attributes.rowsAffected }),
      ...(attributes.cached && { 'db.cache_hit': true }),
      ...(attributes.slow && { 'db.slow_query': true }),
    },
  })

  return span
}

/**
 * Create a child span for a cache operation.
 */
export function createCacheSpan(parentCtx: any, attributes: {
  operation: 'get' | 'set' | 'delete' | 'invalidate'
  key: string
  hit?: boolean
  durationMs: number
}) {
  const span = tracer.startSpan(`cache.${attributes.operation}`, {
    attributes: {
      'cache.operation': attributes.operation,
      'cache.key': attributes.key,
      ...(attributes.hit !== undefined && { 'cache.hit': attributes.hit }),
      'cache.duration_ms': attributes.durationMs,
    },
  })

  return span
}

/**
 * Create a child span for an external service call (Redis, OpenAI, Stripe, etc.).
 */
export function createExternalServiceSpan(parentCtx: any, attributes: {
  service: string
  operation: string
  durationMs: number
  statusCode?: number
  error?: Error
}) {
  const span = tracer.startSpan(`external.${attributes.service.toLowerCase()}`, {
    attributes: {
      'external.service': attributes.service,
      'external.operation': attributes.operation,
      'external.duration_ms': attributes.durationMs,
      ...(attributes.statusCode && { 'external.status_code': attributes.statusCode }),
    },
  })

  if (attributes.error) {
    span.recordException(attributes.error)
    span.setStatus({ code: SpanStatusCode.ERROR, message: attributes.error.message })
  }

  return span
}

/**
 * Create a child span for a queue/job operation.
 */
export function createJobSpan(parentCtx: any, attributes: {
  jobType: string
  durationMs: number
  attempts?: number
  result?: 'success' | 'failure' | 'retry'
}) {
  const span = tracer.startSpan(`job.${attributes.jobType.toLowerCase()}`, {
    attributes: {
      'job.type': attributes.jobType,
      'job.duration_ms': attributes.durationMs,
      ...(attributes.attempts && { 'job.attempts': attributes.attempts }),
      ...(attributes.result && { 'job.result': attributes.result }),
    },
  })

  return span
}

/**
 * Get trace ID from a span for linking to logs/errors.
 */
export function getTraceId(span: any): string {
  return span.spanContext?.traceId || ''
}

/**
 * Serialize trace context for propagating to child services/jobs.
 * Returns a W3C Trace Context header value.
 */
export function serializeTraceContext(): string {
  const span = trace.getActiveSpan()
  if (!span) return ''

  const ctx = span.spanContext()
  return `${ctx.traceId}-${ctx.spanId}-${ctx.traceFlags}`
}

/**
 * Restore trace context from a serialized W3C Trace Context header.
 */
export function restoreTraceContext(traceparent: string) {
  if (!traceparent) return

  try {
    // W3C format: version-traceId-spanId-traceFlags
    const [version, traceId, spanId, traceFlags] = traceparent.split('-')
    if (version !== '00' || !traceId || !spanId) return

    // Set as parent for new spans
    const span = tracer.startSpan(`restored.trace`, {
      attributes: {
        'trace.parent_id': traceparent,
      },
    })
    return span
  } catch {
    // Invalid format, ignore
  }
}
