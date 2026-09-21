// Distributed tracing across the API -> queue -> worker journey. A span is
// created where a route enqueues a BullMQ job (`withEnqueueSpan`, called from
// queues.ts) and its context is injected into the job payload as a single
// `traceparent` string (see queueSchemas.ts's envelope); the worker extracts it
// and continues the SAME trace as a child span (`withConsumerSpan`, called from
// worker.ts) — so a tracing backend shows one trace per request from the API
// call through the queue to the job that processed it, instead of requiring an
// operator to manually correlate three separate log streams.
//
// This COMPLEMENTS, not replaces, the existing requestId-based log correlation
// (queueSchemas.ts's `requestId` meta field, threaded into every worker log()
// call): both are stamped onto every span as an attribute, so an operator can
// jump from a log line to a trace and back.
//
// Built on the real OpenTelemetry API, but with manual spans only — no
// auto-instrumentation package. That mirrors why this app hand-rolls its own
// Prometheus metrics (metrics.ts) and its own minimal Sentry HTTP transport
// (errorReporting.ts) instead of pulling `@sentry/node` — see errorReporting.ts's
// comment: a heavy instrumentation tree sits in dependency-review for a
// capability most deployments only turn on in production. Spans are created by
// hand at exactly the two points that matter (enqueue, process), so
// `@opentelemetry/sdk-node`'s auto-instrumentation meta-package (which pulls in
// per-library instrumentation for express/pg/redis/…) buys nothing here.
//
// Exporter is gated exactly like Sentry's SENTRY_DSN: unset by default, in
// which case every span below is a genuine no-op (the OpenTelemetry API's
// global tracer provider is a no-op until one is registered) so this never
// changes behavior in dev/CI. Set OTEL_EXPORTER_OTLP_ENDPOINT to export real
// spans via OTLP/HTTP; set OTEL_CONSOLE_EXPORTER=true (local debugging only,
// never set in production) to print spans to stdout instead.
import {
  trace,
  propagation,
  context as otContext,
  SpanKind,
  SpanStatusCode,
  type Span,
} from '@opentelemetry/api'
import { W3CTraceContextPropagator } from '@opentelemetry/core'
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  SimpleSpanProcessor,
  ConsoleSpanExporter,
} from '@opentelemetry/sdk-trace-base'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions'

const TRACER_NAME = 'acaos'

let initialized = false

/** Idempotent. Call once at process startup (see server.ts / worker.ts). */
export function initTracing(serviceName: string): void {
  if (initialized) return
  initialized = true

  // Register the propagator unconditionally: it's what lets withEnqueueSpan
  // serialize a traceparent even when no exporter is configured, so a
  // context-carrying job payload behaves identically whether or not this
  // particular deployment happens to have an OTel backend attached.
  propagation.setGlobalPropagator(new W3CTraceContextPropagator())

  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim()
  const useConsole = !endpoint && String(process.env.OTEL_CONSOLE_EXPORTER).toLowerCase() === 'true'
  if (!endpoint && !useConsole) return // no-op: spans are created but never exported

  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName }),
    spanProcessors: [
      endpoint
        ? new BatchSpanProcessor(new OTLPTraceExporter({ url: `${endpoint.replace(/\/+$/, '')}/v1/traces` }))
        : new SimpleSpanProcessor(new ConsoleSpanExporter()),
    ],
  })
  trace.setGlobalTracerProvider(provider)
}

/** Test-only: allow re-running initTracing in a fresh state. */
export function _resetTracingForTest(): void {
  initialized = false
  trace.disable()
  propagation.disable()
}

function tracer() {
  return trace.getTracer(TRACER_NAME)
}

type AttrValue = string | number | boolean | undefined
function compact(attrs: Record<string, AttrValue>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {}
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined) out[k] = v
  return out
}

function finish(span: Span, err: unknown): void {
  if (err !== undefined) {
    span.recordException(err as Error)
    span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error)?.message })
  } else {
    span.setStatus({ code: SpanStatusCode.OK })
  }
  span.end()
}

/**
 * Wraps a BullMQ enqueue call in a PRODUCER span and hands the caller the W3C
 * `traceparent` string for that span so it can be stamped onto the job
 * payload. `fn` receives the traceparent and must return the enqueued Job (or
 * whatever the caller wants to return) — the span records failure/success
 * from whether `fn` throws.
 */
export async function withEnqueueSpan<T>(
  queueName: string,
  jobName: string,
  attributes: Record<string, AttrValue>,
  fn: (traceparent: string | undefined) => Promise<T>,
): Promise<T> {
  const span = tracer().startSpan(`queue.enqueue ${queueName}`, {
    kind: SpanKind.PRODUCER,
    attributes: compact({
      'messaging.system': 'bullmq',
      'messaging.destination.name': queueName,
      'messaging.operation': 'publish',
      'messaging.bullmq.job_name': jobName,
      ...attributes,
    }),
  })
  const carrier: Record<string, string> = {}
  propagation.inject(trace.setSpan(otContext.active(), span), carrier)
  try {
    const result = await fn(carrier.traceparent)
    finish(span, undefined)
    return result
  } catch (err) {
    finish(span, err)
    throw err
  }
}

/**
 * Wraps a BullMQ job processor in a CONSUMER span that is a child of the
 * enqueueing span when `traceparent` is present (extracted from the job
 * payload); with no traceparent (a worker-internal job — the daily retention
 * sweep, the periodic follow-up scan, …) this starts a fresh root span instead
 * of failing, so every job is traced even when there's no API request to
 * attach to.
 */
export async function withConsumerSpan<T>(
  queueName: string,
  jobName: string,
  traceparent: string | undefined,
  attributes: Record<string, AttrValue>,
  fn: () => Promise<T>,
): Promise<T> {
  const parentContext = propagation.extract(otContext.active(), traceparent ? { traceparent } : {})
  const span = tracer().startSpan(
    `queue.process ${queueName}`,
    {
      kind: SpanKind.CONSUMER,
      attributes: compact({
        'messaging.system': 'bullmq',
        'messaging.destination.name': queueName,
        'messaging.operation': 'process',
        'messaging.bullmq.job_name': jobName,
        ...attributes,
      }),
    },
    parentContext,
  )
  try {
    const result = await fn()
    finish(span, undefined)
    return result
  } catch (err) {
    finish(span, err)
    throw err
  }
}
