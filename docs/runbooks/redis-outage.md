# Runbook: Redis / BullMQ outage

**Severity:** SEV2 (SEV1 if it also takes down API readiness in production).

Redis backs four things in ACAOS: the BullMQ job queues, the API rate limiter,
the shared circuit-breaker store (`attachBreakerStore` +
`createRedisBreakerStore`), and ad-hoc caching. The connection
(`getRedisConnection` in `packages/backend-core/src/lib/queues.ts`) uses
`maxRetriesPerRequest: null` and a capped `retryStrategy` (backoff to 10s), so it
reconnects automatically through a flap.

## Symptoms
- Worker `/ready` returns 503 (it requires `connection.status === 'ready'`).
- In production, API `/api/ready` returns 503 (Redis gates production readiness);
  `/api/ready/strict` 503 everywhere.
- `acaos_dependency_up{dependency="redis"} == 0`.
- `[redis] Connection error:` lines in logs; jobs stop draining
  (`bullmq_queue_jobs{state="waiting"}` rising, `active` flat).
- Rate limiting degrades to its in-process fallback; breakers fall back to
  per-process state (both fail-open by design).

## Impact
- No background work runs: outreach generation, **campaign sends**, mailbox sync,
  discovery, scoring all stall. Jobs are *queued*, not lost — they drain once
  Redis is back.
- API stays up for synchronous, non-queue routes (Redis degrades gracefully), but
  in production a Redis-down instance is pulled from rotation by `/api/ready`.

## Immediate mitigation
1. Confirm it's Redis, not the worker: curl worker `/ready` and API
   `/api/ready/strict`; check `acaos_dependency_up{dependency="redis"}`.
2. Restore Redis (restart/failover the managed instance, check memory/maxmemory
   eviction and connection limits). Both API and worker reconnect on their own —
   **no app restart needed.**
3. If readiness flapping is yanking healthy API instances out of rotation and the
   queue-backed flows can tolerate brief degradation, you can point the LB at
   `/api/ready` (Redis optional) instead of `/api/ready/strict` while you fix
   Redis. Revert afterward.

## Diagnosis steps
- `redis-cli -u $REDIS_URL PING` / `INFO server` / `INFO clients` (connected
  clients vs `maxclients`), `INFO memory` (evictions, `maxmemory`).
- Check for an OOM/eviction event — BullMQ keys evicted under `allkeys-lru` would
  drop jobs; ACAOS Redis should use `noeviction`.
- `getQueueStats()` (or the admin/jobs route) for per-queue `waiting/active`
  depth once connectivity returns.

## Rollback steps
- Redis state itself isn't a deploy artifact, so there's usually nothing to roll
  back. If a recent deploy changed `REDIS_URL`, eviction policy, or the
  connection options, revert that change.
- Do **not** flush Redis to "fix" it — that discards queued jobs (lost sends/
  syncs).

## Customer communication
- Internal status: "Background processing (email sending, inbox sync) is delayed;
  no data lost; catching up." Most customers won't notice a short outage.
- If sends were delayed > ~1h, notify affected workspace owners that queued
  outreach is being sent now (it will, automatically, once the queue drains).

## Prevention follow-up
- Alert on `acaos_dependency_up{dependency="redis"}` and on `waiting` depth
  rising while `active` is flat.
- Confirm managed Redis has HA/failover and `noeviction`.
- Verify breaker store + rate limiter fail-open paths in a game day (kill Redis,
  confirm API keeps serving non-queue routes).
</content>
