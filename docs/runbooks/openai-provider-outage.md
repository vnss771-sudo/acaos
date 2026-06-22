# Runbook: OpenAI provider outage

**Severity:** SEV2 (AI flows blocked) / SEV3 (degraded, breaker absorbing it).

OpenAI powers `research-lead`, `generate-outreach`, `analyze-reply`, and the
on-the-fly draft generation inside `send-campaign`. All OpenAI calls go through
the `openai` circuit breaker (`packages/backend-core/src/lib/circuit.ts`):
threshold 5 consecutive failures → OPEN for 30s → one HALF_OPEN probe. The
breaker state is shared across API and worker via Redis
(`attachBreakerStore`/`createRedisBreakerStore`), so when one process trips it,
siblings stop hammering too. AI queue jobs use `attempts:3` with a **35s
exponential backoff** — deliberately longer than the breaker's 30s reset so a
retry waits for the breaker to probe rather than burning all attempts while OPEN.

## Symptoms
- Burst of failures on `research-lead` / `generate-outreach` / `analyze-reply`
  (`worker_jobs_total{result="failed"}` for those queues).
- Logs: `circuit OPEN {circuit: "openai"}`, then `circuit probing` / `circuit
  recovered`; `CircuitOpenError: openai temporarily unavailable — circuit open`.
- `provider_calls_total{provider="openai",outcome="error"}` rising.
- `send-campaign` jobs complete but with `AI_GENERATION_FAILED` skips for leads
  needing fresh copy (already-approved/reused drafts still send fine).

## Impact
- New AI enrichment, outreach-copy generation, and reply classification pause.
- Sending continues for leads with an existing approved/reused draft; only leads
  that need **fresh** generation are skipped (`AI_GENERATION_FAILED`) and stay
  eligible for a later run — no bad data is persisted (strict fail-closed parse).
- AI usage counters are **refunded** on generation/parse failure
  (`refundAiUsage`), so customers aren't charged quota for failed calls.

## Immediate mitigation
1. Confirm it's OpenAI, not us: check status.openai.com and
   `provider_calls_total{provider="openai",outcome="error"}`.
2. Let the breaker + 35s backoff do their job — transient blips self-heal; queued
   jobs retry and drain once `circuit recovered` logs.
3. If the outage is sustained and the AI failures are noisy / wasting quota, set
   `FEATURE_AI=false` (env, no restart) to make the AI workers skip cleanly; the
   send worker will then skip leads needing generation as `AI_GENERATION_FAILED`
   rather than erroring. Re-enable when OpenAI recovers.
4. If only model availability changed, check/adjust `OPENAI_MODEL`
   (default `gpt-4o-mini`).

## Diagnosis steps
- Distinguish outage vs. our key/quota: 401/429 from OpenAI means
  `OPENAI_API_KEY` invalid or rate/quota limited, not a provider outage — fix the
  key/quota.
- Check that the breaker isn't stuck OPEN due to a non-OpenAI bug (e.g. our
  parse throwing) by reading the underlying error before `circuit OPEN`.

## Rollback steps
- Roll back any recent deploy that changed the OpenAI client, `OPENAI_MODEL`,
  prompt/schema (`aiSchemas`), or breaker thresholds.
- No data rollback needed — failed AI jobs persist nothing (fail-closed).

## Customer communication
- Usually none for a short blip. For a sustained outage: "AI drafting and reply
  insights are temporarily delayed; your existing approved drafts still send."

## Prevention follow-up
- Alert on `provider_calls_total{provider="openai",outcome="error"}` rate and on
  `openai` breaker OPEN duration.
- Monitor OpenAI quota/billing to avoid 429s masquerading as outages.
- Consider a fallback model via `OPENAI_MODEL` for degraded operation.
</content>
