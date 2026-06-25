# Design: Bi-directional CRM sync (HubSpot + Salesforce) — Phase 3.2

**Status:** Design / ready-to-execute (blocked only on third-party API credentials + sandboxes)
**Council finding:** Product #2 (P0) — the #1 switching-cost and enterprise-deal blocker. Without it ACAOS is a silo; reps won't trust pipeline that doesn't flow to the system of record. It also feeds closed-won outcomes back into the learning loop, compounding the moat.

This document is the executable design so the build can start the moment credentials are available. It deliberately builds on the **webhook/event infrastructure already shipped** (`packages/backend-core/src/lib/webhooks.ts`, the `AnalyticsEvent`/`ContactEvent` ledgers, and the `OutreachIntent`/`ProspectOutcome` models).

## 1. Goals & non-goals

**Goals**
- **Outbound** (ACAOS → CRM): push contacts, activities (sends/replies/meetings), and won/lost outcomes to the customer's CRM so the rep's system of record stays current.
- **Inbound** (CRM → ACAOS): import contacts/companies as prospects/leads, and pull closed-won/lost so the learning loop trains on real revenue outcomes.
- Per-workspace connection, OAuth-based, revocable; no shared platform credentials.

**Non-goals (v1)**
- Real-time field-level bi-directional conflict resolution (start with last-writer-wins + a sync log).
- Arbitrary custom-object mapping (ship a fixed Contact/Company/Activity/Deal mapping; make it configurable later).

## 2. Provider abstraction

Mirror the existing `providerClient.ts` seam (circuit breaker + typed errors + bounded timeout) so HubSpot and Salesforce are interchangeable:

```ts
interface CrmProvider {
  readonly kind: 'hubspot' | 'salesforce'
  upsertContact(conn, contact): Promise<CrmRef>
  logActivity(conn, ref, activity): Promise<void>     // email sent / reply / meeting
  upsertDeal(conn, ref, deal): Promise<CrmRef>          // pipeline + won/lost + value
  fetchUpdatedContacts(conn, since): Promise<CrmContact[]>
  fetchClosedDeals(conn, since): Promise<CrmDeal[]>
}
```

Each method goes through a per-provider circuit breaker (add `hubspotBreaker` / `salesforceBreaker` to `circuit.ts`) and the SSRF-safe fetch is unnecessary (fixed provider hosts) but the bounded-timeout `fetchWithTimeout` applies.

## 3. Data model (additive migrations)

```prisma
model CrmConnection {
  id            String   @id @default(cuid())
  workspaceId   String   @unique          // one connection per workspace per provider (v1: one provider)
  provider      String                    // 'hubspot' | 'salesforce'
  accessToken   String                    // ENCRYPTED at rest (encrypt.ts keyring — same as SMTP creds)
  refreshToken  String?                   // ENCRYPTED
  expiresAt     DateTime?
  portalId      String?                   // provider account id
  enabled       Boolean  @default(true)
  lastSyncAt    DateTime?
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
}

model CrmSyncMapping {                     // idempotency + dedup: ACAOS entity ↔ CRM ref
  id           String   @id @default(cuid())
  workspaceId  String
  entityType   String                     // 'lead' | 'prospect' | 'deal'
  entityId     String
  provider     String
  crmObjectId  String
  lastPushedAt DateTime?
  @@unique([workspaceId, provider, entityType, entityId])
  @@index([workspaceId, provider, crmObjectId])
}

model CrmSyncLog {                         // observability + conflict audit
  id          String   @id @default(cuid())
  workspaceId String
  direction   String                      // 'outbound' | 'inbound'
  entityType  String
  status      String                      // 'ok' | 'error' | 'skipped'
  detail      Json?
  occurredAt  DateTime @default(now())
  @@index([workspaceId, occurredAt])
}
```
Tokens reuse `encrypt.ts` (AES-256-GCM keyring) exactly as SMTP/IMAP secrets do today. All three models carry `workspaceId` → add to `TENANT_MODELS`.

## 4. Sync flows

**Outbound — event-driven (reuses the webhook emitter pattern).** The same emit sites that fire webhooks (`reply.received`, `campaign.sent`, `meeting.booked`) enqueue a `crm-sync` job:
1. `campaign.sent` / SENT → `logActivity` (email sent).
2. `reply.received` → `logActivity` (reply) + `upsertContact` if not yet mapped.
3. `meeting.booked` → `upsertDeal` (stage = meeting booked).
4. Lead/Prospect → `CLOSED`/`WON` (with `ProspectOutcome.dealValue`) → `upsertDeal` won + value.

Each job is idempotent via `CrmSyncMapping` (upsert-by-mapping; never create a duplicate CRM object). Failures retry with the BullMQ backoff already used by other queues; persistent failures land in `CrmSyncLog` + an alert.

**Inbound — scheduled pull (a new repeatable worker job, mirroring auto-IMAP sync).** Every N minutes, per enabled connection:
1. `fetchUpdatedContacts(since=lastSyncAt)` → upsert as prospects/leads (dedupe by `emailKey`, the existing normalization).
2. `fetchClosedDeals(since)` → write `ProspectOutcome` (WON/LOST + value) → **this is the learning-loop input** (`learningLoop.ts` already trains on WON characteristics).
3. Advance `lastSyncAt`.

## 5. Security & compliance

- OAuth tokens **encrypted at rest** (`encrypt.ts`), never logged, never returned by any API (mirrors SMTP creds + the webhook-secret masking shipped alongside this doc).
- Connection management gated by `workspace:update` (admin/owner), like webhooks.
- Disconnect = revoke + delete tokens + stop the scheduled job (mirror the MFA-disable token-revocation pattern).
- Inbound data is third-party → flows through the same prospect-import sanitization; CRM-sourced free-text entering AI prompts uses the existing `<prospect_data>` fence (shipped in Phase 0).
- Add HubSpot/Salesforce to `docs/legal/subprocessors.md` (the disclosure surface already exists).

## 6. Rollout

1. **Read-only inbound first** (lowest blast radius): import contacts + closed deals; verify the learning-loop signal before writing anything back.
2. **Outbound activities** (idempotent, low-risk: just logging emails/replies).
3. **Outbound deals** (highest-trust: creates pipeline in the customer's CRM) behind a per-connection `writeDeals` flag, default off.
4. Feature-flag the whole surface (`FEATURE_CRM_SYNC`, mirroring the existing launch-control kill-switches) so it ships dormant and enables per-workspace.

## 7. Test strategy (how each layer is verified)

- **Provider clients:** contract tests against recorded fixtures (no live calls in CI), plus the circuit-breaker/timeout behavior reused from `providerClient` tests.
- **Mapping/idempotency:** DB tests proving a repeated outbound event upserts (never duplicates) the CRM object via `CrmSyncMapping`.
- **Inbound → learning loop:** DB test seeding a fetched closed-won deal and asserting a `ProspectOutcome` row + the resulting weight calibration.
- **Token security:** assert tokens are stored encrypted (same test shape as `auth-mfa`'s "secret stored encrypted, not plaintext").
- Live OAuth + real API calls verified in a **staging workspace against provider sandboxes** — the part that genuinely requires credentials.

## 8. Effort

~L (multi-week): provider abstraction + 2 implementations, OAuth flows, 3 models + migrations, outbound queue, inbound scheduler, mapping/idempotency, ~15 tests, legal/subprocessor updates. The **infrastructure it leans on already exists** (event emit sites, encryption keyring, circuit-breaker seam, learning loop, prospect-import sanitization), which is why this is scoped as an execution doc rather than a research spike.
