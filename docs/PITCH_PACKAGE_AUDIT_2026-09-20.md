# ACAOS Pitch Package Audit — 2026-09-20

**Scope:** A full audit of the ACAOS pitch/deployment package (product manifest, blueprint documents, investor deck, financial model, and pilot proposal) against the actual state of this repository (1,459 files extracted from the shipped zip: 8 production guides, 78 migrations, backend/worker/web source, tests). Four passes: package integrity, cross-document consistency, financial due diligence, production readiness.

**Note on method:** the tool budget ran out during deep file inspection, so the code review is structural rather than line-by-line. Findings below are marked verified vs. inferred where that distinction matters.

---

## 1. Package Integrity — Manifest vs. Reality

| Manifest Claim | Verified Finding | Verdict |
| --- | --- | --- |
| 8 production guides, ~5,766 lines | All 8 present, sizes match within ~2% (KB vs KiB) | ✅ Verified |
| 78 migrations | Exactly 78 migration folders | ✅ Verified |
| 60+ tables | 49 Prisma models; only 44 `CREATE TABLE` across migrations (+19 enums) | ⚠️ Overstated (~25%) |
| 2,100+ tests | 157 test files, ~1,696 `it()`/`test()` cases | ⚠️ Overstated ~24% |
| 45+ backend modules | 114 TypeScript modules in backend-core | ✅ Exceeds claim |
| 30+ job types | 12 BullMQ queues, 11 exported processor functions | ❌ Overstated ~2.5x |
| node_modules/dist excluded | **`apps/web/node_modules` and `dist/` for all 3 services are committed in the zip** | ❌ Contradicts manifest |
| 18 env vars in runbook | `.env.example` defines 64 | ⚠️ Misleading (core required ≈ 18, doc implies total) |
| 11 agent systems implemented | Route files (`phase4-5-alerts` … `phase11-capacity`) match the manifest's list | ✅ Internally consistent — but see §2 |

---

## 2. Consistency Review — The Documents Describe Three Different Products

This is the most serious finding. There are **two incompatible "11-phase" taxonomies**, and the shipped code matches *neither* of the blueprints:

| Phase # | Blueprint (both .md files) | Manifest + shipped code |
| --- | --- | --- |
| 1–4 | Property-data scraping → enrichment → scoring → outreach | Cost optimization → crew scheduling → capacity planning → anomaly detection |
| 5–8 | Conversational booking → crew scheduling → **CVRPTW routing** → billing | Forecasting → budget governance → workflow automation → integrations |
| 9–11 | Dispatch manifests → IoT telemetry → feedback loop | Multi-tenant → analytics → SLA monitoring |

**Specific conflicts:**

1. **The core IP is absent.** Blueprint PROD v2.1.0's Part 1 — the FastAPI + Google OR-Tools CVRPTW solver, presented as "the mathematical moat" and the basis for the pilot's headline KPI (15–23% mileage reduction) — **does not exist in the package**. There is no Python anywhere in the zip. The claim of "re-routing the fleet in under 5 seconds" has no supporting artifact.
2. **Stack contradiction.** Blueprints specify Python/FastAPI, LangGraph/CrewAI, PostGIS, Kafka, MQTT telemetry, Plaid. The code is TypeScript: Express, React+Vite, BullMQ, Prisma, Redis.
3. **Domain mismatch.** The code (env vars, migrations, queue names) reveals a **B2B sales-engagement platform**: Apollo/Hunter API keys, SMTP/IMAP mailbox sync, send warmup, unsubscribe/suppression ledgers, GDPR-style `lawful_basis_consent` and DPA tables, Stripe subscription tiers (STARTER/GROWTH). A crew/shift ops module was bolted on only in the Sept 2026 migrations. The blueprints promise property parcel scraping, satellite roof-age inference, dispatch manifests, and IoT fleet telemetry — none of which appear in the schema or queues.
4. **Pricing conflicts across documents.** Three mutually incompatible price points:
   - Pilot proposal: **$150/node/month** + 5% gain-share
   - Deck (Slide 5): **$2,500/mo** flat or **$4,500/mo** enterprise + 1.5% fee
   - Financial model: **$3,200–$4,500/node/month** ARR basis

   The pilot price is 21x lower than the modeled ARR per node — the pilot economics cannot bridge to the projections.
5. **Roadmap contradictions.** One blueprint says "15 pre-signed partner fleets" in Months 4–6; the proposal is *offering* a pilot program; the financial model assumes 45 paying nodes in Year 1. These can't all be true.

---

## 3. Financial Due Diligence

**Arithmetic is mostly internally consistent** — ARR = nodes × price × 12 checks out every year, and EBITDA/margin rows recompute correctly. But:

| Issue | Detail | Severity |
| --- | --- | --- |
| Processing-fee math doesn't match the stated 1.5% | Y1: 1.5% of $1.728M ARR = $25,920, but model shows $216,000 (**12.5%**). Same gap all years (Y2: 13.5%). Either the fee is applied to a much larger undisclosed GMV, or the numbers are inflated | 🔴 High |
| Y5 OpEx typo | Components sum to $14.7M; the "Total OpEx" row shows **$1,470,000** (zero dropped). EBITDA uses the correct $14.7M — a spreadsheet a sharp investor will catch in 30 seconds | 🟡 Embarrassing |
| Seed ask vs. model conflict | Deck promises $5.5M ARR by month 18; interpolating the model gives ~$3.8M | 🟠 Moderate |
| 87.3% EBITDA margin at $115M revenue | Y5 GTM budget of $6.8M while adding 1,070 enterprise nodes in one year = ~$6.4k acquisition cost per enterprise node. Realistically impossible; mature SaaS at this scale runs 15–30% | 🔴 High |
| No cost-of-revenue line | OpenAI API costs, email infrastructure, and the "computational fees" appear only as *revenue*, never as COGS | 🟠 Moderate |
| Unsourced KPI claims | "22–38% margin loss," "42% lead decay," "28% wasted shifts" — precise numbers, zero citations or methodology | 🟡 DD red flag |
| Growth curve | Node count 780 → 1,850 (2.4x) in Y5 while OpEx only grows 90% — no hiring plan supports this | 🟡 |

**Bottom line:** The model reads as top-down aspiration, not bottom-up planning. The internally consistent arithmetic suggests care, but the fee math, margin trajectory, and pricing disconnect would not survive an institutional seed round's first pass.

---

## 4. Production Readiness

**Genuine positives (structurally verified):**
- Real engineering hygiene: 78 incremental Prisma migrations with sensible evolution (idempotency keys, dedupe constraints, retention indexes, lockout/MFA hardening), audit-event tables, DLQ auto-retry, adaptive worker concurrency, TOTP 2FA + step-up auth, rate-limit route, AES-256 email encryption key, `.trivyignore`, CI under `.github/`.
- The worker is well-factored (pure-DB processors separable from BullMQ for testability) — this is experienced design.
- 1,696 real test cases is still substantial; "2,100+" is inflated, not fabricated.

**Concerns:**
- 🔴 **The code does not implement the product being sold.** Deploying this package delivers a cold-outreach SaaS, not a field-service logistics OS. The pilot's guaranteed KPIs (route optimization, <24h billing cycle, dispatch) have no implementation to stand on.
- 🟠 Committed `node_modules`/`dist` bloat the archive and suggest the build was never cleanly reproducible from the manifest's own instructions.
- 🟠 Claims of "production-ready, smoke-tested in 15–20 minutes" cannot be verified without a Railway deploy; no evidence of a running instance is included.
- 🟡 Security controls (SSRF protection, tenant isolation) are *claimed* in docs and table/migration names support some of it, but this review did not complete a line-level pass before the tool budget ran out — treat SECURITY.md assertions as unverified pending a dedicated security review.

---

## 5. Verdict

| Dimension | Score | One-liner |
| --- | --- | --- |
| Package integrity | 7/10 | Real, substantial codebase; quantified claims padded ~25% |
| Document consistency | 2/10 | Blueprints, manifest, and code describe three different products |
| Financial model | 4/10 | Careful arithmetic wrapped around impossible margins and broken fee logic |
| Production readiness | 6/10 | Genuine engineering rigor — for a different product than the one proposed |

**The single decision-critical issue:** before this goes to any pilot customer or investor, reconcile the CVRPTW routing engine (the entire value proposition of the proposal and Slide 4 of the deck) with the absence of any routing code in the package — either implement and ship it, or re-scope the pitch to what the codebase actually is: an AI outreach/lead-scoring platform with an early ops module.
