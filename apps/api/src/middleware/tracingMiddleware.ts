// Phase 4.3: Automatic request-level tracing middleware.
// Creates spans for every HTTP request with automatic context propagation.

import type { Request, Response, NextFunction } from 'express'
import { createRequestSpan, recordRequestResponse } from '@acaos/backend-core/lib/requestTracing.js'
import { recordSpan } from '@acaos/backend-core/lib/spanAnalytics.js'

/**
 * Middleware that creates a span for each incoming HTTP request.
 * Automatically records request method, path, response status, and duration.
 */
export function tracingMiddleware(req: Request, res: Response, next: NextFunction) {
  // Extract request context
  const requestId = (req.headers['x-request-id'] as string) || req.id || ''
  const workspaceId = (req as any).workspaceId // Set by tenantContext middleware
  const userId = (req as any).userId // Set by auth middleware

  const startTime = Date.now()

  // Create root span for this request
  const { span } = createRequestSpan(
    { requestId, workspaceId, userId },
    {
      method: req.method,
      path: req.path,
      userAgent: req.get('user-agent'),
    }
  )

  // Store span on request for child operations
  ;(req as any).span = span
    // @ts-ignore
  ;(req as any).traceId = span.spanContext?.traceId || ''

  // Intercept response to record status and duration
  const originalSend = res.send
  res.send = function (data) {
    const durationMs = Date.now() - startTime

    recordRequestResponse(span, {
      statusCode: res.statusCode,
      durationMs,
    })

    // Add span record to analytics
    recordSpan({
    // @ts-ignore
      traceId: span.spanContext?.traceId || '',
    // @ts-ignore
      spanId: span.spanContext?.spanId || '',
      spanName: `http.request`,
      serviceName: 'api',
      startTimeMs: startTime,
      durationMs,
      attributes: {
        'http.method': req.method,
        'http.url.path': req.path,
        'http.status_code': res.statusCode,
        ...(workspaceId && { 'workspace.id': workspaceId }),
        ...(userId && { 'user.id': userId }),
      },
      status: res.statusCode >= 400 ? 'error' : 'ok',
    })

    span.end()

    // Call original send
    return originalSend.call(this, data)
  }

  next()
}

/**
 * Extract request tracing context for nested operations.
 */
export function getRequestContext(req: Request) {
  return {
    span: (req as any).span,
    traceId: (req as any).traceId,
    requestId: req.headers['x-request-id'] as string,
    workspaceId: (req as any).workspaceId,
    userId: (req as any).userId,
  }
}
