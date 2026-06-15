// Pure-logic tests for the dependency-free Prometheus metrics registry: counters,
// the latency histogram (cumulative buckets + sum/count), in-flight gauge, label
// escaping, and exposition-format shape.

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  incRequest, observeDuration, incInFlight, decInFlight, resetMetrics, renderMetrics,
} from '../apps/api/src/lib/metrics.ts'

beforeEach(() => resetMetrics())

test('incRequest accumulates per method/route/status', () => {
  incRequest('GET', '/api/leads', 200)
  incRequest('GET', '/api/leads', 200)
  incRequest('GET', '/api/leads', 500)
  const out = renderMetrics()
  assert.match(out, /http_requests_total\{method="GET",route="\/api\/leads",status="200"\} 2/)
  assert.match(out, /http_requests_total\{method="GET",route="\/api\/leads",status="500"\} 1/)
})

test('histogram emits cumulative le buckets plus sum and count', () => {
  observeDuration('GET', '/api/x', 0.02)  // <= 0.025, 0.05, ...
  observeDuration('GET', '/api/x', 0.4)   // <= 0.5, 1, ...
  const out = renderMetrics()
  // 0.02 falls in the 0.025 bucket; only 1 observation <= 0.025
  assert.match(out, /_bucket\{method="GET",route="\/api\/x",le="0.025"\} 1/)
  // both observations <= 0.5
  assert.match(out, /_bucket\{method="GET",route="\/api\/x",le="0.5"\} 2/)
  // +Inf bucket = total count
  assert.match(out, /_bucket\{method="GET",route="\/api\/x",le="\+Inf"\} 2/)
  assert.match(out, /http_request_duration_seconds_count\{method="GET",route="\/api\/x"\} 2/)
  assert.match(out, /http_request_duration_seconds_sum\{method="GET",route="\/api\/x"\} 0\.42/)
})

test('buckets are monotonically non-decreasing (cumulative)', () => {
  observeDuration('POST', '/api/y', 0.003)
  const out = renderMetrics()
  // 0.003 <= every bucket, so each le bucket should read 1
  assert.match(out, /le="0.005"\} 1/)
  assert.match(out, /le="10"\} 1/)
})

test('in-flight gauge tracks increments and never goes negative', () => {
  incInFlight(); incInFlight()
  assert.match(renderMetrics(), /http_requests_in_flight 2/)
  decInFlight(); decInFlight(); decInFlight() // extra dec is clamped at 0
  assert.match(renderMetrics(), /http_requests_in_flight 0/)
})

test('label values are escaped', () => {
  incRequest('GET', '/api/"weird"\\path', 200)
  const out = renderMetrics()
  assert.match(out, /route="\/api\/\\"weird\\"\\\\path"/)
})

test('exposition includes HELP/TYPE headers and process gauges', () => {
  const out = renderMetrics()
  assert.match(out, /# TYPE http_requests_total counter/)
  assert.match(out, /# TYPE http_request_duration_seconds histogram/)
  assert.match(out, /# TYPE http_requests_in_flight gauge/)
  assert.match(out, /process_resident_memory_bytes \d+/)
  assert.match(out, /nodejs_process_uptime_seconds /)
})
