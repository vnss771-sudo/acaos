# Design: In-product compliance — sub-processor disclosure, lawful-basis capture, consent

**Status:** Design (implementation-ready) · **Date:** 2026-06-24 · **Owner:** TBD
**Source:** Readiness review §5 (Security/CISO seat) — cold-email compliance gaps (GDPR Art. 6 lawful basis, CASL consent, DPA/sub-processor transparency) are an operator responsibility today with **no in-product surface**.

> Scope note: this is the one substantive Phase-1 item that is genuinely *product + legal*, not pure engineering. The schema/API/UI below are buildable now; the **copy** (sub-processor descriptions, T&Cs, LIA prompts) needs legal sign-off before shipping. Nothing here changes send behavior until the gate in §4 is turned on.

---

## 1. The gap (what's missing today)

ACAOS sends cold commercial email on customers' behalf, which engages three regimes:
- **GDPR (EU/UK) Art. 6(1)(f)** — cold B2B email typically relies on *legitimate interest*, which requires a documented **Legitimate Interest Assessment (LIA)**. Art. 28 requires a **DPA** with each sub-processor; Art. 13–14 require **transparency** about who processes the data.
- **CASL (Canada)** — requires **express or implied consent** before a commercial electronic message, plus sender identification (already handled in the footer — see `processors.ts` / `buildOutreachEmail`).
- **CAN-SPAM (US)** — physical address + unsubscribe (already enforced: `getSendReadiness` + `buildOutreachEmail`).

Already solid (don't rebuild): unsubscribe + suppression honored pre-send (`sendDecision`/`contactPolicy`), physical address in every send (the `buildOutreachEmail` renderer), retention purge (`retention.ts`), encrypted creds at rest (`encrypt.ts`).

**Missing:** (a) a disclosed **sub-processor list**, (b) a captured **lawful-basis/LIA** per workspace, (c) a recorded **terms acceptance**, and (d) for CASL-targeting workspaces, a way to assert a **consent basis**. None are surfaced or recorded.

---

## 2. Sub-processors (the disclosure list)

Derived from the codebase — every external service that may receive personal data:

| Sub-processor | Data | Where in code |
|---|---|---|
| OpenAI | business name, contact first name, `lead.notes` (now truncated — `aiCost`/`openai.ts`), inbound reply bodies | `services/openai.ts` |
| Stripe | billing email, workspace id | `services/stripe.ts` |
| Customer's SMTP/IMAP provider | recipient email + message content | `services/mail.ts` |
| Discovery providers (Apollo, Hunter, Google Places) | prospect company/contact data | `lib/prospectSources.ts`, `discoveryCost.ts` |
| Sentry (if `SENTRY_DSN` set) | error context (method/route/id — **no bodies**, verified ASVS V8) | `lib/errorReporting.ts` |

**Action:** publish this as a versioned list (a static `SUBPROCESSORS` constant + a `/legal/subprocessors` page), shown during onboarding and linked from Settings. Cheap, high-trust, no schema needed.

---

## 3. Schema additions

Additive/nullable only (safe `migrate deploy`, consistent with every migration in the readiness PR):

```prisma
model Workspace {
  // ... existing ...
  // Compliance posture (operator-attested). Null = not yet completed.
  lawfulBasis          String?    // 'legitimate_interest' | 'consent' | 'contract'
  liaAcknowledgedAt    DateTime?  // operator confirmed they have an LIA on file
  termsAcceptedAt      DateTime?
  termsVersion         String?
  subprocessorsAckAt   DateTime?  // acknowledged the sub-processor list (+ version)
  targetsCanada        Boolean    @default(false) // gates the CASL consent requirement
}

// Append-only consent/basis ledger (like ContactEvent / UnsubscribeEvent — decouple
// for durability; purge with the workspace). Lets an operator record the basis per
// recipient/segment when they have one, and gives an auditable trail for SARs.
model ConsentRecord {
  id          String   @id @default(cuid())
  workspaceId String
  emailKey    String   // normalized recipient (matches Suppression.emailKey)
  basis       String   // 'express_consent' | 'implied_consent' | 'legitimate_interest'
  source      String   // 'import' | 'manual' | 'form' | 'crm_sync'
  note        String?
  recordedAt  DateTime @default(now())
  @@index([workspaceId, emailKey])
  @@index([workspaceId, recordedAt])
}
```
> Note: `ConsentRecord` is intentionally **decoupled** (no Workspace FK) — so add it to `DECOUPLED_TENANT_DELETES` in the workspace-erasure handler (`workspaces/core.ts`), exactly like `AuditEvent`/`ScoringOutcome`. (Add a deletion-test assertion too.)

---

## 4. Enforcement — extend the existing launch gate

`getSendReadiness` (`apps/api/src/lib/sendReadiness.ts`) is already the single source of truth for "can this workspace send?", rendered in the onboarding panel and enforced at campaign/mission launch. Add checks (gated behind a `COMPLIANCE_GATE_ENABLED` launch-control flag so it ships dormant, like `FOLLOWUPS_ENABLED`):

```ts
{ name: 'lawfulBasis', label: 'Lawful basis recorded',
  ok: Boolean(ws?.lawfulBasis), hint: 'Confirm your GDPR lawful basis (usually legitimate interest) in Settings → Compliance.' },
{ name: 'terms', label: 'Outreach terms accepted',
  ok: Boolean(ws?.termsAcceptedAt), hint: 'Accept the acceptable-use & data-processing terms.' },
// Only when targetsCanada:
{ name: 'caslConsent', label: 'CASL consent basis (Canada)',
  ok: !ws?.targetsCanada || consentRecordsExist, hint: 'CASL requires express/implied consent — record a consent basis before sending to Canadian recipients.' },
```
This reuses the whole existing pipeline (server enforcement + UI panel) — minimal new surface, and `ready` automatically blocks launch until satisfied. Keep the flag **off** until legal signs off the copy.

---

## 5. API + UI surface

- **API** (extend `workspaces/core.ts`, owner/admin + step-up like the other settings):
  - `GET /api/workspaces/:id/compliance` → posture + sub-processor list/version.
  - `PATCH /api/workspaces/:id/compliance` → set `lawfulBasis`, `targetsCanada`, accept terms/sub-processors (stamps the `*At` + version fields). Add `Assert<Extends<>>` guards + route contracts (mirrors the sendCampaign fix).
  - `POST /api/workspaces/:id/consent` (+ CSV bulk) → append `ConsentRecord`s.
- **UI:** a **Settings → Compliance** panel (extract as its own component — do *not* grow the 930-line `Settings.tsx`, per the architecture finding). Onboarding wizard gains a short "Compliance" step that writes the basis + acceptances. A SAR/erasure affordance can reuse the workspace-deletion endpoint already shipped.

---

## 6. Phased plan

| Phase | Work | Effort | Gate |
|---|---|---|---|
| C1 | `SUBPROCESSORS` constant + `/legal/subprocessors` page + Settings link | S | none (ship now) |
| C2 | Schema (Workspace fields + `ConsentRecord`) + migration; wire `ConsentRecord` into workspace-erasure decoupled deletes | S–M | — |
| C3 | Compliance API (GET/PATCH/consent) + contracts/guards + tests | M | — |
| C4 | `getSendReadiness` checks behind `COMPLIANCE_GATE_ENABLED` (dormant) + Settings→Compliance UI + onboarding step | M | legal sign-off on copy |
| C5 | Flip `COMPLIANCE_GATE_ENABLED=true` for new workspaces; backfill prompt for existing | S | legal + GTM |

**Definition of done:** a workspace cannot launch outreach (when the gate is on) without a recorded lawful basis + accepted terms; Canadian-targeting workspaces must record a consent basis; the sub-processor list is disclosed and versioned; all compliance data is erased by the workspace-deletion endpoint.

---

## 7. Explicitly out of scope (operator/legal, not code)
- Drafting the actual LIA, DPA, T&Cs, and sub-processor descriptions (legal).
- Acting as the data controller — customers remain controllers; ACAOS is the processor. The product *facilitates* their compliance; it does not assume their legal obligations.
