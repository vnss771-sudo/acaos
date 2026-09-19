# Phase 4.1 Load Testing Guide

Load testing for multi-tenant performance hardening. Tests verify that ACAOS can sustain concurrent load while maintaining workspace isolation and enforcing rate limits.

## Quick Start

```bash
# Start the API server in one terminal
npm run dev

# In another terminal, run the load test
DB_POOL_SIZE=20 WORKSPACE_MAIL_RATE_MAX=100 node scripts/load-test.ts
```

## Configuration

Set these environment variables to customize the load test:

| Variable | Default | Description |
|----------|---------|-------------|
| `API_BASE` | `http://localhost:4000` | API server base URL |
| `LOAD_TEST_DURATION` | `30` | Duration in seconds |
| `CONCURRENT_USERS` | `10` | Number of concurrent simulated users |
| `WORKSPACES` | `5` | Number of workspaces to distribute load across |
| `TEST_TOKEN` | none | Bearer token for auth (required) |
| `ENDPOINT` | `/api/lead-scoring/score` | Endpoint to load test |
| `CONCURRENT_USERS` | `10` | Number of concurrent users |

## Example: Test Mail Rate Limiting

```bash
# 20 concurrent users, 5 workspaces, hammering the send-test endpoint
# with a pool size of 30 connections
DB_POOL_SIZE=30 \
WORKSPACE_MAIL_RATE_MAX=100 \
CONCURRENT_USERS=20 \
WORKSPACES=5 \
ENDPOINT=/api/mailbox/send-test \
TEST_TOKEN=your-valid-token \
node scripts/load-test.ts
```

## Example: Test AI Rate Limiting

```bash
# 15 concurrent users testing AI generation endpoints
# with a smaller pool to see contention
DB_POOL_SIZE=15 \
WORKSPACE_AI_RATE_MAX=500 \
CONCURRENT_USERS=15 \
WORKSPACES=3 \
ENDPOINT=/api/ai/research \
TEST_TOKEN=your-valid-token \
node scripts/load-test.ts
```

## Interpreting Results

**Throughput**: requests per second at the API layer.

```
Throughput: 45 req/sec
```

- **Local dev**: 20-100 req/sec depending on hardware
- **Staging with real DB**: 50-200 req/sec
- **Production**: Scales with pool size and DB replica

**Response Times (ms)**: Latency distribution from request start to response received.

```
Response Times (ms):
  P50: 32 ms   — 50% of requests complete this fast
  P95: 180 ms  — 95% of requests complete within this time
  P99: 420 ms  — only 1% of requests are slower
```

- **P50 < 100ms**: Good local performance
- **P95 < 500ms**: Acceptable for user-facing endpoints
- **P99 < 1s**: Monitor for tail latency issues

**Rate Limit Hit Rate**: percentage of requests that hit 429 limits.

```
Rate Limit Hit Rate: 12.5%
```

- **0%**: Load below rate limit thresholds — increase `CONCURRENT_USERS`
- **5-10%**: Good — limits are preventing runaway load
- **> 20%**: Limit might be too aggressive or load unrealistic

## What to Monitor

### Connection Pool Health

Check logs for pool warnings during load:

```
{
  "level": "info",
  "msg": "database pool health",
  "pool": {
    "poolSize": 20,
    "activeConnections": 8,
    "idleConnections": 12,
    "utilization": 0.4
  }
}
```

- **Utilization > 0.9**: Pool is nearly full; increase `DB_POOL_SIZE`
- **Slow queries logged**: May indicate missing indexes or lock contention

### Rate Limit Enforcement

- Mail limit hits should increase as CONCURRENT_USERS grows
- Different workspaces (via `workspaceId`) should each have independent limits
- Per-IP limits should affect all users equally regardless of workspace

### Tail Latency

- P99 response time rising faster than P50 indicates queueing or connection starvation
- If P99 > 2s, check: CPU on the API pod, DB connection pool exhaustion, slow queries

## Troubleshooting

### "No rate limits hit — increase CONCURRENT_USERS"

The test ran without hitting any 429 limits. Try:
- Increasing `CONCURRENT_USERS` (20, 50, 100)
- Decreasing per-request delay in `load-test.ts` (currently 100-500ms)
- Reducing the test endpoint's latency (e.g., use `/api/health` for a fast endpoint)

### Errors increasing over time

Check API logs for:
- Connection pool exhaustion (`connection_limit exceeded`)
- Database overload (slow queries, lock timeouts)
- Auth failures (invalid `TEST_TOKEN`)

### Throughput not increasing with pool size

Indicates the bottleneck is not the database connection pool:
- May be network latency (API base URL)
- May be API handler CPU (expensive calculations)
- May be external service calls (OpenAI, SMTP) blocking requests

## Next Steps: Sustained Load Testing

For longer, more realistic load tests:
1. Use a staging environment with production-like DB size
2. Run for 5-10 minutes to detect memory leaks or connection leaks
3. Monitor the API pod's memory, CPU, and GC pauses
4. Plot throughput and P95/P99 latency over time

Example extended test:

```bash
LOAD_TEST_DURATION=300 \
CONCURRENT_USERS=50 \
WORKSPACES=10 \
DB_POOL_SIZE=50 \
node scripts/load-test.ts
```

## Database Pool Sizing

The rule of thumb for `DB_POOL_SIZE`:

```
DB_POOL_SIZE ≈ (CONCURRENT_USERS / 2) + 5
```

Example:
- 20 concurrent users → `DB_POOL_SIZE=15`
- 50 concurrent users → `DB_POOL_SIZE=30`
- 100 concurrent users → `DB_POOL_SIZE=55`

Too small and requests queue on the pool; too large and the database becomes a bottleneck.

## Phase 4.1 Rate Limits

Current defaults (tunable via env vars):

| Limit | Window | Default | Env Var |
|-------|--------|---------|---------|
| Mail per workspace | 1 minute | 100 emails | `WORKSPACE_MAIL_RATE_MAX` |
| AI per workspace | 1 hour | 500 calls | `WORKSPACE_AI_RATE_MAX` |
| General per IP | 1 minute | 200 requests | (in middleware/rateLimit.ts) |
| Auth per IP | 15 min | 10 attempts | (in middleware/rateLimit.ts) |

The monthly quota (in PLAN_LIMITS) is the billing-relevant ceiling; these hourly/minute windows are burst limiters.
