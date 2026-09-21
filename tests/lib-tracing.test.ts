// Unit tests for the enqueue/consumer span wrapper (lib/tracing.ts) — the pure
// logic underpinning API -> queue -> worker trace continuation. Verified with a
// deterministic in-memory exporter (no live OTel collector needed); a separate
// manual smoke test (see the PR/commit description) additionally confirmed real
// spans printed via ConsoleSpanExporter and a real OTLP-shaped traceparent.
import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { trace, propagation, SpanKind, SpanStatusCode } from '@opentelemetry/api'
import { W3CTraceContextPropagator } from '@opentelemetry/core'
import { BasicTracerProvider, SimpleSpanProcessor, InMemorySpanExporter } from '@opentelemetry/sdk-trace-base'
import {
  withEnqueueSpan,
  withConsumerSpan,
  initTracing,
  _resetTracingForTest,
} from '../packages/backend-core/src/lib/tracing.ts'

// Mirrors what initTracing() itself wires up (propagator + provider), but with
// an InMemorySpanExporter so spans can be asserted on deterministically instead
// of only eyeballed via ConsoleSpanExporter.
function installTestProvider() {
  const exporter = new InMemorySpanExporter()
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })
  trace.setGlobalTracerProvider(provider)
  propagation.setGlobalPropagator(new W3CTraceContextPropagator())
  return exporter
}

afterEach(() => {
  _resetTracingForTest()
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  delete process.env.OTEL_CONSOLE_EXPORTER
})

test('with no provider registered (the default), spans are no-ops and no traceparent is produced', async () => {
  const traceparent = await withEnqueueSpan('research-lead', 'research-lead', {}, async (tp) => tp)
  assert.equal(traceparent, undefined)
})

test('initTracing is a no-op with neither OTEL_EXPORTER_OTLP_ENDPOINT nor OTEL_CONSOLE_EXPORTER set', async () => {
  initTracing('acaos-test')
  const traceparent = await withEnqueueSpan('research-lead', 'research-lead', {}, async (tp) => tp)
  assert.equal(traceparent, undefined)
})

test('withEnqueueSpan injects a well-formed W3C traceparent once a tracer provider is registered', async () => {
  const exporter = installTestProvider()
  const traceparent = await withEnqueueSpan(
    'send-campaign',
    'send-campaign',
    { 'acaos.request_id': 'req_1', 'acaos.workspace_id': 'ws_1' },
    async (tp) => tp,
  )
  assert.match(traceparent!, /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/)

  const spans = exporter.getFinishedSpans()
  assert.equal(spans.length, 1)
  const span = spans[0]
  assert.equal(span.name, 'queue.enqueue send-campaign')
  assert.equal(span.kind, SpanKind.PRODUCER)
  assert.equal(span.attributes['messaging.system'], 'bullmq')
  assert.equal(span.attributes['messaging.destination.name'], 'send-campaign')
  assert.equal(span.attributes['acaos.request_id'], 'req_1')
  assert.equal(span.attributes['acaos.workspace_id'], 'ws_1')
  assert.equal(span.status.code, SpanStatusCode.OK)
})

test('withConsumerSpan continues the SAME trace when given the enqueue span\'s traceparent', async () => {
  const exporter = installTestProvider()
  const traceparent = await withEnqueueSpan('send-campaign', 'send-campaign', {}, async (tp) => tp)
  const enqueueSpan = exporter.getFinishedSpans()[0]

  const result = await withConsumerSpan('send-campaign', 'send-campaign', traceparent, { 'acaos.request_id': 'req_2' }, async () => 'done')
  assert.equal(result, 'done')

  const spans = exporter.getFinishedSpans()
  assert.equal(spans.length, 2)
  const consumerSpan = spans[1]
  assert.equal(consumerSpan.name, 'queue.process send-campaign')
  assert.equal(consumerSpan.kind, SpanKind.CONSUMER)
  // Same trace id as the producer span — this is what makes it ONE trace across
  // the API -> queue -> worker boundary, not two unrelated traces.
  assert.equal(consumerSpan.spanContext().traceId, enqueueSpan.spanContext().traceId)
  // A genuine parent/child link, not just a coincidentally-equal trace id.
  assert.equal(consumerSpan.parentSpanContext?.spanId, enqueueSpan.spanContext().spanId)
  assert.equal(consumerSpan.parentSpanContext?.isRemote, true)
})

test('withConsumerSpan starts a fresh root span when there is no traceparent (worker-internal jobs)', async () => {
  const exporter = installTestProvider()
  await withConsumerSpan('retention-purge', 'retention-purge', undefined, {}, async () => undefined)
  const span = exporter.getFinishedSpans()[0]
  assert.equal(span.parentSpanContext, undefined)
  assert.ok(trace.isSpanContextValid(span.spanContext()))
})

test('withEnqueueSpan records the exception and rethrows on failure', async () => {
  const exporter = installTestProvider()
  const boom = new Error('redis unavailable')
  await assert.rejects(
    withEnqueueSpan('send-campaign', 'send-campaign', {}, async () => { throw boom }),
    boom,
  )
  const span = exporter.getFinishedSpans()[0]
  assert.equal(span.status.code, SpanStatusCode.ERROR)
  assert.equal(span.status.message, 'redis unavailable')
  assert.equal(span.events.length, 1)
  assert.equal(span.events[0].name, 'exception')
})

test('withConsumerSpan records the exception and rethrows on failure', async () => {
  const exporter = installTestProvider()
  const boom = new Error('job processor threw')
  await assert.rejects(
    withConsumerSpan('send-campaign', 'send-campaign', undefined, {}, async () => { throw boom }),
    boom,
  )
  const span = exporter.getFinishedSpans()[0]
  assert.equal(span.status.code, SpanStatusCode.ERROR)
})

test('undefined attribute values are dropped, not sent as literal "undefined"', async () => {
  const exporter = installTestProvider()
  await withEnqueueSpan('research-lead', 'research-lead', { 'acaos.request_id': undefined, 'acaos.workspace_id': 'ws_1' }, async () => undefined)
  const span = exporter.getFinishedSpans()[0]
  assert.equal('acaos.request_id' in span.attributes, false)
  assert.equal(span.attributes['acaos.workspace_id'], 'ws_1')
})

test('initTracing is idempotent — a second call is a harmless no-op', () => {
  process.env.OTEL_CONSOLE_EXPORTER = 'true'
  assert.doesNotThrow(() => {
    initTracing('acaos-test')
    initTracing('acaos-test')
  })
})
